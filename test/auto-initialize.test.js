import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';
import { createSave } from '../src/core/state.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 40; i++) { if (check()) return; await tick(); } assert.fail('自动初始化没有到达预期阶段'); }
const classify = input => ({ strategy: '只记录已发生的事实', entries: input.entries.map(entry => ({
    id: entry.id, kind: 'fact', intro: entry.title, retrieveWhen: '相关时读取',
    segments: [{ id: 'body', text: entry.content, writable: true }],
})) });
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const message = (key, role = 'assistant') => ({ key, role, content: `剧情 ${key}`, hidden: false, hiddenBy: null });
function fixture({ enabled = true, handler } = {}) {
    const state = { chatId: 'new', bookName: 'main', templateEnabled: true, messages: [message('opening')], generating: false };
    const saved = new Map(), calls = [], plans = [], writes = [];
    let bookReady = true, connectionReady = true, failWrite = false;
    const host = { snapshot: () => structuredClone(state),
        loadWorldbook: async () => { if (!bookReady) throw new Error('书未加载'); return [{ uid: 1, comment: '城市', content: '现代地球' }]; },
        auxiliaryReadiness: () => ({ ready: connectionReady, reason: '模型未就绪' }),
        storage: { read: async id => structuredClone(saved.get(id) ?? null), write: async (id, value, revision) => {
            if (failWrite) throw new Error('disk failed');
            assert.equal(saved.get(id)?.revision ?? 0, revision); writes.push(id); saved.set(id, structuredClone(value));
        } }, clearPlan: () => plans.push(null), setPlan: plan => plans.push(plan), applyWindow: async () => {} };
    const model = { complete: async request => {
        calls.push({ purpose: request.purpose, input: structuredClone(request.input) });
        const result = await handler?.(request);
        return result ?? (request.purpose === 'initialize' ? classify(request.input) : { operations: [] });
    } };
    const make = () => new Controller(host, { model, settings: { enabled } });
    const controller = make();
    return { state, saved, calls, plans, writes, host, controller, make,
        setBookReady(value) { bookReady = value; }, setConnectionReady(value) { connectionReady = value; }, failWrites(value) { failWrite = value; } };
}

test('opening a new solo chat with Fish enabled starts initialization without opening its manager', async () => {
    const listeners = new Map(), calls = [];
    const events = { on(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list); },
        removeListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter(value => value !== fn)); } };
    const live = { chatId: 'new', characterId: 0, onlineStatus: 'ready', chatMetadata: {},
        characters: [{ name: '测试卡', avatar: 'test.png', data: { extensions: { world: 'main' } } }],
        chat: [{ mes: '你来到街口。', is_user: false, extra: {} }] };
    const oldTemplate = globalThis.EjsTemplate;
    globalThis.EjsTemplate = { getFeatures: () => ({ enabled: true }) };
    let dispose;
    try {
        const host = await createSillyTavernHost({ context: () => live, eventSource: events, eventTypes: { CHAT_CHANGED: 'chat' },
            script: { setExtensionPrompt() {} }, extensions: { findExtension: () => ({ enabled: true }) }, save: async () => {},
            worldInfo: { loadWorldInfo: async () => ({ entries: { 1: { uid: 1, comment: '城市', content: '现代地球' } } }) } });
        const controller = new Controller(host, { settings: { enabled: true }, model: { complete: async request => {
            calls.push(request.purpose);
            return request.purpose === 'initialize' ? classify(request.input) : { operations: [] };
        } } });
        dispose = host.bindController(controller);
        await controller.start();
        for (const listener of listeners.get('chat') ?? []) await listener();
        await until(() => controller.store?.state.initialized);
        assert.deepEqual(calls, ['initialize', 'maintain']);
        assert.equal(live.chatMetadata.dwm.initialized, true);
    } finally { dispose?.(); globalThis.EjsTemplate = oldTemplate; }
});

test('duplicate readiness and chat events share one scan and refresh keeps the completed save', async () => {
    const pending = gate();
    const f = fixture({ handler: request => request.purpose === 'initialize' ? pending.promise : undefined });
    await f.controller.start();
    const first = f.controller.readinessChanged();
    await until(() => f.calls.length === 1);
    for (let i = 0; i < 5; i++) { await f.controller.chatChanged(); assert.equal(f.controller.readinessChanged(), first); }
    pending.resolve(classify(f.calls[0].input)); await first;
    assert.equal(f.controller.store.state.initialized, true);
    const refreshed = f.make(); await refreshed.start(); await refreshed.readinessChanged();
    assert.equal(f.calls.filter(call => call.purpose === 'initialize').length, 1);
    assert.equal(refreshed.store.state.initialized, true);
});

