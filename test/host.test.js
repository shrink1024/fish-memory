import assert from 'node:assert/strict';
import test from 'node:test';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';
import { Controller } from '../src/runtime/controller.js';
import { makeSourceEntry } from '../src/core/state.js';

function fixture() {
    const raw = { entries: {
        1: { uid: 1, comment: 'blue', content: 'old blue', constant: true, disable: false, order: 9, position: 0 },
        2: { uid: 2, comment: 'green', content: 'old green', constant: false, disable: false, key: ['word'], order: 8, position: 1 },
        3: { uid: 3, comment: 'disabled', content: 'old disabled', constant: false, disable: true, key: ['word'] },
    } };
    const live = {
        chatId: 'chat-1', characterId: 0,
        characters: [{ avatar: 'avatar.png', data: { extensions: { world: 'main' } } }],
        chatMetadata: {},
        chat: [
            { is_user: true, is_system: false, mes: 'hello', extra: {} },
            { is_user: false, is_system: false, mes: 'answer', swipe_id: 1, swipes: ['other', 'answer'], extra: {} },
            { is_user: true, is_system: true, mes: 'externally hidden', extra: {} },
        ],
    };
    const prompts = new Map();
    let failSave = false;
    let saveCount = 0;
    const deps = {
        context: () => live,
        worldInfo: { loadWorldInfo: async name => name === 'main' ? structuredClone(raw) : null },
        script: {
            extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0 },
            setExtensionPrompt: (key, value, position, depth, scan, role) => prompts.set(key, { value, position, depth, scan, role }),
        },
        extensions: { findExtension: () => ({ enabled: true }) },
        save: async () => { saveCount++; if (failSave) throw new Error('save failed'); },
    };
    return { raw, live, prompts, deps, get saveCount() { return saveCount; }, fail: () => { failSave = true; }, recover: () => { failSave = false; } };
}

test('snapshot binds the primary card book and selected swipe without hashing edited text', async () => {
    const f = fixture();
    const previousTemplate = globalThis.EjsTemplate;
    globalThis.EjsTemplate = { getFeatures: () => ({ enabled: true }) };
    try {
        const host = await createSillyTavernHost({ ...f.deps, getUserInput: () => 'pending user turn' });
        const first = host.snapshot();
        assert.equal(first.bookName, 'main');
        assert.equal(first.chatId, 'character:avatar.png:chat-1');
        assert.equal(first.messages[1].role, 'assistant');
        assert.match(first.messages[1].key, /:swipe:1$/);
        assert.equal(first.templateEnabled, true);
        assert.equal(first.userInput, 'pending user turn');
        f.live.chat[1].mes = 'edited without revision tracking';
        assert.equal(host.snapshot().messages[1].key, first.messages[1].key);
        f.live.chat[1].swipe_id = 0;
        assert.notEqual(host.snapshot().messages[1].key, first.messages[1].key);
        assert.deepEqual(await host.loadWorldbook(), Object.values(f.raw.entries));
    } finally { globalThis.EjsTemplate = previousTemplate; }
});

test('prompt preview snapshots and eligibility leave message identities and warning state untouched', async () => {
    const f = fixture(); delete f.live.chat[0].extra;
    const host = await createSillyTavernHost({ ...f.deps, getUserInput: () => 'unsent draft' });
    const before = structuredClone(f.live);
    const snapshot = host.previewSnapshot();
    await host.loadWorldbook(snapshot.bookName);
    assert.equal(snapshot.userInput, 'unsent draft');
    assert.match(snapshot.messages[0].key, /^preview-message-/);
    assert.equal(host.previewEligible({ enabled: true, delayUntilRecursion: true }), false);
    assert.equal(host.previewEligible({ enabled: true, triggers: ['normal'] }), true);
    assert.equal(host.previewEligible({ enabled: true, triggers: ['swipe'] }), false);
    assert.deepEqual(f.live, before);
    assert.deepEqual(host.getWarnings(), []);
    assert.equal(f.saveCount, 0); assert.equal(f.prompts.size, 0);
});

