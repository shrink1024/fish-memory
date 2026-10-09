import test from 'node:test';
import assert from 'node:assert/strict';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';
import { generateAuxiliary } from '../src/adapters/auxiliary-transport.js';

const nativeOptions = (extra = {}) => ({ ...Object.fromEntries(['automatic_trigger', 'force_name2', 'quiet_prompt', 'quietToLoud', 'skipWIAN', 'force_chid', 'signal', 'quietImage'].map(key => [key, undefined])), ...extra });

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
    const listeners = new Map();
    const events = { on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
        removeListener(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
        async emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) { try { await fn(...args); } catch { /* native ST swallows listener errors */ } } } };
    const types = Object.fromEntries(['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'CHAT_CHANGED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'MESSAGE_SENT', 'MESSAGE_SWIPED'].map(name => [name, name]));
    const live = { chatId: 'one', characterId: 0, characters: [{ avatar: 'test.png', data: { extensions: { world: 'main' } } }], chat: [], chatMetadata: {} };
    const state = { input: 'original', locked: false, stopped: 0 };
    const books = { main: { entries: {} }, global: { entries: {} } };
    const deps = { context: live, eventSource: events, eventTypes: types, extensions: {}, getUserInput: () => state.input,
        worldInfo: { loadWorldInfo: async name => books[name], selected_world_info: ['global'] },
        script: { setExtensionPrompt() {}, setSendButtonState(value) { state.locked = value; }, activateSendButtons() {}, deactivateSendButtons() {} },
        stopGeneration() { state.stopped++; return events.emit(types.GENERATION_STOPPED); } };
    return { deps, live, state, events, types, books };
}

test('event boundary rejects cancelled native sends outside ST listener-error swallowing', async () => {
    for (const kind of ['chat', 'newer', 'input']) {
        const f = fixture(), host = await createSillyTavernHost(f.deps), entered = deferred(), finish = deferred();
        let selected = 0, nativeWrites = 0;
        const original = f.events.emit;
        const dispose = host.bindController({ generationBefore: async () => { if (++selected === 1) { entered.resolve(); await finish.promise; } } });
        const send = async () => { await f.events.emit(f.types.GENERATION_STARTED, 'normal', nativeOptions(), false); await f.events.emit(f.types.GENERATION_AFTER_COMMANDS, 'normal', nativeOptions(), false); nativeWrites++; };
        const old = send(); const rejected = assert.rejects(old, { name: 'AbortError' }); await entered.promise;
        assert.equal(f.state.locked, true);
        if (kind === 'chat') { f.live.chatId = 'two'; await f.events.emit(f.types.CHAT_CHANGED); }
        if (kind === 'input') f.state.input = 'changed';
        if (kind === 'newer') await send();
        finish.resolve(); await rejected;
        assert.equal(nativeWrites, kind === 'newer' ? 1 : 0);
        assert.equal(f.state.stopped, 0, 'a stale send cannot globally stop the newer send');
        if (kind === 'newer') assert.equal(f.state.locked, true, 'late old result retains newer lock');
        dispose(); assert.equal(f.events.emit, original);
        assert.equal(f.state.locked, kind === 'newer', 'disposing Fish only unlocks its preflight; native generation keeps its own lock');
    }
});

test('quiet events keep active plans; swipe listener releases the native event immediately', async () => {
    const f = fixture(), host = await createSillyTavernHost(f.deps), held = deferred(); let calls = 0;
    f.live.chat = [{ is_user: false, mes: 'selected', swipes: ['selected'], swipe_id: 0 }];
    host.bindController({ generationBefore() { calls++; }, messageSwiped: () => held.promise });
    await f.events.emit(f.types.GENERATION_AFTER_COMMANDS, 'quiet', {}, false);
    assert.equal(calls, 0);
    await f.events.emit(f.types.MESSAGE_SWIPED, 0);
    held.resolve();
});