test('global and current-save opt-out, progressed chats and inherited memory never auto-scan', async () => {
    for (const variant of ['global-off', 'save-off', 'old', 'branch', 'uninitialized-branch']) {
        const f = fixture({ enabled: variant !== 'global-off' });
        if (variant === 'old') f.state.messages.push(message('player', 'user'), message('reply'));
        if (['save-off', 'branch', 'uninitialized-branch'].includes(variant)) {
            const save = createSave(variant.includes('branch') ? 'parent' : 'new', 'main');
            save.initialized = variant === 'branch'; save.preferences.enabled = variant !== 'save-off';
            f.saved.set('new', save);
        }
        await f.controller.start(); await f.controller.readinessChanged();
        assert.equal(f.calls.length, 0, variant);
    }
});

test('missing model, template and book wait without spending an attempt and recover on readiness', async () => {
    for (const variant of ['model', 'template', 'book', 'opening']) {
        const f = fixture();
        if (variant === 'book') f.setBookReady(false);
        if (variant === 'template') f.state.templateEnabled = false;
        if (variant === 'opening') f.state.messages = [];
        if (variant === 'model') { f.controller.connectionMode = 'raw'; f.setConnectionReady(false); }
        await f.controller.start(); await f.controller.readinessChanged();
        assert.equal(f.calls.length, 0); assert.equal(f.saved.size, 0);
        assert.equal(f.controller.view().initialization.state, 'waiting');
        f.setBookReady(true); f.state.templateEnabled = true; f.state.messages = [message('opening')]; f.setConnectionReady(true);
        await f.controller.readinessChanged();
        assert.equal(f.controller.store.state.initialized, true, variant);
    }
});

test('failed and stopped automatic scans persist a retry boundary across refresh; manual retry works', async () => {
    for (const mode of ['fail', 'stop']) {
        const pending = gate(); let fail = mode === 'fail';
        const f = fixture({ handler: request => {
            if (request.purpose !== 'initialize') return;
            if (fail) throw new Error('model failed');
            if (mode === 'stop') return pending.promise;
        } });
        await f.controller.start(); const attempt = f.controller.readinessChanged();
        await until(() => f.calls.length === 1);
        if (mode === 'stop') await f.controller.requestStop();
        await attempt;
        assert.equal(f.controller.store.state.initialized, false);
        assert.ok(f.saved.get('new').preferences.autoInitialization);
        const refreshed = f.make(); await refreshed.start();
        for (let i = 0; i < 4; i++) await refreshed.readinessChanged();
        assert.equal(f.calls.length, 1); assert.equal(refreshed.view().initialization.retry, true);
        fail = false; pending.resolve(classify(f.calls[0].input));
        await refreshed.initialize();
        assert.equal(refreshed.store.state.initialized, true);
        assert.equal(f.saved.get('new').preferences.autoInitialization, undefined);
        assert.equal(refreshed.view().initialization, null);
        await refreshed.readinessChanged(); assert.equal(f.calls.filter(call => call.purpose === 'initialize').length, 2);
    }
});

test('adapter readiness distinguishes unavailable books and offline model connections without generating', async () => {
    const live = { onlineStatus: 'no_connection', generateRaw: () => { throw new Error('readiness must never generate'); } };
    const host = await createSillyTavernHost({ context: () => live, script: {}, extensions: {}, worldInfo: { loadWorldInfo: async () => null } });
    assert.equal(host.auxiliaryReadiness().ready, false);
    live.onlineStatus = 'ready'; assert.equal(host.auxiliaryReadiness().ready, true);
    delete live.generateRaw; assert.equal(host.auxiliaryReadiness().ready, false);
    await assert.rejects(host.loadWorldbook('missing'), /尚未加载/);
});

test('adapter readiness listeners do not await model work or leak after disposal', async () => {
    const listeners = new Map(); let checks = 0;
    const source = { on: (type, fn) => listeners.set(type, fn), removeListener: type => listeners.delete(type) };
    const host = await createSillyTavernHost({ context: () => ({}), script: { setExtensionPrompt() {} }, extensions: {}, worldInfo: {},
        eventSource: source, eventTypes: { ONLINE_STATUS_CHANGED: 'online', WORLDINFO_UPDATED: 'book', CHARACTER_MESSAGE_RENDERED: 'render' } });
    const dispose = host.bindController({ readinessChanged: () => { checks++; return new Promise(() => {}); } });
    await listeners.get('online')(); await listeners.get('book')();
    await listeners.get('render')(0, 'first_message'); await listeners.get('render')(2, 'normal');
    assert.equal(checks, 3); dispose(); assert.equal(listeners.size, 0);
});

test('an attempt-marker write failure sends no model request and does not spin on further readiness events', async () => {
    const f = fixture(); f.failWrites(true); await f.controller.start();
    await f.controller.readinessChanged(); await f.controller.readinessChanged();
    assert.equal(f.calls.length, 0); assert.equal(f.controller.view().initialization.retry, true);
    f.failWrites(false); await f.controller.initialize(); assert.equal(f.controller.store.state.initialized, true);
});