test('native save posts the full solo chat and only commits on acknowledged success', async () => {
    const f = fixture();
    f.live.characters[0].name = 'Character';
    f.live.getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' });
    f.live.chatMetadata.otherExtension = { preserved: true };
    const requests = [];
    let disk = [{ create_date: 'kept', chat_metadata: { otherExtension: { preserved: true } } }];
    let response = { ok: false, status: 500, json: async () => ({ error: 'server' }) };
    const deps = { ...f.deps, save: undefined, fetch: async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/get')) return { ok: true, json: async () => structuredClone(disk) };
        if (response.ok) disk = JSON.parse(options.body).chat;
        return response;
    } };
    const host = await createSillyTavernHost(deps);
    const chatId = host.snapshot().chatId;
    await assert.rejects(host.storage.write(chatId, { revision: 1 }, 0), /Chat save failed/);
    assert.equal(f.live.chatMetadata.dwm, undefined);
    response = { ok: true, json: async () => ({ ok: true }) };
    await host.storage.write(chatId, { revision: 1 }, 0);
    const payload = JSON.parse(requests.findLast(request => request.url === '/api/chats/save').options.body);
    assert.equal(requests.at(-1).url, '/api/chats/get');
    assert.equal(payload.avatar_url, 'avatar.png');
    assert.equal(payload.file_name, 'chat-1');
    assert.equal(payload.force, false);
    assert.equal(payload.chat.length, f.live.chat.length + 1);
    assert.deepEqual(payload.chat[0].chat_metadata.otherExtension, { preserved: true });
    assert.equal(payload.chat[0].chat_metadata.dwm.revision, 1);
    assert.equal(payload.chat[0].create_date, 'kept');
    assert.equal(f.live.chatMetadata.dwm.revision, 1);
    f.live.groupId = 'group';
    await assert.rejects(host.storage.write(host.snapshot().chatId, { revision: 2 }, 1), /Group chat/);
});

test('native first save accepts an empty GET object and preserves live integrity', async () => {
    const f = fixture();
    f.live.characters[0].name = 'Character';
    f.live.getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
    f.live.chatMetadata.integrity = 'current-chat-integrity';
    let saveBody;
    const host = await createSillyTavernHost({ ...f.deps, save: undefined, fetch: async (url, options) => {
        if (url.endsWith('/get')) return { ok: true, json: async () => saveBody?.chat ?? {} };
        saveBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ ok: true }) };
    } });
    await host.storage.write(host.snapshot().chatId, { revision: 1 }, 0);
    assert.equal(saveBody.chat[0].chat_metadata.integrity, 'current-chat-integrity');
    assert.equal(saveBody.chat[0].chat_metadata.dwm.revision, 1);
    assert.equal(saveBody.chat[0].user_name, 'unused');
    assert.equal(saveBody.chat[0].character_name, 'unused');
});

test('native save stops before POST if the active chat changes during header read', async () => {
    const f = fixture();
    f.live.characters[0].name = 'Character';
    f.live.getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
    let saveCalled = false;
    const host = await createSillyTavernHost({ ...f.deps, save: undefined, fetch: async url => {
        if (url.endsWith('/get')) {
            f.live.chatId = 'other-chat';
            return { ok: true, json: async () => [] };
        }
        saveCalled = true;
        return { ok: true, json: async () => ({ ok: true }) };
    } });
    const chatId = host.snapshot().chatId;
    await assert.rejects(host.storage.write(chatId, { revision: 1 }, 0), /切换/);
    assert.equal(saveCalled, false);
    assert.equal(f.live.chatMetadata.dwm, undefined);
});

test('worldbook override uses this request only and leaves original and other books intact', async () => {
    const f = fixture();
    const host = await createSillyTavernHost(f.deps);
    const chatId = host.snapshot().chatId;
    host.setPlan({ chatId, bookName: 'main', requestId: 'r1', selectedIds: ['source:main:2', 'source:main:3'],
        dynamicEntries: [
            { id: 'source:main:1', source: { book: 'main', uid: 1, original: 'old blue' }, segments: [{ text: 'new blue' }] },
            { id: 'source:main:2', source: { book: 'main', uid: 2, original: 'old green' }, segments: [{ text: 'new <% await danger() %> green' }] },
            { id: 'source:main:3', source: { book: 'main', uid: 3 }, segments: [{ text: 'new disabled' }] },
        ], summary: 'summary', inventory: 'inventory', details: 'detail' });
    const other = { world: 'other', uid: 2, content: 'external' };
    const data = { characterLore: [
        { ...f.raw.entries[1], world: 'main' }, { ...f.raw.entries[2], world: 'main' },
        { ...f.raw.entries[3], world: 'main' }, other,
    ], globalLore: [], personaLore: [], chatLore: [] };
    host.applyWorldInfoEntries(data);
    assert.equal(data.characterLore[0].content, 'new blue');
    assert.equal(data.characterLore[0].constant, true);
    assert.equal(data.characterLore[1].constant, true);
    assert.equal(data.characterLore[1].content.includes('<%'), false);
    assert.equal(data.characterLore[1].order, 8);
    assert.equal(data.characterLore[2].disable, true);
    assert.equal(data.characterLore[3], other);
    assert.equal(f.raw.entries[1].content, 'old blue');
    assert.equal(f.raw.entries[2].content, 'old green');
    assert.deepEqual([...f.prompts.keys()].sort(), ['dwm:details', 'dwm:inventory', 'dwm:summary']);
    host.clearPlan();
    assert.equal(f.prompts.get('dwm:summary').value, '');
    const next = { characterLore: [{ ...f.raw.entries[2], world: 'main' }] };
    host.applyWorldInfoEntries(next);
    assert.equal(next.characterLore[0].content, 'old green');
});

