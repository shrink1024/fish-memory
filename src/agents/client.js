import { invariant, plainText } from '../core/util.js';
import { DEFAULT_SETTINGS, validTimeout } from '../core/state.js';

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

function missingResponse(kind) {
    return Object.assign(new Error(kind === 'empty'
        ? '辅助模型没有返回可用正文，本次未采用，也不会自动重复请求。接口未提供足够信息判断原因，可能与输出长度、思考设置或服务端处理有关。请检查收发记录，调整设置后重试。'
        : '辅助模型未返回完整的 JSON 正文，本次未采用，也不会自动重复请求。接口未提供足够信息判断原因，可能与输出长度、思考设置或提前结束有关。请检查收发记录，减少每批扫描量或调整设置后重试。'),
    { name: kind === 'empty' ? 'EmptyModelResponseError' : 'IncompleteModelResponseError', dwmResponseKind: kind });
}

function jsonBoundary(text, start) {
    const stack = [];
    let quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
        const character = text[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === '{' || character === '[') stack.push(character);
        else if (character === '}' || character === ']') {
            if (stack.pop() !== (character === '}' ? '{' : '[')) return { end: index, invalid: true };
            if (!stack.length) return { end: index };
        }
    }
    return { end: text.length, incomplete: true };
}

// Tolerate prose labels and external reasoning, never repair JSON syntax or
// choose between two objects. Scanning uses original offsets (Unicode lower-
// casing can change length), and skips JSON strings including literal tags.
function wrappedObject(text) {
    let plain;
    try { plain = { value: JSON.parse(text) }; } catch { /* A prose wrapper may remain. */ }
    if (plain) {
        invariant(plain.value && typeof plain.value === 'object' && !Array.isArray(plain.value), '模型必须返回 JSON 对象');
        return plain.value;
    }
    let candidate = null, invalid = false, hasBody = false;
    for (let index = 0; index < text.length; index++) {
        const opening = text[index] === '<' && /^<(think|thinking)>/i.exec(text.slice(index, index + 10));
        if (opening) {
            const closing = new RegExp(`</${opening[1]}>`, 'ig');
            closing.lastIndex = index + opening[0].length;
            const end = closing.exec(text);
            if (!end) throw missingResponse('incomplete');
            index = end.index + end[0].length - 1; continue;
        }
        const closing = text[index] === '<' && /^<\/(?:think|thinking)>/i.exec(text.slice(index, index + 11));
        if (closing) {
            // Some completion templates prefill the opening think tag. Only an
            // external close resets the discarded reasoning prefix.
            candidate = null; invalid = false; hasBody = false;
            index += closing[0].length - 1; continue;
        }
        if (text[index].trim()) hasBody = true;
        if (text[index] !== '{' && text[index] !== '[') continue;
        const looksJson = text[index] === '{' ? /^\{\s*(?:"|\}|$)/.test(text.slice(index)) : /^\[\s*(?:[\[\]{"\d-]|true\b|false\b|null\b|$)/.test(text.slice(index));
        if (!looksJson) continue;
        const start = index, boundary = jsonBoundary(text, start);
        if (boundary.incomplete) {
            // Do not reinterpret literal tags or nested objects inside an
            // unfinished string as external wrappers or a second result.
            throw missingResponse('incomplete');
        }
        index = boundary.end;
        let value;
        try { value = JSON.parse(text.slice(start, index + 1)); }
        catch { invalid = true; continue; }
        invariant(candidate === null, '存在多个可能的 JSON 结果');
        invariant(value && typeof value === 'object' && !Array.isArray(value), '模型必须返回 JSON 对象');
        candidate = value;
    }
    if (!hasBody) throw missingResponse('empty');
    invariant(!invalid, 'JSON 结果格式无效');
    invariant(candidate !== null, '没有 JSON 对象');
    return candidate;
}

export function parseObject(text) {
    if (typeof text === 'object' && text !== null && !Array.isArray(text)) return text;
    try {
        if (typeof text === 'string' && !text.trim()) throw missingResponse('empty');
        plainText(text, '模型返回', 500000);
        return wrappedObject(text.trim());
    } catch (error) {
        if (error.dwmResponseKind) throw error;
        // Parser errors can quote private model output; keep the user-facing error fixed.
        throw Object.assign(new Error('辅助模型未返回有效的 JSON 对象，结果未采用。请重试；若仍失败，请检查辅助模型是否支持按要求返回 JSON。'), { dwmResponseInvalid: true });
    }
}

/** JSON stays lossless while quoted source macros remain inert in ST's
 * substituteParams / EJS passes. These delimiters can only occur inside JSON
 * strings, so unicode escaping them cannot alter the object structure. */
