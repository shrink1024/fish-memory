import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { MemoryStore } from '../src/core/store.js';
import { maintenanceView, playerView } from '../src/core/views.js';

const clone = value => structuredClone(value);
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    for (let count = 0; count < 60; count++) { if (predicate()) return; await tick(); }
    assert.fail('Initialization did not reach expected phase');
}
function fixture({ handler, writeHandler, settings = {} } = {}) {
    const state = { chatId: 'old-chat', bookName: 'main', templateEnabled: true, generating: false,
        messages: [1, 2, 3].map(n => ({ key: `floor-${n}`, role: n % 2 ? 'user' : 'assistant', content: `合成旧剧情-${n}` })), userInput: '' };
    const book = [1, 2].map(uid => ({ uid, comment: `合成资料-${uid}`, content: `不得截断的合成世界书原文-${uid}`, constant: true }));
    const saved = new Map(), calls = [], writes = [];
    const host = { snapshot: () => clone(state), loadWorldbook: async () => clone(book), clearPlan() {}, setPlan() {}, applyWindow: async () => {},
        storage: { read: async id => clone(saved.get(id) ?? null), write: async (id, data, revision) => {
            assert.equal(saved.get(id)?.revision ?? 0, revision);
            await writeHandler?.(data);
            writes.push(clone(data)); saved.set(id, clone(data));
        } },
    };
    const model = { complete: async request => {
        calls.push(clone({ purpose: request.purpose, input: request.input }));
        const reply = await handler?.(request);
        if (reply !== undefined) return reply;
        if (request.purpose === 'initialize') return { strategy: `分类策略-${request.input.entries[0].id}`, entries: request.input.entries.map(entry => ({
            id: entry.id, kind: 'fact', intro: entry.title, segments: [{ id: 'body', writable: true }],
        })) };
        if (request.purpose === 'strategy') return { strategy: '合成统合策略' };
        if (request.purpose === 'maintain') return { operations: [{ type: 'summary', text: request.input.messages.at(-1).key }] };
        return { ids: [] };
    } };
    const make = () => new Controller(host, { model, settings: { enabled: true, batchChars: 1, ...settings } });
    return { controller: make(), make, host, state, book, saved, calls, writes };
}
const histories = calls => calls.filter(call => call.purpose === 'maintain').flatMap(call => call.input.messages.map(message => message.key));

test('scope commits keep accepted worldbook batches across stopping and reopening initialization', async () => {
    const pending = gate(); let blocked = true;
    const f = fixture({ handler: request => {
        if (blocked && request.purpose === 'initialize' && request.input.entries[0].id.endsWith(':3')) return pending.promise;
    } });
    f.book.push({ uid: 3, comment: '第三批', content: '第三批世界书正文' });
    await f.controller.start(); const scanning = f.controller.initialize(); scanning.catch(() => {});
    for (let i = 0; i < 80 && f.calls.filter(call => call.purpose === 'initialize').length < 3; i++) await tick();
    assert.equal(f.saved.get('old-chat').initializationCheckpoint.classifiedBatches, 2);
    await f.controller.setContext({ owner: 'card', activeScopeId: 'new-scope', deferPost: true });
    f.controller.cancel(); pending.resolve(); await assert.rejects(scanning);
    assert.equal(f.saved.get('old-chat').initializationCheckpoint?.classifiedBatches, 2);
    blocked = false; const before = f.calls.length, resumed = f.make(); await resumed.start();
    await resumed.setContext({ owner: 'card', activeScopeId: 'new-scope', deferPost: false });
    await resumed.initialize();
    assert.deepEqual(f.calls.slice(before).filter(call => call.purpose === 'initialize').flatMap(call => call.input.entries.map(e => e.id)), ['source:main:3']);
    assert.equal(resumed.store.state.initialized, true);
});

