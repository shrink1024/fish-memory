import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { installCapture } from '../src/diagnostics/capture.js';
import { createTraceStore } from '../src/diagnostics/trace-store.js';
import { serializeAgentInput } from '../src/agents/client.js';
import { alignStrategy, compact, select } from '../src/agents/tasks.js';
import { createSave } from '../src/core/state.js';

const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(predicate) {
    for (let i = 0; i < 50; i++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Expected asynchronous diagnostic stage was not reached');
}

function fixture({ captured = false, answer = () => ({ value: 'synthetic response' }) } = {}) {
    const traces = createTraceStore(), saved = new Map();
    const snapshot = { chatId: 'validation-chat', bookName: 'validation-book', templateEnabled: true, messages: [], userInput: '' };
    const host = {
        snapshot: () => clone(snapshot), readPreset: () => ({ name: '合成预设', entries: [{ id: 'language', content: '使用简体中文' }] }),
        loadWorldbook: async () => [{ uid: 1, comment: '合成条目', content: '必须完整保留的原文' }],
        clearPlan() {}, setPlan() {}, applyWindow: async () => {},
        storage: { read: async id => clone(saved.get(id) ?? null), write: async (id, value) => saved.set(id, clone(value)) },
    };
    let nextReply;
    const target = { location: { href: 'http://synthetic.invalid/' }, fetch: async () => new Response(JSON.stringify(nextReply), { headers: { 'content-type': 'application/json' } }) };
    if (captured) host.traceCapture = installCapture({ target, store: traces, context: () => ({ chatId: snapshot.chatId }) });
    const model = { complete: async request => {
        const reply = await answer(request);
        if (!captured) return reply;
        nextReply = reply;
        const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ messages: [
            { role: 'system', content: request.system }, { role: 'user', content: serializeAgentInput(request.input) },
        ] }) });
        return response.json();
    } };
    return { controller: new Controller(host, { model, traces }), traces, host, snapshot };
}

for (const captured of [false, true]) test(`Controller initialization records rejected classification and raw response (${captured ? 'captured' : 'fallback'})`, async t => {
    const raw = { entries: [] };
    const f = fixture({ captured, answer: () => raw });
    t.after(() => f.host.traceCapture?.dispose());
    await f.controller.start();
    await assert.rejects(f.controller.initialize(), /完整覆盖/);
    await until(() => f.traces.snapshot().records[0]?.status !== 'pending');
    const record = f.traces.snapshot().records[0], metric = f.controller.diagnostics.requests.at(-1);
    assert.equal(record.source, '鱼忆'); assert.equal(record.label, '扫描世界书');
    assert.match(record.processingError ?? '', /完整覆盖/);
    assert.equal(record.processingOutcome, 'error');
    assert.deepEqual(record.responseBody, raw);
    assert.equal(metric.ok, false); assert.match(metric.error, /完整覆盖/);
    assert.equal(metric.outputChars, JSON.stringify(raw).length);
    assert.equal(f.controller.store.state.initialized, false);
});

test('completed initialization calls out saved entries that need player review', async () => {
    const f = fixture({ answer: request => ({ entries: request.input.entries.map(entry => ({
        id: entry.id, kind: 'fact', intro: '合成简介', needsReview: true,
        segments: [{ id: 'body', text: entry.content, writable: false }],
    })) }) });
    await f.controller.start();
    const result = await f.controller.initialize();
    assert.equal(result.executed, true);
    assert.match(result.message, /其中 1 条待核对，请在“资料”查看/);
    assert.equal(f.controller.store.state.initialized, true);
});

test('Controller preset scan records candidate validation failures in request diagnostics', async () => {
    const f = fixture({ answer: () => ({ preferences: Array(33).fill({}) }) });
    await f.controller.start();
    await assert.rejects(f.controller.scanPreset(), /格式无效/);
    const record = f.traces.snapshot().records[0], metric = f.controller.diagnostics.requests.at(-1);
    assert.match(record.processingError ?? '', /格式无效/);
    assert.equal(metric.ok, false); assert.equal(f.controller.view().preset.draft, null);
});

for (const { task, reply, error, run } of [
    { task: 'strategy', reply: { strategy: 7 }, error: /记忆策略/, run: client => alignStrategy(client, ['策略甲', '策略乙'], [], '') },
    { task: 'select', reply: { ids: ['unavailable-entry'] }, error: /不允许的资料/, run: client => select(client, createSave('synthetic', 'world'), []) },
    { task: 'compact', reply: { operations: [{ type: 'inventory', items: [] }] }, error: /整理只能更新/, run: client => compact(client, createSave('synthetic', 'world')) },
]) test(`${task} task validation remains inside the Controller request diagnostics`, async () => {
    const f = fixture({ answer: () => clone(reply) });
    await assert.rejects(run(f.controller.client), error);
    const record = f.traces.snapshot().records[0], metric = f.controller.diagnostics.requests[0];
    assert.match(record.processingError ?? '', error);
    assert.deepEqual(record.responseBody, reply);
    assert.equal(metric.task, task); assert.equal(metric.ok, false);
});