test('unselected managed green cannot activate from native keywords or recursion', async () => {
    const f = fixture();
    const host = await createSillyTavernHost(f.deps);
    host.setPlan({ chatId: host.snapshot().chatId, bookName: 'main', selectedIds: [],
        dynamicEntries: [{ id: 'source:main:2', source: { book: 'main', uid: 2 }, segments: [{ text: 'updated' }] }] });
    const data = { characterLore: [{ ...f.raw.entries[2], world: 'main' }] };
    host.applyWorldInfoEntries(data);
    assert.equal(data.characterLore[0].disable, true);
    assert.equal(data.characterLore[0].constant, false);
    assert.equal(host.eligible(f.raw.entries[3]), false);
    assert.equal(host.eligible({ characterFilter: { names: ['other'] } }), false);
});

test('configuration entries leave only the request arrays; template removals stay removed', async () => {
    const f = fixture();
    const host = await createSillyTavernHost(f.deps);
    host.setPlan({ chatId: host.snapshot().chatId, selectedIds: ['source:main:2'], configEntryUids: [2],
        entries: [{ id: 'source:main:2', source: { book: 'main', uid: 2 }, segments: [{ text: 'replacement' }] }] });
    const entry = { ...f.raw.entries[2], world: 'main' };
    const external = { world: 'other', uid: 2, content: 'external' };
    const data = { chatLore: [entry, external], characterLore: [], globalLore: [], personaLore: [] };
    host.applyWorldInfoEntries(data);
    assert.deepEqual(data.chatLore, [external]);
    assert.equal(entry.content, 'old green');
    assert.equal(f.raw.entries[2].content, 'old green');
    data.chatLore.length = 0; // Simulates Prompt Template removing an entry first.
    host.applyWorldInfoEntries(data);
    assert.equal(data.chatLore.length, 0);
});

test('native character filename and tag filters admit valid green candidates', async () => {
    const f = fixture();
    const host = await createSillyTavernHost(f.deps);
    assert.equal(host.eligible({ constant: true, characterFilter: { isExclude: false, names: [], tags: [] } }), true);
    assert.equal(host.eligible({ constant: false, characterFilter: { isExclude: true, names: [], tags: [] } }), true);
    assert.equal(host.eligible({ characterFilter: { isExclude: false, names: ['avatar'], tags: [] } }), true);
    assert.equal(host.eligible({ characterFilter: { names: ['other'], tags: [] } }), false);
    assert.equal(host.eligible({ characterFilter: { isExclude: true, names: ['avatar'], tags: [] } }), false);
    f.live.tagMap = { 'avatar.png': ['tag'] };
    assert.equal(host.eligible({ characterFilter: { isExclude: false, names: [], tags: ['tag'] } }), true);
    assert.equal(host.eligible({ characterFilter: { isExclude: false, names: [], tags: ['other'] } }), false);
    assert.equal(host.eligible({ characterFilter: { isExclude: true, names: [], tags: ['other'] } }), true);
    assert.equal(host.eligible({ characterFilter: { isExclude: true, names: [], tags: ['tag'] } }), false);
});

