import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled() { for (let i = 0; i < 12; i++) await tick(); }
function fixture({ settings = {}, handler } = {}) {
    const state = { chatId: 'cadence', bookName: 'main', templateEnabled: true, messages: [], userInput: '' };
    const calls = [], saves = new Map(), windows = [];
    const host = {
        snapshot: () => structuredClone(state), loadWorldbook: async () => [],
        storage: { read: async id => structuredClone(saves.get(id) ?? null), write: async (id, save) => saves.set(id, structuredClone(save)) },
        clearPlan() {}, setPlan() {}, eligible: () => true, applyWindow: async actions => windows.push(...actions),
    };
    const options = { settings, model: { complete: async request => { calls.push(request); return await handler?.(request) ?? (request.purpose === 'select' ? { ids: [] } : { operations: [] }); } } };
    let controller = new Controller(host, options);
    const start = async () => { await controller.start(); await controller.initialize(); };
    const reply = async (number, content = '合成回复') => {
        state.messages.push({ key: `u${number}`, role: 'user', content: '合成输入' }, { key: `a${number}`, role: 'assistant', content });
        controller.messageReceived(); await settled();
    };
    return { get controller() { return controller; }, state, calls, windows, start, reply,
        reload: async () => { controller = new Controller(host, options); await controller.start(); } };
}

test('default cadence accumulates three replies without hiding or omitting pending story', async () => {
    const f = fixture({ settings: { recentTurns: 1 } }); await f.start();
    await f.reply(1); await f.reply(2);
    assert.equal(f.calls.filter(r => r.purpose === 'maintain').length, 0);
    assert.equal(f.controller.store.state.processed.length, 0);
    assert.equal(f.controller.view().maintenance.pendingReplies, 2);
    await f.controller.generationBefore({ type: 'normal' });
    assert.deepEqual(f.calls.find(r => r.purpose === 'select').input.messages.map(m => m.key), ['u1', 'a1', 'u2', 'a2']);
    assert.equal(f.windows.some(action => action.hidden === true), false);
    await f.reply(3);
    assert.equal(f.calls.filter(r => r.purpose === 'maintain').length, 1);
    assert.equal(f.controller.store.state.processed.length, 6);
    assert.equal(f.controller.view().maintenance.pendingReplies, 0);
});

test('manual catch-up and the every-reply setting stay immediate', async () => {
    const f = fixture(); await f.start(); await f.reply(1);
    await f.controller.maintain();
    assert.equal(f.controller.store.state.processed.length, 2);
    await f.controller.updateSettings({ maintenanceEvery: 1 }); await f.reply(2);
    assert.equal(f.controller.store.state.processed.length, 4);
    await assert.rejects(f.controller.updateSettings({ maintenanceEvery: 0 }), /维护|范围/);
});

test('pending text reaching the batch size is processed before the reply threshold', async () => {
    const f = fixture({ settings: { batchChars: 100 } }); await f.start(); await f.reply(1, '长'.repeat(100));
    assert.equal(f.controller.store.state.processed.length, 2);
    assert.ok(f.calls.some(r => r.purpose === 'maintain'));
});

test('pending cadence survives a reload without treating unprocessed replies as remembered', async () => {
    const f = fixture(); await f.start(); await f.reply(1); await f.reply(2); await f.reload();
    assert.equal(f.controller.view().maintenance.pendingReplies, 2);
    assert.equal(f.controller.store.state.processed.length, 0);
    await f.reply(3);
    assert.equal(f.calls.filter(r => r.purpose === 'maintain').length, 1);
});

test('no-change maintenance does not trigger empty compaction', async () => {
    const f = fixture({ settings: { maintenanceEvery: 1, compactEvery: 1 } }); await f.start();
    await f.reply(1); await f.reply(2);
    assert.equal(f.calls.filter(r => r.purpose === 'maintain').length, 2);
    assert.equal(f.calls.filter(r => r.purpose === 'compact').length, 0);
});

