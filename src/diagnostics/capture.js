import { serializeAgentInput } from '../agents/client.js';
// Observes browser transport only. No generation, persistent storage or agent input.
const HOST_ROUTES = new Set(['/api/backends/chat-completions/generate', '/api/backends/text-completions/generate', '/api/backends/kobold/generate', '/api/novelai/generate']);
const TASKS = { initialize: '扫描世界书', strategy: '统合记忆策略', select: '前置选材', maintain: '后置维护', compact: '整理事件', preferences: '扫描预设偏好' };
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

export function modelRoute(input, base = 'http://localhost') {
    const url = safe(() => new URL(typeof input === 'string' || input instanceof URL ? input : input.url, base));
    if (!url) return null;
    const local = url.origin === new URL(base).origin && HOST_ROUTES.has(url.pathname);
    const direct = /\/(?:chat\/completions|responses|messages)$/.test(url.pathname);
    return local || direct ? { route: url.pathname, transport: local ? 'browser-st' : 'browser-api' } : null;
}

/** Makes complete stream text readable; the exact event stream remains responseRaw. */
export function decodeResponse(raw, contentType = '') {
    if (!contentType.includes('text/event-stream') && !/^\s*(?:event:|data:)/.test(raw)) return safe(() => JSON.parse(raw), null);
    const messages = new Map(); const events = [];
    const get = index => { if (!messages.has(index)) messages.set(index, { role: 'assistant', index, content: '', reasoning: '', tool_calls: [] }); return messages.get(index); };
    let malformedEvents = 0, done = false;
    for (const frame of raw.replaceAll('\r\n', '\n').split(/\n\n/)) {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        if (data.trim() === '[DONE]') { done = true; continue; }
        const value = safe(() => JSON.parse(data));
        if (!value) { malformedEvents++; continue; }
        if (value.error) events.push(value.error);
        if (Array.isArray(value.choices)) for (const choice of value.choices) {
            const out = get(choice.index ?? 0), delta = choice.delta ?? choice.message ?? {};
            if (typeof (delta.content ?? choice.text) === 'string') out.content += delta.content ?? choice.text;
            if (typeof (delta.reasoning_content ?? delta.reasoning) === 'string') out.reasoning += delta.reasoning_content ?? delta.reasoning;
            if (delta.tool_calls) out.tool_calls.push(...delta.tool_calls);
            if (delta.function_call) out.tool_calls.push({ function: delta.function_call });
            if (choice.finish_reason != null) done = true;
        }
        else if (Array.isArray(value.candidates)) for (const candidate of value.candidates) {
            const out = get(candidate.index ?? 0);
            for (const part of candidate.content?.parts ?? []) {
                if (typeof part.text === 'string') out[part.thought ? 'reasoning' : 'content'] += part.text;
                if (part.functionCall) out.tool_calls.push(part.functionCall);
            }
        }
        else {
            const out = get(0);
            const text = value.delta?.text ?? value.delta?.message?.content?.text ?? value.token ?? (typeof value.content === 'string' ? value.content : undefined) ?? (value.type === 'response.output_text.delta' ? value.delta : undefined);
            if (typeof text === 'string') out.content += text;
            if (typeof value.delta?.thinking === 'string') out.reasoning += value.delta.thinking;
            if (value.delta?.partial_json) out.tool_calls.push({ partial_json: value.delta.partial_json });
            if (value.content_block?.type === 'tool_use') out.tool_calls.push(value.content_block);
            if (value.type === 'message_stop' || value.type === 'response.completed') done = true;
        }
    }
    return { messages: [...messages.values()], stream: true, done, malformedEvents, ...(events.length ? { errors: events } : {}) };
}

