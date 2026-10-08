import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraceStore } from '../src/diagnostics/trace-store.js';

const assertBounds = (store, maxRecordChars = Infinity) => {
    const snapshot = store.snapshot();
    const lengths = snapshot.records.map(record => JSON.stringify(record).length);
    assert.equal(snapshot.totalChars, lengths.reduce((sum, length) => sum + length, 0));
    assert.ok(snapshot.totalChars <= snapshot.maxChars);
    assert.ok(snapshot.records.length <= snapshot.maxRecords);
    assert.ok(lengths.every(length => length <= maxRecordChars));
    return snapshot;
};

test('session records retain literal request and response, lifecycle and detached snapshots', () => {
    const store = createTraceStore();
    const prompt = '保留原始中文、换行\n以及 api_key / token 等正文词汇。';
    const request = { model: 'sample-model', messages: [{ role: 'system', content: prompt }], temperature: 0.7 };
    const id = store.start({ label: '前置选材', kind: 'front', source: 'fish-memory', transport: 'compatible', request, context: { chatId: 'test-chat' } });
    request.messages[0].content = '外部修改';
    assert.equal(store.snapshot().records[0].status, 'pending');
    assert.equal(store.update(id, { responseRaw: '第一段\n第二段', responseBody: { choices: [{ message: { content: '正文' } }] } }), true);
    assert.equal(store.finish(id, { status: 'complete' }), true);
    const snapshot = assertBounds(store), record = snapshot.records[0];
    assert.equal(record.id, id); assert.equal(record.request.messages[0].content, prompt);
    assert.equal(record.responseRaw, '第一段\n第二段'); assert.equal(record.responseBody.choices[0].message.content, '正文');
    assert.equal(record.status, 'complete'); assert.ok(Date.parse(record.startedAt)); assert.ok(Date.parse(record.endedAt));
    snapshot.records[0].request.messages[0].content = '不能反向修改';
    assert.equal(store.snapshot().records[0].request.messages[0].content, prompt);
    const exported = store.exportData(); assert.equal(exported.format, 'fish-memory-trace'); assert.equal(exported.version, 1); assert.ok(Date.parse(exported.exportedAt));
});

test('configuration secrets are excluded, routes stripped, prompt bodies remain opaque', () => {
    const store = createTraceStore();
    const content = { api_key: 'a fictional password in the story', token: 'a bronze token', headers: 'chapter heading' };
    store.start({ apiKey: 'secret-top', headers: { Authorization: 'Bearer secret-header' },
        endpoint: 'https://secret.example/path?key=secret-query', route: 'https://alice:secret-userinfo@example.test/v1/chat?key=secret-query#fragment',
        connection: { endpoint: 'https://alice:secret-userinfo@example.test/api?token=secret-query', password: 'secret-password', model: 'config-only' },
        request: { model: 'kept', max_tokens: 2048, api_key: 'secret-request', authorization: 'secret-auth', password: 'secret-password', proxy_password: 'secret-proxy',
            custom_include_headers: 'X-Api-Key: secret-custom', custom_include_body: '{"api_key":"secret-body"}', 'api-key': 'secret-hyphen', reverse_proxy: 'https://secret-proxy.test/path',
            nested: { access_token: 'secret-access', refreshToken: 'secret-refresh', client_secret: 'secret-client', token: 'secret-token', safe: 1 },
            messages: [{ role: 'user', content }] }, responseBody: { token: 'model output field must survive' } });
    const record = store.snapshot().records[0], text = JSON.stringify(record);
    assert.doesNotMatch(text, /secret-|alice/);
    assert.equal(record.route, 'https://example.test/v1/chat');
    assert.deepEqual(record.connection, { route: 'https://example.test/api' });
    assert.deepEqual(record.request.messages[0].content, content);
    assert.equal(record.responseBody.token, 'model output field must survive');
    assert.equal(record.request.max_tokens, 2048); assert.deepEqual(record.request.nested, { safe: 1 });
    assert.equal(record.truncated, undefined, 'intentional credential filtering is not prompt truncation');
    assertBounds(store);
});

