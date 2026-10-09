import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { MemoryStore } from '../src/core/store.js';
import { createEntry, entryText } from '../src/core/state.js';
import { applyMaintenance } from '../src/core/operations.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(n = 20) { while (n--) await tick(); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const message = (key, role = 'assistant') => ({ key, role, content: key, hidden: false, hiddenBy: null });
async function fixture() {
    const state = { chatId: 'review', bookName: 'book', templateEnabled: true, messages: [message('a0')] };
    const db = new Map(), calls = [], gates = {}, plans = [], windows = [];
    const host = { snapshot: () => structuredClone(state), generationSnapshot: () => structuredClone(state),
        loadWorldbook: async () => [{ uid: 1, comment: 'Home', content: 'Port' }], clearPlan() {}, setPlan: plan => plans.push(plan),
        applyWindow: async actions => { windows.push(...actions); for (const action of actions) Object.assign(state.messages[action.index], { hidden: action.hidden, hiddenBy: action.hiddenBy }); },
        storage: { read: async id => structuredClone(db.get(id)), write: async (id, value) => db.set(id, structuredClone(value)) } };
    const model = { complete: async request => {
        calls.push(request);
        if (gates[request.purpose]) await gates[request.purpose].promise;
        if (request.purpose === 'initialize') return { strategy: 'remember', entries: request.input.entries.map(e => ({ id: e.id, kind: 'fact', intro: 'Original intro', retrieveWhen: 'Original cue', segments: [{ id: 'body', writable: true }] })) };
        if (request.purpose === 'select') return { ids: [] };
        return { operations: [] };
    } };
    const c = new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1, recentTurns: 1, compactEvery: 1000 } });
    await c.start(); await c.initialize();
    return { c, host, state, calls, gates, plans, windows };
}

test('in-flight maintenance survives a new selection and commits only after the selection snapshot is released', async () => {
    const f = await fixture();
    f.state.messages.push(message('u1', 'user'), message('a1'));
    f.gates.maintain = deferred();
    const maintaining = f.c.maintain(); await settle();
    const request = f.calls.findLast(call => call.purpose === 'maintain');
    f.gates.select = deferred();
    f.state.messages.push(message('u2', 'user'));
    const selecting = f.c.generationBefore({ type: 'normal' }); await settle();
    assert.equal(request.signal.aborted, false, 'a normal foreground send must retain paid in-flight work');
    f.gates.maintain.resolve(); await settle();
    assert.deepEqual(f.c.store.state.processed, ['a0'], 'no commit changes the selected snapshot');
    f.gates.select.resolve(); await selecting; await maintaining;
    assert.deepEqual(f.c.store.state.processed, ['a0', 'u1', 'a1']);
    assert.equal(f.calls.filter(call => call.purpose === 'maintain').length, 2, 'initialization plus one retained maintenance');
});

test('stopping foreground selection retains paid maintenance and releases its commit hold', async () => {
    const f = await fixture(); f.state.messages.push(message('u1', 'user'), message('a1'));
    f.gates.maintain = deferred(); const maintaining = f.c.maintain(); await settle();
    const maintenanceRequest = f.calls.findLast(call => call.purpose === 'maintain');
    f.gates.select = deferred(); const selecting = f.c.generationBefore({ type: 'normal' }); await settle();
    const selectionRequest = f.calls.findLast(call => call.purpose === 'select');
    f.c.generationStopped();
    assert.equal(selectionRequest.signal.aborted, true);
    assert.equal(maintenanceRequest.signal.aborted, false);
    f.gates.maintain.resolve(); await maintaining; await selecting;
    assert.deepEqual(f.c.store.state.processed, ['a0', 'u1', 'a1']);
    assert.equal(f.c.view().autoPostPaused, true, 'stop prevents fresh automatic spending, while retaining the already running maintenance');
});