export function installCapture({ target = globalThis, store, context = () => ({}), provenance = () => [], maxResponseChars = 1500000, readTimeoutMs = 300000 } = {}) {
    const original = target.fetch; const intents = new Set(), readers = new Set();
    let disposed = false;
    const change = (method, ...args) => safe(() => store[method](...args));
    const register = ({ purpose, label, source = '鱼忆', system, input }) => {
        const intent = { label: label ?? TASKS[purpose] ?? purpose ?? '辅助调用', source, system: String(system ?? ''), input: typeof input === 'string' ? input : serializeAgentInput(input), recordIds: [] };
        intents.add(intent);
        return { end: error => { intents.delete(intent); if (error) for (const id of intent.recordIds) change('update', id, { processingError: String(error.message ?? error).slice(0, 1000), processingOutcome: error.dwmYielded ? 'yielded' : error.dwmCancelled || error.wxlCancelled ? 'stopped' : error.name === 'AbortError' ? 'cancelled' : 'error' }); } };
    };
    const identify = request => {
        const texts = Array.isArray(request?.messages) ? request.messages.map(message => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content)).join('\n') : String(request?.prompt ?? '');
        const matching = [...intents].filter(intent => intent.system && intent.input && texts.includes(intent.system) && texts.includes(intent.input));
        return matching.length === 1 ? matching[0] : null;
    };
    const matchedProvenance = request => {
        const texts = Array.isArray(request?.messages) ? request.messages.map(message => typeof message?.content === 'string' ? message.content : '').join('\n') : String(request?.prompt ?? '');
        return safe(provenance, []).filter(item => typeof item?.text === 'string' && item.text.length > 8 && texts.includes(item.text));
    };
    async function collect(response, id) {
        let reader, timer; let raw = '', truncated = false;
        try {
            const clone = response.clone();
            const contentType = clone.headers.get('content-type') ?? '';
            if (clone.body) {
                reader = clone.body.getReader(); readers.add(reader); const decoder = new TextDecoder();
                const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('日志读取超时；生成请求未被取消')), readTimeoutMs); });
                while (!disposed) {
                    const chunk = await Promise.race([reader.read(), timeout]);
                    if (chunk.done) { raw += decoder.decode(); break; }
                    const text = decoder.decode(chunk.value, { stream: true });
                    raw += text.slice(0, Math.max(0, maxResponseChars - raw.length));
                    if (raw.length >= maxResponseChars) { truncated = true; reader.cancel().catch(() => {}); break; }
                }
            }
            if (disposed) return;
            const responseBody = decodeResponse(raw, contentType);
            const apiError = responseBody?.error || responseBody?.errors?.length;
            change('finish', id, { status: response.ok && !apiError ? 'complete' : 'error', httpStatus: response.status, contentType,
                responseRaw: raw, responseBody, ...(truncated ? { truncated: true, truncatedFields: ['responseRaw'], captureNote: '响应超过读取上限，日志只保留开头；实际生成照常继续。' } : {}),
                ...(!response.ok ? { error: `HTTP ${response.status}` } : apiError ? { error: '接口返回错误，详见响应原文。' } : {}) });
        } catch (error) {
            if (!disposed) change('finish', id, { status: error?.name === 'AbortError' ? 'aborted' : 'error', responseRaw: raw,
                responseBody: decodeResponse(raw), error: String(error?.message ?? error), captureNote: '响应记录未完整；已保留读取到的内容。' });
        } finally { clearTimeout(timer); if (reader) { readers.delete(reader); reader.cancel().catch(() => {}); } }
    }
    function wrapped(input, init) {
        if (disposed) return original.apply(this, arguments);
        const route = modelRoute(input, target.location?.href ?? 'http://localhost');
        const method = init?.method ?? input?.method ?? 'GET';
        if (!route || String(method).toUpperCase() !== 'POST') return original.apply(this, arguments);
        let id, intent;
        const requestText = typeof init?.body === 'string' ? init.body : undefined;
        const request = requestText !== undefined ? safe(() => JSON.parse(requestText), { captureError: '请求体不是有效 JSON，未记录未解析配置。' })
            : init?.body != null ? { captureError: '此请求体为流或二进制，未读取；没有使用旧 Request 的正文替代。' } : null;
        // Ignore direct API routes unless their body actually contains model input.
        if (route.transport === 'browser-api' && request && !request.messages && !request.input && !request.prompt) return original.apply(this, arguments);
        intent = safe(() => identify(request));
        id = change('start', { ...route, request, context: safe(context, {}), provenance: safe(() => matchedProvenance(request), []),
            source: intent?.source ?? '来源未确认', label: intent?.label ?? '酒馆 / 外部模型调用', kind: request?.type ?? 'unknown',
            captureNote: route.transport === 'browser-st' ? '浏览器与酒馆之间的收发原文；酒馆服务端可能继续转换供应商协议。' : '浏览器直接发出的模型请求。' });
        if (intent && id) intent.recordIds.push(id);
        if (request === null && input?.clone) {
            safe(() => (async () => {
                const reader = input.clone().body?.getReader(); let text = ''; const decoder = new TextDecoder();
                if (!reader) return;
                readers.add(reader);
                try {
                    while (!disposed) {
                        const { done, value } = await reader.read();
                        if (done) { text += decoder.decode(); break; }
                        text += decoder.decode(value, { stream: true });
                        if (text.length > maxResponseChars) {
                            change('update', id, { request: { captureError: '请求体超过读取上限，未记录。' }, truncated: true, truncatedFields: ['request'] }); return;
                        }
                    }
                } finally { readers.delete(reader); reader.cancel().catch(() => {}); }
                if (disposed) return;
                const body = safe(() => JSON.parse(text), { captureError: '请求体不是有效 JSON，未记录未解析配置。' });
                const match = safe(() => identify(body));
                if (match && id) match.recordIds.push(id);
                change('update', id, { request: body, provenance: safe(() => matchedProvenance(body), []), ...(match ? { label: match.label, source: match.source } : {}) });
            })().catch(() => change('update', id, { captureNote: '无法读取请求体；响应仍会记录。' })));
        }
        let operation;
        try { operation = original.apply(this, arguments); }
        catch (error) { change('finish', id, { status: 'error', error: String(error?.message ?? error) }); throw error; }
        // Read a clone independently. Return the original response without delaying consumption.
        return operation.then(response => { if (id) void collect(response, id); return response; }, error => {
            change('finish', id, { status: error?.name === 'AbortError' ? 'aborted' : 'error', error: String(error?.message ?? error) }); throw error;
        });
    }
    if (typeof original === 'function') target.fetch = wrapped;
    return { register, dispose() {
        disposed = true; intents.clear(); if (target.fetch === wrapped) target.fetch = original;
        for (const reader of readers) reader.cancel().catch(() => {}); readers.clear();
    } };
}