test('delay and cooldown become eligible when their native intervals expire', async () => {
    const f = fixture();
    const host = await createSillyTavernHost(f.deps);
    const source = metadata => ({ title: '有时间限制的绿灯', source: { book: 'main', uid: 2, metadata } });
    assert.equal(host.eligible(source({ delay: 3 })), false); // Two visible messages; the third is externally hidden.
    assert.equal(host.eligible(source({ delay: 2 })), true);
    f.live.chat.push({ is_user: true, is_system: false, mes: 'next', extra: {} });
    assert.equal(host.eligible(source({ delay: 3 })), true);
    f.live.chatMetadata.timedWorldInfo = { cooldown: { 'main.2': { start: 1, end: 5, protected: false } } };
    assert.equal(host.eligible(source({ cooldown: 2 })), false);
    f.live.chatMetadata.timedWorldInfo.sticky = { 'main.2': { start: 1, end: 5, protected: false } };
    assert.equal(host.eligible(source({ cooldown: 2, sticky: 2 })), true);
    delete f.live.chatMetadata.timedWorldInfo.sticky;
    f.live.chat.push({ is_user: true, is_system: false, mes: 'third', extra: {} },
        { is_user: false, is_system: false, mes: 'fourth', extra: {} });
    assert.equal(host.eligible(source({ cooldown: 2 })), true);
});

test('unverifiable recursion, template and missing tag data warn with entry names only once', async () => {
    const f = fixture();
    const notices = [];
    const host = await createSillyTavernHost({ ...f.deps, onWarning: notice => notices.push(notice) });
    const entry = (uid, title, metadata, original = '') => ({ title, source: { book: 'main', uid, metadata, original } });
    assert.equal(host.eligible(entry(4, '递归门', { delayUntilRecursion: 1 })), false);
    assert.equal(host.eligible(entry(4, '递归门', { delayUntilRecursion: 1 })), false);
    assert.equal(host.eligible(entry(5, '条件门', {}, '@@if something')), false);
    assert.equal(host.eligible(entry(6, '标签门', { characterFilter: { names: [], tags: ['tag'] } })), false);
    assert.equal(notices.length, 3);
    assert.deepEqual(notices.map(notice => notice.entry.title), ['递归门', '条件门', '标签门']);
    assert.ok(notices.every(notice => notice.code === 'native-eligibility-unverified'));
    assert.ok(notices.every(notice => notice.message.includes('本插件本轮不会激活该绿灯')));
});

test('author EJS keeps its native flow and dynamic EJS is not injected', async () => {
    const f = fixture();
    const host = await createSillyTavernHost(f.deps);
    const authored = 'Rule: <% authorRule() %>';
    host.setPlan({ chatId: host.snapshot().chatId, selectedIds: ['source:main:1'], entries: [{
        id: 'source:main:1', source: { book: 'main', uid: 1, original: authored },
        segments: [{ text: `${authored}\nNew fact: <% injected() %>` }],
    }] });
    const data = { characterLore: [{ ...f.raw.entries[1], world: 'main', content: authored }] };
    host.applyWorldInfoEntries(data);
    assert.match(data.characterLore[0].content, /<% authorRule\(\) %>/);
    assert.equal(data.characterLore[0].content.includes('<% injected() %>'), false);
    assert.equal(data.characterLore[0].content, authored);
});

test('template-preprocessed native body wins over dynamic edits and emits a nonblocking warning', async () => {
    const f = fixture();
    const notices = [];
    const host = await createSillyTavernHost({ ...f.deps, onWarning: notice => notices.push(notice) });
    host.setPlan({ chatId: host.snapshot().chatId, requestId: 'r-template', selectedIds: ['source:main:1'], entries: [{
        id: 'source:main:1', source: { book: 'main', uid: 1, original: 'Hello <%= name %>' },
        segments: [{ text: 'Hello <%= name %> new memory' }],
    }] });
    const data = { characterLore: [{ ...f.raw.entries[1], world: 'main', content: 'Hello Alice' }] };
    host.applyWorldInfoEntries(data);
    assert.equal(data.characterLore[0].content, 'Hello Alice');
    assert.equal(data.characterLore[0].constant, true);
    assert.equal(notices[0].code, 'native-template-preserved');
    assert.deepEqual(notices[0].uids, ['1']);
    assert.equal(f.raw.entries[1].content, 'old blue');
});

