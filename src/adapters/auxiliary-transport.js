import { readStreamResponse } from '../agents/stream-response.js';
import { throwIfAborted } from '../platform/abort.js';
import { auxiliaryResponseLength, assertCompleteModelResponse, boundedResponseLength, modelApiError, requestMessages } from '../agents/client.js';

/** Dedicated auxiliary transport using ST's connection parameter builders only.
 * No generation/prompt events, macro expansion of source data, or reply cleanup. */
export async function generateAuxiliary({ params, context, script, openai, textgen, instruct, fetchImpl }) {
    const api = context.mainApi ?? script.main_api;
    const signal = params.signal;
    throwIfAborted(signal);
    const requestedLength = params.responseLength ?? auxiliaryResponseLength(params.purpose, params.input);
    const messages = requestMessages(params);
    let data, url, templateStops = [];
    if (api === 'openai') {
        if (typeof openai?.createGenerationParameters !== 'function') throw new Error('当前酒馆缺少独立辅助请求接口，请更新酒馆或配置单独辅助连接。');
        const settings = structuredClone(context.chatCompletionSettings ?? openai.oai_settings);
        const model = openai.getChatCompletionModel(settings);
        const metadata = openai.model_list?.find(item => item.id === model);
        const responseLength = boundedResponseLength(requestedLength, settings.openai_max_tokens, metadata);
        Object.assign(settings, { openai_max_tokens: responseLength, stream_openai: Boolean(params.stream), n: 1,
            function_calling: false, enable_web_search: false, request_images: false });
        // The story's thinking effort is not inherited unless the player asks.
        if (params.reasoningEffort && params.reasoningEffort !== 'inherit') settings.reasoning_effort = params.reasoningEffort;
        ({ generate_data: data } = await openai.createGenerationParameters(settings, model, 'quiet', messages));
        url = '/api/backends/chat-completions/generate';
    } else if (api === 'textgenerationwebui') {
        if (typeof textgen?.createTextGenGenerationData !== 'function' || typeof script.createRawPrompt !== 'function') {
            throw new Error('当前酒馆缺少独立文本补全接口，请更新酒馆或配置单独辅助连接。');
        }
        const settings = structuredClone(textgen.textgenerationwebui_settings);
        const responseLength = boundedResponseLength(requestedLength, script.getMaxResponseTokens?.());
        Object.assign(settings, { grammar_string: '', json_schema: {}, negative_prompt: '', custom_token_bans: '',
            banned_strings: '', min_length: 0, ban_eos_token: false, ignore_eos_token: false });
        // Let ST format its configured instruct template around opaque slots;
        // source material itself never enters substituteParams or regex passes.
        const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
        const slots = messages.map((_, index) => `FISH_MEMORY_LITERAL_${nonce}_${index}`);
        let prompt = script.createRawPrompt(messages.map((message, index) => ({ ...message, content: slots[index] })), api, false, false, '', '');
        for (let index = 0; index < slots.length; index++) {
            if (typeof prompt !== 'string' || prompt.split(slots[index]).length !== 2) throw new Error('文本补全模板改变了辅助请求结构，请使用单独辅助连接。');
            prompt = prompt.replace(slots[index], () => messages[index].content);
        }
        data = textgen.createTextGenGenerationData(settings, textgen.getTextGenModel(settings), prompt, responseLength, false, false, null, 'quiet');
        templateStops = [...new Set((instruct?.getInstructStoppingSequences?.({ useStopStrings: false }) ?? []).filter(value => typeof value === 'string' && value.trim()))];
        url = '/api/backends/text-completions/generate';
    } else {
        throw new Error('沿用酒馆连接目前支持聊天补全及文本补全；此后端请配置单独辅助连接。');
    }
    // Remove story-oriented stop strings, but keep the instruct template's
    // actual message terminators so text-completion models can end a reply.
    for (const key of ['stop', 'stopping_strings', 'grammar', 'grammar_string', 'guided_grammar', 'json_schema', 'guided_json',
        'tools', 'tool_choice', 'logprobs', 'top_logprobs']) delete data[key];
    data.stream = Boolean(params.stream);
    if (typeof data.n === 'number') data.n = 1;
    else delete data.n;
    if (templateStops.length) { data.stop = templateStops; data.stopping_strings = templateStops; }
    throwIfAborted(signal);
    const response = await fetchImpl(url, { method: 'POST', headers: context.getRequestHeaders?.() ?? script.getRequestHeaders?.(),
        body: JSON.stringify(data), signal });
    throwIfAborted(signal);
    if ([401, 403].includes(response.status)) throw modelApiError(null, response.status);
    let payload, plainJson = false;
    const contentType = response.headers?.get('content-type') ?? '';
    // ST's forwardFetchResponse pipes successful SSE without forwarding its
    // Content-Type. A requested native stream is therefore also authoritative
    // for a readable, non-JSON success response. HTTP errors still use JSON.
    const streamed = params.stream && (contentType.includes('text/event-stream')
        || response.ok && response.body?.getReader && !/application\/(?:[\w.-]+\+)?json\b/i.test(contentType));
    try { payload = streamed
        ? await readStreamResponse(response, { signal, onProgress: params.onProgress,
            allowJson: !contentType.includes('text/event-stream'), onJson: () => { plainJson = true; },
            // TT forwards some upstream failures as a synthetic assistant SSE
            // message instead of an error event. This exact native envelope is
            // not interpreted on ST or on a direct compatible connection.
            mapContentError: globalThis.__TAURITAVERN__ ? content => {
                const match=/^\[API 错误\]\s*\n(Custom OpenAI endpoint failed with status [45]\d\d:[\s\S]*)$/.exec(content);
                return match ? modelApiError({error:{message:match[1]}},response.status,{nativeTauri:true}) : null;
            } : undefined,
            mapError: value => modelApiError(value, response.ok ? undefined : response.status) }) : await response.json(); }
    catch (error) {
        throwIfAborted(signal);
        if (error?.dwmStreamFault) throw error;
        if (!response.ok) throw modelApiError(null, response.status);
        throw new Error('酒馆辅助接口未返回有效的 JSON 响应，本次未采用。请检查收发记录与连接后重试。');
    }
    throwIfAborted(signal);
    if (!response.ok || payload?.error) throw modelApiError(payload, response.ok ? undefined : response.status);
    assertCompleteModelResponse(payload);
    return streamed && !plainJson ? payload.choices[0].message.content : script.extractMessageFromData(payload, api);
}