test('a changed scope replays the history draft but reuses its completed worldbook classification', async () => {
    let fail = true;
    const f = fixture({ handler: request => {
        if (fail && request.purpose === 'maintain' && request.input.messages[0].key === 'floor-2') throw Error('暂停历史批次');
    } });
    await f.controller.start(); await assert.rejects(f.controller.initialize(), /暂停历史/);
    assert.equal(f.saved.get('old-chat').initializationCheckpoint.stage, 'history');
    await f.controller.setContext({ owner: 'card', activeScopeId: 'new-scope', deferPost: false });
    const attribution = clone(f.controller.store.state.data.messageScopes);
    const before = f.calls.length; fail = false; await f.controller.initialize();
    const subsequent = f.calls.slice(before);
    assert.equal(subsequent.some(call => call.purpose === 'initialize' || call.purpose === 'strategy'), false);
    assert.deepEqual(histories(subsequent), ['floor-1', 'floor-2', 'floor-3']);
    assert.ok(subsequent.filter(call => call.purpose === 'maintain').every(call => call.input.memory.scopeId === attribution[call.input.messages[0].key]));
    assert.equal(f.controller.store.state.data.scopeContext.activeScopeId, 'new-scope');
});

test('a failed old-chat scan resumes after reload without changing formal memory before its atomic completion', async () => {
    let fail = true;
    const f = fixture({ handler: request => { if (fail && request.purpose === 'maintain' && request.input.messages[0].key === 'floor-2') throw Error('合成第二批失败'); } });
    await f.controller.start();
    const original = playerView(f.controller.store.state);
    await assert.rejects(f.controller.initialize(), /第二批失败/);
    assert.deepEqual(playerView(f.controller.store.state), original);
    const checkpoint = f.saved.get('old-chat').initializationCheckpoint;
    assert.equal(checkpoint.draft.processed.length, 1);
    assert.equal(checkpoint.draft.initializationCheckpoint, undefined);
    assert.equal(checkpoint.classification, undefined, 'history keeps one draft rather than another full classification copy');
    assert.ok(checkpoint.draft.journal.every(commit => !('draft' in commit) && !('initializationCheckpoint' in commit)));
    assert.equal(f.saved.get('old-chat').revision, original.revision);
    assert.equal(JSON.stringify(playerView(f.controller.store.state)).includes('initializationCheckpoint'), false);
    assert.equal(JSON.stringify(maintenanceView(f.controller.store.state)).includes('initializationCheckpoint'), false);
    assert.equal(f.controller.initializationResumeSummary().processedCount, 1);
    const before = f.calls.length;
    f.state.messages.push({ key: 'floor-4', role: 'assistant', content: '新增合成剧情' }); fail = false;
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    assert.deepEqual(f.calls.slice(before).map(call => call.purpose), ['maintain', 'maintain', 'maintain']);
    assert.deepEqual(histories(f.calls.slice(before)), ['floor-2', 'floor-3', 'floor-4']);
    assert.equal(resumed.store.state.initialized, true);
    assert.equal(resumed.store.state.data.summary, 'floor-4');
    assert.equal(resumed.store.state.processed.length, 4);
    assert.equal(resumed.store.state.initializationCheckpoint, undefined);
    assert.equal(f.saved.get('old-chat').initializationCheckpoint, undefined);
    assert.equal(resumed.initializationResumeSummary(), null);
    assert.equal(resumed.store.state.revision, original.revision + 1);
    assert.ok(f.writes.slice(0, -1).every(save => !save.initialized && save.processed.length === 0));
});

for (const phase of ['classification', 'strategy']) test(`a saved ${phase} checkpoint avoids repeating accepted classification after reload`, async () => {
    let fail = true;
    const f = fixture({ handler: request => {
        if (fail && ((phase === 'classification' && request.purpose === 'initialize' && request.input.entries[0].id.endsWith(':2'))
            || (phase === 'strategy' && request.purpose === 'strategy'))) throw Error('合成阶段失败');
    } });
    await f.controller.start(); await assert.rejects(f.controller.initialize(), /阶段失败/);
    const before = f.calls.length; fail = false;
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    const repeats = f.calls.slice(before).filter(call => call.purpose === 'initialize');
    assert.equal(repeats.length, phase === 'classification' ? 1 : 0);
    if (repeats.length) assert.equal(repeats[0].input.entries[0].id, 'source:main:2');
    assert.equal(resumed.store.state.initialized, true);
});

