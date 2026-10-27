// Per-entry tier: 常驻 / 按需 / 关闭, set by the player on this save's dynamic
// copy, with a reset to the scanned tier. Requested 2026-10-21.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';
import { assemblePromptPlan } from '../src/runtime/prompt-plan.js';
import { frontCatalog, maintenanceView } from '../src/core/views.js';
import { encodeSave, decodeSave } from '../src/core/storage-codec.js';
import { entryTier, scannedTier, createEntry } from '../src/core/state.js';
import { compileRules } from '../src/rules/index.js';

const msg = (key, role = 'assistant', content = `${role} ${key}`) => ({ key, role, content, hidden: false, hiddenBy: null });
function fixture(book) {
    const state = { chatId: 'c', bookName: 'main', templateEnabled: true, generating: false, messages: [msg('m0')] };
    const db = new Map(), calls = [];
    const host = { snapshot: () => structuredClone(state), generationSnapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book),
        storage: { read: async id => structuredClone(db.get(id) ?? null), write: async (id, v) => db.set(id, structuredClone(v)) },
        clearPlan() {}, setPlan() {}, applyWindow: async () => {} };
    const model = { complete: async request => {
        calls.push({ purpose: request.purpose, titles: (request.input.entries ?? []).map(e => e.title) });
        if (request.purpose === 'initialize') return { strategy: 's', entries: request.input.entries.map(e => ({ id: e.id, kind: 'fact', intro: `简介${e.title}`, retrieveWhen: '相关时', segments: [{ id: 'body', writable: true }] })) };
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } };
    const make = () => new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1 } });
    return { state, db, calls, host, make, controller: make() };
}
const book = () => [
    { uid: 1, comment: '世界现状', content: '和平。', constant: true },
    { uid: 2, comment: '城门', content: '城门白天开放。', key: ['城门'] },
    { uid: 3, comment: '密道', content: '城北有密道。', disable: true },
];
const byTitle = (c, title) => Object.values(c.store.state.data.entries).find(e => e.title === title);
const plan = c => assemblePromptPlan(c.store.state, [], { eligible: () => true, compiledRules: compileRules('') });

test('tier defaults follow the scan and an explicit tier wins', () => {
    assert.equal(scannedTier({ enabled: true, constant: true }), 'constant');
    assert.equal(scannedTier({ enabled: true, important: true }), 'constant');
    assert.equal(scannedTier({ enabled: true }), 'onDemand');
    assert.equal(scannedTier({ enabled: false, constant: true }), 'off');
    assert.equal(entryTier({ enabled: true, constant: true, tier: 'onDemand' }), 'onDemand');
    assert.equal(entryTier({ enabled: true, tier: 'nonsense' }), 'onDemand');
    assert.equal(createEntry({ title: 't', text: 'x', tier: 'off' }).tier, 'off');
    assert.equal('tier' in createEntry({ title: 't', text: 'x' }), false, 'entries without a tier keep their old shape');
});

test('the player moves entries between always, on demand and off, and can restore the scanned tier', async () => {
    const f = fixture(book());
    const c = f.controller; await c.start(); await c.initialize();
    const blue = byTitle(c, '世界现状'), green = byTitle(c, '城门');
    assert.deepEqual(plan(c).selectedIds, [blue.id]);

    await c.manual({ type: 'tier', id: blue.id, tier: 'onDemand' });
    await c.manual({ type: 'tier', id: green.id, tier: 'constant' });
    assert.deepEqual(plan(c).selectedIds, [green.id], 'blue lamp now waits for selection, the green one is always sent');
    const catalog = frontCatalog(c.store.state);
    assert.equal(catalog.find(e => e.id === blue.id).constant, false);
    assert.equal(catalog.find(e => e.id === green.id).constant, true);

    await c.manual({ type: 'tier', id: green.id, tier: 'off' });
    assert.deepEqual(plan(c).selectedIds, []);
    assert.ok(!frontCatalog(c.store.state).some(e => e.id === green.id), 'off entries are not offered to selection');
    assert.ok(!maintenanceView(c.store.state).entries.some(e => e.id === green.id), 'off entries are not maintained');
    assert.equal(c.view().save.scannedTiers[green.id], 'onDemand');

    await c.manual({ type: 'tier-reset', id: green.id });
    await c.manual({ type: 'tier-reset', id: blue.id });
    assert.equal(byTitle(c, '城门').tier, undefined);
    assert.equal(entryTier(byTitle(c, '城门')), 'onDemand');
    assert.equal(entryTier(byTitle(c, '世界现状')), 'constant');
    assert.deepEqual(plan(c).selectedIds, [blue.id]);
    await assert.rejects(c.manual({ type: 'tier', id: blue.id, tier: 'maybe' }), /档位/);
});

