import assert from 'node:assert/strict';
import test from 'node:test';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
    const live = { chatId: 'one', characterId: 0, characters: [{ avatar: 'card.png', data: { extensions: { world: 'main' } } }],
        chat: [{ mes: 'private message' }], chatMetadata: {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'private header' }) };
    const files = new Map(), cache = new Map([['unrelated', { entries: { 1: { content: 'unrelated body' } } }]]);
    const reads = [], requests = [];
    const controls = { settings: null, read: null };
    const worldInfo = { world_names: ['main'], worldInfoCache: cache, world_info: { charLore: [] },
        async loadWorldInfo(name) {
            reads.push(name);
            if (controls.read) return controls.read(name);
            if (!cache.has(name)) cache.set(name, structuredClone(files.get(name) ?? { entries: {} }));
            return structuredClone(cache.get(name));
        } };
    const deps = { context: () => live, script: {}, extensions: {}, worldInfo,
        fetch: async (url, options) => {
            requests.push({ url, options });
            assert.equal(url, '/api/settings/get'); assert.equal(options.method, 'POST');
            if (controls.settings) return controls.settings();
            return { ok: true, json: async () => ({ world_names: [...files.keys()], api_key: 'never expose this', settings: 'private settings' }) };
        } };
    return { live, files, cache, reads, requests, controls, worldInfo, deps };
}

test('missing primary is not accepted as ST 200 empty placeholder and later import recovers on recheck', async () => {
    const f = fixture(), host = await createSillyTavernHost(f.deps);
    await assert.rejects(host.loadWorldbook(), /不存在/);
    assert.equal(host.worldbookStatus().state, 'missing');
    f.files.set('main', { entries: { 7: { uid: 7, content: 'newly imported' } } });
    const status = await host.checkWorldbook();
    assert.equal(status.state, 'ready'); assert.equal(status.entryCount, 1); assert.equal(status.listed, true);
    assert.deepEqual(await host.loadWorldbook(), [{ uid: 7, content: 'newly imported' }]);
    assert.ok(f.cache.has('unrelated')); assert.ok(f.reads.every(name => name === 'main'));
    assert.equal(f.requests.length, 2, 'non-empty routine reads do not check the complete settings again');
});

test('real empty primary remains valid even when the local world-name list is stale', async () => {
    const f = fixture(); f.files.set('main', { entries: {} }); f.worldInfo.world_names = [];
    const host = await createSillyTavernHost(f.deps);
    assert.deepEqual(await host.loadWorldbook(), []);
    assert.equal(host.worldbookStatus().state, 'empty'); assert.equal(host.worldbookStatus().listed, true);
    assert.equal((await host.checkWorldbook()).state, 'empty');
});

test('explicit detection refreshes a non-empty old cache for the current primary only', async () => {
    const f = fixture();
    f.cache.set('main', { entries: { 1: { uid: 1, content: 'old cached body' } } });
    f.files.set('main', { entries: { 2: { uid: 2, content: 'new body' }, 3: { uid: 3, content: 'new entry' } } });
    const host = await createSillyTavernHost(f.deps), before = JSON.stringify(f.live);
    assert.equal((await host.checkWorldbook()).entryCount, 2);
    assert.deepEqual((await host.loadWorldbook()).map(entry => entry.uid), [2, 3]);
    assert.equal(f.requests.length, 1); assert.ok(f.cache.has('unrelated')); assert.equal(JSON.stringify(f.live), before);
});

test('snapshots and book status share binding validation without changing valid file names', async () => {
    const f = fixture(), host = await createSillyTavernHost(f.deps);
    for (const name of ['  ', {}, 123, null]) {
        f.live.characters[0].data.extensions.world = name;
        assert.equal(host.previewSnapshot().bookName, null); assert.equal(host.worldbookStatus().state, 'unbound');
    }
    f.live.characters[0].data.extensions.world = ' book with spaces ';
    assert.equal(host.previewSnapshot().bookName, ' book with spaces '); assert.equal(host.worldbookStatus().primaryName, ' book with spaces ');
});

test('book status is read-only and distinguishes auxiliary or embedded books from the primary', async () => {
    const f = fixture(); f.live.characters[0].data.extensions.world = '';
    f.live.characters[0].data.character_book = { name: 'private embedded name', entries: [{ content: 'private embedded body' }] };
    f.worldInfo.world_info.charLore = [{ name: 'card', extraBooks: ['private extra name'] }];
    f.live.chatMetadata.world_info = 'private chat-book name';
    const before = JSON.stringify(f.live), host = await createSillyTavernHost(f.deps);
    const status = host.worldbookStatus();
    assert.equal(status.state, 'unbound'); assert.equal(status.primaryName, null);
    assert.equal(status.embeddedBook, true); assert.equal(status.additionalBookCount, 1); assert.equal(status.chatBook, true);
    assert.equal((await host.checkWorldbook()).state, 'unbound');
    assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 0); assert.equal(JSON.stringify(f.live), before);
    assert.doesNotMatch(JSON.stringify(status), /private/);
    status.message = 'mutated'; assert.notEqual(host.worldbookStatus().message, 'mutated');
});

