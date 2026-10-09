import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';

const nativeOptions = () => Object.fromEntries(['automatic_trigger', 'force_name2', 'quiet_prompt', 'quietToLoud', 'skipWIAN', 'force_chid', 'signal', 'quietImage'].map(key => [key, undefined]));

const BASE = 'remembered earlier history';
const OLD = 'discarded old reply';
const NEW = 'replacement reply';
const DYNAMIC = 'remembered dynamic source';
const message = (id, mes, user = false) => ({ is_user: user, is_system: false, mes, extra: { dwmKey: id },
    ...(user ? {} : { swipe_id: 0, swipes: [mes], swipe_info: [{ extra: { dwmKey: id } }] }) });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function events() {
    const listeners = new Map();
    const names = ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'WORLDINFO_ENTRIES_LOADED'];
    const types = Object.fromEntries(names.map(name => [name, name]));
    return { types, source: {
        on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
        removeListener(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
        makeFirst(name, fn) { this.removeListener(name, fn); listeners.set(name, [fn, ...(listeners.get(name) ?? [])]); },
        async emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) await fn(...args); },
    } };
}
async function fixture(t, { scoped = false, singleBatch = false, selectFailure = false } = {}) {
    const previous = globalThis.EjsTemplate;
    globalThis.EjsTemplate = { getFeatures: () => ({ enabled: true }) };
    t.after(() => { globalThis.EjsTemplate = previous; });
    const { source, types } = events();
    const live = { chatId: 'reroll', characterId: 0,
        characters: [{ avatar: 'synthetic.png', data: { extensions: { world: 'main' } } }], chatMetadata: {},
        chat: [message('u1', 'first question', true), message('a1', BASE), message('u2', 'repeat the ending', true)] };
    const raw = { uid: 1, comment: 'Source fact', content: 'original source', constant: true, disable: false };
    const slots = new Map(), calls = [];
    let generating = false;
    const host = await createSillyTavernHost({ context: () => live, eventSource: source, eventTypes: types,
        extensions: { findExtension: () => ({ enabled: true }) }, worldInfo: { loadWorldInfo: async () => ({ entries: { 1: raw } }) },
        save: async () => {}, stopGeneration: () => source.emit(types.GENERATION_STOPPED),
        script: { isGenerating: () => generating, setExtensionPrompt: (key, value) => slots.set(key, value) } });
    const model = { complete: async request => {
        calls.push(structuredClone({ purpose: request.purpose, input: request.input }));
        if (request.purpose === 'initialize') return { strategy: 'remember selected history', entries: request.input.entries.map(e => ({
            id: e.id, kind: 'fact', intro: e.title, segments: [{ id: 'body', text: e.content, writable: true }],
        })) };
        if (request.purpose === 'select') {
            if (selectFailure) throw new Error('synthetic selection failed');
            return { ids: request.input.catalog.map(e => e.id) };
        }
        if (request.purpose === 'maintain') {
            const text = request.input.messages.map(m => m.content).join('; ');
            const operations = [{ type: 'summary', text: [request.input.memory.summary, text].filter(Boolean).join('; ') }];
            if (text.includes(BASE)) {
                const entry = request.input.memory.entries.find(e => e.id === 'source:main:1');
                operations.push({ type: 'update', id: entry.id, expectedVersion: entry.version,
                    segments: [{ id: 'body', text: DYNAMIC }], evidence: request.input.messages.map(m => m.key) });
            }
            if (text.includes(OLD)) operations.push({ type: 'create', kind: 'event', title: 'Old outcome', intro: OLD, text: OLD,
                evidence: request.input.messages.filter(m => m.content.includes(OLD)).map(m => m.key) });
            return { operations };
        }
        return { operations: [] };
    } };
    const c = new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1, recentTurns: 1, windowEnabled: true, batchChars: 100000, compactEvery: 100000 } });
    if (singleBatch) live.chat.push(message('a2', OLD));
    await c.start(); await c.initialize();
    if (scoped) { await c.setContext({ owner: 'card', activeScopeId: 'A' }); await c.whenIdle(); }
    if (!singleBatch) { live.chat.push(message('a2', OLD)); await c.maintain(); }
    const dispose = host.bindController(c);
    t.after(dispose);
    if (scoped) source.makeFirst(types.GENERATION_AFTER_COMMANDS, () => c.setContext({ owner: 'card', activeScopeId: 'A', deferPost: true }));
    return { host, c, live, slots, calls, raw, source, types, setGenerating: value => { generating = value; },
        emit: (name, ...args) => source.emit(types[name], ...args),
        summary: () => [c.store.state.data.summary, ...Object.values(c.store.state.data.scopeSummaries)].join('\n'),
        async start(type) {
            generating = true;
            if (type === 'swipe') { live.chat.at(-1).swipe_id = live.chat.at(-1).swipes.length; await source.emit(types.MESSAGE_SWIPED, live.chat.length - 1); }
            await source.emit(types.GENERATION_STARTED, type, nativeOptions(), false);
            await source.emit(types.GENERATION_AFTER_COMMANDS, type, nativeOptions(), false);
        },
        async receive(type) {
            if (type === 'regenerate') live.chat.push(message('new', NEW));
            else { const tail = live.chat.at(-1); tail.mes = NEW; tail.swipes[tail.swipe_id] = NEW; }
            await source.emit(types.MESSAGE_RECEIVED, live.chat.length - 1, type);
            generating = false;
            await source.emit(types.GENERATION_ENDED);
            await tick(); await c.whenIdle();
            if (scoped) { await c.setContext({ owner: 'card', activeScopeId: 'A', postScopeId: 'A', deferPost: false }); await c.whenIdle(); }
        },
    };
}
for (const type of ['regenerate', 'swipe']) for (const scoped of [false, true]) {
    test(`${type}${scoped ? ' with deferred card' : ''}: actual native order excludes old branch and keeps injection through replacement`, async t => {
        const f = await fixture(t, { scoped });
        const saved = structuredClone(f.c.store.state);
        await f.start(type);
        const input = f.calls.findLast(call => call.purpose === 'select').input;
        assert.equal(JSON.stringify(input).includes(OLD), false, 'no replaced text, summary or event enters selection');
        assert.equal(f.summary().includes(OLD), true, 'preflight must not destroy saved old candidate memory');
        if (scoped) assert.equal(JSON.stringify(await f.c.readScope('A')).includes(OLD), false, 'card reads use the same prospective branch');
        if (type === 'regenerate') { f.live.chat.pop(); await f.emit('MESSAGE_DELETED', f.live.chat.length); }
        assert.ok((await f.c.whenCommitted()).pendingCount >= 0);
        assert.ok(f.slots.get('dwm:summary').includes(BASE));
        assert.equal(f.slots.get('dwm:summary').includes(OLD), false);
        const lore = { characterLore: [{ ...f.raw, world: 'main' }] };
        await f.emit('WORLDINFO_ENTRIES_LOADED', lore);
        assert.equal(lore.characterLore[0].content, DYNAMIC);
        assert.deepEqual(f.c.store.state.processed, saved.processed, 'replacement deletion must not commit a speculative path');
        await f.receive(type);
        assert.equal(f.summary().includes(OLD), false);
        assert.ok(f.summary().includes(NEW));
        assert.equal(JSON.stringify(Object.values(f.c.store.state.data.entries)).includes(OLD), false);
        assert.deepEqual(f.c.store.state.processed, f.host.snapshot().messages.map(m => m.key));
    });
}
for (const type of ['regenerate', 'swipe']) for (const failure of ['stop', 'preflight failure']) {
    test(`${type}: ${failure} and original candidate restoration preserve valid remembered history`, async t => {
        const f = await fixture(t, { scoped: true, selectFailure: failure === 'preflight failure' });
        const previous = structuredClone(f.live.chat.at(-1));
        const originalSummary = f.summary();
        const previousCalls = f.calls.filter(c => c.purpose === 'maintain').length;
        if (failure === 'preflight failure') await assert.rejects(f.start(type), { name: 'AbortError' });
        else await f.start(type);
        if (failure === 'stop') {
            if (type === 'regenerate') { f.live.chat.pop(); await f.emit('MESSAGE_DELETED', f.live.chat.length); }
            await f.emit('GENERATION_STOPPED');
        }
        f.live.chat[3] = previous; f.setGenerating(false);
        await f.c.setContext({ owner: 'card', activeScopeId: 'A', postScopeId: 'A', deferPost: false });
        await f.emit('MESSAGE_SWIPED', 3); await f.c.whenIdle();
        assert.equal(f.summary(), originalSummary);
        assert.deepEqual(f.c.store.state.processed, f.host.snapshot().messages.map(m => m.key));
        assert.equal(f.calls.filter(c => c.purpose === 'maintain').length, previousCalls, 'restoring original path does not rebuild its remembered outcome');
        assert.equal(f.slots.get('dwm:summary'), '');
    });
}
test('regenerate does not suppress unrelated deletion or a second delete', async t => {
    const f = await fixture(t);
    await f.start('regenerate');
    f.live.chat.pop(); await f.emit('MESSAGE_DELETED', 3);
    assert.ok(f.slots.get('dwm:summary'));
    f.live.chat.pop(); await f.emit('MESSAGE_DELETED', 2); await tick(); await f.c.whenIdle();
    assert.equal(f.slots.get('dwm:summary'), '');
    assert.deepEqual(f.c.store.state.processed, f.host.snapshot().messages.map(m => m.key));
    assert.equal(f.summary().includes(OLD), false);
});
test('regenerate restores raw history omitted by rollback of a whole memory batch', async t => {
    const f = await fixture(t, { singleBatch: true });
    assert.ok(f.host.snapshot().messages[1].hidden);
    assert.equal(f.live.chat[1].is_system, false, 'window never mutates saved history');
    await f.start('regenerate');
    const input = f.calls.findLast(call => call.purpose === 'select').input;
    assert.equal(input.summary.includes(OLD), false);
    assert.equal(JSON.stringify(input).includes(OLD), false);
    assert.ok(input.messages.some(m => m.content === BASE));
    assert.equal(f.live.chat[1].is_system, false, 'without a surviving summary, earlier raw history must re-enter native prompt');
});
test('stopped regenerate keeps original memory when card cleanup precedes native candidate restoration', async t => {
    const f = await fixture(t, { scoped: true });
    const previous = structuredClone(f.live.chat.at(-1)), summary = f.summary();
    await f.start('regenerate');
    f.live.chat.pop(); await f.emit('MESSAGE_DELETED', 3);
    await f.emit('GENERATION_STOPPED');
    await f.emit('GENERATION_ENDED');
    await f.c.setContext({ owner: 'card', activeScopeId: 'A', postScopeId: 'A', deferPost: false });
    assert.equal(f.summary(), summary, 'scope cleanup must not commit the temporary missing tail');
    f.live.chat.push(previous);
    await f.emit('MESSAGE_SWIPED', 3); await f.c.whenIdle();
    assert.equal(f.summary(), summary);
    assert.deepEqual(f.c.store.state.processed, f.host.snapshot().messages.map(m => m.key));
});
test('a finished failed generation cannot claim a later user deletion as its native replacement', async t => {
    const f = await fixture(t);
    await f.start('regenerate');
    // Native unblockGeneration clears is_send_press before ENDED. The event
    // alone can also come from a foreign generator while this one is active.
    f.setGenerating(false);
    await f.emit('GENERATION_ENDED');
    f.live.chat.pop(); await f.emit('MESSAGE_DELETED', 3); await tick(); await f.c.whenIdle();
    assert.equal(f.summary().includes(OLD), false);
    assert.deepEqual(f.c.store.state.processed, f.host.snapshot().messages.map(m => m.key));
});
for (const type of ['regenerate', 'swipe']) test(`${type}: unidentified end retains the active replacement and its stored original history`, async t => {
    const f = await fixture(t);
    await f.start(type);
    const saved = structuredClone(f.c.store.state), summary = f.slots.get('dwm:summary');
    assert.ok(f.host.pendingReplacement());
    await f.emit('GENERATION_ENDED');
    assert.ok(f.host.pendingReplacement(), 'END alone cannot settle this replacement');
    assert.equal(f.slots.get('dwm:summary'), summary);
    assert.deepEqual(f.c.store.state, saved, 'an unrelated end never commits a speculative branch');
});
test('trial selection during an unfilled swipe leaves the original saved journal intact', async t => {
    const f = await fixture(t);
    const saved = structuredClone(f.c.store.state);
    f.live.chat.at(-1).swipe_id = 1;
    await f.emit('MESSAGE_SWIPED', 3);
    const plan = await f.c.previewPlan();
    assert.equal(plan.summary.includes(OLD), false);
    assert.deepEqual(f.c.store.state, saved);
});
test('normal send after failed regeneration restores valid raw history when the old tail stays deleted', async t => {
    const f = await fixture(t, { singleBatch: true });
    await f.start('regenerate');
    f.live.chat.pop(); await f.emit('MESSAGE_DELETED', 3);
    await f.emit('GENERATION_STOPPED'); await f.emit('GENERATION_ENDED');
    await f.start('normal');
    assert.equal(f.slots.get('dwm:summary').includes(OLD), false);
    assert.equal(f.live.chat[1].is_system, false);
    assert.ok(f.calls.findLast(call => call.purpose === 'select').input.messages.some(m => m.content === BASE));
});
