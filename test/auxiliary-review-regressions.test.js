import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient, auxiliaryResponseLength, compatibleConnection, parseObject } from '../src/agents/client.js';
import { generateAuxiliary } from '../src/adapters/auxiliary-transport.js';

function nativeFixture({ settings = {}, models = [], api = 'openai', payload = { choices: [{ message: { content: '{"ids":[]}' } }] }, stops = [] } = {}) {
    const calls = [], settingsSeen = [];
    const generate = params => generateAuxiliary({ params,
        context: { mainApi: api, chatCompletionSettings: settings },
        script: { createRawPrompt: messages => messages.map(message => message.content).join('\n'), getMaxResponseTokens: () => 16000,
            extractMessageFromData: data => (Array.isArray(data.content) ? data.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : null) ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? data.content ?? '' },
        openai: { model_list: models, getChatCompletionModel: value => value.model ?? 'synthetic',
            createGenerationParameters: async (value, model, _type, messages) => { settingsSeen.push(value); return { generate_data: { model, messages, max_tokens: value.openai_max_tokens, n: undefined } }; } },
        textgen: { textgenerationwebui_settings: {}, getTextGenModel: () => 'synthetic', createTextGenGenerationData: (_settings, _model, prompt, maxTokens) => ({ prompt, max_tokens: maxTokens, stop: ['}', '\nPlayer:'], stopping_strings: ['}', '\nPlayer:'] }) },
        instruct: { getInstructStoppingSequences: options => { assert.equal(options.useStopStrings, false); return stops; } },
        fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => payload }; },
    });
    return { generate, calls, settingsSeen };
}
const request = { purpose: 'select', system: '固定任务', input: {} };

test('native auxiliary generation preserves a higher configured output budget and reasoning settings', async () => {
    const settings = { openai_max_tokens: 32768, reasoning_effort: 'max', show_thoughts: true };
    const f = nativeFixture({ settings });
    await new AgentClient(f.generate).complete(request);
    assert.equal(f.calls[0].max_tokens, 32768);
    assert.equal(f.settingsSeen[0].reasoning_effort, 'max');
    assert.deepEqual(settings, { openai_max_tokens: 32768, reasoning_effort: 'max', show_thoughts: true });
    assert.equal(Object.hasOwn(f.calls[0], 'n'), false, 'quiet builders may deliberately omit n');
});

test('task budgets grow with selected identifiers and stay within a conservative unknown-model limit', () => {
    const catalog = Array.from({ length: 200 }, (_, i) => ({ id: `source:encoded-book-name:entry-${i}` }));
    assert.ok(auxiliaryResponseLength('select', { selectionLimit: 200, catalog }) > auxiliaryResponseLength('select', { selectionLimit: 1, catalog }));
    assert.ok(auxiliaryResponseLength('initialize', { entries: Array.from({ length: 24 }, () => ({})) }) <= 8192);
});

test('native model metadata bounds the requested budget without confusing context length with output length', async () => {
    const f = nativeFixture({ settings: { model: 'bounded', openai_max_tokens: 32768 }, models: [{ id: 'bounded', context_length: 128000, top_provider: { max_completion_tokens: 8192 } }] });
    await new AgentClient(f.generate).complete({ ...request, purpose: 'initialize', input: { entries: Array.from({ length: 24 }, () => ({})) } });
    assert.equal(f.calls[0].max_tokens, 8192);
});

for (const [name, payload] of [
    ['Claude wrapper with incomplete JSON', { content: [{ type: 'text', text: '{"ids":["a' }] }],
    ['Claude wrapper with only thinking', { content: [{ type: 'thinking', thinking: 'private-source' }] }],
    ['Gemini wrapper with incomplete JSON', { choices: [{ message: { content: '{"ids":[' } }], responseContent: {} }],
    ['Gemini empty candidate error', { error: { message: 'Google AI Studio Candidate text empty' } }],
]) test(`${name} avoids another paid request without claiming a proven token limit`, async () => {
    const f = nativeFixture({ payload });
    await assert.rejects(new AgentClient(f.generate).complete(request), error => {
        assert.match(error.message, /完整|正文/);
        assert.match(error.message, /可能/);
        assert.notEqual(error.name, 'OutputLimitError');
        assert.doesNotMatch(error.message, /private-source/);
        return true;
    });
    assert.equal(f.calls.length, 1);
});

test('llama.cpp explicit stopped_limit is a confirmed non-retried truncation', async () => {
    const f = nativeFixture({ payload: { content: '{"ids":[', stopped_limit: true } });
    await assert.rejects(new AgentClient(f.generate).complete(request), error => error.name === 'OutputLimitError');
    assert.equal(f.calls.length, 1);
});