test('native activation audit reports missing blue without claiming a budget cause', async () => {
    const f = fixture();
    const events = new Map();
    const notices = [];
    const host = await createSillyTavernHost({ ...f.deps, onWarning: notice => notices.push(notice),
        eventSource: { on: (name, fn) => events.set(name, fn), removeListener: name => events.delete(name) },
        eventTypes: { WORLD_INFO_ACTIVATED: 'activated', MESSAGE_RECEIVED: 'received' },
    });
    const dispose = host.bindController({});
    host.setPlan({ chatId: host.snapshot().chatId, requestId: 'r-budget', entries: [{
        id: 'source:main:1', source: { book: 'main', uid: 1, original: 'old blue' }, segments: [{ text: 'new blue' }],
    }] });
    host.applyWorldInfoEntries({ characterLore: [{ ...f.raw.entries[1], world: 'main' }] });
    events.get('activated')([{ world: 'other', uid: 9 }]);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].code, 'native-blue-omitted');
    assert.equal(notices[0].cause, 'unknown');
    assert.match(notices[0].message, /预算、概率、分组/);
    assert.deepEqual(notices[0].entries, [{ uid: 1, title: 'blue' }]);
    events.get('received')(1, 'normal');
    assert.equal(notices.length, 1);
    dispose();
});

test('an activated blue produces no warning; a zero-activation reply reports omission', async () => {
    const f = fixture();
    const events = new Map();
    const notices = [];
    const host = await createSillyTavernHost({ ...f.deps, onWarning: notice => notices.push(notice),
        eventSource: { on: (name, fn) => events.set(name, fn), removeListener: name => events.delete(name) },
        eventTypes: { WORLD_INFO_ACTIVATED: 'activated', MESSAGE_RECEIVED: 'received' },
    });
    const dispose = host.bindController({});
    const start = () => {
        host.setPlan({ chatId: host.snapshot().chatId, requestId: 'r', entries: [{
            id: 'source:main:1', source: { book: 'main', uid: 1, original: 'old blue' }, segments: [{ text: 'new blue' }],
        }] });
        host.applyWorldInfoEntries({ characterLore: [{ ...f.raw.entries[1], world: 'main' }] });
    };
    start();
    events.get('activated')([{ world: 'main', uid: 1 }]);
    assert.equal(notices.length, 0);
    start();
    events.get('received')(1, 'normal');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].code, 'native-blue-omitted');
    dispose();
});

test('metadata write checks revision and restores previous state on save failure', async () => {
    const f = fixture();
    const host = await createSillyTavernHost(f.deps);
    const id = host.snapshot().chatId;
    f.fail();
    await assert.rejects(host.storage.write(id, { revision: 1, data: {} }, 0), /save failed/);
    assert.equal(f.live.chatMetadata.dwm, undefined);
    f.recover();
    await host.storage.write(id, { revision: 1, data: {} }, 0);
    assert.equal((await host.storage.read(id)).revision, 1);
    await assert.rejects(host.storage.write(id, { revision: 2 }, 0), /版本/);
    f.live.chatId = 'branch';
    await assert.rejects(host.storage.read(id), /切换/);
    assert.equal(f.live.chatMetadata.dwm.revision, 1);
});

test('legacy recovery owns only its flags and rolls back failed save', async () => {
    const f = fixture();
    f.live.chat[0].is_system = true;
    f.live.chat[0].extra.dwmHidden = { owner: 'dynamic-world-memory' };
    const host = await createSillyTavernHost(f.deps);
    f.fail();
    await assert.rejects(host.restoreLegacyWindow(), /save failed/);
    assert.equal(f.live.chat[0].is_system, true);
    assert.equal(f.live.chat[0].extra.dwmHidden.owner, 'dynamic-world-memory');
    f.recover();
    assert.equal(await host.restoreLegacyWindow(), 1);
    assert.equal(f.live.chat[0].is_system, false);
    assert.equal(f.live.chat[2].is_system, true);
    assert.equal(f.live.chat[0].extra.dwmHidden, undefined);
});

