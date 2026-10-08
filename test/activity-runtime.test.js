import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';

const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    for (let count = 0; count < 30; count++) { if (predicate()) return; await tick(); }
    assert.fail('Task did not reach expected phase');
}
const message = (key, role = 'assistant') => ({ key, role, content: `正文-${key}`, hidden: false, hiddenBy: null });
function classification(input) {
    return { strategy: `策略-${input.entries[0]?.id}`, entries: input.entries.map(entry => ({ id: entry.id, kind: 'fact',
        intro: entry.title, retrieveWhen: '相关时读取', segments: [{ id: 'body', text: entry.content, writable: true }] })) };
}
function fixture({ raw = false, handler, book, messages = [], settings = {} } = {}) {
    const state = { chatId: 'activity-chat', bookName: 'main', templateEnabled: true, messages, userInput: '' };
    const calls = [], plans = [], saved = new Map();
    let stops = 0, writeGate = null;
    const host = {
        snapshot: () => structuredClone(state), eligible: entry => entry.enabled !== false,
        loadWorldbook: async () => book ?? [{ uid: 1, comment: '世界', content: '既定事实', constant: true }],
        clearPlan: () => plans.push(null), setPlan: plan => plans.push(structuredClone(plan)), applyWindow: async () => {},
        stopGeneration: () => { stops++; },
        storage: { read: async id => structuredClone(saved.get(id) ?? null), write: async (id, value) => {
            if (writeGate) await writeGate.promise;
            saved.set(id, structuredClone(value));
        } },
    };
    const complete = async request => {
        calls.push(request);
        const result = await handler?.(request);
        if (result !== undefined) return result;
        if (request.purpose === 'initialize') return classification(request.input);
        if (request.purpose === 'strategy') return { strategy: '统合策略' };
        if (request.purpose === 'select') return { ids: [] };
        return { operations: [] };
    };
    host.rawGenerate = async request => JSON.stringify(await complete({ ...request, input: JSON.parse(request.input) }));
    const controller = new Controller(host, { ...(raw ? {} : { model: { complete } }),
        settings: { enabled: true, maintenanceEvery: 1, timeoutMs: 10000, ...settings } });
    return { controller, state, host, calls, plans, saved, get stops() { return stops; }, holdWrite(value) { writeGate = value; } };
}
async function ready(options) { const f = fixture(options); await f.controller.start(); await f.controller.initialize(); return f; }

test('initialization reports book batches, strategy, historical scan and final save without exposing content', async () => {
    const f = fixture({ book: [{ uid: 1, comment: '一', content: '甲' }, { uid: 2, comment: '二', content: '乙' }],
        messages: [message('history')], settings: { batchChars: 1 } });
    const states = [];
    f.controller.subscribe(view => { if (view.activity) states.push(view.activity); });
    await f.controller.start(); await f.controller.initialize();
    assert.ok(states.some(activity => /读取角色世界书/.test(activity.label)));
    assert.ok(states.some(activity => /扫描世界书 2\/2/.test(activity.label)));
    assert.ok(states.some(activity => /统合记忆策略/.test(activity.label)));
    assert.ok(states.some(activity => /扫描历史剧情/.test(activity.label)));
    assert.ok(states.some(activity => /保存/.test(activity.label) && activity.cancellable === false));
    assert.ok(states.every(activity => activity.kind === 'initialize' && Number.isFinite(activity.startedAt)));
    assert.doesNotMatch(JSON.stringify(states), /既定事实|正文-history|segments|signal|abort/);
    assert.equal(f.controller.view().activity, null);
    assert.deepEqual(f.controller.view().activities, []);
});

test('stopping initialization while reading discards late book data and does not broadcast native stop', async () => {
    const f = fixture({ raw: true }); await f.controller.start();
    const reading = gate(); f.host.loadWorldbook = () => reading.promise;
    const initializing = f.controller.initialize(); initializing.catch(() => {});
    const activity = f.controller.view().activity;
    assert.equal(activity.kind, 'initialize');
    assert.match(activity.hint, /已发给酒馆的请求可能继续/);
    assert.deepEqual(await f.controller.requestStop(activity.id), { stopped: true });
    await assert.rejects(initializing, /用户已停止/);
    reading.resolve([{ uid: 99, comment: '迟到世界书', content: '不得使用' }]); await tick();
    assert.equal(f.stops, 0); assert.equal(f.calls.length, 0);
    assert.equal(f.controller.view().save.initialized, false);
    assert.equal(f.controller.view().activity, null);
    assert.match(f.controller.view().status, /已停止等待/);
});