const requestFor = purpose => ({ purpose, system: `synthetic ${purpose} task`, input: { marker: purpose } });

test('validated completion awaits acceptance and returns its projection while preserving raw diagnostics', async () => {
    const raw = { value: 'original model response' }, f = fixture({ answer: () => raw });
    assert.equal(await f.controller.client.complete(requestFor('maintain')), raw, 'ordinary completion keeps its original return value');
    const entered = deferred(), release = deferred();
    const pending = f.controller.client.completeValidated(requestFor('select'), async result => {
        entered.resolve(); await release.promise;
        return { accepted: result.value };
    });
    await entered.promise;
    assert.equal(f.controller.diagnostics.requests.length, 1, 'validation has not finished the request metric');
    assert.equal(f.traces.snapshot().records.at(-1).status, 'pending');
    release.resolve();
    assert.deepEqual(await pending, { accepted: raw.value });
    const record = f.traces.snapshot().records.at(-1), metric = f.controller.diagnostics.requests.at(-1);
    assert.deepEqual(record.responseBody, raw); assert.equal(record.status, 'complete');
    assert.equal(metric.ok, true); assert.equal(metric.outputChars, JSON.stringify(raw).length);
});

test('asynchronous validation rejection stays in the same request trace and metric', async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    const pending = f.controller.client.completeValidated(requestFor('select'), async () => {
        entered.resolve(); await release.promise; throw new Error('synthetic acceptance rejected');
    });
    const rejected = assert.rejects(pending, /acceptance rejected/);
    await entered.promise; release.resolve(); await rejected;
    assert.equal(f.traces.snapshot().records.length, 1);
    const record = f.traces.snapshot().records[0], metric = f.controller.diagnostics.requests[0];
    assert.match(record.processingError, /acceptance rejected/);
    assert.deepEqual(record.responseBody, { value: 'synthetic response' });
    assert.equal(metric.ok, false); assert.equal(metric.outcome, 'error');
});

for (const captured of [false, true]) test(`clearing during validation cannot resurrect a late result (${captured ? 'captured' : 'fallback'})`, async t => {
    const f = fixture({ captured }); t.after(() => f.host.traceCapture?.dispose());
    for (const fail of [false, true]) {
        const entered = deferred(), release = deferred();
        const pending = f.controller.client.completeValidated(requestFor('select'), async value => {
            entered.resolve(); await release.promise;
            if (fail) throw new Error('late rejected result');
            return value;
        });
        const settled = fail ? assert.rejects(pending, /late rejected/) : pending;
        await entered.promise; f.traces.clear(); release.resolve(); await settled;
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.traces.snapshot().records, []);
    }
});

test('stopping during validation rejects promptly and a late acceptance cannot change the cancelled outcome', async () => {
    const f = fixture(), entered = deferred(), release = deferred(), abort = new AbortController();
    const pending = f.controller.client.completeValidated({ ...requestFor('select'), signal: abort.signal }, async value => {
        entered.resolve(); await release.promise; return value;
    });
    const stopped = assert.rejects(pending, /synthetic stop/);
    await entered.promise;
    abort.abort(Object.assign(new Error('synthetic stop'), { name: 'AbortError', dwmCancelled: true }));
    await stopped; release.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.controller.diagnostics.requests.length, 1);
    assert.equal(f.controller.diagnostics.requests[0].ok, false);
    assert.equal(f.controller.diagnostics.requests[0].outcome, 'stopped');
    assert.equal(f.traces.snapshot().records[0].status, 'aborted');
    assert.equal(f.traces.snapshot().records[0].processingOutcome, 'stopped');
});

test('concurrent captured completions attach validation failures only to their matching source request', async t => {
    const f = fixture({ captured: true, answer: request => ({ marker: request.purpose }) });
    t.after(() => f.host.traceCapture.dispose());
    const entered = deferred(), release = deferred();
    const first = f.controller.client.completeValidated(requestFor('select'), async () => {
        entered.resolve(); await release.promise; throw new Error('selection rejected only');
    });
    const rejected = assert.rejects(first, /selection rejected only/);
    await entered.promise;
    assert.deepEqual(await f.controller.client.completeValidated(requestFor('compact'), value => value), { marker: 'compact' });
    release.resolve(); await rejected;
    await until(() => f.traces.snapshot().records.every(record => record.status !== 'pending'));
    const records = f.traces.snapshot().records;
    assert.deepEqual(records.map(record => [record.source, record.label, record.responseBody.marker]), [
        ['鱼忆', '前置选材', 'select'], ['鱼忆', '整理事件', 'compact'],
    ]);
    assert.match(records[0].processingError, /selection rejected only/);
    assert.equal(records[1].processingError, undefined);
    assert.deepEqual(f.controller.diagnostics.requests.map(metric => [metric.task, metric.ok]), [['compact', true], ['select', false]]);
});