test('compatible reasoning models keep the provider default unless the player sets a limit', async () => {
    const send = async (model, options = {}) => {
        let body;
        const generate = compatibleConnection({ endpoint: 'https://synthetic.example/v1', model, ...options, fetchImpl: async (_url, init) => {
            body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
        } });
        await generate({ ...request, input: '{}', responseLength: 2048 });
        return body;
    };
    // Reasoning tokens share the allowance; a task-sized cap would starve the JSON.
    for (const model of ['gpt-5', 'gpt-5.1', 'gpt-5-mini', 'gpt-6-astra', 'o1', 'o3-mini', 'o4-mini', 'openai/gpt-5', 'deepseek-reasoner', 'deepseek-r1', 'qwq-32b']) {
        const body = await send(model);
        assert.equal(body.max_tokens, undefined, model);
        assert.equal(body.max_completion_tokens, undefined, model);
    }
    for (const model of ['gpt-5', 'o3-mini', 'openai/gpt-5', 'gpt-6-astra']) {
        assert.equal((await send(model, { maxOutputTokens: 12000 })).max_completion_tokens, 2048, model);
    }
    assert.equal((await send('deepseek-reasoner', { maxOutputTokens: 12000 })).max_tokens, 2048);
    for (const model of ['gpt-4.1', 'other', 'deepseek-chat']) {
        const body = await send(model);
        assert.equal(body.max_tokens, 2048, model);
        assert.equal(body.max_completion_tokens, undefined, model);
    }
});

test('text completion keeps only instruct terminators and respects a higher configured budget', async () => {
    const f = nativeFixture({ api: 'textgenerationwebui', stops: ['<|eot_id|>', '\n### Instruction:'] });
    await new AgentClient(f.generate).complete(request);
    assert.deepEqual(f.calls[0].stop, ['<|eot_id|>', '\n### Instruction:']);
    assert.deepEqual(f.calls[0].stopping_strings, f.calls[0].stop);
    assert.equal(f.calls[0].max_tokens, 16000);
});

test('parser ignores prose brackets, detached reasoning and unicode before a think wrapper', () => {
    const object = '{"ids":["a"]}';
    for (const response of [`[完成] ${object}`, `${object}\n参见 [说明](#)`, `{完成} ${object}`, `需要输出 {"ids":[...]} 格式。</think>\n${object}`,
        `İİ<think>{private}</think>${object}`, `<thinking>草稿 {a}</thinking>${object}`]) assert.deepEqual(parseObject(response), { ids: ['a'] }, response);
    assert.deepEqual(parseObject('说明 {"value":"literal </think> [x]"}'), { value: 'literal </think> [x]' });
    assert.throws(() => parseObject(`${object} ${object}`));
    assert.throws(() => parseObject('[{"ids":[]}]'));
    assert.throws(() => parseObject('{"unfinished":"literal </think>{"ids":[]}'), error => error.name === 'IncompleteModelResponseError');
});

test('reasoning-only and whitespace responses do not trigger format correction', async () => {
    for (const output of [' ', '<think>private</think>', '<thinking>private</thinking>', 'private</think>']) {
        let calls = 0;
        await assert.rejects(new AgentClient(async () => { calls++; return output; }).complete(request), error => error.name === 'EmptyModelResponseError');
        assert.equal(calls, 1);
    }
});

test('unsupported native backends fail clearly before sending to a different connection', async () => {
    for (const api of ['kobold', 'novel', 'koboldhorde']) {
        const f = nativeFixture({ api });
        await assert.rejects(new AgentClient(f.generate).complete(request), /此后端请配置单独辅助连接/);
        assert.equal(f.calls.length, 0);
    }
});

test('compatible endpoints can explicitly override token field and known output cap', async () => {
    let body;
    const generate = compatibleConnection({ endpoint: 'https://synthetic.example/v1', model: 'o3', tokenParameter: 'max_tokens', maxOutputTokens: 4096,
        fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }; } });
    await generate({ ...request, input: '{}', responseLength: 8192 });
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.max_completion_tokens, undefined);
});

test('format correction is a task instruction and leaves input data byte-identical', async () => {
    const attempts = [], input = { private_scene: 'source', outputCorrection: 'source-authored-field' };
    const client = new AgentClient(async value => { attempts.push(value); return attempts.length === 1 ? '{"ids":[],}' : '{"ids":[]}'; });
    await client.complete({ ...request, input });
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].input, attempts[1].input);
    assert.match(attempts[1].system, /程序格式校验/);
    assert.equal(attempts[0].system, request.system);
});

test('known structured API errors give parameter guidance without echoing the response', async () => {
    const generate = compatibleConnection({ endpoint: 'https://synthetic.example/v1', model: 'o3', fetchImpl: async () => ({ ok: false, status: 400,
        json: async () => ({ error: { message: 'Unsupported parameter: max_completion_tokens private-secret', param: 'max_completion_tokens' } }) }) });
    await assert.rejects(generate({ ...request, input: '{}' }), error => {
        assert.match(error.message, /HTTP 400/); assert.match(error.message, /max_completion_tokens/);
        assert.doesNotMatch(error.message, /private-secret/); return true;
    });
});