test('a replacement send aborts the old selection before its model promise returns', async () => {
    const f = await fixture(); f.gates.select = deferred();
    const old = f.c.generationBefore({ type: 'normal' }); await settle();
    const previous = f.calls.findLast(call => call.purpose === 'select');
    delete f.gates.select;
    const current = f.c.generationBefore({ type: 'normal' }); await settle();
    assert.equal(previous.signal.aborted, true);
    await current; assert.deepEqual(await old, { cancel: true });
});

test('external send signal stops its selection without ending maintenance', async () => {
    const f = await fixture(), abort = new AbortController(); f.gates.select = deferred();
    const pending = f.c.generationBefore({ type: 'normal', signal: abort.signal }); await settle();
    abort.abort(new Error('superseded'));
    const request = f.calls.findLast(call => call.purpose === 'select');
    assert.equal(request.signal.aborted, true);
    assert.deepEqual(await pending, { cancel: true });
});

test('readiness events after a rebind preserve the warning and the active rescan', async () => {
    const f = await fixture(); f.state.bookName = 'new-book'; await f.c.chatChanged();
    const originalStore = f.c.store;
    await f.c.readinessChanged();
    assert.equal(f.c.store, originalStore);
    assert.match(f.c.view().initialization.message, /绑定已改变/);
    f.gates.initialize = deferred(); const scan = f.c.initialize(); scan.catch(() => {}); await settle();
    await f.c.readinessChanged(); await f.c.chatChanged();
    assert.equal(f.calls.findLast(call => call.purpose === 'initialize').signal.aborted, false);
    f.gates.initialize.resolve(); await scan;
    assert.equal(f.c.store.state.bookName, 'new-book');
});

test('failed saved-data reads publish a visible error without replacing or writing the save', async () => {
    const f = await fixture(); let writes = 0;
    f.host.storage.read = async () => { throw Error('不支持的存档格式'); };
    f.host.storage.write = async () => { writes++; };
    await assert.rejects(f.c.chatChanged(), /存档格式/);
    assert.match(f.c.view().status, /载入失败/);
    assert.match(f.c.view().error, /存档格式/);
    assert.equal(writes, 0); assert.equal(f.c.store, null);
});

test('cancelled manual initialization exposes a retry instead of a permanently running notice', async () => {
    const f = await fixture(); f.gates.initialize = deferred();
    const scan = f.c.initialize(); scan.catch(() => {}); await settle();
    f.c.cancel(); f.gates.initialize.resolve(); await assert.rejects(scan);
    assert.equal(f.c.view().initialization?.state, 'retry');
    assert.equal(f.c.view().initialization?.retry, true);
    assert.equal(f.c.view().activity, null);
});

test('candidate-change notification releases the host without waiting for background model work', async () => {
    const f = await fixture(); f.state.messages.push(message('u1', 'user'), message('new'));
    f.gates.maintain = deferred();
    let returned = false;
    const event = Promise.resolve(f.c.messageSwiped()).then(() => { returned = true; });
    await settle(); assert.equal(returned, true);
    f.gates.maintain.resolve(); await event; await f.c.whenIdle();
});

test('an empty memory result cannot hide old original text when there is no narrative memory', async () => {
    const f = await fixture(); f.state.messages.push(message('u1', 'user'), message('a1'), message('u2', 'user'), message('a2'));
    await f.c.maintain(); await f.c.generationBefore({ type: 'normal' });
    assert.equal(f.state.messages.some(m => m.hiddenBy === 'dynamic-world-memory'), false);
});

test('unhiding a floor that maintenance skipped keeps its original text sendable', async () => {
    const f = await fixture();
    f.state.messages.push({ ...message('u1', 'user'), hidden: true }, { ...message('a1'), hidden: true },
        message('u2', 'user'), message('a2'), message('u3', 'user'), message('a3'));
    await f.c.maintain();
    await f.c.store.commit({ operations: [{ type: 'summary', text: '已记住可见剧情' }] }, {
        expectedRevision: f.c.store.state.revision, sourceKeys: f.state.messages.map(m => m.key), allowedEvidence: ['u2', 'a2', 'u3', 'a3'] });
    for (const m of f.state.messages) if (['u1', 'a1'].includes(m.key)) m.hidden = false;
    await f.c.generationBefore({ type: 'normal' });
    assert.equal(f.state.messages.find(m => m.key === 'u1').hidden, false);
    assert.equal(f.state.messages.find(m => m.key === 'a1').hidden, false);
    assert.equal(f.state.messages.find(m => m.key === 'u2').hiddenBy, 'dynamic-world-memory');
    assert.ok(!f.c.store.state.rememberedKeys.includes('u1'));
});

