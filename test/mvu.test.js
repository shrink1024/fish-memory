import test from 'node:test';
import assert from 'node:assert/strict';
import { readMvuProjection } from '../src/adapters/mvu.js';

const selected = [{ path: '角色.位置', label: '当前位置' }];
function fixture(data = { stat_data: { 角色: { 位置: '书店' } } }) {
    let live = { characterId: 0, characters: [{ avatar: 'card.png' }], getCurrentChatId: () => 'chat-a',
        chat: [{ is_user: false, is_system: false, mes: '已经抵达书店。', swipe_id: 0,
            swipes: ['已经抵达书店。', '留在家中。'], extra: { dwmKey: 'reply-a' } }] };
    const calls = [], writes = [];
    const globals = { Mvu: {
        getMvuData(options) { calls.push(options); return data; },
        parseMessage() { writes.push('parse'); throw new Error('must not parse'); },
        replaceMvuData() { writes.push('replace'); throw new Error('must not write'); },
        setMvuVariable() { writes.push('set'); throw new Error('must not write'); },
    } };
    const settings = { mvuEnabled: true, mvuFields: selected };
    return { globals, settings, calls, writes, context: () => live, get live() { return live; },
        replaceContext(value) { live = value; }, read(overrides = {}) { return readMvuProjection({ context: () => live, globals, settings, ...overrides }); } };
}
function defer() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('MVU disabled and absent never read or call mutations', async () => {
    const f = fixture();
    const disabled = await f.read({ settings: { mvuEnabled: false, mvuFields: selected } });
    assert.equal(disabled.status, 'disabled'); assert.deepEqual(f.calls, []);
    const absent = await f.read({ globals: {} });
    assert.equal(absent.status, 'unavailable'); assert.equal(absent.available, false);
    assert.deepEqual(f.writes, []);
});

test('MVU projects only explicit scalar leaves with source and unverified freshness', async () => {
    const stat = { 角色: { 位置: '书店', 好感: 5 }, secret: 'UNSELECTED_SECRET' };
    Object.defineProperty(stat, 'hidden', { get() { throw new Error('unselected getter read'); } });
    const f = fixture({ stat_data: stat, schema: { secret: 'INTERNAL_SCHEMA' } });
    const result = await f.read();
    assert.equal(result.status, 'ready'); assert.equal(result.source, 'Mvu.getMvuData');
    assert.deepEqual(f.calls, [{ type: 'message', message_id: 0 }]);
    assert.deepEqual(result.fields, [{ path: 'stat_data.角色.位置', label: '当前位置', value: '书店' }]);
    assert.equal(result.messageId, 0); assert.equal(result.swipeId, 0);
    assert.equal(result.freshness.chatId, 'character:card.png:chat-a');
    assert.equal(result.freshness.messageKey, 'reply-a:swipe:0');
    assert.equal(result.freshness.persistence, 'unverified');
    assert.doesNotMatch(JSON.stringify(result), /UNSELECTED_SECRET|INTERNAL_SCHEMA/);
    assert.deepEqual(f.writes, []);
});

test('MVU falls back only to the public TH reader when MVU API is absent', async () => {
    const f = fixture();
    const result = await f.read({ globals: { TavernHelper: { getVariables(options) {
        assert.deepEqual(options, { type: 'message', message_id: 0 }); return { stat_data: { 角色: { 位置: '公园' } } };
    } } } });
    assert.equal(result.source, 'TavernHelper.getVariables'); assert.equal(result.fields[0].value, '公园');
});

test('MVU rejects invalid, root, prototype, internal and accessor paths without leaking values', async () => {
    const actor = Object.create({ inherited: 'INHERITED_SECRET' });
    actor.位置 = '书店';
    Object.defineProperty(actor, 'accessor', { get() { throw new Error('accessor must not run'); } });
    const f = fixture({ stat_data: { 角色: actor, $internal: { secret: 'INTERNAL_SECRET' } } });
    const paths = ['stat_data', 'constructor.name', '__proto__.secret', '角色.prototype', '$internal.secret',
        '角色[0].位置', '角色.*', '角色..位置', '角色.inherited', '角色.accessor', '角色'];
    const result = await f.read({ settings: { mvuEnabled: true, mvuFields: [...paths, '角色.位置'] } });
    assert.equal(result.status, 'partial'); assert.deepEqual(result.fields, [{ path: 'stat_data.角色.位置', label: '角色.位置', value: '书店' }]);
    assert.doesNotMatch(JSON.stringify(result), /INHERITED_SECRET|INTERNAL_SECRET/);
    const onlyInvalid = await f.read({ settings: { mvuEnabled: true, mvuFields: ['stat_data', '__proto__.x'] } });
    assert.equal(onlyInvalid.status, 'invalid-settings'); assert.equal(f.calls.length, 1);
});

test('MVU limits field count and scalar sizes without truncating facts or dumping objects', async () => {
    const stat_data = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, 'a'.repeat(300)]));
    stat_data.huge = 'SECRET'.repeat(10000); stat_data.object = { private: 'DO_NOT_DUMP' }; stat_data.nan = NaN;
    const f = fixture({ stat_data });
    const result = await f.read({ settings: { mvuEnabled: true, mvuFields: [
        'huge', 'object', 'nan', ...Array.from({ length: 20 }, (_, i) => `f${i}`),
    ] } });
    assert.equal(result.status, 'partial'); assert.equal(result.fields.length, 10);
    assert.ok(result.fields.every(field => field.value.length === 300));
    assert.doesNotMatch(JSON.stringify(result), /SECRET|DO_NOT_DUMP/);
    assert.ok(result.fields.every(field => Number(field.path.slice('stat_data.f'.length)) < 13));
});

