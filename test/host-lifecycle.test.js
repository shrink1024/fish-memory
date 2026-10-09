import test from 'node:test';
import assert from 'node:assert/strict';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const nativeOptions = () => Object.fromEntries(['automatic_trigger', 'force_name2', 'quiet_prompt', 'quietToLoud', 'skipWIAN', 'force_chid', 'signal', 'quietImage'].map(key => [key, undefined]));
function fixture() {
    const listeners = new Map();
    const events = { on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
        removeListener(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
        async emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) { try { await fn(...args); } catch { /* ST catches listener errors */ } } } };
    const types = Object.fromEntries(['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'CHAT_CHANGED'].map(name => [name, name]));
    const inputListeners = new Set();
    const textarea = { value: 'player message', readOnly: false,
        addEventListener(type, listener) { if (type === 'input') inputListeners.add(listener); },
        removeEventListener(type, listener) { if (type === 'input') inputListeners.delete(listener); },
        edit(value, isTrusted = true) { this.value = value; for (const listener of [...inputListeners]) listener({ isTrusted }); } };
    const state = { locked: false, stopVisible: false, writes: 0, ended: 0, selections: 0 };
    const prompts = new Map(), warnings = [];
    const live = { chatId: 'one', characterId: 0, characters: [{ avatar: 'test.png', data: { extensions: { world: 'main' } } }], chat: [], chatMetadata: {} };
    const activate = () => { state.locked = false; if (state.stopVisible) { state.stopVisible = false; void events.emit(types.GENERATION_ENDED, live.chat.length); } };
    const deps = { context: live, eventSource: events, eventTypes: types, extensions: {}, getUserInput: () => textarea.value,
        worldInfo: { loadWorldInfo: async () => ({ entries: {} }) },
        onWarning: value => warnings.push(value),
        script: { setExtensionPrompt(key, value) { prompts.set(key, value); }, setSendButtonState(value) { state.locked = value; }, activateSendButtons: activate,
            deactivateSendButtons() { state.stopVisible = true; }, isGenerating: () => state.locked },
        stopGeneration() { activate(); void events.emit(types.GENERATION_STOPPED); } };
    const send = async (type = 'normal') => {
        await events.emit(types.GENERATION_STARTED, type, nativeOptions(), false);
        await events.emit(types.GENERATION_AFTER_COMMANDS, type, nativeOptions(), false);
        state.writes++;
        if (type === 'normal') { live.chat.push({ is_user: true, mes: textarea.value, extra: {} }); textarea.value = ''; await events.emit(types.MESSAGE_SENT, live.chat.length - 1); }
    };
    return { deps, live, state, events, types, textarea, send, activate, prompts, warnings };
}

async function withHost(run) {
    const old = globalThis.document, f = fixture();
    globalThis.document = { querySelector: selector => selector === '#send_textarea' ? f.textarea : null };
    const host = await createSillyTavernHost(f.deps);
    try { await run(f, host); } finally { host.bindController({})(); globalThis.document = old; }
}

test('silent direct AFTER cannot lock or select, including the native slash-command gap', async () => withHost(async (f, host) => {
    host.bindController({ generationBefore() { f.state.selections++; } });
    await f.events.emit(f.types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    assert.equal(f.state.locked, false); assert.equal(f.textarea.readOnly, false); assert.equal(f.state.selections, 0);
    await f.events.emit(f.types.GENERATION_STARTED, 'normal', nativeOptions(), false);
    await f.events.emit(f.types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    assert.equal(f.state.locked, false); assert.equal(f.state.selections, 0, 'TH does not steal a pending native start');
    await f.events.emit(f.types.GENERATION_AFTER_COMMANDS, 'normal', nativeOptions(), false);
    assert.equal(f.state.selections, 1);
}));

test('foreign end during preflight retains send and reasserts the native send lock', async () => withHost(async (f, host) => {
    const entered = deferred(), finish = deferred();
    host.bindController({ async generationBefore() { entered.resolve(); await finish.promise; }, generationEnded() { f.state.ended++; } });
    const sending = f.send(); await entered.promise;
    f.activate(); await tick();
    assert.equal(f.state.locked, true, 'another extension cannot reopen the send button during selection');
    assert.equal(f.textarea.readOnly, true); assert.equal(f.state.ended, 0);
    finish.resolve(); await sending;
    assert.equal(f.state.writes, 1); assert.equal(f.textarea.readOnly, false);
}));

test('delayed end emitted before a new send cannot cancel the newer preflight', async () => withHost(async (f, host) => {
    const endEntered = deferred(), endFinish = deferred(), entered = deferred(), finish = deferred();
    f.events.on(f.types.GENERATION_ENDED, async () => { endEntered.resolve(); await endFinish.promise; });
    host.bindController({ async generationBefore() { entered.resolve(); await finish.promise; }, generationEnded() { f.state.ended++; } });
    const priorEnd = f.events.emit(f.types.GENERATION_ENDED, 0); await endEntered.promise;
    const sending = f.send(); await entered.promise;
    endFinish.resolve(); await priorEnd;
    finish.resolve(); await sending;
    assert.equal(f.state.writes, 1); assert.equal(f.state.ended, 0);
}));

test('a delayed preflight end cannot relock native UI after ST has completed or failed', async () => withHost(async (f, host) => {
    const endEntered = deferred(), endFinish = deferred(), entered = deferred(), finish = deferred(); let ends = 0;
    f.events.on(f.types.GENERATION_ENDED, async () => { if (++ends === 1) { endEntered.resolve(); await endFinish.promise; } });
    host.bindController({ async generationBefore() { entered.resolve(); await finish.promise; } });
    const sending = f.send(); await entered.promise;
    f.activate(); await endEntered.promise;
    finish.resolve(); await sending;
    f.activate(); await tick();
    assert.equal(f.state.locked, false);
    endFinish.resolve(); await tick();
    assert.equal(f.state.locked, false, 'late preflight-only cleanup must not reacquire a native send lock');
}));

test('regenerate, swipe and continue release the input immediately after preflight', async () => {
    for (const type of ['regenerate', 'swipe', 'continue']) await withHost(async (f, host) => {
        const entered = deferred(), finish = deferred();
        host.bindController({ async generationBefore() { entered.resolve(); await finish.promise; } });
        const sending = f.send(type); await entered.promise;
        assert.equal(f.textarea.readOnly, true);
        finish.resolve(); await sending;
        assert.equal(f.textarea.readOnly, false, type); assert.equal(f.state.locked, true, 'native generation owns the send lock');
    });
});

test('replaced preflight receives abort immediately, without stopping the newer request', async () => withHost(async (f, host) => {
    const entered = deferred(), finish = deferred(); let oldSignal;
    host.bindController({ async generationBefore({ signal }) { if (!oldSignal) { oldSignal = signal; entered.resolve(); await finish.promise; } } });
    const oldSend = f.send(); const rejected = assert.rejects(oldSend, { name: 'AbortError' }); await entered.promise;
    await f.send('continue'); assert.equal(oldSignal?.aborted, true);
    finish.resolve(); await rejected;
    assert.equal(f.state.writes, 1); assert.equal(f.state.locked, true);
}));

function installMemory(f, host) {
    host.bindController({ generationBefore() { host.setPlan({ chatId: host.snapshot().chatId, summary: 'prepared-memory', selectedIds: [], entries: [] }); },
        generationEnded() { f.state.ended++; } });
}
async function beforeNative(f, type = 'normal') {
    await f.events.emit(f.types.GENERATION_STARTED, type, nativeOptions(), false);
    await f.events.emit(f.types.GENERATION_AFTER_COMMANDS, type, nativeOptions(), false);
}
const hasMemory = f => [...f.prompts.values()].includes('prepared-memory');

test('normal input remains readonly after preflight until native MESSAGE_SENT consumes it', async () => withHost(async (f, host) => {
    installMemory(f, host); await beforeNative(f);
    assert.equal(f.textarea.readOnly, true, 'native ping still precedes reading the input');
    f.live.chat.push({ is_user: true, mes: f.textarea.value, extra: {} });
    f.textarea.value = ''; await f.events.emit(f.types.MESSAGE_SENT, 0);
    assert.equal(f.textarea.readOnly, false);
    assert.equal(hasMemory(f), true);
}));

test('foreign end after preflight cannot discard memory or unlock the native send', async () => withHost(async (f, host) => {
    installMemory(f, host); await beforeNative(f);
    await f.events.emit(f.types.GENERATION_ENDED, 0);
    assert.equal(hasMemory(f), true);
    assert.equal(f.state.locked, true, 'Fish does not activate native send controls for an unidentified END');
    assert.equal(f.state.ended, 0, 'an unidentified END is not a completed native request');
}));

test('editing a draft after unidentified end safely falls back to full native input', async () => withHost(async (f, host) => {
    f.live.chat.push({ is_user: false, mes: 'remembered past', extra: {} }, { is_user: true, mes: 'recent', extra: {} });
    installMemory(f, host); await beforeNative(f);
    const key = host.snapshot().messages[0].key;
    await host.applyWindow([{ index: 0, key, hidden: true }]);
    const selectedHistory = structuredClone(f.live.chat);
    await host.filterOutgoingHistory(selectedHistory, null, null, 'normal');
    assert.equal(selectedHistory.length, 1);
    await f.events.emit(f.types.GENERATION_ENDED, 0);
    assert.equal(hasMemory(f), true);
    assert.equal(f.textarea.readOnly, false, 'native pre-send errors must not leave a readonly input');
    f.textarea.edit('changed draft');
    assert.equal(hasMemory(f), false, 'selection for the former draft must not be used');
    assert.equal(f.state.locked, true);
    assert.match(f.warnings.at(-1).message, /原世界书.*完整历史/);
    const nativeHistory = structuredClone(f.live.chat);
    await host.filterOutgoingHistory(nativeHistory, null, null, 'normal');
    assert.equal(nativeHistory.length, 2, 'fallback really sends the retained original history');
}));

test('native synthetic input clearing and later MESSAGE_SENT listeners cannot invalidate sent memory', async () => withHost(async (f, host) => {
    f.events.on(f.types.MESSAGE_SENT, () => f.textarea.edit('next draft'));
    installMemory(f, host); await beforeNative(f);
    await f.events.emit(f.types.GENERATION_ENDED, 0);
    f.live.chat.push({ is_user: true, mes: f.textarea.value, extra: {} });
    f.textarea.edit('', false); // ST clears the textarea before emitting MESSAGE_SENT.
    assert.equal(hasMemory(f), true);
    await f.events.emit(f.types.MESSAGE_SENT, 0);
    assert.equal(hasMemory(f), true, 'guard is removed at emit entry, before another listener edits the next draft');
    assert.equal(f.warnings.length, 0);
}));

test('a native pre-send failure unlocks its input and a new trusted start clears stale memory', async () => withHost(async (f, host) => {
    installMemory(f, host); await beforeNative(f);
    f.activate(); await tick();
    assert.equal(f.state.locked, false, 'ST owns error-path button cleanup');
    assert.equal(f.textarea.readOnly, false);
    assert.equal(hasMemory(f), true, 'the unidentified end does not erase a possibly active prompt');
    await f.events.emit(f.types.GENERATION_STARTED, 'normal', nativeOptions(), false);
    assert.equal(hasMemory(f), false);
}));

test('only a matching native reply retires the used plan', async () => withHost(async (f, host) => {
    installMemory(f, host); await f.send();
    f.live.chat.push({ is_user: false, mes: 'reply', extra: {} });
    await f.events.emit(f.types.MESSAGE_RECEIVED, 1, 'extension');
    assert.equal(hasMemory(f), true);
    await f.events.emit(f.types.MESSAGE_RECEIVED, 0, 'normal');
    assert.equal(hasMemory(f), true, 'a user message at the wrong position cannot retire the plan');
    await f.events.emit(f.types.MESSAGE_RECEIVED, 1, 'normal');
    assert.equal(hasMemory(f), false);
    assert.equal(f.state.locked, true, 'Fish never takes over native completion UI cleanup');
    assert.equal(f.state.ended, 1);
}));
