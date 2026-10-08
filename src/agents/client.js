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
    plainText(text, '模型返回', 500000);
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned);
    invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), '模型必须返回 JSON 对象');
    return parsed;
}

/** JSON stays lossless while quoted source macros remain inert in ST's
 * substituteParams pass. Consecutive opening braces only occur inside JSON
 * strings, so unicode escaping them cannot alter the object structure. */
export function serializeAgentInput(input) {
    const json = JSON.stringify(input);
    return typeof json === 'string' ? json.replace(/\{\{/g, '\\u007b\\u007b') : json;
}

export class AgentClient {
    constructor(generate, { timeoutMs = 90000 } = {}) { this.generate = generate; this.timeoutMs = timeoutMs; }
    async complete({ purpose, system, input, signal }) {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        combined.throwIfAborted();
        const operation = this.generate({ purpose, system, input: serializeAgentInput(input), signal: combined });
        return parseObject(await untilAborted(operation, combined));
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
        invariant(response.ok, `模型连接失败（HTTP ${response.status}）`);
        const payload = await response.json();
        return payload.choices?.[0]?.message?.content ?? '';
    };
}