for (const change of ['content', 'metadata', 'natural-language', 'script']) test(`changing worldbook ${change} invalidates an earlier checkpoint`, async () => {
    let fail = true;
    const f = fixture({ handler: request => { if (fail && request.purpose === 'maintain') throw Error('合成中断'); } });
    f.book.push({ uid: 9, comment: '[DWM Rules]', disable: true, content: JSON.stringify({ format: 'dwm-rules', version: 1, naturalLanguage: '', script: '' }) });
    await f.controller.start(); await assert.rejects(f.controller.initialize(), /合成中断/);
    if (change === 'content') f.book[0].content += '新版本';
    if (change === 'metadata') f.book[0].key = ['新关键词'];
    if (change === 'natural-language') f.book.at(-1).content = JSON.stringify({ format: 'dwm-rules', version: 1, naturalLanguage: '只记录合成事实', script: '' });
    if (change === 'script') f.book.at(-1).content = JSON.stringify({ format: 'dwm-rules', version: 1, naturalLanguage: '', script: 'when kind == "npc" => lock;' });
    const before = f.calls.length; fail = false;
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    assert.equal(f.calls.slice(before).filter(call => call.purpose === 'initialize').length, 2);
    assert.deepEqual(histories(f.calls.slice(before)), ['floor-1', 'floor-2', 'floor-3']);
});

test('a changed selected reply replays the saved draft only through the common prefix', async () => {
    let fail = true;
    const f = fixture({ handler: request => { if (fail && request.purpose === 'maintain' && request.input.messages[0].key === 'floor-3') throw Error('合成第三批失败'); } });
    await f.controller.start(); await assert.rejects(f.controller.initialize(), /第三批失败/);
    f.state.messages[1] = { key: 'floor-2-alt', role: 'assistant', content: '另一个合成候选' };
    const before = f.calls.length; fail = false;
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    assert.equal(f.calls.slice(before).filter(call => call.purpose === 'initialize').length, 0);
    assert.deepEqual(histories(f.calls.slice(before)), ['floor-2-alt', 'floor-3']);
    assert.equal(f.calls[before].input.memory.summary, 'floor-1');
    assert.deepEqual(resumed.store.state.processed, ['floor-1', 'floor-2-alt', 'floor-3']);
    assert.equal(JSON.stringify(resumed.store.state.journal).includes('"floor-2"'), false);
});

test('checkpoint save failures propagate without reporting the rejected batch as resumable progress', async () => {
    let fail = true;
    const f = fixture({ writeHandler: save => {
        if (fail && save.initializationCheckpoint?.draft?.processed.length === 1) throw Error('合成断点保存失败');
    } });
    await f.controller.start(); await assert.rejects(f.controller.initialize(), /断点保存失败/);
    assert.equal(f.controller.store.state.initialized, false);
    assert.equal(f.controller.initializationResumeSummary().processedCount, 0);
    assert.equal(f.saved.get('old-chat').initializationCheckpoint.draft.processed.length, 0);
    const before = f.calls.length; fail = false;
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    assert.deepEqual(histories(f.calls.slice(before)), ['floor-1', 'floor-2', 'floor-3']);
    assert.equal(f.calls.slice(before).some(call => call.purpose === 'initialize'), false);
});

for (const cancel of ['stop', 'switch-chat']) test(`${cancel} prevents a late response from replacing a persisted initialization checkpoint`, async () => {
    const pending = gate(); let hold = true;
    const f = fixture({ handler: request => {
        if (hold && request.purpose === 'maintain' && request.input.messages[0].key === 'floor-2') return pending.promise;
    } });
    await f.controller.start(); const initializing = f.controller.initialize();
    const rejected = assert.rejects(initializing);
    await until(() => histories(f.calls).includes('floor-2'));
    const savedBefore = clone(f.saved.get('old-chat'));
    assert.equal(savedBefore.initializationCheckpoint.draft.processed.length, 1);
    if (cancel === 'stop') await f.controller.requestStop();
    else { f.state.chatId = 'other-chat'; await f.controller.chatChanged(); }
    await rejected;
    pending.resolve({ operations: [{ type: 'summary', text: '禁止写入的迟到正文' }] }); await tick();
    assert.deepEqual(f.saved.get('old-chat'), savedBefore);
    f.state.chatId = 'old-chat'; hold = false;
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    assert.equal(resumed.store.state.initialized, true);
    assert.equal(JSON.stringify(f.saved.get('old-chat')).includes('禁止写入的迟到正文'), false);
});