test('event bridge waits for preflight and explicitly cancels after a failed preflight', async () => {
    const f = fixture();
    const events = new Map();
    const source = {
        on(name, fn) { events.set(name, fn); },
        removeListener(name) { events.delete(name); },
    };
    const types = Object.fromEntries([
        'GENERATION_AFTER_COMMANDS', 'WORLDINFO_ENTRIES_LOADED', 'MESSAGE_RECEIVED',
        'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_CHANGED', 'MESSAGE_SWIPED',
        'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED',
    ].map(name => [name, name]));
    let stopped = 0;
    let beforeDone = false;
    const host = await createSillyTavernHost({ ...f.deps, eventSource: source, eventTypes: types,
        stopGeneration: () => { stopped++; }, onPreflightFailure: () => 'cancel' });
    const dispose = host.bindController({ generationBefore: async () => {
        await Promise.resolve();
        beforeDone = true;
        throw new Error('selector failed');
    } });
    await events.get(types.GENERATION_AFTER_COMMANDS)('normal', {}, false);
    assert.equal(beforeDone, true);
    assert.equal(stopped, 1);
    dispose();
    assert.equal(events.size, 0);
});

test('controller cancel result invokes native stop and raw helper maps to generateRaw prompt', async () => {
    const f = fixture();
    const events = new Map();
    const source = { on: (name, fn) => events.set(name, fn), removeListener: name => events.delete(name) };
    const types = { GENERATION_AFTER_COMMANDS: 'before' };
    let stopped = 0, rawArgs;
    const host = await createSillyTavernHost({ ...f.deps, eventSource: source, eventTypes: types,
        stopGeneration: () => { stopped++; }, rawGenerate: async args => { rawArgs = args; return '{"ok":true}'; } });
    const dispose = host.bindController({ generationBefore: async () => ({ cancel: true }) });
    await events.get('before')('normal', {}, false);
    assert.equal(stopped, 1);
    const signal = new AbortController();
    assert.equal(await host.rawGenerate({ purpose: 'select', system: 'system text', input: '{"story":1}', signal: signal.signal }), '{"ok":true}');
    assert.deepEqual(rawArgs.prompt, [{ role: 'system', content: 'system text' }, { role: 'user', content: '{"story":1}' }]);
    assert.equal(rawArgs.trimNames, false);
    dispose();
});

test('event bridge does not stop twice when the controller already used the host stop', async () => {
    const f = fixture();
    const events = new Map();
    let stopped = 0;
    const host = await createSillyTavernHost({ ...f.deps,
        eventSource: { on: (name, fn) => events.set(name, fn), removeListener: name => events.delete(name) },
        eventTypes: { GENERATION_AFTER_COMMANDS: 'before' },
        stopGeneration: () => { stopped++; },
    });
    const dispose = host.bindController({ generationBefore: async () => {
        host.stopGeneration();
        return { cancel: true };
    } });
    await events.get('before')('normal', {}, false);
    assert.equal(stopped, 1);
    dispose();
});

function preflightEvents() {
    const listeners = new Map();
    const types = Object.fromEntries(['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_STOPPED', 'CHAT_CHANGED'].map(name => [name, name]));
    const source = {
        on(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
        removeListener(type, listener) { listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener)); },
        makeFirst(type, listener) { this.removeListener(type, listener); listeners.set(type, [listener, ...(listeners.get(type) ?? [])]); },
        async emit(type, ...args) { for (const listener of [...(listeners.get(type) ?? [])]) await listener(...args); },
    };
    const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
    return { source, types, deferred };
}

test('activity stop through the real host bridge cancels once and leaves the next foreground request usable', async () => {
    const f = fixture(), { source, types, deferred } = preflightEvents();
    const first = deferred(), entered = deferred(); let selections = 0, stopped = 0;
    const host = await createSillyTavernHost({ ...f.deps, eventSource: source, eventTypes: types,
        stopGeneration: () => { stopped++; return source.emit(types.GENERATION_STOPPED); } });
    const controller = new Controller(host, { settings: { enabled: true }, model: { complete: async request => {
        assert.equal(request.purpose, 'select');
        if (++selections === 1) { entered.resolve(); return first.promise; }
        return { ids: [] };
    } } });
    await controller.start();
    await controller.store.initialize(Object.values(f.raw.entries).map(raw => makeSourceEntry('main', raw)), '记录事实');
    const dispose = host.bindController(controller);
    await source.emit(types.GENERATION_STARTED, 'normal', {}, false);
    const oldRun = source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    await entered.promise;
    const oldId = controller.view().activity.id;
    assert.deepEqual(await controller.requestStop(oldId), { stopped: true });
    await oldRun;
    assert.equal(stopped, 1);
    assert.equal(controller.view().activity, null);
    await source.emit(types.GENERATION_STARTED, 'normal', {}, false);
    await source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    assert.equal(selections, 2);
    const currentPlan = controller.view().diagnostics.lastPlan;
    assert.ok(currentPlan);
    first.resolve({ ids: [] }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, 1);
    assert.deepEqual(controller.view().diagnostics.lastPlan, currentPlan);
    assert.deepEqual(await controller.requestStop(oldId), { stopped: false, reason: '该任务已结束' });
    dispose();
});