test('history window keeps native time counts for timed entries in any active book', async () => {
    const f = fixture(), host = await createSillyTavernHost(f.deps);
    f.live.chat = [{ mes: 'past', is_user: true }, { mes: 'recent', is_user: false }];
    const at = host.snapshot();
    await host.applyWindow([{ index: 0, key: at.messages[0].key, hidden: true }]);
    host.setPlan({ chatId: at.chatId, dynamicEntries: [] });
    f.books.global.entries[1] = { uid: 1, sticky: 2, content: 'global sticky' };
    const kept = structuredClone(f.live.chat); await host.filterOutgoingHistory(kept, null, null, 'normal');
    assert.equal(kept.length, 2);
    f.books.global.entries = {};
    const filtered = structuredClone(f.live.chat); await host.filterOutgoingHistory(filtered, null, null, 'normal');
    assert.equal(filtered.length, 1);
    assert.equal(f.live.chat.length, 2);
});

test('timed native entries keep their complete hash-bearing record across changing selections', async () => {
    const f = fixture(), host = await createSillyTavernHost(f.deps), at = host.snapshot();
    const original = { world: 'main', uid: 1, sticky: 2, constant: false, disable: false, content: 'authored' };
    const dynamic = { id: 'source:main:1', enabled: true, source: { book: 'main', uid: 1, original: 'authored' }, segments: [{ id: 'body', text: 'updated' }] };
    for (const selectedIds of [[], [dynamic.id], []]) {
        host.setPlan({ chatId: at.chatId, dynamicEntries: [dynamic], selectedIds });
        const data = { characterLore: [structuredClone(original)] }; host.applyWorldInfoEntries(data);
        assert.deepEqual(data.characterLore, [original]);
    }
    assert.equal(host.getWarnings().length, 1);
});

test('dedicated chat transport preserves literal macros, output and selected connection without events', async () => {
    const originalSettings = { openai_max_tokens: 80, n: 4, stream_openai: true, model: 'test' };
    const original = structuredClone(originalSettings); const signal = new AbortController().signal;
    const content = '{"text":"<% sideEffect() %> {{user}} <USER>"}';
    let request;
    const result = await generateAuxiliary({ params: { purpose: 'initialize', responseLength: 8192, system: 'JSON', input: content, signal },
        context: { mainApi: 'openai', chatCompletionSettings: originalSettings, getRequestHeaders: () => ({ test: 'header' }) },
        script: { extractMessageFromData: data => data.choices[0].message.content },
        openai: { getChatCompletionModel: settings => settings.model, createGenerationParameters: async (settings, model, type, messages) => {
            assert.equal(settings.openai_max_tokens, 8192); assert.equal(type, 'quiet'); assert.equal(messages[1].content, content);
            return { generate_data: { model, messages, max_tokens: settings.openai_max_tokens, stream: true, stop: ['}'], tools: ['bad'] } };
        } }, fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) }; } });
    assert.equal(result, content); assert.deepEqual(originalSettings, original);
    assert.equal(request.options.signal, signal);
    const body = JSON.parse(request.options.body); assert.equal(body.max_tokens, 8192); assert.equal(body.stream, false); assert.equal(body.stop, undefined); assert.equal(body.tools, undefined);
});

test('dedicated text transport uses instruct formatting without evaluating story macros', async () => {
    const input = '{"body":"{{setvar::x::1}} <% x() %> <USER>"}'; let body;
    const result = await generateAuxiliary({ params: { purpose: 'select', system: 'system', input },
        context: { mainApi: 'textgenerationwebui' },
        script: { createRawPrompt: messages => messages.map(message => `<${message.role}>${message.content}</${message.role}>`).join(''), extractMessageFromData: data => data.choices[0].text },
        textgen: { textgenerationwebui_settings: { type: 'llamacpp' }, getTextGenModel: () => 'local', createTextGenGenerationData: (_settings, _model, prompt, maxTokens) => ({ prompt, max_tokens: maxTokens, stop: ['}'] }) },
        fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ text: '{"ids":[]}', finish_reason: 'stop' }] }) }; } });
    assert.equal(body.prompt, `<system>system</system><user>${input}</user>`); assert.equal(body.max_tokens, 2048); assert.equal(result, '{"ids":[]}');
});

test('dedicated transport refuses truncated responses instead of passing partial JSON to repair', async () => {
    await assert.rejects(generateAuxiliary({ params: { purpose: 'maintain', input: '{}' }, context: { mainApi: 'openai', chatCompletionSettings: {} },
        script: { extractMessageFromData() { assert.fail('must reject first'); } }, openai: { getChatCompletionModel: () => 'test', createGenerationParameters: async () => ({ generate_data: {} }) },
        fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"broken":' } }] }) }) }), /长度|截断|上限/);
});