test('formal preference/context changes and inherited branches cannot reuse the parent checkpoint', async () => {
    let fail = true;
    const f = fixture({ handler: request => { if (fail && request.purpose === 'maintain') throw Error('合成中断'); } });
    await f.controller.start(); await assert.rejects(f.controller.initialize(), /合成中断/);
    const old = clone(f.saved.get('old-chat'));
    assert.equal(old.initializationCheckpoint.stage, 'history');
    const branch = new MemoryStore(f.host.storage);
    await branch.load('branch-chat', 'main', old);
    assert.equal(branch.state.initializationCheckpoint, undefined);
    await f.controller.store.updatePreferences({ preset: { synthetic: true } });
    assert.equal(f.controller.store.state.initializationCheckpoint, undefined);
    const before = f.calls.length; fail = false;
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    assert.equal(f.calls.slice(before).filter(call => call.purpose === 'initialize').length, 2);
});

test('a reply changing during the final book check is replayed before the draft can replace formal memory', async () => {
    const f = fixture(); let reads = 0;
    const originalLoad = f.host.loadWorldbook;
    f.host.loadWorldbook = async () => {
        reads++;
        if (reads === 3) f.state.messages[2] = { key: 'floor-3-alt', role: 'assistant', content: '最终核对期间切换的候选' };
        return originalLoad();
    };
    await f.controller.start(); await f.controller.initialize();
    assert.equal(f.controller.store.state.data.summary, 'floor-3-alt');
    assert.deepEqual(f.controller.store.state.processed, ['floor-1', 'floor-2', 'floor-3-alt']);
    assert.deepEqual(histories(f.calls), ['floor-1', 'floor-2', 'floor-3', 'floor-3-alt']);
    assert.equal(f.calls.filter(call => call.purpose === 'initialize').length, 2);
});

test('a failed final atomic replace retains the entire completed draft for a model-free manual retry', async () => {
    let fail = true;
    const f = fixture({ writeHandler: save => { if (fail && save.initialized) throw Error('合成正式保存失败'); } });
    await f.controller.start(); await assert.rejects(f.controller.initialize(), /正式保存失败/);
    assert.equal(f.controller.store.state.initialized, false);
    assert.equal(f.controller.initializationResumeSummary().processedCount, 3);
    const before = f.calls.length; fail = false;
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    assert.equal(f.calls.length, before);
    assert.equal(resumed.store.state.initialized, true);
    assert.equal(resumed.store.state.initializationCheckpoint, undefined);
});

test('a checkpoint queued behind a formal write is rejected and failed checkpoint saves retain the previous revision', async () => {
    const f = fixture({ handler: request => { if (request.purpose === 'maintain') throw Error('合成中断'); } });
    await f.controller.start(); await assert.rejects(f.controller.initialize(), /合成中断/);
    const store = f.controller.store, checkpoint = store.initializationCheckpoint(), revision = store.state.revision;
    const change = store.updatePreferences({ enabled: false });
    const saving = store.saveInitializationCheckpoint(checkpoint, { expectedRevision: revision });
    await change; await assert.rejects(saving, /存档已经变化/);
    assert.equal(store.state.initializationCheckpoint, undefined);
    assert.equal(store.state.revision, revision + 1);
});

test('a truncated checkpoint with a matching source header cannot certify missing source entries', async () => {
    let fail = true;
    const f = fixture({ handler: request => { if (fail && request.purpose === 'maintain') throw Error('合成中断'); } });
    await f.controller.start(); await assert.rejects(f.controller.initialize(), /合成中断/);
    delete f.saved.get('old-chat').initializationCheckpoint.draft.base.entries['source:main:2'];
    const before = f.calls.length; fail = false;
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    assert.equal(f.calls.slice(before).filter(call => call.purpose === 'initialize').length, 2);
    assert.equal(Object.keys(resumed.store.state.data.entries).length, 2);
});
