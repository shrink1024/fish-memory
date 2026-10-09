// Regressions for the 2026-10-09 alpha.5 recheck (C-1, C-3). A-1 and C-2 are
// covered in protected-reference-roundtrip and auxiliary-review-regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';
import { createSave } from '../src/core/state.js';
import { encodeSave } from '../src/core/storage-codec.js';

const nativeOptions = () => Object.fromEntries(['automatic_trigger', 'force_name2', 'quiet_prompt', 'quietToLoud', 'skipWIAN', 'force_chid', 'signal', 'quietImage'].map(key => [key, undefined]));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
    const listeners = new Map();
    const events = { on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
        removeListener(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
        async emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) { try { await fn(...args); } catch { /* native ST swallows listener errors */ } } } };
    const types = Object.fromEntries(['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'CHAT_CHANGED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'MESSAGE_SENT', 'MESSAGE_SWIPED'].map(name => [name, name]));
    const live = { chatId: 'one', characterId: 0, characters: [{ avatar: 'test.png', data: { extensions: { world: 'main' } } }], chat: [], chatMetadata: {} };
    const state = { input: 'original', locked: false, stopped: 0 };
    const deps = { context: live, eventSource: events, eventTypes: types, extensions: {}, getUserInput: () => state.input,
        worldInfo: { loadWorldInfo: async () => ({ entries: {} }), selected_world_info: [] },
        script: { setExtensionPrompt() {}, setSendButtonState(value) { state.locked = value; }, activateSendButtons() {}, deactivateSendButtons() {} },
        stopGeneration() { state.stopped++; return events.emit(types.GENERATION_STOPPED); } };
    return { deps, live, state, events, types };
}

test('a TavernHelper stop carrying its generation id does not cancel the player send', async () => {
    const f = fixture(), host = await createSillyTavernHost(f.deps), entered = deferred(), finish = deferred();
    let playerStops = 0;
    host.bindController({ generationBefore: async () => { entered.resolve(); await finish.promise; }, generationStopped: () => { playerStops++; } });
    let sent = 0;
    const send = (async () => {
        await f.events.emit(f.types.GENERATION_STARTED, 'normal', nativeOptions(), false);
        await f.events.emit(f.types.GENERATION_AFTER_COMMANDS, 'normal', nativeOptions(), false);
        sent++;
    })();
    await entered.promise;
    // TavernHelper stopGenerationById / stopAllGeneration (e.g. MVU's extra attempts).
    await f.events.emit(f.types.GENERATION_STOPPED, 'th-generation-1');
    finish.resolve();
    await send;
    assert.equal(sent, 1, 'the player send reaches native generation');
    assert.equal(playerStops, 0);
    // ST's own Stop emits without arguments and still stops the run.
    await f.events.emit(f.types.GENERATION_STOPPED);
    assert.equal(playerStops, 1);
});

test('saves persisted as schema 2 count their processed prefix as read; schema 3 stays conservative', async () => {
    const f = fixture(), host = await createSillyTavernHost(f.deps), id = host.snapshot().chatId;
    const legacy = createSave(id, 'main');
    delete legacy.rememberedKeys;
    legacy.processed = ['u1', 'a1']; legacy.storyKeys = ['u1', 'a1'];
    f.live.chatMetadata.dwm = structuredClone(legacy);
    const read = await host.storage.read(id);
    assert.deepEqual(read.rememberedKeys, ['u1', 'a1']);
    assert.equal(f.live.chatMetadata.dwm.rememberedKeys, undefined, 'reading never mutates the stored save');
    f.live.chatMetadata.dwm = encodeSave(legacy);
    assert.equal((await host.storage.read(id)).rememberedKeys, undefined);
});
