import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient } from '../src/agents/client.js';
import { Controller } from '../src/runtime/controller.js';

const request = (purpose = 'select', signal) => ({ purpose, system: 'synthetic task', input: {}, signal });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    for (let count = 0; count < 30; count++) { if (predicate()) return; await tick(); }
    assert.fail('Request did not reach expected phase');
}
function controlledTimeouts(t) {
    const timers = [];
    t.mock.method(AbortSignal, 'timeout', milliseconds => {
        const controller = new AbortController();
        timers.push({ milliseconds, expire: () => controller.abort(new DOMException('Browser timeout', 'TimeoutError')) });
        return controller.signal;
    });
    return timers;
}
function fixture({ settings = {}, persistSettings = async () => {}, handler } = {}) {
    const state = { chatId: 'timeout-chat', bookName: 'main', templateEnabled: true,
        messages: [{ key: 'old-user', role: 'user', content: '合成历史一' }, { key: 'old-reply', role: 'assistant', content: '合成历史二' }], userInput: '' };
    const calls = [], saved = new Map();
    const host = {
        snapshot: () => structuredClone(state), eligible: entry => entry.enabled !== false,
        loadWorldbook: async () => [{ uid: 1, comment: '甲', content: '合成原文甲' }, { uid: 2, comment: '乙', content: '合成原文乙' }],
        clearPlan() {}, setPlan() {}, applyWindow: async () => {},
        storage: { read: async id => structuredClone(saved.get(id) ?? null), write: async (id, value) => saved.set(id, structuredClone(value)) },
        rawGenerate: async raw => {
            const parsed = { ...raw, input: JSON.parse(raw.input) }; calls.push(parsed);
            const reply = await handler?.(parsed);
            if (reply !== undefined) return JSON.stringify(reply);
            if (parsed.purpose === 'initialize') return JSON.stringify({ strategy: `合成策略${calls.length}`, entries: parsed.input.entries.map(entry => ({
                id: entry.id, kind: 'fact', intro: entry.title, segments: [{ id: 'body', writable: true }],
            })) });
            if (parsed.purpose === 'strategy') return '{"strategy":"合成统合策略"}';
            if (parsed.purpose === 'select') return '{"ids":[]}';
            return '{"operations":[]}';
        },
    };
    return { controller: new Controller(host, { settings, persistSettings }), state, calls };
}

test('loading upgrades only unversioned old timeout defaults and persists them on the next normal save', async () => {
    const writes = [];
    const f = fixture({ settings: { timeoutMs: 90000, initializationTimeoutMs: 180000 }, persistSettings: async value => writes.push(structuredClone(value)) });
    assert.equal(f.controller.settings.timeoutMs, 300000);
    assert.equal(f.controller.settings.initializationTimeoutMs, 1800000);
    assert.equal(f.controller.settings.timeoutSettingsVersion, 1);
    assert.equal(writes.length, 0, 'loading migration must not write host settings automatically');
    await f.controller.updateSettings({ recentTurns: 20 });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].timeoutMs, 300000);
    assert.equal(writes[0].initializationTimeoutMs, 1800000);
    assert.equal(writes[0].timeoutSettingsVersion, 1);
    for (const settings of [
        { timeoutMs: 23000, initializationTimeoutMs: 47000 },
        { timeoutMs: 0, initializationTimeoutMs: 0 },
        { timeoutMs: 90000, initializationTimeoutMs: 180000, timeoutSettingsVersion: 1 },
    ]) {
        const controller = fixture({ settings }).controller;
        assert.equal(controller.settings.timeoutMs, settings.timeoutMs);
        assert.equal(controller.settings.initializationTimeoutMs, settings.initializationTimeoutMs);
    }
});

test('invalid stored timeouts fall back safely while invalid updates never save or change active settings', async () => {
    let writes = 0;
    for (const value of [-1, 1, 999, 1000.5, 86400001, NaN, Infinity, '300000', null, undefined]) {
        const f = fixture({ settings: { timeoutMs: value, initializationTimeoutMs: value, timeoutSettingsVersion: 1 }, persistSettings: async () => { writes++; } });
        assert.equal(f.controller.settings.timeoutMs, 300000);
        assert.equal(f.controller.settings.initializationTimeoutMs, 1800000);
        for (const key of ['timeoutMs', 'initializationTimeoutMs']) {
            await assert.rejects(f.controller.updateSettings({ [key]: value }), /等待时间/);
        }
        assert.equal(f.controller.settings.timeoutMs, 300000);
        assert.equal(f.controller.settings.initializationTimeoutMs, 1800000);
    }
    assert.equal(writes, 0);
    const f = fixture();
    await f.controller.updateSettings({ timeoutMs: 1000, initializationTimeoutMs: 86400000 });
    assert.equal(f.controller.settings.timeoutMs, 1000);
    assert.equal(f.controller.settings.initializationTimeoutMs, 86400000);
    await f.controller.updateSettings({ timeoutMs: 0, initializationTimeoutMs: 0 });
    assert.equal(f.controller.settings.timeoutMs, 0);
    assert.equal(f.controller.settings.initializationTimeoutMs, 0);
});