test('cancelled native event is captured before an earlier card listener and cannot enter a new preflight', async () => {
    const f = fixture(), { source, types, deferred } = preflightEvents();
    const cardStarted = deferred(), cardFinished = deferred(), calls = [];
    let stopped = 0;
    const host = await createSillyTavernHost({ ...f.deps, eventSource: source, eventTypes: types, stopGeneration: () => { stopped++; } });
    const dispose = host.bindController({ generationBefore: async ({ options }) => { calls.push(options.tag); return { cancel: false }; } });
    // Cards may register makeFirst after the extension has initialized.
    source.makeFirst(types.GENERATION_AFTER_COMMANDS, async (type, options) => {
        if (options.tag === 'old') { cardStarted.resolve(); await cardFinished.promise; }
    });
    await source.emit(types.GENERATION_STARTED, 'normal', {}, false);
    const oldEvent = source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', { tag: 'old' }, false);
    await cardStarted.promise;
    await source.emit(types.GENERATION_STOPPED);
    await source.emit(types.GENERATION_STARTED, 'normal', {}, false);
    await source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', { tag: 'new' }, false);
    cardFinished.resolve(); await oldEvent;
    assert.deepEqual(calls, ['new']);
    assert.equal(stopped, 0);
    dispose();
});

test('late cancelled or rejected preflight cannot stop a newer run or clear its plan', async () => {
    for (const outcome of ['cancel', 'reject']) {
        const f = fixture(), { source, types, deferred } = preflightEvents();
        const entered = deferred(), result = deferred();
        let stopped = 0, fallback = 0;
        const host = await createSillyTavernHost({ ...f.deps, eventSource: source, eventTypes: types,
            stopGeneration: () => { stopped++; }, onPreflightFailure: () => { fallback++; return 'cancel'; } });
        const dispose = host.bindController({ generationBefore: async ({ options }) => {
            if (options.tag === 'old') { entered.resolve(); return result.promise; }
            host.setPlan({ chatId: host.snapshot().chatId, bookName: 'main', selectedIds: [], dynamicEntries: [], summary: 'new plan' });
        } });
        await source.emit(types.GENERATION_STARTED, 'normal', {}, false);
        const oldEvent = source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', { tag: 'old' }, false);
        await entered.promise;
        await source.emit(types.GENERATION_STARTED, 'normal', {}, false);
        await source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', { tag: 'new' }, false);
        if (outcome === 'reject') result.reject(new Error('old failure'));
        else result.resolve({ cancel: true });
        await oldEvent;
        assert.equal(stopped, 0, outcome); assert.equal(fallback, 0, outcome);
        assert.equal(f.prompts.get('dwm:summary').value, 'new plan', outcome);
        dispose();
    }
});

test('late fallback decision cannot stop the next native run', async () => {
    const f = fixture(), { source, types, deferred } = preflightEvents();
    const shown = deferred(), choice = deferred();
    let stopped = 0;
    const host = await createSillyTavernHost({ ...f.deps, eventSource: source, eventTypes: types,
        stopGeneration: () => { stopped++; }, onPreflightFailure: async () => { shown.resolve(); return choice.promise; } });
    const dispose = host.bindController({ generationBefore: async ({ options }) => { if (options.tag === 'old') throw new Error('failed'); } });
    await source.emit(types.GENERATION_STARTED, 'normal', {}, false);
    const oldEvent = source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', { tag: 'old' }, false);
    await shown.promise;
    await source.emit(types.GENERATION_STARTED, 'normal', {}, false);
    await source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', { tag: 'new' }, false);
    choice.resolve('cancel'); await oldEvent;
    assert.equal(stopped, 0);
    dispose();
});