test('successful no-op compaction is remembered across reloads', async () => {
    let first = true;
    const f = fixture({ settings: { maintenanceEvery: 1, compactEvery: 1 }, handler: request => {
        if (request.purpose === 'maintain' && first) { first = false; return { operations: [{ type: 'summary', text: '合成事件摘要' }] }; }
    } });
    await f.start(); await f.reply(1);
    assert.equal(f.calls.filter(r => r.purpose === 'compact').length, 1);
    await f.reload(); await f.reply(2);
    assert.equal(f.calls.filter(r => r.purpose === 'compact').length, 1);
});

test('failed compaction retry suppression does not survive a rollback to an earlier story path', async () => {
    const f = fixture({ settings: { maintenanceEvery: 1, compactEvery: 1 }, handler: request => {
        if (request.purpose === 'maintain') return { operations: [{ type: 'summary', text: request.input.messages.at(-1).content }] };
        if (request.purpose === 'compact') throw new Error('合成整理失败');
    } });
    await f.start();
    for (let i = 1; i <= 10; i++) await f.reply(i, `第 ${i} 轮的新剧情`);
    const beforeRollback = f.calls.filter(request => request.purpose === 'compact').length;
    assert.ok(beforeRollback >= 2, 'the original path exercised repeated failure backoff');
    f.state.messages.splice(2);
    await f.controller.messageDeleted();
    await f.reply(11, '回滚后另一条剧情');
    assert.equal(f.calls.filter(request => request.purpose === 'compact').length, beforeRollback + 1,
        'a removed future attempt must not delay compaction until its old cycle count is reached');
});

test('a no-op compaction does not claim memory changes committed while its response was pending', async () => {
    let releaseCompact, firstCompact = true, updateSummary = true;
    const f = fixture({ settings: { maintenanceEvery: 1, compactEvery: 1 }, handler: request => {
        if (request.purpose === 'maintain') return { operations: updateSummary ? [{ type: 'summary', text: request.input.messages.at(-1).content }] : [] };
        if (request.purpose === 'compact' && firstCompact) {
            firstCompact = false;
            return new Promise(resolve => { releaseCompact = resolve; });
        }
    } });
    await f.start();
    f.state.messages.push({ key: 'a1', role: 'assistant', content: '整理开始前的摘要' });
    await f.controller.maintain();
    const compacting = f.controller.compact(); await settled();
    assert.equal(typeof releaseCompact, 'function');
    f.state.messages.push({ key: 'a2', role: 'assistant', content: '整理请求发出后才出现的新摘要' });
    await f.controller.maintain();
    releaseCompact({ operations: [] }); await compacting;
    updateSummary = false;
    await f.reply(3, '不改变摘要的闲聊');
    const requests = f.calls.filter(request => request.purpose === 'compact');
    assert.equal(requests.length, 2, 'the concurrently committed change still requires its own compaction review');
    assert.equal(requests[0].input.memory.summary, '整理开始前的摘要');
    assert.equal(requests[1].input.memory.summary, '整理请求发出后才出现的新摘要');
});

test('an early changed candidate invalidates a compaction marker even when the final message survives', async () => {
    let updateSummary = true;
    const f = fixture({ settings: { maintenanceEvery: 1, compactEvery: 1 }, handler: request => {
        if (request.purpose === 'maintain') return { operations: updateSummary ? [{ type: 'summary', text: request.input.messages.map(message => message.content).join('；') }] : [] };
    } });
    await f.start();
    for (let i = 1; i <= 3; i++) f.state.messages.push(
        { key: `u${i}`, role: 'user', content: `合成输入 ${i}` },
        { key: `a${i}`, role: 'assistant', content: `原剧情 ${i}` });
    await f.controller.maintain(); await f.controller.compact();
    assert.equal(f.calls.filter(request => request.purpose === 'compact').length, 1);
    f.state.messages[1] = { key: 'a1-new', role: 'assistant', content: '改选后不同的剧情' };
    await f.controller.messageSwiped();
    updateSummary = false; await f.reply(4, '不改变摘要的闲聊');
    const requests = f.calls.filter(request => request.purpose === 'compact');
    assert.equal(requests.length, 2, 'the unchanged tail key does not certify the earlier path');
    assert.match(requests[1].input.memory.summary, /改选后不同的剧情/);
});
