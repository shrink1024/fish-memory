import { throwIfAborted } from '../platform/abort.js';

const incomplete = () => Object.assign(new Error('流式响应未完整结束，本次未写入任何改动。'), { name: 'IncompleteStreamError', dwmStreamFault: 'cut' });
/** OpenAI-compatible chat/text SSE; the caller validates finish_reason and JSON.
 * No partial result escapes this boundary. Provider text never enters errors. */
export async function readStreamResponse(response, { signal, onProgress, allowJson = false, onJson, mapContentError,
    mapError = () => new Error('流式接口返回错误，本次未采用。请检查连接与收发记录。') } = {}) {
    if (!response.body?.getReader) throw incomplete();
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '', content = '', reasoning = '', finish = null, usage, blockReason, done = false, protocol = allowJson ? null : 'sse';
    const abort = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    const event = text => {
        const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data.startsWith(':')) return;
        if (data.trim() === '[DONE]') { done = true; return; }
        if (done) return;
        let value;
        try { value = JSON.parse(data); } catch { throw incomplete(); }
        if (value.error) throw Object.assign(mapError(value), {dwmStreamFault:'api'});
        if (value.usage) usage = value.usage;
        // Host chat backends may forward native Anthropic, Gemini or Cohere SSE.
        if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta') content += value.delta.text ?? '';
        if (value.type === 'message_delta' && value.delta?.stop_reason) finish = value.delta.stop_reason === 'max_tokens' ? 'length' : value.delta.stop_reason;
        if (value.type === 'message_stop') done = true;
        if (value.type === 'content-delta') content += value.delta?.message?.content?.text ?? '';
        if (value.type === 'message-end') { done = true; finish = /max_tokens/i.test(value.delta?.finish_reason ?? '') ? 'length' : value.delta?.finish_reason === 'COMPLETE' ? 'stop' : value.delta?.finish_reason ?? null; }
        if (value.candidates?.[0]) {
            const candidate=value.candidates[0];
            content += (candidate.content?.parts ?? []).filter(part=>!part.thought&&typeof part.text==='string').map(part=>part.text).join('');
            if(candidate.finishReason) { finish=String(candidate.finishReason).toLowerCase();done=true; }
        }
        if(value.promptFeedback?.blockReason) { blockReason=String(value.promptFeedback.blockReason);finish=blockReason.toLowerCase();done=true; }
        if (content.length + reasoning.length > 2000000) throw new Error('流式响应超过接收上限，本次未采用。');

        if (!value.choices && (value.index ?? 0) === 0 && typeof value.content === 'string') {
            content += value.content;
            if (content.length > 2000000) throw new Error('流式响应超过接收上限，本次未采用。');
            if (value.stop === true) { done = true; finish = value.stopped_limit ? 'length' : 'stop'; }
            onProgress?.({phase:'recv',chars:content.length});
        }
        const choice = value.choices?.find(item => (item.index ?? 0) === 0);
        if (!choice) { onProgress?.({phase:'recv',chars:content.length}); return; }
        const delta=choice.delta?.content ?? choice.message?.content ?? choice.text;
        if (typeof delta === 'string') content += delta;
        else if (Array.isArray(delta)) content += delta.filter(part=>typeof part.text==='string').map(part=>part.text).join('');
        if (typeof choice.delta?.reasoning_content === 'string') reasoning += choice.delta.reasoning_content;
        if (choice.finish_reason != null) finish = choice.finish_reason;
        if (content.length + reasoning.length > 2000000) throw new Error('流式响应超过接收上限，本次未采用。');
        onProgress?.({ phase: 'recv', chars: content.length });
    };
    try {
        throwIfAborted(signal);
        while (!done) {
            const part = await reader.read(); throwIfAborted(signal);
            pending += decoder.decode(part.value, { stream: !part.done });
            pending = pending.replace(/\r\n/g, '\n');
            if (pending.length > 2000000) throw incomplete();
            // Native proxies can omit Content-Type even when an upstream
            // answers a requested stream with one JSON envelope. Sniff only
            // before the first SSE event; a partial stream never becomes JSON.
            if (protocol === null && pending.trim()) protocol = /^[{[]/.test(pending.trimStart()) ? 'json' : 'sse';
            if (protocol === 'json') {
                if (!part.done) continue;
                let payload;
                try { payload = JSON.parse(pending); } catch { throw incomplete(); }
                onJson?.();return payload;
            }
            let boundary;
            while ((boundary = pending.indexOf('\n\n')) >= 0) { event(pending.slice(0, boundary)); pending = pending.slice(boundary + 2); }
            if (part.done) { if (pending.trim()) event(pending); break; }
        }
        throwIfAborted(signal);
        const contentError=mapContentError?.(content);
        if(contentError)throw Object.assign(contentError,{dwmStreamFault:'api'});
        if (!done || finish === null) throw incomplete();
        if (/error|cancel|abort|malformed|unexpected|recitation|other/i.test(String(finish))) throw incomplete();
        return { choices: [{ index: 0, text: content, message: { role: 'assistant', content }, finish_reason: finish }], ...(usage ? { usage } : {}), ...(blockReason ? {promptFeedback:{blockReason}} : {}) };
    } finally {
        signal?.removeEventListener('abort', abort);
        await reader.cancel().catch(() => {}); reader.releaseLock();
    }
}