test('stopping maintenance retains committed batches, drops late output, and resumes only for new narrative', async () => {
    const late = gate(); let hold = true;
    const f = await ready({ raw: true, settings: { batchChars: 1 }, handler: request => {
        if (request.purpose === 'maintain' && request.input.messages[0].key === 'two' && hold) return late.promise;
    } });
    f.state.messages.push(message('one'), message('two'));
    const maintaining = f.controller.maintain(); maintaining.catch(() => {});
    await until(() => f.calls.some(request => request.purpose === 'maintain' && request.input.messages[0].key === 'two'));
    assert.equal(f.controller.view().save.processedCount, 1);
    await f.controller.requestStop(); await assert.rejects(maintaining, /用户已停止/);
    assert.equal(f.stops, 0);
    assert.equal(f.controller.view().autoPostPaused, true);
    const count = f.calls.length;
    f.controller.messageReceived(); await tick(); await tick();
    assert.equal(f.calls.length, count, 'existing receive signal must not restart stopped work');
    late.resolve({ operations: [{ type: 'summary', text: '迟到结果不得入库' }] }); await tick();
    assert.equal(f.controller.view().save.data.summary, '');
    assert.equal(f.controller.view().save.processedCount, 1);
    hold = false; f.state.messages.push(message('three'));
    f.controller.messageReceived();
    await until(() => f.controller.view().save.processedCount === 3 && !f.controller.view().activity);
    assert.equal(f.controller.view().autoPostPaused, false);
});

test('saving is visibly non-cancellable and cannot be falsely reported as withdrawn', async () => {
    const f = await ready(); const writing = gate();
    f.holdWrite(writing); f.state.messages.push(message('write'));
    const maintaining = f.controller.maintain();
    await until(() => f.controller.view().activity?.cancellable === false && f.calls.some(call => call.purpose === 'maintain'));
    assert.match(f.controller.view().activity.label, /保存/);
    assert.deepEqual(await f.controller.requestStop(), { stopped: false, reason: '当前结果正在保存，请稍候' });
    writing.resolve(); await maintaining;
    assert.equal(f.controller.view().save.processedCount, 1);
    assert.equal(f.controller.view().activity, null);
});

test('preflight wait and selection are observable; stop ends this native generation exactly once', async () => {
    const maintenance = gate();
    const f = await ready({ handler: request => request.purpose === 'maintain' ? maintenance.promise : undefined });
    f.state.messages.push(message('later'));
    const maintaining = f.controller.maintain();
    await until(() => f.calls.some(call => call.purpose === 'maintain'));
    const selecting = f.controller.generationBefore();
    await until(() => f.controller.view().activity?.kind === 'select');
    assert.equal(f.controller.view().activities.length, 2);
    assert.match(f.controller.view().activity.label, /前置/);
    const selectedId = f.controller.view().activity.id;
    await f.controller.requestStop(selectedId);
    assert.deepEqual(await selecting, { cancel: true });
    assert.equal(f.stops, 1);
    assert.deepEqual(await f.controller.requestStop(selectedId), { stopped: false, reason: '该任务已结束' });
    assert.equal(f.calls.some(call => call.purpose === 'select'), false);
    maintenance.resolve({ operations: [] }); await maintaining;
});

test('stale foreground activity cannot stop a new generation or replace its activity', async () => {
    const oldResponse = gate(), newResponse = gate(); let serial = 0, isOldCurrent = true;
    const f = await ready({ handler: request => request.purpose === 'select' ? (++serial === 1 ? oldResponse : newResponse).promise : undefined });
    const old = f.controller.generationBefore({ isCurrent: () => isOldCurrent });
    await until(() => serial === 1); const oldId = f.controller.view().activity.id;
    isOldCurrent = false;
    const current = f.controller.generationBefore(); await until(() => serial === 2);
    const currentId = f.controller.view().activities.find(activity => activity.id !== oldId).id;
    assert.equal(f.controller.view().activity.id, currentId, 'a superseded native run must no longer own the visible stop button');
    assert.deepEqual(await f.controller.requestStop(oldId), { stopped: false, reason: '该任务已过期' });
    await old;
    assert.equal(f.stops, 0); assert.equal(f.controller.view().activity.id, currentId);
    oldResponse.resolve({ ids: [] }); await tick();
    assert.equal(f.controller.view().activity.id, currentId);
    newResponse.resolve({ ids: [] }); await current;
    assert.equal(f.plans.filter(Boolean).length, 1); assert.equal(f.controller.view().activity, null);
});