test('MVU preserves primitive values and allows an explicit indexed leaf', async () => {
    const f = fixture({ stat_data: { zero: 0, no: false, nil: null, list: [{ name: '红伞' }] } });
    const result = await f.read({ settings: { mvuEnabled: true, mvuFields: ['zero', 'no', 'nil', 'list.0.name'] } });
    assert.equal(result.status, 'ready'); assert.deepEqual(result.fields.map(field => field.value), [0, false, null, '红伞']);
});

test('MVU never falls back to an older reply when state is missing or a newer user tail exists', async () => {
    const f = fixture({});
    assert.equal((await f.read()).status, 'missing'); assert.equal(f.calls.length, 1);
    f.live.chat.push({ is_user: true, mes: '接下来去哪里？' });
    const pending = await f.read();
    assert.equal(pending.status, 'pending'); assert.deepEqual(pending.fields, []); assert.equal(f.calls.length, 1);
});

test('MVU accepts fish-owned hidden assistant but not an unknown hidden/system tail', async () => {
    const f = fixture();
    f.live.chat[0].is_system = true;
    assert.equal((await f.read()).status, 'pending'); assert.equal(f.calls.length, 0);
    f.live.chat[0].extra.dwmHidden = { owner: 'dynamic-world-memory' };
    assert.equal((await f.read()).status, 'ready'); assert.equal(f.calls.length, 1);
});

test('MVU discards reads when chat identity, selected swipe, message object or pending tail changes', async t => {
    const changes = {
        chat: f => { f.replaceContext({ ...f.live, getCurrentChatId: () => 'chat-b' }); },
        character: f => { f.live.characters[0].avatar = 'other.png'; },
        swipe: f => { f.live.chat[0].swipe_id = 1; },
        replacement: f => { f.live.chat[0] = { ...f.live.chat[0] }; },
        user: f => { f.live.chat.push({ is_user: true, mes: '新输入' }); },
        text: f => { f.live.chat[0].mes = '读取期间内容发生变化。'; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
        const f = fixture(), d = defer();
        f.globals.Mvu.getMvuData = () => d.promise;
        const pending = f.read(); change(f); d.resolve({ stat_data: { 角色: { 位置: 'STALE_SECRET' } } });
        const result = await pending;
        assert.equal(result.status, 'changed'); assert.deepEqual(result.fields, []);
        assert.doesNotMatch(JSON.stringify(result), /STALE_SECRET/);
    });
});

test('MVU defers during extra analysis and rejects a replaced API instance', async () => {
    const f = fixture(); f.globals.Mvu.isDuringExtraAnalysis = () => true;
    assert.equal((await f.read()).status, 'pending'); assert.equal(f.calls.length, 0);
    delete f.globals.Mvu.isDuringExtraAnalysis;
    const d = defer(); f.globals.Mvu.getMvuData = () => d.promise;
    const pending = f.read(); f.globals.Mvu = { ...f.globals.Mvu };
    d.resolve({ stat_data: { 角色: { 位置: 'stale' } } });
    assert.equal((await pending).status, 'changed');
});

test('MVU discards a read when extra analysis starts while waiting', async () => {
    const f = fixture(), d = defer();
    let busy = false;
    f.globals.Mvu.isDuringExtraAnalysis = () => busy;
    f.globals.Mvu.getMvuData = () => d.promise;
    const pending = f.read(); busy = true;
    d.resolve({ stat_data: { 角色: { 位置: 'not-final' } } });
    const result = await pending;
    assert.equal(result.status, 'pending'); assert.deepEqual(result.fields, []);
});

test('MVU bounds a stalled optional reader without applying its eventual result', async () => {
    const f = fixture(), d = defer();
    f.globals.Mvu.getMvuData = () => d.promise;
    const result = await f.read();
    assert.equal(result.status, 'pending'); assert.match(result.reason, /超时/);
    assert.deepEqual(result.fields, []); assert.equal(result.freshness, null);
    d.resolve({ stat_data: { 角色: { 位置: 'TOO_LATE' } } });
    await Promise.resolve(); assert.deepEqual(result.fields, []); assert.deepEqual(f.writes, []);
});

test('MVU never relays upstream error text or retries through another reader', async () => {
    const f = fixture(); f.globals.Mvu.getMvuData = () => { throw new Error('PRIVATE_VALUE'); };
    f.globals.TavernHelper = { getVariables() { assert.fail('no fallback after read error'); } };
    const result = await f.read();
    assert.equal(result.status, 'error'); assert.deepEqual(result.fields, []);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE/); assert.deepEqual(f.writes, []);
});

test('MVU requires a live context getter, handles empty fields, and supports the global getter', async () => {
    const f = fixture();
    assert.equal((await f.read({ settings: { mvuEnabled: true, mvuFields: [] } })).status, 'unconfigured');
    assert.equal((await f.read({ context: f.live })).status, 'unavailable');
    f.globals.SillyTavern = { getContext: f.context };
    assert.equal((await f.read({ context: undefined })).status, 'ready');
});
