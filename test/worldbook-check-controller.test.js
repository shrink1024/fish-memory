import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';

// Synthetic host contract: checking a binding is independent of paid scanning.
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
    const snapshot = { chatId: 'card:chat', bookName: null, messages: [], templateEnabled: true, generating: false };
    const calls = { model: 0, write: 0, check: 0 };
    let wait;
    const status = () => ({ chatId: snapshot.chatId, primaryName: snapshot.bookName, state: snapshot.bookName ? 'ready' : 'unbound',
        message: snapshot.bookName ? '主世界书读取成功，共 1 条。' : '角色尚未绑定主世界书。', entryCount: snapshot.bookName ? 1 : null });
    const host = { snapshot: () => structuredClone(snapshot), worldbookStatus: status,
        checkWorldbook: async () => { calls.check++; if (wait) await wait; return status(); },
        loadWorldbook: async () => [{ uid: 1, comment: '资料', content: '正文' }],
        storage: { read: async () => null, write: async () => { calls.write++; } },
        clearPlan() {}, setPlan() {}, applyWindow: async () => {} };
    const controller = new Controller(host, { settings: { enabled: true }, model: { complete: async () => { calls.model++; throw Error('不得调用模型'); } } });
    return { controller, snapshot, host, calls, setWait: promise => { wait = promise; } };
}

test('manual binding check recovers an unannounced late binding without initializing or saving', async () => {
    const f = fixture(); await f.controller.start();
    assert.equal(f.controller.store, null);
    f.snapshot.bookName = 'later-imported';
    const result = await f.controller.checkWorldbook();
    assert.match(result.message, /读取成功/);
    assert.equal(f.controller.view().worldbook.primaryName, 'later-imported');
    assert.equal(f.controller.store.state.bookName, 'later-imported');
    assert.equal(f.controller.store.state.initialized, false);
    assert.deepEqual(f.calls, { model: 0, write: 0, check: 1 });
});

test('manual check cannot cancel running initialization or narration', async () => {
    const f = fixture(); await f.controller.start(); f.snapshot.bookName = 'main';
    f.snapshot.generating = true;
    await assert.rejects(f.controller.checkWorldbook(), /等待/);
    f.snapshot.generating = false;
    f.controller.progress = { stage: '扫描', done: 0, total: 2 };
    await assert.rejects(f.controller.checkWorldbook(), /等待/);
    assert.equal(f.calls.check, 0);
});

test('a late check cannot load or change status in a different chat', async () => {
    const f = fixture(), pending = gate(); await f.controller.start(); f.snapshot.bookName = 'main';
    f.setWait(pending.promise);
    const checking = f.controller.checkWorldbook();
    assert.equal(f.controller.view().worldbookChecking, true);
    f.snapshot.chatId = 'another-chat'; f.snapshot.bookName = null;
    await f.controller.chatChanged(); const status = f.controller.status;
    pending.resolve();
    await assert.rejects(checking, /切换|改变/);
    assert.equal(f.controller.status, status); assert.equal(f.controller.store, null);
    assert.equal(f.controller.view().worldbookChecking, false);
    assert.equal(f.calls.model, 0); assert.equal(f.calls.write, 0);
});

test('binding check preserves an existing memory object and shares duplicate checks', async () => {
    const f = fixture(); f.snapshot.bookName = 'main'; await f.controller.start();
    const store = f.controller.store, pending = gate(); f.setWait(pending.promise);
    const checking = f.controller.checkWorldbook(), duplicate = f.controller.checkWorldbook();
    pending.resolve(); await Promise.all([checking, duplicate]);
    assert.equal(f.controller.store, store);
    assert.deepEqual(f.calls, { model: 0, write: 0, check: 1 });
});

test('changing the binding while a recovered chat loads cannot certify the old book', async () => {
    const f = fixture(), pending = gate(), reading = gate(); await f.controller.start();
    f.snapshot.bookName = 'main';
    f.host.storage.read = async () => { reading.resolve(); await pending.promise; return null; };
    const checking = f.controller.checkWorldbook(); await reading.promise;
    f.snapshot.bookName = 'another-book'; pending.resolve();
    await assert.rejects(checking, /世界书.*改变/);
    assert.equal(f.controller.store, null);
    assert.equal(f.calls.model, 0); assert.equal(f.calls.write, 0);
});

test('a card claiming the status display does not prevent an idle worldbook check', async () => {
    const f = fixture(); await f.controller.start();
    f.controller.claimActivity({ owner: 'card-ui', chatId: f.snapshot.chatId });
    assert.equal(f.controller.view().activityClaimed, true);
    await f.controller.checkWorldbook();
    assert.equal(f.calls.check, 1);
});