test('a tier survives reloads, the storage codec and a metadata-only source update', async () => {
    const raw = book();
    const f = fixture(raw);
    await f.controller.start(); await f.controller.initialize();
    const blue = byTitle(f.controller, '世界现状');
    await f.controller.manual({ type: 'tier', id: blue.id, tier: 'onDemand' });
    const reloaded = f.make(); await reloaded.start();
    assert.equal(byTitle(reloaded, '世界现状').tier, 'onDemand');
    const roundTrip = decodeSave(JSON.parse(JSON.stringify(encodeSave(reloaded.store.state))));
    assert.equal(roundTrip.data.entries[blue.id].tier, 'onDemand');
    raw[0].key = ['现状']; // metadata only
    await reloaded.syncSourceChanges();
    assert.equal(entryTier(byTitle(reloaded, '世界现状')), 'onDemand', 'syncing the original book keeps the player tier');
});

test('turning on an entry that was off at scan time scans just that entry once', async () => {
    const f = fixture(book());
    const c = f.controller; await c.start(); await c.initialize();
    const hidden = byTitle(c, '密道');
    assert.equal(hidden.status, 'deferred');
    f.calls.length = 0;
    await c.manual({ type: 'tier', id: hidden.id, tier: 'onDemand' });
    assert.deepEqual(f.calls.filter(x => x.purpose === 'initialize').map(x => x.titles), [['密道']]);
    const now = byTitle(c, '密道');
    assert.equal(now.status, 'confirmed'); assert.equal(now.enabled, true); assert.equal(now.intro, '简介密道');
    assert.ok(frontCatalog(c.store.state).some(e => e.id === hidden.id));
    f.calls.length = 0;
    await c.manual({ type: 'tier', id: hidden.id, tier: 'constant' });
    assert.equal(f.calls.length, 0, 'already scanned: no further call');
});

test('native activation follows the tier on the dynamic copy', async () => {
    const live = { chatId: 'chat-1', characterId: 0, characters: [{ avatar: 'a.png', data: { extensions: { world: 'main' } } }], chatMetadata: {}, chat: [] };
    const host = await createSillyTavernHost({ context: () => live, worldInfo: { loadWorldInfo: async () => ({ entries: {} }) },
        script: { extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0 }, setExtensionPrompt() {} }, extensions: { findExtension: () => ({ enabled: true }) } });
    const dyn = (uid, tier) => ({ id: `source:main:${uid}`, source: { book: 'main', uid }, segments: [{ text: `动态${uid}` }], enabled: tier !== 'off', ...(tier ? { tier } : {}) });
    host.setPlan({ chatId: host.snapshot().chatId, bookName: 'main', selectedIds: ['source:main:2'],
        dynamicEntries: [dyn(1, 'onDemand'), dyn(2, 'onDemand'), dyn(3, 'constant'), dyn(4, 'off'), dyn(5, 'constant')] });
    const native = () => [
        { uid: 1, constant: true, disable: false }, { uid: 2, constant: true, disable: false },
        { uid: 3, constant: false, disable: false }, { uid: 4, constant: true, disable: false }, { uid: 5, constant: false, disable: true },
    ].map(e => ({ ...e, world: 'main', content: '原文' }));
    const data = { characterLore: native() };
    host.applyWorldInfoEntries(data);
    // The plan's selectedIds already include always-sent entries (assemblePromptPlan).
    assert.deepEqual(data.characterLore.map(e => e.uid), [2], 'only what fish chose is sent');
    host.setPlan({ chatId: host.snapshot().chatId, bookName: 'main', selectedIds: ['source:main:2', 'source:main:3', 'source:main:4', 'source:main:5'],
        dynamicEntries: [dyn(1, 'onDemand'), dyn(2, 'onDemand'), dyn(3, 'constant'), dyn(4, 'off'), dyn(5, 'constant')] });
    const again = { characterLore: native() };
    host.applyWorldInfoEntries(again);
    assert.deepEqual(again.characterLore.map(e => [e.uid, e.constant, e.disable]), [[2, true, false], [3, true, false], [5, true, false]],
        'off wins over selection; a natively disabled entry turned on by the player is sent');
});

