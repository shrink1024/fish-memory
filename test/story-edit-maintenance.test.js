// 0.3.1 problem package: on an 880-floor save with 103 floors pending, deleting
// replies one by one cancelled and resent the same 62k-character maintenance
// batch seven times, and selection carried ~480k characters of backlog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { selectionMessages, SELECTION_BACKLOG_CHARS } from '../src/agents/requests.js';
import { externalLabel } from '../src/diagnostics/capture.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled(n = 30) { for (let i = 0; i < n; i++) await tick(); }
function fixture(messageCount) {
    const state = { chatId: 'long', bookName: 'main', templateEnabled: true, messages: [], userInput: '' };
    for (let i = 0; i < messageCount; i++) state.messages.push({ key: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `第${i}楼`.padEnd(10, '。') });
    const saves = new Map(), calls = [], gates = [];
    const host = { snapshot: () => structuredClone(state), loadWorldbook: async () => [],
        storage: { read: async id => structuredClone(saves.get(id) ?? null), write: async (id, save) => saves.set(id, structuredClone(save)) },
        clearPlan() {}, setPlan() {}, eligible: () => true, applyWindow: async () => {} };
    let hold = false;
    const model = { complete: async request => {
        calls.push({ purpose: request.purpose, keys: (request.input.messages ?? []).map(m => m.key) });
        if (request.purpose === 'maintain' && hold) await new Promise(resolve => gates.push(resolve));
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } };
    const controller = new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1000, batchChars: 40 } });
    return { state, calls, controller, holdMaintenance: value => { hold = value; }, release: () => gates.shift()?.(), gates };
}

test('deleting replies after the batch being written does not cancel or resend it', async () => {
    const f = fixture(4);
    await f.controller.start(); await f.controller.initialize(); f.calls.length = 0;
    for (let i = 4; i < 20; i++) f.state.messages.push({ key: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `第${i}楼`.padEnd(10, '。') });
    f.holdMaintenance(true);
    const running = f.controller.maintain();
    await settled();
    assert.equal(f.gates.length, 1, 'first backlog batch is in flight');
    const firstBatch = f.calls.filter(c => c.purpose === 'maintain')[0].keys;
    // The player deletes the last three floors one by one while it runs.
    for (let i = 0; i < 3; i++) { f.state.messages.pop(); await f.controller.messageDeleted(); await settled(5); }
    assert.equal(f.calls.filter(c => c.purpose === 'maintain').length, 1, 'no resend per deletion');
    f.holdMaintenance(false); f.release();
    await running; await settled(); await f.controller.whenIdle();
    const batches = f.calls.filter(c => c.purpose === 'maintain').map(c => c.keys);
    assert.deepEqual(batches[0], firstBatch);
    assert.equal(new Set(batches.flat()).size, batches.flat().length, 'every floor is sent once');
    assert.deepEqual(f.controller.store.state.processed, f.state.messages.map(m => m.key), 'the rest catches up on the current story');
    assert.ok(!batches.flat().some(key => ['m17', 'm18', 'm19'].includes(key)), 'deleted floors are never maintained');
});

test('an edit inside the batch being written still cancels it', async () => {
    const f = fixture(4);
    await f.controller.start(); await f.controller.initialize(); f.calls.length = 0;
    f.state.messages.push({ key: 'm4', role: 'user', content: '短' }, { key: 'm5', role: 'assistant', content: '短' });
    f.holdMaintenance(true);
    const running = f.controller.maintain(); running.catch(() => {});
    await settled();
    f.state.messages.pop(); await f.controller.messageDeleted();
    await assert.rejects(running);
    f.holdMaintenance(false); for (const gate of f.gates.splice(0)) gate();
    await settled(); await f.controller.whenIdle();
    assert.deepEqual(f.controller.store.state.processed, ['m0', 'm1', 'm2', 'm3', 'm4']);
});

test('selection keeps recent turns whole and only the newest part of an unmaintained backlog', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(5000) }));
    const recent = selectionMessages({ messages }, { processed: [] }, 2);
    const recentStart = messages.length - 4;
    assert.deepEqual(recent.slice(-4).map(m => m.key), messages.slice(recentStart).map(m => m.key));
    const backlog = recent.slice(0, -4);
    assert.ok(backlog.reduce((n, m) => n + m.content.length, 0) <= SELECTION_BACKLOG_CHARS);
    assert.deepEqual(backlog.map(m => m.key), messages.slice(recentStart - backlog.length, recentStart).map(m => m.key), 'the newest backlog floors, in order');
    const caughtUp = selectionMessages({ messages }, { processed: messages.slice(0, 30).map(m => m.key) }, 2);
    assert.deepEqual(caughtUp.map(m => m.key), messages.slice(30).map(m => m.key), 'a short backlog is kept whole');
});

test('requests fish did not send are named by generation type', () => {
    for (const type of ['normal', 'regenerate', 'swipe', 'continue']) assert.equal(externalLabel(type), '酒馆正文生成');
    assert.equal(externalLabel('quiet'), '后台请求（其他扩展或角色卡）');
    assert.equal(externalLabel('impersonate'), '酒馆代写（替玩家发言）');
    assert.equal(externalLabel(undefined), '酒馆 / 外部模型调用');
});

test('the automatic continuation respects a pause the player set meanwhile', async () => {
    const f = fixture(4);
    await f.controller.start(); await f.controller.initialize(); f.calls.length = 0;
    for (let i = 4; i < 20; i++) f.state.messages.push({ key: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `第${i}楼`.padEnd(10, '。') });
    f.holdMaintenance(true);
    const running = f.controller.maintain(); await settled();
    f.state.messages.pop(); await f.controller.messageDeleted(); await settled();
    f.controller.generationStopped();
    f.holdMaintenance(false); f.release(); await running; await settled(); await f.controller.whenIdle();
    assert.equal(f.calls.filter(c => c.purpose === 'maintain').length, 1, 'no continuation while paused');
    assert.equal(f.controller.view().autoPostPaused, true, 'the pause is kept');
    assert.equal(f.controller.store.state.processed.length, 8);
});

test('an edit while a later batch waits for MVU is checked against that batch before sending', async () => {
    const f = fixture(4);
    await f.controller.start(); await f.controller.initialize(); f.calls.length = 0;
    for (let i = 4; i < 12; i++) f.state.messages.push({ key: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `第${i}楼`.padEnd(10, '。') });
    Object.assign(f.controller.settings, { mvuEnabled: true, mvuBookName: 'main' });
    const waiting = [];
    f.controller.host.readMvu = () => new Promise(resolve => waiting.push(() => resolve({ status: 'unavailable', fields: [] })));
    const running = f.controller.maintain(); running.catch(() => {}); await settled();
    assert.equal(waiting.length, 1, 'the second batch (m8–m11) waits for MVU');
    f.state.messages.pop(); await f.controller.messageDeleted();
    for (let i = 0; i < 5; i++) { while (waiting.length) waiting.shift()(); await settled(); }
    await f.controller.whenIdle();
    const sent = f.calls.filter(c => c.purpose === 'maintain').flatMap(c => c.keys);
    assert.ok(!sent.includes('m11'), 'the deleted floor is never sent');
    assert.deepEqual(f.controller.store.state.processed, f.state.messages.map(m => m.key), 'the rest is caught up');
});
