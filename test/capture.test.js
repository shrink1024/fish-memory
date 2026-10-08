import test from 'node:test';
import assert from 'node:assert/strict';
import { installCapture, modelRoute, decodeResponse } from '../src/diagnostics/capture.js';
import { createTraceStore } from '../src/diagnostics/trace-store.js';
const route = '/api/backends/chat-completions/generate';
const body = (text = 'hello') => ({ method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: text }], stream: false }) });
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
function setup(fetch, options = {}) {
    const target = { fetch, location: { href: 'http://localhost:4192/' } }, store = createTraceStore();
    const capture = installCapture({ target, store, ...options });
    return { target, store, capture };
}

test('captures actual final body, response, metadata; original fetch receives identical inputs', async () => {
    let received; const response = new Response('{"choices":[{"message":{"content":"实际回复"}}]}');
    const f = setup((...args) => { received = args; return Promise.resolve(response); }, { context: () => ({ chatId: 'branch-b' }) });
    const init = body('插件加工后的实际文本');
    assert.equal(await f.target.fetch(route, init), response);
    assert.equal(received[1], init);
    await tick(); const record = f.store.snapshot().records[0];
    assert.equal(record.request.messages[0].content, '插件加工后的实际文本');
    assert.equal(record.responseBody.choices[0].message.content, '实际回复');
    assert.equal(record.context.chatId, 'branch-b'); assert.equal(record.status, 'complete');
    assert.equal(await response.text(), record.responseRaw); f.capture.dispose();
});

test('ordinary requests and nonmodel POST are neither read nor logged', async () => {
    const f = setup(async () => new Response('fine'));
    await f.target.fetch('/api/chats/save', body());
    await f.target.fetch('/api/backends/chat-completions/status', body());
    await f.target.fetch('https://other.example/chat/completions', { method: 'POST', body: '{"check":true}' });
    assert.equal(f.store.snapshot().records.length, 0); f.capture.dispose();
});

test('parallel requests keep source and replies matched by exact content, not last event', async () => {
    const resolvers = [];
    const f = setup(() => new Promise(resolve => resolvers.push(resolve)));
    const a = f.capture.register({ purpose: 'select', system: 'system A', input: 'input A' });
    const b = f.capture.register({ purpose: 'maintain', system: 'system B', input: 'input B' });
    const first = f.target.fetch(route, body('system A\ninput A'));
    const second = f.target.fetch(route, body('system B\ninput B'));
    resolvers[1](new Response('"B"')); await second;
    resolvers[0](new Response('"A"')); await first; await tick();
    a.end(new Error('后续解析失败')); b.end();
    const records = f.store.snapshot().records;
    assert.deepEqual(records.map(r => [r.label, r.responseBody]), [['前置选材', 'A'], ['后置维护', 'B']]);
    assert.match(records[0].processingError, /解析失败/); f.capture.dispose();
});

test('ambiguous equal requests stay unlabelled instead of borrowing a concurrent source', async () => {
    const f = setup(async () => new Response('{}'));
    f.capture.register({ label: 'A', source: 'one', system: 's', input: 'i' });
    f.capture.register({ label: 'B', source: 'two', system: 's', input: 'i' });
    await f.target.fetch(route, body('s\ni')); await tick();
    assert.equal(f.store.snapshot().records[0].source, '来源未确认'); f.capture.dispose();
});

test('streams return immediately; split UTF8 and SSE chunks are read only from clone', async () => {
    let send; const enc = new TextEncoder();
    const stream = new ReadableStream({ start(controller) { send = controller; } });
    const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    const f = setup(async () => response); const returned = await f.target.fetch(route, body());
    assert.equal(returned, response); assert.equal(f.store.snapshot().records[0].status, 'pending');
    const raw = 'data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = enc.encode(raw); for (let i = 0; i < bytes.length; i += 3) send.enqueue(bytes.slice(i, i + 3)); send.close();
    assert.equal(await returned.text(), raw); await tick();
    const record = f.store.snapshot().records[0];
    assert.equal(record.responseRaw, raw); assert.equal(record.responseBody.messages[0].content, '你好'); f.capture.dispose();
});

test('decode retains candidate separation, reasoning, tool deltas, malformed and error events', () => {
    const data = decodeResponse('data: {"choices":[{"index":1,"delta":{"content":"B"}},{"index":0,"delta":{"content":"A","reasoning_content":"思考","tool_calls":[{"id":"t"}]}}]}\n\ndata: broken\n\ndata: {"error":"失败"}\n\ndata: [DONE]\n\n');
    assert.equal(data.messages.find(m => m.index === 0).reasoning, '思考');
    assert.equal(data.messages.find(m => m.index === 1).content, 'B');
    assert.equal(data.messages.find(m => m.index === 0).tool_calls[0].id, 't');
    assert.equal(data.malformedEvents, 1); assert.equal(data.done, true); assert.deepEqual(data.errors, ['失败']);
});

test('partial stream failures retain text; rejected and HTTP requests are recorded', async () => {
    const f = setup(async () => { throw new DOMException('stopped', 'AbortError'); });
    await assert.rejects(f.target.fetch(route, body()));
    assert.equal(f.store.snapshot().records[0].status, 'aborted'); f.capture.dispose();
    const g = setup(async () => new Response('bad gateway', { status: 502 }));
    await g.target.fetch(route, body()); await tick();
    assert.equal(g.store.snapshot().records[0].status, 'error'); assert.equal(g.store.snapshot().records[0].responseRaw, 'bad gateway'); g.capture.dispose();
});

