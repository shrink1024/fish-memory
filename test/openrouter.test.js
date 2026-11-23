import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient, compatibleConnection, listModels } from '../src/agents/client.js';
import { generateAuxiliary } from '../src/adapters/auxiliary-transport.js';

const endpoint = 'https://openrouter.ai/api/v1';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const complete = () => json({ choices: [{ message: { content: '{"ids":[]}', reasoning: 'private thought' }, finish_reason: 'stop' }] });
const request = { purpose: 'select', system: 'select memories', input: '{}' };
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const stream = body => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

test('inherited SillyTavern OpenRouter keeps native provider routing and settings', async () => {
    const settings = {chat_completion_source:'openrouter',openrouter_model:'vendor/test-model',openrouter_providers:['test-provider'],openai_max_tokens:4096};
    const original = structuredClone(settings); let wire;
    const result = await generateAuxiliary({params:{...request,reasoningEffort:'inherit'}, context:{mainApi:'openai',chatCompletionSettings:settings},
        script:{extractMessageFromData:payload=>payload.choices[0].message.content},
        openai:{getChatCompletionModel:value=>value.openrouter_model,createGenerationParameters:async (value,model,_type,messages)=>{
            assert.equal(value.chat_completion_source,'openrouter'); assert.deepEqual(value.openrouter_providers,['test-provider']);
            return {generate_data:{chat_completion_source:value.chat_completion_source,model,provider:{order:value.openrouter_providers},messages}};
        }},fetchImpl:async (url,options)=>{wire={url,body:JSON.parse(options.body)};return complete();}});
    assert.equal(result,'{"ids":[]}'); assert.deepEqual(settings,original);
    assert.equal(wire.url,'/api/backends/chat-completions/generate');
    assert.equal(wire.body.chat_completion_source,'openrouter'); assert.equal(wire.body.model,'vendor/test-model');
    assert.deepEqual(wire.body.provider,{order:['test-provider']});
});

test('OpenRouter model listing preserves namespaced IDs and uses bearer authentication', async () => {
    let seen;
    const models = await listModels({ endpoint: `${endpoint}/`, apiKey: 'synthetic-key', fetchImpl: async (url, options) => {
        seen = { url, ...options };
        return json({ data: [{ id: 'vendor/model-b:free', name: 'Friendly label' }, { id: 'vendor/model-a' }] });
    } });
    assert.deepEqual(models, ['vendor/model-a', 'vendor/model-b:free']);
    assert.equal(seen.url, `${endpoint}/models`);
    assert.deepEqual(seen.headers, { Authorization: 'Bearer synthetic-key' });
});

test('compatible routes append paths before query parameters and discard URL fragments', async () => {
    const base = 'https://gateway.example/api/v1///?api-version=2026-01-01#setup';
    const seen = [];
    const fetchImpl = async (url, options) => {
        seen.push(url);
        return options.method === 'GET' ? json({data:[{id:'vendor/model'}]}) : complete();
    };
    await listModels({endpoint:base, fetchImpl});
    await compatibleConnection({endpoint:base, model:'vendor/model', fetchImpl})(request);
    assert.deepEqual(seen, ['https://gateway.example/api/v1/models?api-version=2026-01-01',
        'https://gateway.example/api/v1/chat/completions?api-version=2026-01-01']);
});

test('model listing preserves cancellation during response body parsing', async () => {
    for (const rejectBody of [false, true]) {
        const abort = new AbortController(), reason = new DOMException('Stopped listing', 'AbortError');
        const fetchImpl = async () => ({ok:true,status:200,json:async () => {
            abort.abort(reason);
            if (rejectBody) throw reason;
            return {data:[{id:'late-model'}]};
        }});
        await assert.rejects(listModels({endpoint,fetchImpl,signal:abort.signal}), error => error === reason);
    }
});

