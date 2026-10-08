import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { sourceBookChanges } from '../src/core/source-book.js';
import { MemoryStore } from '../src/core/store.js';
import { makeSourceEntry } from '../src/core/state.js';
const raw = { uid: 1, comment: '住址', content: '港口', constant: true, disable: false };
async function fixture() {
    let saved;
    const storage = { read: async () => structuredClone(saved), write: async (_id, value) => { saved = structuredClone(value); } };
    const seed = new MemoryStore(storage); await seed.load('chat', 'book'); await seed.initialize([makeSourceEntry('book', raw)], 'remember');
    return { seed, storage };
}
test('source comparison detects same-name edits, activation changes, additions and removals', async () => {
    const { seed } = await fixture();
    assert.equal(sourceBookChanges(seed.state, [Object.fromEntries(Object.entries(raw).reverse())]).changed, false);
    assert.equal(sourceBookChanges(seed.state, [{ ...raw, content: '北城' }]).updated.length, 1);
    assert.equal(sourceBookChanges(seed.state, [{ ...raw, disable: true }]).changed, true);
    assert.equal(sourceBookChanges(seed.state, []).removed.length, 1);
    assert.equal(sourceBookChanges(seed.state, [raw, { ...raw, uid: 2 }]).added.length, 1);
});
test('same-name upgrade warns, prevents old baseline reset and sends original on explicit fallback without model calls', async () => {
    const { storage } = await fixture(); let calls = 0, plans = 0;
    const host = { storage, snapshot: () => ({ chatId: 'chat', bookName: 'book', templateEnabled: true, messages: [] }),
        loadWorldbook: async () => [{ ...raw, content: '北城' }], clearPlan() {}, setPlan() { plans++; }, applyWindow() {} };
    const c = new Controller(host, { model: { complete: async () => { calls++; return { ids: [] }; } }, chooseFallback: async () => 'original' });
    await c.start();
    assert.equal(c.view().sourceChanges.changed, true);
    await assert.rejects(c.manual({ type: 'reset', id: 'source:book:1', confirmed: true }), /原书已变化/);
    await c.generationBefore({ type: 'normal' });
    assert.equal(plans, 0); assert.equal(calls, 0);
    assert.equal(c.store.state.data.entries['source:book:1'].source.original, '港口');
});

const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function changingSourceFixture(model) {
    const { storage } = await fixture(), current = structuredClone(raw), calls = [], plans = [];
    const state = { chatId: 'chat', bookName: 'book', templateEnabled: true,
        messages: [{ key: 'pending', role: 'user', content: 'New history', index: 0 }] };
    const host = { storage, snapshot: () => structuredClone(state), loadWorldbook: async () => [structuredClone(current)],
        clearPlan() {}, setPlan(plan) { plans.push(plan); }, applyWindow() {} };
    const c = new Controller(host, { model: { complete: async request => { calls.push(request.purpose); return model(request); } },
        chooseFallback: async () => 'original' });
    await c.start();
    return { c, current, state, calls, plans };
}

test('native editor display order changes do not invalidate the source baseline', async () => {
    const f = await changingSourceFixture(async () => ({ ids: [] }));
    f.current.displayIndex = 42;
    assert.equal(sourceBookChanges(f.c.store.state, [f.current]).changed, false);
    await f.c.generationBefore({ type: 'normal' });
    assert.equal(f.plans.length, 1);
    assert.equal(f.c.view().sourceChanges.changed, false);
    assert.equal(sourceBookChanges(f.c.store.state, [{ ...f.current, order: 42 }]).changed, true, 'actual insertion order is still author-controlled metadata');
});

for (const mode of ['select', 'maintain', 'compact']) test(`${mode} rejects a result when the source changes during its model request`, async () => {
    const entered = gate(), resume = gate();
    const f = await changingSourceFixture(async request => {
        entered.resolve(); await resume.promise;
        return request.purpose === 'select' ? { ids: [] } : { operations: [{ type: 'summary', text: 'A result based on the previous source.' }] };
    });
    const before = structuredClone(f.c.store.state);
    const running = mode === 'select' ? f.c.generationBefore({ type: 'normal' }) : f.c[mode]();
    const checked = mode === 'select' ? running : assert.rejects(running, /原书已变化/);
    await entered.promise; f.current.content = '新版住址'; resume.resolve();
    await checked;
    assert.equal(f.plans.length, 0);
    assert.deepEqual(f.c.store.state, before, 'late model output must not modify the saved baseline or story');
    assert.equal(f.c.view().sourceChanges.changed, true);
});

test('re-enabling inventory does not bypass a known source change or spend a maintenance request', async () => {
    const f = await changingSourceFixture(async () => ({ operations: [{ type: 'inventory', items: [{ name: 'key', description: 'old source result' }] }] }));
    await f.c.manual({ type: 'inventory-toggle', enabled: false });
    f.current.content = '新版住址';
    await assert.rejects(f.c.previewPlan(), /原书已变化/);
    assert.equal(f.c.view().sourceChanges.changed, true);
    await assert.rejects(f.c.manual({ type: 'inventory-toggle', enabled: true }), /原书已变化/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.c.store.state.data.inventory, []);
    assert.notEqual(f.c.store.state.inventoryDisabledAt, null, 'unreconciled inventory stays unavailable for injection');
});

test('inventory catch-up rejects a source change while the model is running', async () => {
    const entered = gate(), resume = gate();
    const f = await changingSourceFixture(async () => {
        entered.resolve(); await resume.promise;
        return { operations: [{ type: 'inventory', items: [{ name: 'key', description: 'old source result' }] }] };
    });
    await f.c.manual({ type: 'inventory-toggle', enabled: false });
    const running = assert.rejects(f.c.manual({ type: 'inventory-toggle', enabled: true }), /原书已变化/);
    await entered.promise; f.current.content = '新版住址'; resume.resolve(); await running;
    assert.deepEqual(f.c.store.state.data.inventory, []);
    assert.notEqual(f.c.store.state.inventoryDisabledAt, null);
    assert.equal(f.c.view().sourceChanges.changed, true);
});

test('read-only prompt preview identifies a source upgrade and does not show old memory as sendable', async () => {
    const f = await changingSourceFixture(async () => ({ ids: [] }));
    f.current.content = '新版住址';
    const before = structuredClone(f.c.store.state), preview = await f.c.previewPrompts();
    const narration = preview.stages.find(stage => stage.id === 'narration');
    assert.equal(narration.input, null);
    assert.match(narration.explanation, /原书已变化/);
    assert.match(preview.warnings.join('\n'), /原书已变化/);
    for (const stage of preview.stages.filter(stage => ['fish-select', 'fish-maintain'].includes(stage.agent.id))) {
        assert.equal(stage.status, 'unavailable'); assert.equal(stage.input, null);
    }
    assert.deepEqual(f.c.store.state, before, 'inspection does not rebuild or mutate the archive');
    assert.deepEqual(f.calls, []);
});
