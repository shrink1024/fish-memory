import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';

const LOST = 'The brass key was lost in the river.';
const KEPT = 'The brass key remains in the coat pocket.';
const THIRD = 'The brass key was given to the librarian.';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

function events() {
    const listeners = new Map();
    const types = Object.fromEntries(['MESSAGE_SWIPE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'CHAT_CHANGED'].map(name => [name, name]));
    return { types, source: {
        on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
        removeListener(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
        async emit(name, ...args) { for (const fn of listeners.get(name) ?? []) await fn(...args); },
    } };
}

async function fixture(t, { candidates = [LOST, KEPT, THIRD], live: restored } = {}) {
    const previous = globalThis.EjsTemplate;
    globalThis.EjsTemplate = { getFeatures: () => ({ enabled: true }) };
    t.after(() => { globalThis.EjsTemplate = previous; });
    const { source, types } = events();
    const shared = { dwmKey: 'native-shared-extra' };
    const tail = { is_user: false, is_system: false, mes: candidates[0], swipe_id: 0,
        extra: structuredClone(shared), swipes: [...candidates],
        swipe_info: candidates.map(() => ({ extra: structuredClone(shared) })) };
    const live = restored ?? { chatId: 'candidate-test', characterId: 0,
        characters: [{ avatar: 'ordinary.png', data: { extensions: { world: 'ordinary' } } }], chatMetadata: {},
        chat: [{ is_user: true, is_system: false, mes: 'Where is the key?', extra: { dwmKey: 'user' } }, tail] };
    const calls = [], slots = new Map();
    const host = await createSillyTavernHost({ context: () => live, eventSource: source, eventTypes: types,
        extensions: { findExtension: () => ({ enabled: true }) }, worldInfo: { loadWorldInfo: async () => ({ entries: {} }) },
        save: async () => {}, script: { setExtensionPrompt: (key, value) => slots.set(key, value) } });
    const controller = new Controller(host, { settings: { enabled: true, maintenanceEvery: 1, windowEnabled: false }, model: { complete: async request => {
        calls.push(structuredClone({ purpose: request.purpose, input: request.input }));
        if (request.purpose === 'select') return { ids: [] };
        if (request.purpose === 'maintain') return { operations: [{ type: 'summary',
            text: [request.input.memory.summary, ...request.input.messages.map(message => message.content)].filter(Boolean).join('\n') }] };
        throw new Error(`Unexpected purpose ${request.purpose}`);
    } } });
    await controller.start();
    if (!restored) await controller.initialize();
    const dispose = host.bindController(controller);
    t.after(dispose);
    const f = { live, host, controller, source, types, calls, slots, dispose,
        key: () => host.snapshot().messages.at(-1).key,
        maintains: () => calls.filter(call => call.purpose === 'maintain'),
        summary: () => controller.store.state.data.summary,
        async select(index) {
            const item = live.chat.at(-1);
            item.swipe_id = index; item.mes = item.swipes[index]; item.extra = structuredClone(item.swipe_info[index]?.extra ?? {});
            await source.emit(types.MESSAGE_SWIPED, live.chat.length - 1); await controller.whenIdle();
        },
        async remove(index) {
            const item = live.chat.at(-1), selected = item.swipe_id;
            item.swipes.splice(index, 1); item.swipe_info.splice(index, 1);
            item.swipe_id = index < selected ? selected - 1 : index > selected ? selected : Math.min(index, item.swipes.length - 1);
            await source.emit(types.MESSAGE_SWIPE_DELETED, { messageId: live.chat.length - 1, swipeId: index, newSwipeId: item.swipe_id });
            // The real host can await animation before changing mes and extra.
            if (index === selected) { await tick(); await f.select(item.swipe_id); }
            await tick(); await controller.whenIdle();
        },
    };
    return f;
}

test('native shared-extra candidates: deleting selected first candidate only remembers and injects surviving outcome', async t => {
    const f = await fixture(t), oldKey = f.key();
    await f.remove(0);
    assert.notEqual(f.key(), oldKey, 'surviving candidate must not inherit deleted candidate identity');
    assert.equal(f.summary().includes(LOST), false, 'deleted outcome is rolled back');
    assert.ok(f.summary().includes(KEPT), 'surviving selected outcome is remembered');
    assert.ok(f.maintains().slice(1).every(call => !call.input.messages.some(m => m.content === LOST)), 'deletion event must not remember stale mes under the replacement identity');
    await f.controller.generationBefore({ type: 'normal' });
    assert.equal(f.slots.get('dwm:summary').includes(LOST), false);
    assert.ok(f.slots.get('dwm:summary').includes(KEPT));
    assert.deepEqual(f.controller.store.state.processed, f.host.snapshot().messages.map(m => m.key));
});

test('removing an earlier unselected candidate preserves selected identity and does not rebuild valid memory', async t => {
    const f = await fixture(t); await f.select(2);
    const selectedKey = f.key(), summary = f.summary(), maintains = f.maintains().length;
    await f.remove(0);
    assert.equal(f.key(), selectedKey);
    assert.equal(f.summary(), summary);
    assert.equal(f.maintains().length, maintains);
});

test('candidate reordering and selection back retain identities across refresh and a cloned branch', async t => {
    const f = await fixture(t); await f.select(1);
    const keptKey = f.key();
    await f.select(2); const thirdKey = f.key();
    const tail = f.live.chat.at(-1);
    [tail.swipes[0], tail.swipes[1]] = [tail.swipes[1], tail.swipes[0]];
    [tail.swipe_info[0], tail.swipe_info[1]] = [tail.swipe_info[1], tail.swipe_info[0]];
    await f.select(0);
    assert.equal(f.key(), keptKey);
    assert.equal(f.summary().includes(THIRD), false);
    assert.ok(f.summary().includes(KEPT));
    const saved = structuredClone(f.live); f.dispose();
    const refreshed = await fixture(t, { live: saved });
    assert.equal(refreshed.key(), keptKey);
    await refreshed.select(2); assert.equal(refreshed.key(), thirdKey);
    const branch = structuredClone(saved); branch.chatId = 'candidate-test-branch';
    const branched = await fixture(t, { live: branch });
    await branched.select(0);
    assert.equal(branched.key(), keptKey);
    assert.equal(branched.summary().includes(THIRD), false);
    assert.ok(branched.summary().includes(KEPT));
});

test('ordinary edits of selected history do not change identity or automatically rebuild memory', async t => {
    const f = await fixture(t), key = f.key(), count = f.maintains().length;
    const tail = f.live.chat.at(-1); tail.mes = 'An ordinary manual edit.'; tail.swipes[0] = tail.mes;
    assert.equal(f.key(), key);
    await f.controller.generationBefore({ type: 'normal' });
    assert.equal(f.maintains().length, count);
    assert.ok(f.summary().includes(LOST));
});

test('dev.11 archives retain their remembered legacy keys on upgrade, refresh, and branch before deletion', async t => {
    const original = await fixture(t); await original.select(1);
    const oldKeys = original.controller.store.state.processed, oldSummary = original.summary();
    const archived = structuredClone(original.live);
    for (const message of archived.chat) {
        delete message.extra.dwmCandidateKey;
        for (const info of message.swipe_info ?? []) { delete info.dwmCandidateKey; delete info.extra.dwmCandidateKey; }
    }
    original.dispose();
    const upgraded = await fixture(t, { live: archived });
    assert.deepEqual(upgraded.host.snapshot().messages.map(m => m.key), oldKeys);
    assert.equal(upgraded.summary(), oldSummary);
    assert.equal(upgraded.maintains().length, 0, 'installing the new version does not rescan a valid archive');
    const copied = structuredClone(archived); copied.chatId = 'old-archive-branch';
    const branch = await fixture(t, { live: copied });
    assert.equal(branch.key(), oldKeys.at(-1));
    await branch.remove(0);
    assert.equal(branch.key(), oldKeys.at(-1));
    assert.equal(branch.summary(), oldSummary);
    await branch.remove(0);
    assert.ok(branch.summary().includes(THIRD));
    assert.equal(branch.summary().includes(KEPT), false);
});

test('saveReply copying an already assigned extra identity to multiple completions gives each a distinct durable identity', async t => {
    const f = await fixture(t, { candidates: ['An earlier reply.'] });
    const generated = { is_user: false, is_system: false, mes: LOST, extra: {} };
    f.live.chat.push(generated);
    await f.source.emit(f.types.MESSAGE_RECEIVED, 2, 'normal');
    // ST finalizes the selected swipe and clones extra into all completions
    // only after MESSAGE_RECEIVED has let the plugin take its first snapshot.
    assert.ok(generated.extra.dwmCandidateKey);
    generated.swipe_id = 0;
    generated.swipes = [LOST, KEPT, THIRD];
    generated.swipe_info = generated.swipes.map(() => ({ extra: structuredClone(generated.extra) }));
    await tick(); await f.controller.whenIdle();
    const oldKey = f.key(), keys = generated.swipe_info.map(info => info.dwmCandidateKey);
    assert.equal(new Set(keys).size, 3);
    assert.equal(keys[0], oldKey);
    assert.ok(f.summary().includes(LOST));
    await f.remove(0);
    assert.equal(f.key(), keys[1]);
    assert.equal(f.summary().includes(LOST), false);
    assert.ok(f.summary().includes(KEPT));
    const disk = structuredClone(f.live); f.dispose();
    const refreshed = await fixture(t, { live: disk });
    assert.equal(refreshed.key(), keys[1]);
    assert.ok(refreshed.summary().includes(KEPT));
    assert.equal(refreshed.maintains().length, 0);
});

test('native swipe_info replacement during continue preserves the candidate identity through its extra mirror', async t => {
    const f = await fixture(t); await f.select(1);
    const key = f.key(), tail = f.live.chat.at(-1);
    tail.mes += ' It is wrapped in a handkerchief.';
    tail.swipes[1] = tail.mes;
    tail.swipe_info[1] = { extra: structuredClone(tail.extra) };
    assert.equal(f.key(), key);
    await f.source.emit(f.types.MESSAGE_RECEIVED, 1, 'continue');
    await tick(); await f.controller.whenIdle();
    assert.equal(f.key(), key);
    assert.ok(f.summary().includes('handkerchief'));
    assert.equal(f.summary().includes(LOST), false);
});
