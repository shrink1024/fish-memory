import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { createSave } from '../src/core/state.js';

const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const state = { chatId: 'old', bookName: 'book', templateEnabled: true, messages: [], userInput: '' };
    const gates = new Map(), reads = [], writes = [], saved = new Map();
    const host = { snapshot: () => structuredClone(state), loadWorldbook: async () => [], clearPlan() {}, applyWindow: async () => {},
        storage: { read: async id => { reads.push(id); if (gates.has(id)) await gates.get(id).promise; return structuredClone(saved.get(id) ?? null); },
            write: async (id, data) => { writes.push(id); saved.set(id, structuredClone(data)); } } };
    const controller = new Controller(host, { model: { complete: async () => ({ operations: [] }) } });
    return { state, gates, reads, writes, saved, controller };
}

test('committed barrier and setContext wait for current chat load instead of returning null or touching the previous save', async () => {
    const f = fixture(); await f.controller.start();
    const target = createSave('new', 'book'); target.initialized = true; target.data.summary = '目标档记忆'; target.base = structuredClone(target.data); f.saved.set('new', target);
    const loadingGate = gate(); f.gates.set('new', loadingGate); f.state.chatId = 'new';
    const loading = f.controller.chatChanged();
    let committed = false, scoped = false;
    const scope = f.controller.setContext({ owner: 'card', activeScopeId: 'world:new', deferPost: true }).then(result => { scoped = true; return result; });
    const barrier = f.controller.whenCommitted().then(result => { committed = true; return result; });
    await tick();
    assert.equal(committed, false); assert.equal(scoped, false); assert.deepEqual(f.writes, []);
    loadingGate.resolve(); await loading;
    const result = await scope, status = await barrier;
    assert.equal(result.chatId, 'new'); assert.equal(status.chatId, 'new'); assert.notEqual(status.revision, null);
    assert.equal(f.controller.store.state.data.summary, '目标档记忆');
    assert.equal(f.controller.store.state.data.scopeContext.activeScopeId, 'world:new');
    assert.deepEqual(f.writes, ['new']);
});

test('a card scope call before Fish CHAT_CHANGED starts joins one load with the host event', async () => {
    const f = fixture(); await f.controller.start();
    const loadingGate = gate(); f.gates.set('new', loadingGate); f.state.chatId = 'new';
    const scope = f.controller.setContext({ owner: 'card', activeScopeId: 'world:new', deferPost: true });
    const hostEvent = f.controller.chatChanged();
    await tick(); assert.equal(f.reads.filter(id => id === 'new').length, 1);
    loadingGate.resolve(); await Promise.all([scope, hostEvent]);
    assert.equal(f.controller.store.state.chatId, 'new');
    assert.equal(f.controller.store.state.data.scopeContext.activeScopeId, 'world:new');
});

test('switching again interrupts waiting scope and committed calls before old read completes and never publishes old store', async () => {
    const f = fixture(); await f.controller.start();
    const loadingGate = gate(); f.gates.set('waiting', loadingGate); f.state.chatId = 'waiting';
    const loading = f.controller.chatChanged(), barrier = f.controller.whenCommitted();
    const scope = f.controller.setContext({ owner: 'card', activeScopeId: 'world:old', deferPost: true });
    for (const promise of [loading, barrier, scope]) promise.catch(() => {});
    await tick(); f.state.chatId = 'latest'; await f.controller.chatChanged();
    for (const promise of [loading, barrier, scope]) await assert.rejects(promise, /切换|作废|取消/);
    assert.equal(f.controller.store.state.chatId, 'latest');
    assert.equal(f.controller.store.state.data.scopeContext, null);
    loadingGate.resolve(); await tick();
    assert.equal(f.controller.store.state.chatId, 'latest'); assert.deepEqual(f.writes, []);
});

test('page cancellation ends pending storage-load waits without waiting for the underlying storage provider', async () => {
    const f = fixture(); await f.controller.start();
    const loadingGate = gate(); f.gates.set('waiting', loadingGate); f.state.chatId = 'waiting';
    const loading = f.controller.chatChanged(), barrier = f.controller.whenCommitted();
    loading.catch(() => {}); barrier.catch(() => {});
    await tick(); f.controller.cancel('页面已关闭，辅助等待已结束');
    await assert.rejects(loading, /取消/); await assert.rejects(barrier, /取消/);
    loadingGate.resolve(); await tick();
    assert.equal(f.controller.store, null); assert.deepEqual(f.writes, []);
});

test('cancellation also releases a committed-barrier consumer during an accepted write without pretending to roll it back', async () => {
    const f = fixture(); await f.controller.start();
    const writing = gate(), originalWrite = f.controller.host.storage.write; let entered = false;
    f.controller.host.storage.write = async (...args) => { entered = true; await writing.promise; return originalWrite(...args); };
    const scope = f.controller.setContext({ owner: 'card', activeScopeId: 'world:accepted', deferPost: true });
    scope.catch(() => {}); await tick(); assert.equal(entered, true);
    const barrier = f.controller.whenCommitted(); barrier.catch(() => {}); await tick();
    f.controller.cancel('页面已关闭，辅助等待已结束');
    await assert.rejects(scope, /取消/); await assert.rejects(barrier, /取消/);
    writing.resolve(); await tick();
    assert.equal(f.saved.get('old').data.scopeContext.activeScopeId, 'world:accepted', 'an accepted atomic write is allowed to finish');
});

test('cancel immediately after a ready API call still invalidates that queued scope operation', async () => {
    const f = fixture(); await f.controller.start();
    const scope = f.controller.setContext({ owner: 'card', activeScopeId: 'world:cancelled', deferPost: true });
    const barrier = f.controller.whenCommitted();
    f.controller.cancel('页面已关闭，辅助等待已结束');
    await assert.rejects(scope, /取消|作废/); await assert.rejects(barrier, /取消|作废/);
    await tick(); assert.deepEqual(f.writes, []); assert.equal(f.controller.store.state.data.scopeContext, null);
});