test('direct AFTER_COMMANDS without START remains usable before and after a stopped native run', async () => {
    const f = fixture(), { source, types } = preflightEvents(), calls = [];
    const host = await createSillyTavernHost({ ...f.deps, eventSource: source, eventTypes: types });
    const dispose = host.bindController({ generationBefore: async ({ options }) => { calls.push(options.tag); } });
    await source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', { tag: 'direct-before' }, false);
    await source.emit(types.GENERATION_STARTED, 'normal', {}, false);
    await source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', { tag: 'native' }, false);
    await source.emit(types.GENERATION_STOPPED);
    await source.emit(types.GENERATION_AFTER_COMMANDS, 'normal', { tag: 'direct-after' }, false);
    assert.deepEqual(calls, ['direct-before', 'native', 'direct-after']);
    dispose();
});

test('received body runs after event turn; pending swipe does not reconcile as a reply', async () => {
    const f = fixture();
    const events = new Map();
    const source = { on: (name, fn) => events.set(name, fn), removeListener: name => events.delete(name) };
    const types = { MESSAGE_RECEIVED: 'received', MESSAGE_SWIPED: 'swiped' };
    let received = 0, swiped = 0;
    const host = await createSillyTavernHost({ ...f.deps, eventSource: source, eventTypes: types });
    const dispose = host.bindController({ messageReceived: () => { received++; }, messageSwiped: () => { swiped++; } });
    events.get('received')(1, 'normal');
    assert.equal(received, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(received, 1);
    f.live.chat[1].swipe_id = 2; // New slot before generated text exists.
    events.get('swiped')(1);
    assert.equal(swiped, 0);
    f.live.chat[1].swipe_id = 1;
    events.get('swiped')(1);
    assert.equal(swiped, 1);
    dispose();
});

test('chat save reconciles MVU updates that arrive during POST and verifies durable selected swipe data', async () => {
    const f = fixture();
    f.live.characters[0].name = 'Character';
    f.live.getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
    let disk = [], posts = 0;
    const host = await createSillyTavernHost({ ...f.deps, save: undefined, fetch: async (url, options) => {
        if (url.endsWith('/get')) return { ok: true, json: async () => structuredClone(disk) };
        disk = JSON.parse(options.body).chat; posts++;
        if (posts === 1) f.live.chat[1].variables = [{ stat_data: { location: 'wrong swipe' } }, { stat_data: { location: 'river' } }];
        return { ok: true, json: async () => ({ ok: true }) };
    } });
    await host.storage.write(host.snapshot().chatId, { revision: 1 }, 0);
    assert.equal(posts, 2);
    assert.equal(disk[2].variables[1].stat_data.location, 'river');
    assert.equal(disk[0].chat_metadata.dwm.revision, 1);
});

test('save acknowledgement without matching readback does not certify memory progress', async () => {
    const f = fixture();
    f.live.characters[0].name = 'Character';
    f.live.getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
    const host = await createSillyTavernHost({ ...f.deps, save: undefined, fetch: async url =>
        ({ ok: true, json: async () => url.endsWith('/get') ? [] : { ok: true } }) });
    await assert.rejects(host.storage.write(host.snapshot().chatId, { revision: 1 }, 0), /保存结果与提交不符/);
    assert.equal(f.live.chatMetadata.dwm, undefined);
});

test('a competing memory replacement during save cannot certify the requested revision', async () => {
    const f = fixture();
    f.live.characters[0].name = 'Character';
    f.live.getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
    let disk = [];
    const host = await createSillyTavernHost({ ...f.deps, save: undefined, fetch: async (url, options) => {
        if (url.endsWith('/get')) return { ok: true, json: async () => structuredClone(disk) };
        disk = JSON.parse(options.body).chat;
        f.live.chatMetadata.dwm = { revision: 0, marker: 'another writer' };
        return { ok: true, json: async () => ({ ok: true }) };
    } });
    await assert.rejects(host.storage.write(host.snapshot().chatId, { revision: 1 }, 0), /被其他操作替换/);
    assert.equal(f.live.chatMetadata.dwm.marker, 'another writer');
});

test('CHAT_CHANGED returns the load promise so later host listeners wait for current memory readiness', async () => {
    const f = fixture(), { source, types, deferred } = preflightEvents(), loading = deferred();
    const host = await createSillyTavernHost({ ...f.deps, eventSource: source, eventTypes: types });
    const dispose = host.bindController({ chatChanged: () => loading.promise });
    let laterRan = false; source.on(types.CHAT_CHANGED, () => { laterRan = true; });
    const changing = source.emit(types.CHAT_CHANGED);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(laterRan, false);
    loading.resolve(); await changing; assert.equal(laterRan, true); dispose();
});