test('OpenRouter uses unified reasoning and the configured completion budget across model families', async () => {
    for (const model of ['openai/gpt-5', 'anthropic/claude-sonnet', 'vendor/alias']) {
        for (const [reasoningEffort, effort] of [['min', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['max', 'max']]) {
            let wire;
            const abort = new AbortController();
            const generate = compatibleConnection({ endpoint, model, apiKey: 'synthetic-key', maxOutputTokens: 16384,
                fetchImpl: async (url, options) => { wire = { url, ...options, body: JSON.parse(options.body) }; return complete(); } });
            assert.equal(await generate({ ...request, reasoningEffort, signal: abort.signal }), '{"ids":[]}');
            assert.equal(wire.url, `${endpoint}/chat/completions`);
            assert.equal(wire.headers.Authorization, 'Bearer synthetic-key');
            assert.equal(wire.signal, abort.signal);
            assert.equal(wire.body.model, model);
            assert.equal(wire.body.max_completion_tokens, 16384);
            assert.equal(wire.body.max_tokens, undefined);
            assert.deepEqual(wire.body.reasoning, { effort });
            assert.equal(wire.body.reasoning_effort, undefined);
        }
    }
});

test('OpenRouter inherits provider defaults when no output limit or effort is chosen', async () => {
    for (const reasoningEffort of ['auto', 'inherit', undefined]) {
        let body;
        const generate = compatibleConnection({ endpoint, model: 'vendor/model', fetchImpl: async (_url, options) => {
            body = JSON.parse(options.body); return complete();
        } });
        await generate({ ...request, reasoningEffort, responseLength: 8192 });
        assert.equal(body.max_completion_tokens, undefined);
        assert.equal(body.max_tokens, undefined);
        assert.equal(body.reasoning, undefined);
        assert.equal(body.reasoning_effort, undefined);
    }
});

test('similar-looking domains retain generic compatible parameters', async () => {
    for (const base of ['https://openrouter.ai.example/api/v1', 'https://proxy.example/openrouter.ai/api/v1']) {
        let body;
        const generate = compatibleConnection({ endpoint: base, model: 'vendor/model', maxOutputTokens: 4096,
            fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return complete(); } });
        await generate({ ...request, reasoningEffort: 'min' });
        assert.equal(body.reasoning, undefined); assert.equal(body.reasoning_effort, 'low');
        assert.equal(body.max_tokens, 4096); assert.equal(body.max_completion_tokens, undefined);
    }
});

for (const status of [401, 402, 429]) test(`OpenRouter HTTP ${status} is sanitized and never automatically retried`, async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return json({ error: { code: status, message: 'synthetic-secret private story' } }, status); };
    const client = new AgentClient(compatibleConnection({ endpoint, model: 'vendor/model', fetchImpl }));
    const check = error => {
        assert.equal(error.httpStatus, status);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, /synthetic-secret|private story/);
        if (status === 402) assert.equal(error.kind, 'quota');
        return true;
    };
    await assert.rejects(client.complete({ ...request, input: {} }), check);
    assert.equal(calls, 1);
    await assert.rejects(listModels({ endpoint, fetchImpl }), check);
});

test('OpenRouter SSE ignores heartbeat and reasoning and accepts only completed content', async () => {
    const body = ': OPENROUTER PROCESSING\n\n' + event({ choices: [{ index: 0, delta: { reasoning: 'private thought' } }] })
        + event({ choices: [{ index: 0, delta: { content: '{"ids":[]}' } }] })
        + event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
    const generate = compatibleConnection({ endpoint, model: 'vendor/model', fetchImpl: async () => stream(body) });
    assert.equal(await generate({ ...request, stream: true }), '{"ids":[]}');
});

test('OpenRouter choice-level errors reject partial JSON in regular and streaming responses', async () => {
    for (const streaming of [false, true]) {
        let calls = 0;
        const choice = { index: 0, message: { content: '{"ids":[]}' }, finish_reason: 'error', error: { code: 402, message: 'private server detail' } };
        const generate = compatibleConnection({ endpoint, model: 'vendor/model', fetchImpl: async () => {
            calls++; return streaming ? stream(event({ choices: [choice] }) + 'data: [DONE]\n\n') : json({ choices: [choice] });
        } });
        await assert.rejects(generate({ ...request, stream: streaming }), error => {
            assert.equal(error.httpStatus, 402); assert.equal(error.kind, 'quota');
            assert.doesNotMatch(error.message, /private server detail/); return true;
        });
        assert.equal(calls, 1);
    }
});