test('record and total limits evict oldest entries while preserving start order', () => {
    const store = createTraceStore({ maxRecords: 2, maxChars: 1200, maxRecordChars: 800 });
    const first = store.start({ label: 'one', request: '甲'.repeat(200) });
    const second = store.start({ label: 'two', request: '乙'.repeat(200) });
    store.finish(first, { responseRaw: 'first done' });
    assert.deepEqual(store.snapshot().records.map(record => record.id), [first, second]);
    const third = store.start({ label: 'three', request: '丙'.repeat(200) });
    const snapshot = assertBounds(store, 800);
    assert.deepEqual(snapshot.records.map(record => record.id), [second, third]);
    assert.equal(snapshot.droppedRecords, 1); assert.equal(store.finish(first, { responseRaw: 'late' }), false);
    const tight = createTraceStore({ maxChars: 460, maxRecordChars: 400 });
    tight.start({ request: 'a'.repeat(150) }); tight.start({ request: 'b'.repeat(150) });
    assert.equal(assertBounds(tight, 500).records.length, 1);
});

test('oversized Unicode and escaped content stays bounded and explicitly reports truncation', () => {
    const store = createTraceStore({ maxRecordChars: 900, maxChars: 2000 });
    const id = store.start({ request: { messages: [{ content: '界🌙\u0000"\\'.repeat(5000) }] } });
    let snapshot = assertBounds(store, 900), record = snapshot.records[0];
    assert.equal(record.truncated, true); assert.ok(record.truncatedFields.includes('request'));
    assert.ok(record.request.messages[0].content.length < 5000);
    assert.equal(store.finish(id, { responseRaw: '回应'.repeat(5000) }), true);
    snapshot = assertBounds(store, 900); record = snapshot.records[0];
    assert.equal(record.status, 'complete'); assert.ok(record.endedAt); assert.equal(record.truncated, true);
    assert.ok(record.truncatedFields.includes('responseRaw'));
});

test('upstream response truncation remains explicit even when retained text fits store limits', () => {
    const store = createTraceStore(), id = store.start({ request: { messages: [{ content: '原始请求' }] } });
    store.finish(id, { responseRaw: '截断后的响应', responseBody: { text: '截断后的响应' }, truncated: true, truncatedFields: ['responseRaw'] });
    store.update(id, { label: '更新标签不会抹去截断标记' });
    const record = assertBounds(store).records[0];
    assert.equal(record.truncated, true); assert.deepEqual(record.truncatedFields, ['responseRaw']);
    assert.equal(record.responseRaw, '截断后的响应');
});

test('clear does not resurrect late finishes and retains subscriber error isolation', async () => {
    const store = createTraceStore(); let calls = 0;
    store.subscribe(() => { throw new Error('broken viewer'); });
    store.subscribe(async () => { throw new Error('broken async viewer'); });
    const unsubscribe = store.subscribe(() => calls++);
    const old = store.start({ label: 'before' }); store.clear();
    assert.equal(store.finish(old, { responseRaw: 'late completion' }), false);
    assert.equal(store.update(old, { error: 'late error' }), false);
    const current = store.start({ label: 'after' }); assert.notEqual(current, old);
    assert.equal(calls, 3); unsubscribe(); store.finish(current, { status: 'aborted' });
    assert.equal(calls, 3); assert.equal(store.snapshot().records[0].status, 'aborted');
    await new Promise(resolve => setImmediate(resolve));
    assertBounds(store);
});

test('circular data, accessors and thrown proxies cannot escape diagnostics', () => {
    const store = createTraceStore({ maxRecordChars: 1200 }), data = { safe: 'yes' }; data.self = data;
    Object.defineProperty(data, 'getter', { enumerable: true, get() { throw new Error('must never execute'); } });
    const id = store.start({ request: data });
    const evil = new Proxy({}, { ownKeys() { throw new Error('bad object'); } });
    assert.doesNotThrow(() => store.update(id, evil));
    assert.doesNotThrow(() => store.finish(id, { error: new Error('request failed') }));
    const record = assertBounds(store, 1200).records[0];
    assert.equal(record.status, 'error'); assert.equal(record.error.message, 'request failed');
    assert.equal(record.request.safe, 'yes'); assert.equal(record.request.self, '[Circular]'); assert.equal(record.truncated, true);
});

test('zero budgets drop records safely, long keys and many omitted fields cannot grow retained memory', () => {
    const disabled = createTraceStore({ maxRecords: 0, maxChars: 0 });
    const id = disabled.start({ request: 'anything' }); assert.equal(disabled.finish(id), false);
    assert.equal(assertBounds(disabled).droppedRecords, 1);
    const store = createTraceStore({ maxRecordChars: 800, maxChars: 800 });
    const patch = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`field${i}`, 'x'.repeat(900)]));
    patch['k'.repeat(10000)] = 'too long';
    store.start(patch);
    const record = assertBounds(store, 800).records[0];
    assert.equal(record.truncated, true); assert.ok(record.truncatedFields.length <= 8);
});
