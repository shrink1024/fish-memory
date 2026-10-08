import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient, compatibleConnection, parseObject } from '../src/agents/client.js';
import { DEFAULT_SETTINGS } from '../src/core/state.js';

const request = (purpose = 'select', signal) => ({ purpose, system: '合成测试任务', input: {}, signal });
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
function controlledTimeouts(t) {
    const timers = [];
    t.mock.method(AbortSignal, 'timeout', milliseconds => {
        const controller = new AbortController();
        timers.push({ milliseconds, expire: () => controller.abort(new DOMException('Browser timeout', 'TimeoutError')) });
        return controller.signal;
    });
    return timers;
}

test('initialization, history maintenance, and compaction use the long-task budget', async t => {
    const timers = controlledTimeouts(t);
    const client = new AgentClient(async () => '{"ok":true}');
    for (const purpose of ['initialize', 'strategy', 'select', 'maintain', 'compact', 'preferences']) {
        assert.deepEqual(await client.complete(request(purpose)), { ok: true });
    }
    assert.deepEqual(timers.map(timer => timer.milliseconds), [1800000, 1800000, 300000, 1800000, 1800000, 300000]);
    assert.equal(DEFAULT_SETTINGS.initializationTimeoutMs, 1800000);
    assert.equal(DEFAULT_SETTINGS.timeoutMs, 300000);
});

test('an explicit legacy timeout applies to all purposes unless an initialization budget is also supplied', async t => {
    const timers = controlledTimeouts(t);
    const legacy = new AgentClient(async () => '{}', { timeoutMs: 23000 });
    await legacy.complete(request('initialize')); await legacy.complete(request('strategy')); await legacy.complete(request());
    const separated = new AgentClient(async () => '{}', { timeoutMs: 23000, initializationTimeoutMs: 47000 });
    await separated.complete(request('initialize')); await separated.complete(request('strategy')); await separated.complete(request());
    assert.deepEqual(timers.map(timer => timer.milliseconds), [23000, 23000, 23000, 47000, 47000, 23000]);
});

test('timed out requests explain their actual budget and never adopt a late host result', async t => {
    const timers = controlledTimeouts(t), gate = deferred();
    let adopted = 0, parsed = 0;
    const client = new AgentClient(() => gate.promise, { timeoutMs: 90000, initializationTimeoutMs: 180000 });
    const pending = client.complete(request('initialize')).then(value => { adopted++; return value; });
    const rejected = assert.rejects(pending, error => {
        assert.equal(error.name, 'TimeoutError');
        assert.match(error.message, /180\s*秒/);
        assert.match(error.message, /设置.*辅助模型等待时间/);
        assert.match(error.message, /关闭插件限时/);
        assert.match(error.message, /重试/);
        return true;
    });
    timers[0].expire(); await rejected;
    gate.resolve({ get late() { parsed++; return true; } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(adopted, 0); assert.equal(parsed, 0);
});

test('front selection timeout keeps its shorter budget and readable retry guidance', async t => {
    const timers = controlledTimeouts(t);
    const client = new AgentClient(() => new Promise(() => {}));
    const rejected = assert.rejects(client.complete(request()), error => {
        assert.equal(error.name, 'TimeoutError'); assert.match(error.message, /300\s*秒/); assert.match(error.message, /重试/); return true;
    });
    timers[0].expire(); await rejected;
});

test('user cancellation wins over timeout and preserves the original cancellation reason', async t => {
    const timers = controlledTimeouts(t);
    for (const timeoutFirst of [false, true]) {
        const user = new AbortController(), reason = new DOMException('玩家停止', 'AbortError');
        const client = new AgentClient(({ signal }) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Host abort', 'AbortError')), { once: true });
        }));
        const rejected = assert.rejects(client.complete(request('initialize', user.signal)), error => error === reason);
        const timer = timers.at(-1);
        if (timeoutFirst) timer.expire();
        user.abort(reason);
        if (!timeoutFirst) timer.expire();
        await rejected;
    }
});

test('already cancelled requests do not call the model', async () => {
    const user = new AbortController(), reason = new Error('已停止此任务');
    user.abort(reason);
    const client = new AgentClient(() => { throw new Error('不应发送'); });
    await assert.rejects(client.complete(request('initialize', user.signal)), error => error === reason);
});

for (const status of [401, 403]) {
    test(`compatible connection HTTP ${status} gives safe authentication guidance`, async () => {
        let readBody = false;
        const generate = compatibleConnection({ endpoint: 'https://model.example/v1', model: 'test', apiKey: 'synthetic-secret-key',
            fetchImpl: async () => ({ ok: false, status, json: async () => { readBody = true; throw new Error('private-server-response'); } }) });
        await assert.rejects(generate({ system: 'test', input: '{}' }), error => {
            assert.match(error.message, new RegExp(`HTTP ${status}`));
            assert.match(error.message, /鉴权|权限/);
            assert.match(error.message, /密钥/);
            assert.doesNotMatch(error.message, /synthetic-secret-key|private-server-response/);
            return true;
        });
        assert.equal(readBody, false);
    });
}

test('invalid model JSON gives actionable guidance without revealing model output', () => {
    for (const response of ['私人剧情不能泄漏', '{"private_scene":"synthetic-private-scene",}', '[]', 'null']) {
        assert.throws(() => parseObject(response), error => {
            assert.match(error.message, /JSON/); assert.match(error.message, /重试/);
            assert.doesNotMatch(error.message, /私人剧情|synthetic-private-scene/);
            assert.equal(error.cause, undefined);
            return true;
        });
    }
});

test('plain JSON, fenced JSON, and object responses remain supported', () => {
    const expected = { ok: true, nested: { value: '合成' } };
    assert.deepEqual(parseObject(JSON.stringify(expected)), expected);
    assert.deepEqual(parseObject('```json\n' + JSON.stringify(expected) + '\n```'), expected);
    assert.deepEqual(parseObject('```\n' + JSON.stringify(expected) + '\n```'), expected);
    assert.equal(parseObject(expected), expected);
});

test('non-JSON compatible responses do not expose the server response through parser errors', async () => {
    const generate = compatibleConnection({ endpoint: 'https://model.example/v1', model: 'test',
        fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('private-server-response'); } }) });
    await assert.rejects(generate({ system: 'test', input: '{}' }), error => {
        assert.match(error.message, /JSON/); assert.match(error.message, /重试/);
        assert.doesNotMatch(error.message, /private-server-response/);
        assert.equal(error.cause, undefined);
        return true;
    });
});