test('capture cap never truncates actual response; clear does not revive in-flight logs', async () => {
    const f = setup(async () => new Response('1234567890'), { maxResponseChars: 5 });
    const response = await f.target.fetch(route, body()); await tick();
    assert.equal(await response.text(), '1234567890');
    assert.equal(f.store.snapshot().records[0].responseRaw, '12345'); assert.equal(f.store.snapshot().records[0].truncated, true);
    f.capture.dispose();
    let resolve; const g = setup(() => new Promise(r => { resolve = r; }));
    const pending = g.target.fetch(route, body()); g.store.clear(); resolve(new Response('{}')); await pending; await tick();
    assert.equal(g.store.snapshot().records.length, 0); g.capture.dispose();
});

test('only exact source snippets already present in final prompt are recorded', async () => {
    const f = setup(async () => new Response('{}'), { provenance: () => [{ title: 'yes', text: '实际发送的世界书正文' }, { title: 'no', text: '没有发送的私有模板文本' }] });
    await f.target.fetch(route, body('规则：实际发送的世界书正文。')); await tick();
    assert.deepEqual(f.store.snapshot().records[0].provenance.map(p => p.title), ['yes']); f.capture.dispose();
});

test('supports Request input and uninstall leaves newer fetch wrappers intact', async () => {
    const original = async () => new Response('{}'), f = setup(original);
    await f.target.fetch(new Request('http://localhost:4192' + route, body())); await tick();
    assert.equal(f.store.snapshot().records[0].request.messages[0].content, 'hello');
    const otherWrapper = f.target.fetch.bind(f.target); f.target.fetch = otherWrapper; f.capture.dispose();
    assert.equal(f.target.fetch, otherWrapper);
});

test('capture diagnostics exceptions cannot prevent actual generation', async () => {
    let called = 0; const target = { fetch: async () => { called++; return new Response('ok'); } };
    const capture = installCapture({ target, store: { start() { throw Error('broken UI'); } }, context: () => { throw Error('broken context'); } });
    assert.equal(await (await target.fetch(route, body())).text(), 'ok'); assert.equal(called, 1); capture.dispose();
});

test('routes include supported ST backends and direct compatible endpoints; ignore credential query', () => {
    assert.equal(modelRoute('/api/backends/text-completions/generate').transport, 'browser-st');
    assert.equal(modelRoute('https://x.example/v1/chat/completions?key=secret').route, '/v1/chat/completions');
    assert.equal(modelRoute('/api/chats/save'), null);
});

test('malformed model messages never block transport and invalid JSON configuration is not retained', async () => {
    let called = 0;
    const f = setup(async () => { called++; return new Response('bad', { status: 400 }); });
    await f.target.fetch(route, { method: 'POST', body: '{"messages":[null]}' });
    await f.target.fetch(route, { method: 'POST', body: '{"api_key":"VERY_SECRET", broken}' });
    await tick(); assert.equal(called, 2);
    assert.doesNotMatch(JSON.stringify(f.store.exportData()), /VERY_SECRET/); f.capture.dispose();
});

test('unusual rejection identity and explicit replacement body are preserved', async () => {
    const f = setup(() => Promise.reject(null));
    let rejected = false;
    try { await f.target.fetch(route, body()); } catch (error) { rejected = true; assert.equal(error, null); }
    assert.equal(rejected, true); f.capture.dispose();
    const g = setup(async () => new Response('{}'));
    await g.target.fetch(new Request('http://localhost:4192' + route, body('OLD_BODY_MUST_NOT_APPEAR')), { method: 'POST', body: new Blob(['{}']) });
    await tick(); assert.doesNotMatch(JSON.stringify(g.store.exportData()), /OLD_BODY_MUST_NOT_APPEAR/);
    assert.match(g.store.snapshot().records[0].request.captureError, /未读取/); g.capture.dispose();
});

test('bounded Request clone does not buffer entire upload into the log', async () => {
    const f = setup(async () => new Response('{}'), { maxResponseChars: 30 });
    await f.target.fetch(new Request('http://localhost:4192' + route, body('x'.repeat(300)))); await tick();
    const record = f.store.snapshot().records[0];
    assert.equal(record.truncated, true); assert.match(record.request.captureError, /超过读取上限/); f.capture.dispose();
});

test('provider SSE formats retain visible and returned reasoning text without inventing data', () => {
    const claude = decodeResponse('event: content_block_delta\ndata: {"delta":{"text":"正文","thinking":"已返回推理"}}\n\ndata: {"type":"message_stop"}\n\n');
    assert.equal(claude.messages[0].content, '正文'); assert.equal(claude.messages[0].reasoning, '已返回推理');
    const gemini = decodeResponse('data: {"candidates":[{"content":{"parts":[{"text":"推理","thought":true},{"text":"正文"}]}}]}\n\n');
    assert.equal(gemini.messages[0].content, '正文'); assert.equal(gemini.messages[0].reasoning, '推理');
});
