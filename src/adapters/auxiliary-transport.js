import { auxiliaryResponseLength, assertCompleteModelResponse, boundedResponseLength, modelApiError } from '../agents/client.js';

/** Dedicated auxiliary transport using ST's connection parameter builders only.
 * No generation/prompt events, macro expansion of source data, or reply cleanup. */
export async function generateAuxiliary({ params, context, script, openai, textgen, instruct, fetchImpl }) {
    const api = context.mainApi ?? script.main_api;
    const signal = params.signal;
    signal?.throwIfAborted();
    const requestedLength = params.responseLength ?? auxiliaryResponseLength(params.purpose, params.input);
    const messages = [{ role: 'system', content: String(params.system ?? '') }, { role: 'user', content: String(params.input ?? '') }];
    let data, url, templateStops = [];
    if (api === 'openai') {
        if (typeof openai?.createGenerationParameters !== 'function') throw new Error('当前酒馆缺少独立辅助请求接口，请更新酒馆或配置单独辅助连接。');
        const settings = structuredClone(context.chatCompletionSettings ?? openai.oai_settings);
        const model = openai.getChatCompletionModel(settings);
        const metadata = openai.model_list?.find(item => item.id === model);
        const responseLength = boundedResponseLength(requestedLength, settings.openai_max_tokens, metadata);
        Object.assign(settings, { openai_max_tokens: responseLength, stream_openai: false, n: 1,
            function_calling: false, enable_web_search: false, request_images: false });
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
    data.stream = false;
    if (typeof data.n === 'number') data.n = 1;
    else delete data.n;
    if (templateStops.length) { data.stop = templateStops; data.stopping_strings = templateStops; }
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { method: 'POST', headers: context.getRequestHeaders?.() ?? script.getRequestHeaders?.(),
        body: JSON.stringify(data), signal });
    signal?.throwIfAborted();
    if ([401, 403].includes(response.status)) throw modelApiError(null, response.status);
    let payload;
    try { payload = await response.json(); }
    catch {
        signal?.throwIfAborted();
        if (!response.ok) throw modelApiError(null, response.status);
        throw new Error('酒馆辅助接口未返回有效的 JSON 响应，本次未采用。请检查收发记录与连接后重试。');
    }
    signal?.throwIfAborted();
    if (!response.ok || payload?.error) throw modelApiError(payload, response.ok ? undefined : response.status);
    assertCompleteModelResponse(payload);
    return script.extractMessageFromData(payload, api);
}
