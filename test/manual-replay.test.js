import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core/store.js';
import { createEntry, entryTier } from '../src/core/state.js';

function storage() {
    const db = new Map();
    return { read: async id => db.get(id), write: async (id, data) => { db.set(id, structuredClone(data)); }, db };
}
async function setup() {
    const persistence = storage(), store = new MemoryStore(persistence);
    await store.load('chat', 'world');
    await store.initialize([
        createEntry({ id: 'gate', title: '城门', text: '白天开放', source: { original: '白天开放', book: 'world', uid: 1 } }),
        createEntry({ id: 'world', title: '世界', text: '和平', constant: true, source: { original: '和平', book: 'world', uid: 2 } }),
    ], '策略');
    // One remembered reply, so the candidate under test is the second.
    await store.commit({ operations: [{ type: 'create', kind: 'event', title: '旧回复事件', text: '第一条回复里发生', intro: 'x', retrieveWhen: 'x', evidence: ['a:0'] }] },
        { expectedRevision: store.state.revision, sourceKeys: ['u', 'a:0'] });
    return { store, persistence };
}
const imported = store => Object.values(store.state.data.entries).filter(e => e.origin === 'import');
const titled = (store, title) => Object.values(store.state.data.entries).find(e => e.title === title);
const importAction = (title, scopeId = 'global') => ({ type: 'import-memory', scopeId, entries: [{ title, content: `${title}的旧总结` }] });

test('R1: imported history survives a reroll and deleting the floor it was imported on', async () => {
    const { store, persistence } = await setup();
    await store.manual(importAction('旧总结'), ['u', 'a:0', 'u2', 'b:0']);
    assert.equal(imported(store).length, 1);
    await store.reconcile(['u', 'a:0', 'u2', 'b:1']);
    assert.deepEqual(imported(store).map(e => e.title), ['旧总结'], 'a swipe keeps it');
    await store.reconcile(['u', 'a:0']);
    assert.deepEqual(imported(store).map(e => e.title), ['旧总结'], 'deleting the import-time floors keeps it');
    assert.deepEqual(imported(store)[0].evidence, []);
    assert.equal(entryTier(imported(store)[0]), 'constant');
    assert.ok(titled(store, '旧回复事件'), 'memory from the surviving reply is unchanged');
    const reloaded = new MemoryStore(persistence); await reloaded.load('chat', 'world');
    assert.deepEqual(imported(reloaded).map(e => e.title), ['旧总结'], 'and after reload');
    await reloaded.reconcile(['u', 'a:1']);
    assert.deepEqual(imported(reloaded).map(e => e.title), ['旧总结']);
    assert.equal(titled(reloaded, '旧回复事件'), undefined, 'generated memory of a discarded reply still rolls back');
});

test('R1: later player changes to an import replay with it; other scopes and generated entries are unaffected', async () => {
    const { store } = await setup();
    await store.manual(importAction('主线总结'), ['u', 'a:0', 'u2', 'b:0']);
    await store.manual(importAction('支线总结', 'side'), ['u', 'a:0', 'u2', 'b:0']);
    const id = titled(store, '主线总结').id;
    await store.manual({ type: 'tier', id, tier: 'onDemand' }, ['u', 'a:0', 'u2', 'b:0', 'u3', 'c:0']);
    await store.commit({ operations: [{ type: 'create', kind: 'npc', title: '新回复人物', text: '只在被重写的回复里出现', intro: 'x', retrieveWhen: 'x', evidence: ['b:0'] }] },
        { expectedRevision: store.state.revision, sourceKeys: ['u', 'a:0', 'u2', 'b:0'] });
    await store.reconcile(['u', 'a:0', 'u2', 'b:1']);
    assert.deepEqual(imported(store).map(e => [e.title, e.scopeId]).sort(), [['主线总结', 'global'], ['支线总结', 'side']]);
    assert.equal(entryTier(titled(store, '主线总结')), 'onDemand', 'the player tier change on the import survives');
    assert.equal(titled(store, '新回复人物'), undefined);
});

test('tier changes, single and batch, survive a reroll of the reply they were made after', async () => {
    const { store } = await setup();
    const keys = ['u', 'a:0', 'u2', 'b:0'];
    await store.manual({ type: 'tier', id: 'gate', tier: 'constant' }, keys);
    await store.manual({ type: 'tiers', tier: 'off', items: [{ id: 'world', expectedVersion: store.state.data.entries.world.version }] }, keys);
    await store.reconcile(['u', 'a:0', 'u2', 'b:1']);
    assert.equal(entryTier(store.state.data.entries.gate), 'constant');
    assert.equal(entryTier(store.state.data.entries.world), 'off');
    assert.equal(store.state.data.entries.world.enabled, false);
    assert.ok(store.state.audit.some(item => item.entryId === 'gate' && item.reason === 'tier'), 'their audit records are kept');
});