test('worldbook batches and the actual historical initialization/maintenance path get independent long-task budgets', async t => {
    const timers = controlledTimeouts(t), f = fixture({ settings: { batchChars: 1 } });
    await f.controller.start(); await f.controller.initialize();
    assert.deepEqual(f.calls.map(call => call.purpose), ['initialize', 'initialize', 'strategy', 'maintain', 'maintain']);
    assert.deepEqual(timers.map(timer => timer.milliseconds), Array(5).fill(1800000));
    f.state.messages.push({ key: 'later', role: 'assistant', content: '补记合成剧情' });
    await f.controller.maintain();
    assert.equal(f.calls.at(-1).purpose, 'maintain');
    assert.equal(timers.at(-1).milliseconds, 1800000);
    assert.equal(timers.length, f.calls.length, 'there is one timer per request, no total initialization timer');
    assert.equal(f.controller.store.state.processed.length, 3);
});

test('zero disables plugin timers but keeps cancellation and late-result isolation', async t => {
    const timers = controlledTimeouts(t), pending = gate(), user = new AbortController();
    const reason = Object.assign(new Error('合成取消'), { name: 'AbortError' });
    let adopted = false, receivedSignal;
    const client = new AgentClient(({ signal }) => { receivedSignal = signal; return pending.promise; }, { timeoutMs: 0 });
    const result = client.complete(request('maintain', user.signal)).then(() => { adopted = true; });
    const rejected = assert.rejects(result, error => error === reason);
    user.abort(reason); await rejected;
    assert.equal(receivedSignal.aborted, true);
    assert.equal(timers.length, 0);
    pending.resolve('{}'); await tick();
    assert.equal(adopted, false);
    assert.deepEqual(await new AgentClient(async () => '{}', { timeoutMs: 0 }).complete(request()), {});
    assert.equal(timers.length, 0);
});

test('zero long-task timeout still lets foreground selection yield maintenance and discard its late result', async t => {
    const timers = controlledTimeouts(t), pending = gate();
    const f = fixture({ settings: { timeoutMs: 0, initializationTimeoutMs: 0 }, handler: request => {
        if (request.purpose === 'maintain' && request.input.messages.some(message => message.key === 'later')) return pending.promise;
    } });
    await f.controller.start(); await f.controller.initialize();
    f.state.messages.push({ key: 'later', role: 'assistant', content: '补记合成剧情' });
    const maintaining = f.controller.maintain();
    await until(() => f.calls.some(call => call.purpose === 'maintain' && call.input.messages.some(message => message.key === 'later')));
    await f.controller.generationBefore({ type: 'normal' });
    assert.equal((await maintaining).executed, false);
    pending.resolve({ operations: [{ type: 'summary', text: '迟到结果不应采用' }] }); await tick();
    assert.equal(f.controller.store.state.data.summary, '');
    assert.equal(f.controller.store.state.processed.length, 2);
    assert.equal(timers.length, 0);
});

for (const compatible of [false, true]) test(`saved waiting settings apply to the next real client request without changing the connection (${compatible ? 'compatible' : 'raw'})`, async t => {
    const timers = controlledTimeouts(t), pending = gate(), seen = [];
    const f = fixture({ handler: async request => {
        seen.push(request);
        return seen.length === 1 ? pending.promise : {};
    } });
    if (compatible) {
        t.mock.method(globalThis, 'fetch', async (url, options) => {
            seen.push({ url, options });
            const reply = seen.length === 1 ? await pending.promise : {};
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
        });
        await f.controller.updateConnection({ mode: 'compatible', endpoint: 'https://synthetic.example/v1', model: 'synthetic-model', apiKey: 'synthetic-key' });
    }
    const first = f.controller.client.complete(request('maintain'));
    assert.equal(timers[0].milliseconds, 1800000);
    await f.controller.updateSettings({ timeoutMs: 15000, initializationTimeoutMs: 27000 });
    assert.equal(timers.length, 1, 'the request already running keeps its original timer');
    pending.resolve({}); await first;
    await f.controller.client.complete(request('maintain'));
    await f.controller.client.complete(request('select'));
    assert.deepEqual(timers.map(timer => timer.milliseconds), [1800000, 27000, 15000]);
    if (compatible) {
        assert.equal(f.controller.connectionMode, 'compatible');
        assert.equal(f.calls.length, 0, 'updating timeouts must not switch back to raw');
        assert.ok(seen.every(call => call.url === 'https://synthetic.example/v1/chat/completions'));
        assert.ok(seen.every(call => call.options.headers.Authorization === 'Bearer synthetic-key'));
        assert.ok(seen.every(call => JSON.parse(call.options.body).model === 'synthetic-model'));
    }
});

test('a pending or failed settings save never changes the budget of subsequent requests', async t => {
    const timers = controlledTimeouts(t), pendingSave = gate();
    const f = fixture({ persistSettings: async () => { await pendingSave.promise; throw new Error('合成保存失败'); } });
    const updating = f.controller.updateSettings({ timeoutMs: 23000, initializationTimeoutMs: 47000 });
    const rejected = assert.rejects(updating, /保存失败/);
    await f.controller.client.complete(request('maintain'));
    pendingSave.resolve(); await rejected;
    await f.controller.client.complete(request('select'));
    await f.controller.client.complete(request('maintain'));
    assert.deepEqual(timers.map(timer => timer.milliseconds), [1800000, 300000, 1800000]);
});
