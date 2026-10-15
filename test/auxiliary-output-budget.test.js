import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibleConnection } from '../src/agents/client.js';
async function request(options = {}) {
    let body;
    const generate = compatibleConnection({ endpoint: 'https://synthetic.example/v1', model: 'deepseek-v4.1-flash', ...options,
        fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }; } });
    await generate({ purpose: 'initialize', system: '', input: '{}', responseLength: 8192 });
    return body;
}
test('unknown reasoning alias uses provider output default instead of 8192 ceiling', async () => {
    const body = await request();
    assert.equal(Object.hasOwn(body, 'max_tokens'), false);
    assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
});
test('explicit output allowance overrides the small task estimate', async () => {
    assert.equal((await request({ maxOutputTokens: 32768 })).max_tokens, 32768);
    assert.equal((await request({ model: 'gpt-5', maxOutputTokens: 32768 })).max_completion_tokens, 32768);
});
test('invalid output allowances fail before calling the service', async () => {
    for (const maxOutputTokens of [-1, 0, 1.5, NaN, Infinity, 'bad']) await assert.rejects(request({ maxOutputTokens }), /输出/);
});