test('stopped paid trial selection never injects and cannot clear a later trial', async () => {
    const firstResponse = gate(), secondResponse = gate(); let serial = 0;
    const f = await ready({ handler: request => request.purpose === 'select' ? (++serial === 1 ? firstResponse : secondResponse).promise : undefined });
    const first = f.controller.previewPlan(); first.catch(() => {});
    await until(() => serial === 1); assert.equal(f.controller.view().activity.kind, 'preview');
    await f.controller.requestStop(); await assert.rejects(first, error => error.dwmCancelled === true);
    const second = f.controller.previewPlan(); await until(() => serial === 2);
    assert.equal(f.controller.view().status, '正在试选资料');
    const secondId = f.controller.view().activity.id;
    firstResponse.resolve({ ids: [] }); await tick();
    assert.equal(f.controller.view().activity.id, secondId);
    secondResponse.resolve({ ids: [] }); await second;
    assert.equal(f.stops, 0); assert.equal(f.plans.filter(Boolean).length, 0);
    assert.equal(f.controller.view().diagnostics.lastPreview.mode, 'preview');
    assert.equal(f.controller.view().status, '试选已完成（未发送）');
    assert.equal(f.controller.view().error, '');
});

test('a failed trial after a stopped trial reports failure instead of inheriting cancellation', async () => {
    const response = gate(); let serial = 0;
    const f = await ready({ handler: request => {
        if (request.purpose !== 'select') return;
        if (++serial === 1) return response.promise;
        throw new Error('选材接口暂不可用');
    } });
    const trial = f.controller.previewPlan(); trial.catch(() => {});
    await until(() => serial === 1); await f.controller.requestStop();
    await assert.rejects(trial, error => error.dwmCancelled === true);
    await assert.rejects(f.controller.previewPlan(), error => error.message === '选材接口暂不可用' && !error.dwmCancelled);
    assert.equal(f.controller.view().status, '试选未完成');
    assert.equal(f.controller.view().error, '选材接口暂不可用');
    assert.equal(f.controller.view().activity, null);
    response.resolve({ ids: [] }); await tick();
    assert.equal(f.controller.view().status, '试选未完成');
});

test('cancelled automatic maintenance does not continue into automatic compaction', async () => {
    const response = gate(); let holding = false;
    const f = await ready({ settings: { compactEvery: 1 }, handler: request => request.purpose === 'maintain' && holding ? response.promise : undefined });
    f.state.messages.push(message('committed')); await f.controller.maintain();
    holding = true; f.state.messages.push(message('cancelled')); f.controller.messageReceived();
    await until(() => f.controller.view().activity?.kind === 'maintain');
    await until(() => f.calls.filter(call => call.purpose === 'maintain').length === 2);
    await f.controller.requestStop(); await tick(); await tick();
    response.resolve({ operations: [] }); await tick();
    assert.equal(f.calls.some(call => call.purpose === 'compact'), false);
    assert.equal(f.controller.view().save.processedCount, 1);
});

test('event compaction exposes its own task and logical cancellation ignores its late result', async () => {
    const response = gate();
    const f = await ready({ handler: request => request.purpose === 'compact' ? response.promise : undefined });
    const compacting = f.controller.compact(); compacting.catch(() => {});
    await until(() => f.calls.some(call => call.purpose === 'compact'));
    assert.equal(f.controller.view().activity.kind, 'compact');
    await f.controller.requestStop(); await assert.rejects(compacting, /用户已停止/);
    response.resolve({ operations: [{ type: 'summary', text: '迟到整理' }] }); await tick();
    assert.equal(f.controller.view().save.data.summary, ''); assert.equal(f.stops, 0);
});

test('successful event compaction clears a previous failure status and error', async () => {
    let fail = true;
    const f = await ready({ handler: request => {
        if (request.purpose === 'compact' && fail) throw new Error('整理接口失败');
    } });
    await assert.rejects(f.controller.compact(), /整理接口失败/);
    assert.equal(f.controller.view().status, '整理未完成');
    fail = false; await f.controller.compact();
    assert.equal(f.controller.view().status, '整理已完成'); assert.equal(f.controller.view().error, '');
});