test('protected-text placeholders cannot be committed as generated memory', () => {
    const data = { entries: {}, summary: '', inventory: [], inventoryEnabled: true };
    for (const operation of [
        { type: 'summary', text: '城门[受保护资料]守卫' },
        { type: 'inventory', items: [{ name: '物品', description: '[受保护资料]' }] },
        { type: 'create', kind: 'fact', title: 'Fact', text: '[受保护资料]', evidence: ['a1'] },
    ]) assert.throws(() => applyMaintenance(data, { operations: [operation] }, { allowedEvidence: ['a1'] }), /受保护|占位/);
});

test('reset restores the initialized source description and recall cue', async () => {
    const f = await fixture(), id = 'source:book:1';
    await f.c.manual({ type: 'edit', id, intro: 'Changed', retrieveWhen: 'Changed' });
    await f.c.manual({ type: 'reset', id, confirmed: true });
    assert.equal(f.c.store.state.data.entries[id].intro, 'Original intro');
    assert.equal(f.c.store.state.data.entries[id].retrieveWhen, 'Original cue');
});

test('branch-independent player controls survive reroll while discarded narrative does not', async () => {
    const f = await fixture(); f.state.messages.push(message('u1', 'user'), message('a1'));
    await f.c.maintain();
    await f.c.manual({ type: 'inventory-toggle', enabled: false });
    const projected = f.c.store.project(['a0', 'u1']);
    assert.equal(projected.data.inventoryEnabled, false);
    await f.c.store.reconcile(['a0', 'u1', 'new']);
    assert.equal(f.c.store.state.data.inventoryEnabled, false);
});

test('manual source corrections survive reroll without resurrecting discarded generated entries', async () => {
    const store = new MemoryStore({ read: async () => null, write: async () => {} });
    await store.load('chat', 'book');
    await store.initialize([createEntry({ id: 'home', title: 'Home', text: 'Port', source: { original: 'Port', book: 'book', uid: 1 } })], 'remember');
    await store.commit({ operations: [{ type: 'create', kind: 'npc', title: 'Discarded NPC', text: 'Only in old reply', evidence: ['old'] }] }, { expectedRevision: store.state.revision, sourceKeys: ['u1', 'old'] });
    const npc = Object.values(store.state.data.entries).find(e => !e.source);
    await store.manual({ type: 'edit', id: 'home', segments: [{ id: 'body', text: 'South city', writable: true }] }, ['u1', 'old']);
    await store.manual({ type: 'edit', id: npc.id, intro: 'Manual description' }, ['u1', 'old']);
    await store.reconcile(['u1', 'new']);
    assert.equal(entryText(store.state.data.entries.home), 'South city');
    assert.equal(store.state.data.entries[npc.id], undefined);
    assert.ok(store.state.audit.some(a => a.entryId === 'home' && a.reason === 'edit'));
});

test('rebinding a worldbook preserves the old save and exposes an atomic rescan recovery', async () => {
    const f = await fixture(), saved = f.c.store.snapshot();
    f.state.bookName = 'renamed-book';
    await f.c.chatChanged();
    assert.equal(f.c.store.state.bookName, 'book');
    assert.equal(f.c.view().sourceChanges.changed, true);
    assert.equal(f.c.view().initialization.retry, true);
    assert.deepEqual((await f.host.storage.read('review')).data, saved.data);
    await f.c.initialize();
    assert.equal(f.c.store.state.bookName, 'renamed-book');
    assert.ok(f.c.store.state.data.entries['source:renamed-book:1']);
});

