import { invariant, plainText } from '../core/util.js';

/** Detach cancelled consumers even when the host cannot stop its underlying request. */
export async function untilAborted(operation, signal) {
    if (!signal) return operation;
    let onAbort;
    try {
        const result = await Promise.race([operation, new Promise((_, reject) => {
            onAbort = () => reject(signal.reason ?? new Error('已取消'));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
        })]);
        signal.throwIfAborted();
        return result;
    } finally { signal.removeEventListener('abort', onAbort); }
}

export function parseObject(text) {
    if (typeof text === 'object' && text !== null && !Array.isArray(text)) return text;
    try {
        plainText(text, '模型返回', 500000);
        const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const parsed = JSON.parse(cleaned);
        invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), '模型必须返回 JSON 对象');
        return parsed;
    } catch {
        // Parser errors can quote private model output; keep the user-facing error fixed.
        throw new Error('辅助模型未返回有效的 JSON 对象，结果未采用。请重试；若仍失败，请检查辅助模型是否支持按要求返回 JSON。');
    }
}

/** JSON stays lossless while quoted source macros remain inert in ST's
 * substituteParams pass. Consecutive opening braces only occur inside JSON
 * strings, so unicode escaping them cannot alter the object structure. */
export function serializeAgentInput(input) {
    const json = JSON.stringify(input);
    return typeof json === 'string' ? json.replace(/\{\{/g, '\\u007b\\u007b') : json;
}

export class AgentClient {
    constructor(generate, { timeoutMs, initializationTimeoutMs } = {}) {
        this.generate = generate;
        this.timeoutMs = timeoutMs ?? 90000;
        // An explicit legacy timeout still covers every purpose unless separately overridden.
        this.initializationTimeoutMs = initializationTimeoutMs ?? timeoutMs ?? 180000;
    }
    async complete({ purpose, system, input, signal }) {
        signal?.throwIfAborted();
        const timeoutMs = ['initialize', 'strategy'].includes(purpose) ? this.initializationTimeoutMs : this.timeoutMs;
        const timeout = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
            combined.throwIfAborted();
            const operation = this.generate({ purpose, system, input: serializeAgentInput(input), signal: combined });
            const result = await untilAborted(operation, combined);
            combined.throwIfAborted();
            return parseObject(result);
        } catch (error) {
            // A host may throw its own AbortError; preserve the caller's cancellation first.
            signal?.throwIfAborted();
            if (timeout.aborted) throw new DOMException(`辅助模型请求已等待 ${timeoutMs / 1000} 秒，现已超时，迟到结果不会采用。请检查辅助模型连接后重试。`, 'TimeoutError');
            throw error;
        }
    }
}

/** Optional separate connection; credentials are supplied at runtime, never in save data. */
export function compatibleConnection({ endpoint, model, apiKey = '', fetchImpl = fetch }) {
    const url = new URL(endpoint);
    invariant(['https:', 'http:'].includes(url.protocol), '模型连接必须使用 HTTP(S)');
    invariant(url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), '非本地连接必须使用 HTTPS');
    return async ({ system, input, signal }) => {
        const response = await fetchImpl(url.href.replace(/\/$/, '') + '/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: input }], stream: false }), signal,
        });
        signal?.throwIfAborted();
        if (response.status === 401) throw new Error('辅助模型连接鉴权失败（HTTP 401）。请检查辅助连接的 API 密钥是否填写正确、是否已失效，再重试。');
        if (response.status === 403) throw new Error('辅助模型连接被拒绝（HTTP 403）。请检查 API 密钥、账户和所选模型的访问权限，再重试。');
        invariant(response.ok, `模型连接失败（HTTP ${response.status}）`);
        let payload;
        try { payload = await response.json(); }
        catch {
            signal?.throwIfAborted();
            throw new Error('辅助模型接口未返回有效的 JSON 响应。请检查辅助连接地址是否为兼容接口，再重试。');
        }
        return payload?.choices?.[0]?.message?.content ?? '';
    };
}
