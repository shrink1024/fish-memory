// FM (minou 10-19): refreshing during the history stage seemed to restart the
// worldbook scan. The checkpoint was keyed to the whole preset and all save
// preferences, so anything read differently after a reload discarded it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';

function fixture() {
    const state = { chatId: 'c', bookName: 'main', templateEnabled: true, messages: [] };
    for (let i = 0; i < 6; i++) state.messages.push({ key: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `第${i}楼` });
    const book = Array.from({ length: 6 }, (_, i) => ({ uid: i, comment: `条目${i}`, content: `设定${i}`.repeat(40) }));
    const saves = new Map(), calls = [];
    const f = { state, calls, failMaintain: true,
        preset: { name: 'P', entries: [{ id: 'a', title: '未勾选', content: '原文', enabled: true }, { id: 'b', title: '要应用', content: '使用中文', enabled: true }] } };
    const host = { snapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book), readPreset: () => structuredClone(f.preset),
        storage: { read: async id => structuredClone(saves.get(id) ?? null), write: async (id, v) => saves.set(id, structuredClone(v)) },
        clearPlan() {}, setPlan() {}, applyWindow: async () => {} };
    const model = { complete: async request => {
        calls.push(request.purpose);
        if (request.purpose === 'initialize') return { strategy: 's', entries: request.input.entries.map(e => ({ id: e.id, kind: 'fact', intro: 'i', retrieveWhen: 'w', segments: [{ id: 'body', writable: true }] })) };
        if (request.purpose === 'maintain' && f.failMaintain) throw new Error('刷新前中断');
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } };
    f.make = async () => { const c = new Controller(host, { model, settings: { enabled: true, batchChars: 300, historyBatchChars: 1 } }); await c.start(); return c; };
    f.scans = () => calls.filter(purpose => purpose === 'initialize').length;
    return f;
}

test('a reload in the history stage resumes even if an unapplied preset entry changed', async () => {
    const f = fixture();
    await assert.rejects((await f.make()).initialize(), /刷新前中断/);
    const first = f.scans();
    assert.ok(first > 1);
    f.preset.entries[0].content = '改过但没有被应用';
    f.failMaintain = false;
    const c = await f.make(); await c.initialize();
    assert.equal(f.scans(), first, 'the finished worldbook scan is reused');
    assert.equal(c.store.state.initialized, true);
});

test('changing a preset entry that is applied to the requests still invalidates the scan', async () => {
    const f = fixture();
    const c = await f.make();
    await c.savePresetApplication(['b'], c.view().presetApplication.fingerprint);
    await assert.rejects(c.initialize(), /刷新前中断/);
    const first = f.scans();
    // Edit the applied entry, then re-apply it so the new text reaches requests.
    f.preset.entries[1].content = '使用繁体中文';
    const reloaded = await f.make();
    await reloaded.savePresetApplication(['b'], reloaded.view().presetApplication.fingerprint);
    f.failMaintain = false;
    await reloaded.initialize();
    assert.equal(f.scans(), first * 2, 'classification reruns with the new applied text');
});