test('late scan results cannot initialize a different chat and a new eligible chat can initialize normally', async () => {
    const pending = gate(); let first = true;
    const f = fixture({ handler: request => { if (request.purpose === 'initialize' && first) { first = false; return pending.promise; } } });
    await f.controller.start(); const old = f.controller.readinessChanged(); await until(() => f.calls.length === 1);
    f.state.chatId = 'next'; await f.controller.chatChanged(); await f.controller.readinessChanged();
    pending.resolve(classify(f.calls[0].input)); await old;
    assert.equal(f.saved.get('new').initialized, false); assert.equal(f.saved.get('next').initialized, true);
    assert.equal(f.controller.store.state.chatId, 'next');
});

test('disabling the master or current save during a scan revokes its late result', async () => {
    for (const mode of ['master', 'save']) {
        const pending = gate(); const f = fixture({ handler: request => request.purpose === 'initialize' ? pending.promise : undefined });
        await f.controller.start(); const running = f.controller.readinessChanged(); await until(() => f.calls.length === 1);
        if (mode === 'master') await f.controller.updateSettings({ enabled: false }); else await f.controller.setSaveEnabled(false);
        pending.resolve(classify(f.calls[0].input)); await running;
        assert.equal(f.controller.store.state.initialized, false); assert.equal(f.controller.view().enabled, false);
    }
});

test('a card can prepare and commit a first turn while initialization bypasses and then catches up with correct scopes', async () => {
    const pending = gate(); const f = fixture({ handler: request => request.purpose === 'initialize' ? pending.promise : undefined });
    await f.controller.start();
    await f.controller.setContext({ owner: 'card', activeScopeId: 'source', deferPost: false });
    const running = f.controller.readinessChanged(); await until(() => f.calls.length === 1);
    await f.controller.setContext({ owner: 'card', activeScopeId: 'source', requestedScopeIds: ['world:one'], deferPost: true });
    f.state.generating = true; await f.controller.generationBefore({ type: 'normal' });
    assert.equal(f.plans.at(-1), null); assert.match(f.controller.status, /本轮使用原生/);
    f.state.messages.push(message('player', 'user'), message('reply'));
    pending.resolve(classify(f.calls[0].input));
    await until(() => /等待本轮/.test(f.controller.view().activity?.label ?? ''));
    assert.equal(f.controller.store.state.initialized, false);
    f.state.generating = false;
    await f.controller.setContext({ owner: 'card', activeScopeId: 'world:one', postScopeId: 'source', deferPost: false });
    await f.controller.generationEnded(); await running;
    assert.equal(f.controller.store.state.initialized, true);
    assert.equal(f.controller.store.state.processed.length, 3);
    assert.deepEqual(f.controller.store.state.data.messageScopes, { opening: 'global', player: 'source', reply: 'source' });
    assert.equal(f.controller.store.state.data.scopeContext.activeScopeId, 'world:one');
    assert.equal(f.calls.filter(call => call.purpose === 'initialize').length, 1);
    assert.equal(f.calls.some(call => call.purpose === 'select'), false);
});

test('scope updates during an in-flight history batch rebuild only the draft and cannot commit stale attribution', async () => {
    const pending = gate(); let firstHistory = true;
    const f = fixture({ handler: request => {
        if (request.purpose === 'maintain' && firstHistory) { firstHistory = false; return pending.promise; }
    } });
    await f.controller.start(); const running = f.controller.readinessChanged();
    await until(() => f.calls.some(call => call.purpose === 'maintain'));
    await f.controller.setContext({ owner: 'card', activeScopeId: 'source', deferPost: true });
    f.state.messages.push(message('player', 'user'), message('reply'));
    await f.controller.setContext({ owner: 'card', activeScopeId: 'world:two', postScopeId: 'source', deferPost: false });
    pending.resolve({ operations: [{ type: 'summary', text: '过期批次不得保存' }] }); await running;
    assert.equal(f.controller.store.state.initialized, true);
    assert.equal(f.controller.store.state.data.scopeContext.activeScopeId, 'world:two');
    assert.equal(f.controller.store.state.processed.length, 3);
    assert.equal(JSON.stringify(f.saved.get('new')).includes('过期批次不得保存'), false);
    assert.equal(f.calls.filter(call => call.purpose === 'initialize').length, 1);
    assert.equal(f.controller.store.state.data.messageScopes.reply, 'source');
});

test('ordinary cards also wait for a native generation to finish before remembering its selected reply', async () => {
    const pending = gate(); const f = fixture({ handler: request => request.purpose === 'initialize' ? pending.promise : undefined });
    await f.controller.start(); const running = f.controller.readinessChanged(); await until(() => f.calls.length === 1);
    f.state.generating = true; f.state.messages.push(message('player', 'user'));
    await f.controller.generationBefore({ type: 'normal' }); pending.resolve(classify(f.calls[0].input));
    await until(() => /等待本轮/.test(f.controller.view().activity?.label ?? ''));
    assert.equal(f.calls.some(call => call.purpose === 'maintain'), false);
    f.state.messages.push(message('reply')); f.state.generating = false;
    await f.controller.generationEnded(); await running;
    assert.equal(f.controller.store.state.processed.length, 3);
    assert.equal(f.plans.every(plan => plan === null), true);
});