export function serializeAgentInput(input) {
    const json = JSON.stringify(input);
    return typeof json === 'string' ? json.replace(/\{\{/g, '\\u007b\\u007b').replace(/<(?=%|(?:user|bot|char)>)/gi, '\\u003c') : json;
}

// Task estimates are bounded for unknown models. Transports preserve a higher
// configured budget and honor explicit model output metadata when available.
// A token allowance is not a prediction of actual output or billed usage.
export function auxiliaryResponseLength(purpose, input = {}) {
    if (purpose === 'select') {
        const limit = Number.isInteger(input?.selectionLimit) ? Math.max(1, Math.min(200, input.selectionLimit)) : 16;
        const lengths = (input?.catalog ?? []).filter(entry => !entry.constant).map(entry => JSON.stringify(String(entry.id)).length + 1).sort((a, b) => b - a).slice(0, limit);
        // One token per identifier character is a conservative estimate for
        // escaped/percent-encoded ids; the remainder leaves structural room.
        return Math.max(2048, Math.min(8192, 1024 + (lengths.length ? lengths.reduce((sum, value) => sum + value, 0) : limit * 48)));
    }
    if (['strategy', 'preferences'].includes(purpose)) return 4096;
    if (purpose === 'initialize') return Math.max(4096, Math.min(8192, (input?.entries?.length ?? 14) * 512 + 1024));
    return 8192;
}

/** Only explicit output metadata is a hard bound. Context length is not one. */
export function boundedResponseLength(requested, configured, metadata) {
    const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
    const limits = [metadata?.max_output_tokens, metadata?.max_completion_tokens, metadata?.top_provider?.max_completion_tokens,
        metadata?.limits?.max_output_tokens].map(positive).filter(Boolean);
    return Math.min(Math.max(positive(requested), positive(configured), 1), ...limits);
}

export function assertCompleteModelResponse(payload) {
    const reason = String(payload?.choices?.[0]?.finish_reason ?? payload?.stop_reason ?? payload?.candidates?.[0]?.finishReason ?? '').toLowerCase();
    if (['length', 'max_tokens', 'max_output_tokens'].includes(reason) || payload?.stopped_limit === true) {
        throw Object.assign(new Error('辅助模型达到输出长度上限，返回结果已截断或未生成正文，本次未采用。请提高输出上限、调低思考强度、减少每批扫描量或改用支持更长输出的辅助模型后重试。'), { name: 'OutputLimitError' });
    }
    if (reason === 'content_filter') {
        throw Object.assign(new Error('辅助模型接口未提供完整结果（content_filter），本次未采用。请检查接口返回与模型设置后重试。'), { name: 'OutputBlockedError' });
    }
}

/** Return fixed, useful error categories without exposing server text/secrets. */
export function modelApiError(payload, status) {
    const raw = typeof payload?.error === 'string' ? payload.error : payload?.error?.message ?? payload?.message ?? '';
    const message = String(raw), http = Number.isInteger(status) ? `（HTTP ${status}）` : '';
    if (/candidate text empty/i.test(message)) return missingResponse('empty');
    if (status === 401) return new Error(`辅助模型连接鉴权失败${http}。请检查辅助连接的 API 密钥是否填写正确、是否已失效，再重试。`);
    if (status === 403) return new Error(`辅助模型连接被拒绝${http}。请检查 API 密钥、账户和所选模型的访问权限，再重试。`);
    if (status === 429) return new Error(`辅助模型请求受到频率或额度限制${http}。请检查账户额度或稍后重试。`);
    if (/context[_ ]length|maximum context|too many tokens|prompt is too long/i.test(message)) return new Error(`辅助模型输入超过接口允许的上下文${http}。请减少每批扫描量或改用更大上下文的模型后重试。`);
    if (/unsupported|not supported|not allowed|invalid.*(?:parameter|argument)|must be|maximum|too (?:large|high)/i.test(message)) {
        const parameter = ['max_completion_tokens', 'max_tokens', 'reasoning_effort', 'temperature', 'n'].find(name => payload?.error?.param === name || new RegExp(`\\b${name}\\b`).test(message));
        if (parameter) return new Error(`辅助模型接口不接受当前 ${parameter} 参数或其取值${http}。请检查模型支持的输出长度、思考设置及接口兼容性后重试。`);
    }
    if (/model.*(?:not found|does not exist|not available)/i.test(message)) return new Error(`辅助模型不存在或当前账户无法使用${http}。请检查模型名称及访问权限后重试。`);
    return new Error(`辅助模型接口返回错误${http}，本次未采用。请检查收发记录中的接口响应和连接设置后重试。`);
}

export class AgentClient {
    constructor(generate, { timeoutMs, initializationTimeoutMs, getTimeouts } = {}) {
        this.generate = generate;
        this.timeoutMs = timeoutMs ?? DEFAULT_SETTINGS.timeoutMs;
        // An explicit legacy timeout still covers every purpose unless separately overridden.
        this.initializationTimeoutMs = initializationTimeoutMs ?? timeoutMs ?? DEFAULT_SETTINGS.initializationTimeoutMs;
        invariant(validTimeout(this.timeoutMs) && validTimeout(this.initializationTimeoutMs), '辅助模型等待时间应为 0（关闭插件限时）或 1000–86400000 毫秒的整数');
        this.getTimeouts = getTimeouts;
    }
    async completeValidated(request, validate) { return this.complete({ ...request, validate }); }
    async complete({ purpose, system, input, signal, validate = result => result, onAttempt }) {
        signal?.throwIfAborted();
        // Read settings once for this request. Saving new limits does not alter work already in flight.
        const current = this.getTimeouts?.();
        const longTask = ['initialize', 'strategy', 'maintain', 'compact'].includes(purpose);
        const timeoutMs = longTask ? current?.initializationTimeoutMs ?? this.initializationTimeoutMs : current?.timeoutMs ?? this.timeoutMs;
        invariant(validTimeout(timeoutMs), '辅助模型等待时间应为 0（关闭插件限时）或 1000–86400000 毫秒的整数');
        const timeout = timeoutMs === 0 ? null : AbortSignal.timeout(timeoutMs);
        const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
        try {
            combined?.throwIfAborted();
            let correction;
            for (let attempt = 0; attempt < 2; attempt++) {
                combined?.throwIfAborted();
                const request = { purpose, system: correction ? `${system ?? ''}\n\n${correction}` : system, input: serializeAgentInput(input),
                    signal: combined, responseLength: auxiliaryResponseLength(purpose, input) };
                const started = onAttempt?.({ ...request, attempt });
                if (started && typeof started.then === 'function') await started;
                combined?.throwIfAborted();
                // Transport/length failures are outside the correction boundary.
                const result = await untilAborted(this.generate(request), combined);
                combined?.throwIfAborted();
                try {
                    const accepted = await untilAborted(Promise.resolve().then(() => validate(parseObject(result))), combined);
                    combined?.throwIfAborted();
                    return accepted;
                } catch (error) {
                    combined?.throwIfAborted();
                    if (attempt || !error.dwmResponseInvalid) throw error;
                    correction = '上一次结果未通过程序格式校验，未写入任何资料。请依据同一批原始输入重新返回符合本任务字段的完整 JSON 对象。不要解释或省略条目，不要把未完成的处理替换为空结果。';
                }
            }
        } catch (error) {
            // A host may throw its own AbortError; preserve the caller's cancellation first.
            signal?.throwIfAborted();
            if (timeout?.aborted) throw new DOMException(`辅助模型请求已等待 ${timeoutMs / 1000} 秒，现已超时，迟到结果不会采用。可在“设置 → 辅助模型等待时间”提高上限或关闭插件限时后重试。`, 'TimeoutError');
            throw error;
        }
    }
}

/** Optional separate connection; credentials are supplied at runtime, never in save data. */
export function compatibleConnection({ endpoint, model, apiKey = '', fetchImpl = fetch, tokenParameter = 'auto', maxOutputTokens }) {
    const url = new URL(endpoint);
    invariant(['https:', 'http:'].includes(url.protocol), '模型连接必须使用 HTTP(S)');
    invariant(url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), '非本地连接必须使用 HTTPS');
    invariant(['auto', 'max_tokens', 'max_completion_tokens'].includes(tokenParameter), '不支持的辅助输出长度参数');
    const openaiReasoning = /(?:^|\/)(?:gpt-[56](?:[.\-]|$)|o[134](?:-|$))/i.test(model);
    const lengthParameter = tokenParameter === 'auto' ? openaiReasoning ? 'max_completion_tokens' : 'max_tokens' : tokenParameter;
    // Reasoning tokens share this allowance. A task-sized cap would starve the
    // JSON answer, so (as before alpha.5) leave the provider default unless the
    // player chose an explicit limit or parameter.
    const omitLength = tokenParameter === 'auto' && !maxOutputTokens
        && (openaiReasoning || /(?:^|[\/\-_.:])(?:r1|reasoner|reasoning|thinking|qwq)(?:$|[\/\-_.:])/i.test(model));
    return async ({ purpose, system, input, signal, responseLength = auxiliaryResponseLength(purpose) }) => {
        const response = await fetchImpl(url.href.replace(/\/$/, '') + '/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: input }], stream: false,
                ...(omitLength ? {} : { [lengthParameter]: boundedResponseLength(responseLength, null, { max_output_tokens: maxOutputTokens }) }) }), signal,
        });
        signal?.throwIfAborted();
        if ([401, 403].includes(response.status)) throw modelApiError(null, response.status);
        let payload;
        try { payload = await response.json(); }
        catch {
            signal?.throwIfAborted();
            if (!response.ok) throw modelApiError(null, response.status);
            throw new Error('辅助模型接口未返回有效的 JSON 响应。请检查辅助连接地址是否为兼容接口，再重试。');
        }
        signal?.throwIfAborted();
        if (!response.ok || payload?.error) throw modelApiError(payload, response.ok ? undefined : response.status);
        assertCompleteModelResponse(payload);
        return payload?.choices?.[0]?.message?.content ?? '';
    };
}