test('successful inventory catch-up clears a previous failure without losing retained history', async () => {
    let fail = true;
    const f = await ready({ handler: request => {
        if (request.purpose === 'maintain' && fail) throw new Error('物品接口失败');
    } });
    await f.controller.manual({ type: 'inventory-toggle', enabled: false });
    f.state.messages.push(message('item'));
    await assert.rejects(f.controller.manual({ type: 'inventory-toggle', enabled: true }), /物品接口失败/);
    assert.equal(f.controller.view().status, '物品补记未完成，原文保留');
    fail = false; await f.controller.manual({ type: 'inventory-toggle', enabled: true });
    assert.equal(f.controller.view().status, '物品补记已完成'); assert.equal(f.controller.view().error, '');
    assert.equal(f.state.messages[0].key, 'item');
});

test('stopping preflight does not let card scope cleanup start old maintenance; a new reply resumes it', async () => {
    const response = gate();
    const f = await ready({ handler: request => request.purpose === 'select' ? response.promise : undefined });
    await f.controller.setContext({ owner: 'card', activeScopeId: 'global', requestedScopeIds: [], deferPost: true });
    f.state.messages.push(message('old-gap'));
    f.host.stopGeneration = () => {
        f.controller.generationStopped();
        // The card releases its paused scope on native STOP, without a new reply.
        return f.controller.setContext({ owner: 'card', activeScopeId: 'global', requestedScopeIds: [], deferPost: false });
    };
    const selecting = f.controller.generationBefore();
    await until(() => f.calls.some(call => call.purpose === 'select'));
    await f.controller.requestStop(); await selecting; await f.controller.whenIdle();
    assert.equal(f.calls.some(call => call.purpose === 'maintain'), false, 'scope release must not restart a task after Stop');
    assert.equal(f.controller.view().status, '本轮已停止');
    assert.equal(f.controller.view().autoPostPaused, true);
    f.state.messages.push({ ...message('user-after-stop', 'user'), content: '原生尾部追加的用户消息' });
    await f.controller.setContext({ owner: 'card', activeScopeId: 'global', requestedScopeIds: [], deferPost: false });
    await f.controller.whenIdle();
    assert.equal(f.calls.some(call => call.purpose === 'maintain'), false);
    f.state.messages.push({ ...message('placeholder'), content: '' });
    f.controller.messageReceived(); await tick();
    assert.equal(f.calls.some(call => call.purpose === 'maintain'), false);
    f.state.messages.at(-1).content = '真正的新正文';
    // A card may commit scope before the delayed native MESSAGE_RECEIVED handler.
    await f.controller.setContext({ owner: 'card', activeScopeId: 'global', requestedScopeIds: [], deferPost: false });
    await f.controller.whenIdle();
    assert.equal(f.controller.view().autoPostPaused, false);
    assert.equal(f.controller.view().save.processedCount, 3);
    response.resolve({ ids: [] }); await tick();
});

test('committed barrier ignores unfinished model work but waits for atomic storage; scope switch keeps attribution', async () => {
    const response = gate(), writing = gate();
    const f = await ready({ handler: request => request.purpose === 'maintain' ? response.promise : undefined });
    await f.controller.setContext({ owner: 'card', activeScopeId: 'old', deferPost: true });
    f.state.messages.push(message('old-message'));
    await f.controller.setContext({ owner: 'card', activeScopeId: 'old', deferPost: false });
    await until(() => f.calls.some(request => request.purpose === 'maintain'));
    const committed = await f.controller.whenCommitted();
    assert.equal(committed.pendingCount, 1);
    let idle = false; const oldIdle = f.controller.whenIdle().then(() => { idle = true; });
    await tick(); assert.equal(idle, false, 'legacy whenIdle still waits for model work');
    await f.controller.setContext({ owner: 'card', activeScopeId: 'new', deferPost: true });
    await oldIdle;
    assert.equal(f.controller.store.state.data.messageScopes['old-message'], 'old');
    assert.equal(f.stops, 0, 'scope handoff does not broadcast native STOP');
    response.resolve({ operations: [{ type: 'summary', text: 'late old-world result' }] }); await tick();
    assert.equal((await f.controller.readScope('old')).summary, '');
    assert.equal((await f.controller.readScope('new')).summary, '');
    f.holdWrite(writing);
    const scopeSaving = f.controller.setContext({ owner: 'card', activeScopeId: 'new', deferPost: false });
    await tick(); let crossed = false;
    const barrier = f.controller.whenCommitted().then(() => { crossed = true; });
    await tick(); assert.equal(crossed, false);
    writing.resolve(); await scopeSaving; await barrier;
    assert.equal(crossed, true);
});