test('batch tiers save once, preserve original book and do not call the model for classified entries', async () => {
    const original = book(), f = fixture(original), c = f.controller;
    await c.start(); await c.initialize();
    const ids = Object.values(c.store.state.data.entries).filter(e => e.status !== 'deferred').map(e => e.id);
    const before = c.store.snapshot(), calls = f.calls.length;
    await c.setEntryTiers(ids, 'onDemand');
    assert.equal(c.store.state.revision, before.revision + 1);
    assert.equal(c.store.state.journal.length, before.journal.length + 1);
    assert.equal(f.calls.length, calls);
    assert.ok(ids.every(id => entryTier(c.store.state.data.entries[id]) === 'onDemand'));
    assert.deepEqual(original, book());
    const restored = f.make(); await restored.start();
    assert.ok(ids.every(id => entryTier(restored.store.state.data.entries[id]) === 'onDemand'));
});
test('batch tiers classify deferred entries before a single save and reject invalid selection atomically', async () => {
    const f = fixture(book()), c = f.controller; await c.start(); await c.initialize();
    const ids = Object.keys(c.store.state.data.entries), before = c.store.state.revision;
    await assert.rejects(c.setEntryTiers([...ids, 'missing'], 'constant'), /不存在/);
    assert.equal(c.store.state.revision, before);
    await c.setEntryTiers(ids, 'constant');
    assert.ok(ids.every(id => entryTier(c.store.state.data.entries[id]) === 'constant'));
    assert.equal(byTitle(c, '密道').status, 'confirmed');
    assert.equal(c.store.state.revision, before + 1);
});

test('supplement import adds protected facts without replacing main book or certifying unprocessed history', async () => {
    const original = book(), f = fixture(original), c = f.controller; await c.start(); await c.initialize();
    f.state.messages.push(msg('pending', 'assistant', '还没补记'));
    const before = c.store.snapshot(), calls = f.calls.length;
    await c.importSupplementaryMemory([{ title: '旧总结', content: '以前在北城生活。' }], before.id);
    assert.equal(c.store.state.bookName, 'main'); assert.deepEqual(original, book());
    assert.deepEqual(c.store.state.processed, before.processed);
    const imported = byTitle(c, '旧总结'); assert.ok(imported.constant); assert.ok(imported.segments.every(s => !s.writable));
    assert.equal(imported.source, null); assert.equal(f.calls.length, calls);
    await c.importSupplementaryMemory([{ title: '旧总结', content: '以前在北城生活。' }], before.id);
    assert.equal(Object.values(c.store.state.data.entries).filter(e => e.title === '旧总结').length, 1);
    await assert.rejects(c.importSupplementaryMemory([{ title: 'x', content: 'y' }], 'another-save'), /存档已切换/);
    await assert.rejects(c.importSupplementaryMemory([{ title: 'x', content: 'y' }], before.id, 'other-scope'), /范围已改变/);
    const reload = f.make(); await reload.start(); assert.ok(byTitle(reload, '旧总结'));
});

test('failed bulk save leaves every selected entry unchanged', async () => {
    const f = fixture(book()), c = f.controller; await c.start(); await c.initialize();
    const before = c.store.snapshot();
    c.store.storage.write = async () => { throw new Error('synthetic save failure'); };
    await assert.rejects(c.setEntryTiers(Object.keys(before.data.entries), 'off'), /synthetic save failure/);
    assert.deepEqual(c.store.snapshot(), before);
});