test('changing only a model retains its session credential but a new endpoint does not inherit it', async t => {
    const f = await fixture(), requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    });
    await f.c.updateConnection({ mode: 'compatible', endpoint: 'https://synthetic.example/v1', model: 'first', apiKey: 'synthetic-key' });
    await f.c.updateConnection({ mode: 'compatible', endpoint: 'https://synthetic.example/v1/', model: 'second', apiKey: '' });
    await f.c.client.complete({ purpose: 'select', system: 'test', input: {} });
    assert.equal(requests.at(-1).options.headers.Authorization, 'Bearer synthetic-key');
    assert.equal(f.c.view().connection.model, 'second');
    assert.equal(JSON.stringify(f.c.view()).includes('synthetic-key'), false);
    await f.c.updateConnection({ mode: 'compatible', endpoint: 'https://another.example/v1', model: 'third', apiKey: '' });
    await f.c.client.complete({ purpose: 'select', system: 'test', input: {} });
    assert.equal(requests.at(-1).options.headers.Authorization, undefined);
});

test('externally hidden messages never enter selection or maintenance while fish-owned omissions remain readable', async () => {
    const f = await fixture();
    f.state.messages.push({ ...message('private-hidden', 'user'), hidden: true, hiddenBy: 'other' },
        { ...message('owned-history'), hidden: true, hiddenBy: 'dynamic-world-memory' });
    await f.c.maintain(); await f.c.generationBefore({ type: 'normal' });
    const requests = f.calls.filter(call => ['maintain', 'select'].includes(call.purpose));
    assert.ok(requests.some(call => call.input.messages.some(m => m.key === 'owned-history')));
    assert.equal(requests.some(call => call.input.messages.some(m => m.key === 'private-hidden')), false);
});

for (const mixed of [false, true]) test(`manual corrections do not carry discarded facts from ${mixed ? 'the same text field' : 'another segment'}`, async () => {
    const store = new MemoryStore({ read: async () => null, write: async () => {} });
    await store.load('c', 'b');
    const segments = mixed ? [{ id: 'body', text: '黑发，住港口。', writable: true }]
        : [{ id: 'appearance', text: '黑发', writable: true }, { id: 'location', text: '住港口', writable: true }];
    await store.initialize([createEntry({ id: 'npc', kind: 'npc', segments })], 's');
    await store.commit({ operations: [{ type: 'update', id: 'npc', expectedVersion: 1,
        segments: [{ id: mixed ? 'body' : 'location', text: mixed ? '黑发，住王都。' : '住王都' }], evidence: ['old'] }] }, { expectedRevision: store.state.revision, sourceKeys: ['u', 'old'] });
    const edited = structuredClone(store.state.data.entries.npc.segments);
    edited[0].text = edited[0].text.replace('黑发', '白发');
    await store.manual({ type: 'edit', id: 'npc', segments: edited }, ['u', 'old']);
    await store.reconcile(['u', 'new']);
    assert.equal(entryText(store.state.data.entries.npc), mixed ? '白发，住港口。' : '白发住港口');
    assert.deepEqual(store.state.processed, []);
});

test('overlapping manual and branch text changes preserve the branch and request review', async () => {
    const store = new MemoryStore({ read: async () => null, write: async () => {} });
    await store.load('c', 'b'); await store.initialize([createEntry({ id: 'npc', text: '住港口' })], 's');
    await store.commit({ operations: [{ type: 'update', id: 'npc', expectedVersion: 1, segments: [{ id: 'body', text: '住王都' }], evidence: ['old'] }] }, { expectedRevision: store.state.revision, sourceKeys: ['u', 'old'] });
    await store.manual({ type: 'edit', id: 'npc', segments: [{ id: 'body', text: '住北城', writable: true }] }, ['u', 'old']);
    await store.reconcile(['u', 'new']);
    assert.equal(entryText(store.state.data.entries.npc), '住港口');
    assert.equal(store.state.data.entries.npc.needsReview, true);
});