test('no chat, group, and unavailable character produce distinct safe statuses', async () => {
    const f = fixture(), host = await createSillyTavernHost(f.deps);
    f.live.chatId = null; assert.equal(host.worldbookStatus().state, 'no-chat');
    f.live.chatId = 'group-one'; f.live.groupId = 'group'; assert.equal((await host.checkWorldbook()).state, 'group');
    delete f.live.groupId; f.live.characters = []; assert.equal((await host.checkWorldbook()).state, 'character-unavailable');
    assert.equal(f.requests.length, 0); assert.equal(f.reads.length, 0);
});

test('read failures never leak exception text or settings into diagnostic status', async () => {
    const f = fixture(); f.files.set('main', { entries: {} });
    f.controls.read = () => { throw new Error('private token=secret; private story body'); };
    const host = await createSillyTavernHost(f.deps), status = await host.checkWorldbook();
    assert.equal(status.state, 'read-failed'); assert.equal(status.listed, true); assert.equal(status.entryCount, null);
    assert.doesNotMatch(JSON.stringify(status), /private|secret|api_key/);
    await assert.rejects(host.loadWorldbook(), /尚未加载/);
});

test('failed or malformed existence checks are unknown, never reported as a missing or empty book', async () => {
    for (const response of [{ ok: false, status: 503 }, { ok: true, json: async () => ({ world_names: 'wrong', token: 'secret' }) }]) {
        const f = fixture(); f.controls.settings = async () => response;
        const host = await createSillyTavernHost(f.deps);
        await assert.rejects(host.loadWorldbook(), /无法确认/);
        assert.equal(host.worldbookStatus().state, 'check-failed'); assert.equal(host.worldbookStatus().listed, null);
        const checked = await host.checkWorldbook(); assert.equal(checked.state, 'check-failed');
        assert.doesNotMatch(JSON.stringify(checked), /secret|token/);
    }
});

test('late existence and read results cannot update another chat or changed primary', async () => {
    for (const phase of ['fetch', 'json', 'book']) {
        const f = fixture(), held = deferred(); f.files.set('main', { entries: { 1: { content: 'old body' } } });
        const entered = deferred();
        if (phase === 'fetch') f.controls.settings = async () => { entered.resolve(); return held.promise; };
        if (phase === 'json') f.controls.settings = async () => ({ ok: true, json: () => { entered.resolve(); return held.promise; } });
        if (phase === 'book') f.controls.read = async () => { entered.resolve(); return held.promise; };
        const host = await createSillyTavernHost(f.deps), pending = host.checkWorldbook();
        const rejected = assert.rejects(pending, { name: 'AbortError' }); await entered.promise;
        if (phase === 'json') f.live.characters[0].data.extensions.world = 'other'; else f.live.chatId = 'two';
        held.resolve(phase === 'fetch' ? { ok: true, json: async () => ({ world_names: ['main'] }) }
            : phase === 'json' ? { world_names: ['main'] } : { entries: { 1: { content: 'old body' } } });
        await rejected;
        const current = host.worldbookStatus(); assert.equal(current.state, 'bound'); assert.equal(current.checkedAt, null);
        assert.doesNotMatch(JSON.stringify(current), /old body/);
    }
});

test('overlapping checks keep the latest result for the same binding', async () => {
    const f = fixture(), held = deferred(), entered = deferred();
    f.controls.settings = async () => { entered.resolve(); return held.promise; };
    const host = await createSillyTavernHost(f.deps), old = host.checkWorldbook();
    const rejected = assert.rejects(old, { name: 'AbortError' }); await entered.promise;
    f.controls.settings = null; f.files.set('main', { entries: { 1: { uid: 1, content: 'available' } } });
    assert.equal((await host.checkWorldbook()).state, 'ready');
    held.resolve({ ok: true, json: async () => ({ world_names: [] }) }); await rejected;
    assert.equal(host.worldbookStatus().state, 'ready');
});

test('explicit detection has a total deadline including a stalled native book read', async t => {
    const f = fixture(), held = deferred(), entered = deferred(); f.files.set('main', { entries: {} });
    f.controls.read = () => { entered.resolve(); return held.promise; };
    const host = await createSillyTavernHost(f.deps);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const checking = host.checkWorldbook(); await entered.promise;
    t.mock.timers.tick(15000);
    const status = await checking; assert.equal(status.state, 'read-failed'); assert.match(status.message, /超时/);
    held.resolve({ entries: { 1: { uid: 1, content: 'late result' } } });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(host.worldbookStatus(), status);
});

test('injected hosts without HTTP headers keep legacy reads but explicit detection reports unavailable checks', async () => {
    const f = fixture(); delete f.live.getRequestHeaders; delete f.deps.fetch;
    const host = await createSillyTavernHost(f.deps);
    assert.deepEqual(await host.loadWorldbook(), []);
    assert.equal((await host.checkWorldbook()).state, 'check-failed');
});