test('foreground waits only for accepted atomic write and then uses that committed result', async () => {
    const f = await ready(), writing = gate();
    f.state.messages.push(message('write-before-front')); f.holdWrite(writing);
    const background = f.controller.maintain();
    await until(() => f.calls.some(request => request.purpose === 'maintain') && f.controller.view().activity?.cancellable === false);
    const foreground = f.controller.generationBefore(); await tick();
    assert.equal(f.calls.some(request => request.purpose === 'select'), false);
    writing.resolve(); await background; await foreground;
    assert.equal(f.controller.view().save.processedCount, 1);
    assert.equal(f.calls.filter(request => request.purpose === 'select').length, 1);
    assert.equal(f.stops, 0);
});

test('claimed footer ownership is chat-bound and stale release cannot remove a newer claim', async () => {
    const f = await ready();
    const first = f.controller.claimActivity({ owner: 'card', chatId: f.state.chatId });
    const current = f.controller.claimActivity({ owner: 'card', chatId: f.state.chatId });
    first(); assert.equal(f.controller.view().activityClaimed, true);
    assert.equal(f.controller.uiStatus().initialized, true);
    assert.equal(f.controller.uiStatus().enabled, true);
    assert.throws(() => f.controller.claimActivity({ owner: 'foreign', chatId: 'other' }), /当前聊天/);
    current(); assert.equal(f.controller.view().activityClaimed, false);
    const release = f.controller.claimActivity({ owner: 'card', chatId: f.state.chatId });
    f.state.chatId = 'new-chat'; await f.controller.chatChanged();
    assert.equal(f.controller.view().activityClaimed, false); release();
});

test('per-save pause persists without changing master setting or other chat, and maintenance reports skips', async () => {
    const f = await ready();
    await f.controller.setSaveEnabled(false);
    assert.equal(f.controller.view().enabled, false);
    assert.equal(f.controller.settings.enabled, true);
    const skipped = await f.controller.maintain(); assert.equal(skipped.executed, false); assert.match(skipped.reason, /暂停/);
    f.state.chatId = 'second-chat'; await f.controller.chatChanged(); await f.controller.initialize();
    assert.equal(f.controller.uiStatus().enabled, true);
    f.state.chatId = 'activity-chat'; await f.controller.chatChanged();
    assert.equal(f.controller.uiStatus().enabled, false);
    await f.controller.setSaveEnabled(true);
    await f.controller.setContext({ owner: 'card', activeScopeId: 'global', deferPost: true });
    assert.deepEqual(await f.controller.maintain(), { executed: false, reason: '角色卡正在确认本轮归属，稍后自动补记' });
    await f.controller.updateSettings({ enabled: false }); await f.controller.initialize().catch(() => {});
    assert.equal(f.controller.settings.enabled, false, 'initialization must not enable global master');
});

test('applying connection while a model is running is rejected without silently cancelling it', async () => {
    const response = gate(); const f = await ready({ handler: request => request.purpose === 'maintain' ? response.promise : undefined });
    f.state.messages.push(message('connection')); const running = f.controller.maintain();
    await until(() => f.calls.some(request => request.purpose === 'maintain'));
    await assert.rejects(f.controller.updateConnection({ mode: 'raw' }), /当前任务继续运行/);
    assert.equal(f.controller.view().activity.kind, 'maintain');
    response.resolve({ operations: [] }); assert.equal((await running).executed, true);
});


test('claim issued by an earlier chat-change listener survives Fish loading, and the old release cannot revoke it', async () => {
    const f = await ready();
    const releaseOld = f.controller.claimActivity({ owner: 'card', chatId: f.state.chatId });
    f.state.chatId = 'new-chat';
    // Simulate the card's CHAT_CHANGED listener running before Fish's listener.
    const releaseNew = f.controller.claimActivity({ owner: 'card', chatId: f.state.chatId });
    await f.controller.chatChanged();
    assert.equal(f.controller.view().activityClaimed, true);
    releaseOld();
    assert.equal(f.controller.view().activityClaimed, true);
    releaseNew();
    assert.equal(f.controller.view().activityClaimed, false);
});
