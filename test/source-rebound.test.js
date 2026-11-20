import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';

async function fixture() {
    const books = { old: [{ uid: 1, comment: '林舟', content: '旧版人物设定' }],
        new: [{ uid: 1, comment: '林舟', content: '新版人物设定' }],
        extra: [{ uid: 1, comment: '港口', content: '外部书设定' }] };
    const live = { chatId: 'rebound', bookName: 'old', templateEnabled: true, generating: false,
        messages: [{ key: 'm1', role: 'assistant', content: '合成开场', hidden: false }] };
    let disk, afterRead;
    const calls = [], reads = [];
    const host = { snapshot: () => structuredClone(live), clearPlan() {}, applyWindow: async () => {},
        listWorldbooks: async () => Object.keys(books).map(name => ({ name, primary: name === live.bookName })),
        loadWorldbook: async (name = live.bookName) => {
            reads.push(name);
            if (!books[name]) throw Error('missing book');
            const raw = structuredClone(books[name]);
            await afterRead?.(name);
            return raw;
        },
        storage: { read: async () => structuredClone(disk ?? null), write: async (_, value) => { disk = structuredClone(value); } } };
    const options = { settings: { lazyMode: false }, lazyClock: { setTimer: () => 1, clearTimer() {} }, model: { complete: async request => {
        calls.push(request);
        return request.purpose === 'initialize' ? { strategy: '', entries: request.input.entries.map(e => ({ id: e.id,
            kind: 'npc', segments: [{ id: 'body', writable: true }] })) } : { operations: [] };
    } } };
    const c = new Controller(host, options); await c.start(); await c.initialize();
    calls.length = 0; reads.length = 0;
    return { c, books, live, calls, reads, host, options, disk: () => structuredClone(disk),
        onRead: callback => { afterRead = callback; } };
}
const reboundError = error => error.kind === 'source-rebound' && error.dwmSourceRebound === true
    && /重新扫描整个存档/.test(error.message) && !/同步期间变化/.test(error.message);

for (const deleted of [false, true]) test(`manual sync blocks a rebound before any calls even when old book ${deleted ? 'was deleted' : 'still exists'}`, async () => {
    const f = await fixture(); f.live.bookName = 'new'; if (deleted) delete f.books.old;
    await f.c.chatChanged(); const saved = f.disk(); f.reads.length = 0;
    for (const input of [undefined, { sourceBook: 'old' }, { sourceBook: 'new' }]) {
        await assert.rejects(f.c.syncSourceChanges(input), reboundError);
        assert.equal(f.calls.length, 0); assert.deepEqual(f.reads, []);
        assert.deepEqual(f.c.store.state, saved); assert.deepEqual(f.disk(), saved);
    }
    const changes = f.c.view().sourceChanges;
    assert.equal(changes.rebound, true); assert.equal(changes.previousBook, 'old'); assert.equal(changes.currentBook, 'new');
    assert.equal(f.c.view().errorInfo.kind, 'source-rebound');
});
test('rebinding before a host change event also blocks explicit external sync and the aggregate menu path', async () => {
    const f = await fixture(); await f.c.addFromBook('extra', [1]);
    f.calls.length = 0; f.reads.length = 0; const saved = f.disk(); f.live.bookName = 'new';
    for (const input of [undefined, { sourceBook: 'extra' }]) await assert.rejects(f.c.syncSourceChanges(input), reboundError);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.reads, []); assert.deepEqual(f.disk(), saved);
    assert.equal(f.c.view().sourceChanges.currentBook, 'new');
});
test('lazy mode shows rebound attention without syncing, retrying, or changing the old save', async () => {
    const f = await fixture(); f.live.bookName = 'new'; delete f.books.old;
    const c = new Controller(f.host, { ...f.options, settings: { lazyMode: true } });
    const saved = f.disk(); await c.start();
    for (let i = 0; i < 3; i++) { await c.readinessChanged(); await c.lazyRetry(); }
    assert.equal(f.calls.length, 0); assert.deepEqual(f.disk(), saved); assert.deepEqual(c.store.state, saved);
    assert.equal(c.view().lazy.status.state, 'needs-attention');
    assert.equal(c.view().lazy.attention.reason, 'source-rebound');
    assert.equal(c.view().lazy.attention.currentBook, 'new');
    // The warning derives from current binding; it is not a sticky failure ledger.
    f.books.old = [{ uid: 1, comment: '林舟', content: '旧版人物设定' }]; f.live.bookName = 'old';
    await c.chatChanged(); await c.readinessChanged();
    assert.equal(c.view().sourceChanges.rebound, undefined); assert.equal(c.view().lazy.attention, null);
    assert.equal(f.calls.length, 0); await c.setLazyMode(false);
});
test('rebind during the initial source read is rejected before classification', async () => {
    const f = await fixture(); f.books.old[0].content = '同名书作者更新';
    const saved = f.disk(); f.onRead(() => { f.live.bookName = 'new'; });
    await assert.rejects(f.c.syncSourceChanges(), reboundError);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.disk(), saved);
});
test('rebind while classification is in flight discards its result and preserves the save', async () => {
    const f = await fixture(); f.books.old[0].content = '同名书作者更新';
    const saved = f.disk(), complete = f.c.client.completeValidated;
    f.c.client.completeValidated = async (...args) => {
        const result = await complete(...args); f.live.bookName = 'new'; return result;
    };
    await assert.rejects(f.c.syncSourceChanges(), reboundError);
    assert.equal(f.calls.length, 1, 'the one request began before the binding changed');
    assert.deepEqual(f.disk(), saved); assert.deepEqual(f.c.store.state, saved);
});
test('rebind during the final source read does not commit a completed classification', async () => {
    const f = await fixture(); f.books.old[0].content = '同名书作者更新';
    const saved = f.disk(); let count = 0;
    f.onRead(() => { if (++count === 2) f.live.bookName = 'new'; });
    await assert.rejects(f.c.syncSourceChanges(), reboundError);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.disk(), saved);
});
test('a successful explicit rescan onto the new book clears rebound attention', async () => {
    const f = await fixture(); f.live.bookName = 'new'; await f.c.chatChanged();
    assert.equal(f.c.view().lazy.attention.reason, 'source-rebound');
    await f.c.initialize();
    assert.equal(f.c.store.state.bookName, 'new'); assert.equal(f.c.view().sourceChanges.rebound, undefined);
    assert.equal(f.c.view().lazy.attention, null); assert.equal(f.c.view().sourceChanges.changed, false);
});
test('ordinary same-book edits still sync incrementally', async () => {
    const f = await fixture(); f.books.old[0].content = '同名书作者更新';
    const result = await f.c.syncSourceChanges();
    assert.equal(result.executed, true); assert.equal(f.calls.length, 1);
    assert.equal(f.c.store.state.data.entries['source:old:1'].source.original, '同名书作者更新');
    assert.equal(f.c.view().sourceChanges.changed, false); assert.equal(f.c.view().lazy.attention, null);
});
