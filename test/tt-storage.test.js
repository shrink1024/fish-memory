import test from 'node:test';
import assert from 'node:assert/strict';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';

async function fixture({ corrupt, beforeRead, gate } = {}) {
    const original = { swipes: ['older', 'selected'], swipe_info: [{ extra: { otherPlugin: 'keep', dwmCandidateKey: 'old-key' }, dwmCandidateKey: 'old-key' }, { extra: {} }] };
    const live = { chatId: 'test', characterId: 0, characters: [{ avatar: 'fixture.png', name: 'Fixture', data: { extensions: { world: 'main' } } }],
        chatMetadata: {}, getRequestHeaders: () => ({}), chat: [{ mes: 'selected', is_user: false, swipe_id: 1,
            swipes: [null, 'selected'], swipe_info: [null, { extra: {} }], extra: {}, tt_swipe_cold: { sourceId: 7, record: 1 } }] };
    let disk = [{ chat_metadata: {} }], writes = 0, inQueue = false;
    const deps = { context: () => live, tauriHost: { abiVersion: 1 },
        tauriTransport: { readColdSwipeRecord: async reference => {
            assert.deepEqual(reference, { sourceId: 7, record: 1 }); await beforeRead?.(live); return structuredClone(original);
        } },
        script: { setExtensionPrompt() {}, enqueueChatSave: async task => { await gate; inQueue = true; try { return await task(); } finally { inQueue = false; } } },
        worldInfo: {}, extensions: {}, fetch: async (url, options) => {
            assert.equal(inQueue, true, 'Fish persistence must run inside TT queue');
            if (url.endsWith('/save')) {
                disk = JSON.parse(options.body).chat; writes++;
                for (const message of disk.slice(1)) {
                    if (!message.tt_swipe_cold) continue;
                    for (const field of ['swipes', 'swipe_info']) for (let i = 0; i < original[field].length; i++) message[field][i] ??= structuredClone(original[field][i]);
                    delete message.tt_swipe_cold;
                }
                corrupt?.(disk);
                return { ok: true, json: async () => ({ ok: true }) };
            }
            return { ok: true, json: async () => structuredClone(disk) };
        } };
    const host = await createSillyTavernHost(deps);
    return { host, live, original, get disk() { return disk; }, get writes() { return writes; } };
}

test('TT cold candidate metadata stays null; complete save verifies restored original fields', async () => {
    const f = await fixture();
    const id = f.host.snapshot().chatId;
    assert.equal(f.live.chat[0].swipe_info[0], null);
    f.host.previewSnapshot(); assert.equal(f.live.chat[0].swipe_info[0], null);
    await f.host.storage.write(id, { revision: 1 }, 0);
    assert.deepEqual(f.disk[1].swipe_info[0], f.original.swipe_info[0]);
    assert.equal(f.disk[0].chat_metadata.dwm.revision, 1);
    assert.equal(f.live.chatMetadata.dwm.revision, 1);
    assert.equal(f.live.chat[0].swipe_info[0], null);
});

for (const [name, corrupt] of [
    ['cold metadata', disk => { disk[1].swipe_info[0].extra.otherPlugin = 'lost'; }],
    ['selected content', disk => { disk[1].mes = 'wrong'; }],
    ['memory revision', disk => { disk[0].chat_metadata.dwm.revision = 999; }],
]) test(`TT verification rejects corrupt ${name}`, async () => {
    const f = await fixture({ corrupt }), id = f.host.snapshot().chatId;
    await assert.rejects(f.host.storage.write(id, { revision: 1 }, 0), /聊天保存结果与提交不符/);
    assert.equal(f.live.chatMetadata.dwm, undefined);
});

test('TT queued Fish write does not expose new memory before its turn', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture({ gate }), id = f.host.snapshot().chatId;
    const pending = f.host.storage.write(id, { revision: 1 }, 0);
    assert.equal(f.live.chatMetadata.dwm, undefined);
    release(); await pending;
    assert.equal(f.writes, 1);
});

test('TT changes made while cold records load are reconciled from current chat', async () => {
    let changed = false;
    const f = await fixture({ beforeRead: live => {
        if (!changed) { changed = true; live.chat[0].extra.foreign = { latest: true }; }
    } });
    await f.host.storage.write(f.host.snapshot().chatId, { revision: 1 }, 0);
    assert.deepEqual(f.disk[1].extra.foreign, { latest: true });
    assert.equal(f.writes, 1);
});

test('TT switch during queued save cannot write new chat or publish pending memory', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture({ gate }), id = f.host.snapshot().chatId;
    const pending = f.host.storage.write(id, { revision: 1 }, 0);
    f.live.chatId = 'other'; release();
    await assert.rejects(pending, /存档已经切换/);
    assert.equal(f.writes, 0); assert.equal(f.live.chatMetadata.dwm, undefined);
});

test('TT switch during cold record read prevents any write', async () => {
    const f = await fixture({ beforeRead: live => { live.chatId = 'other'; } });
    await assert.rejects(f.host.storage.write(f.host.snapshot().chatId, { revision: 1 }, 0), /存档已经切换/);
    assert.equal(f.writes, 0); assert.equal(f.live.chatMetadata.dwm, undefined);
});

test('TT shortened cold arrays fail before the save request', async () => {
    const f = await fixture(); f.live.chat[0].swipes.length = 1;
    await assert.rejects(f.host.storage.write(f.host.snapshot().chatId, { revision: 1 }, 0), /冷候选尚未加载完整/);
    assert.equal(f.writes, 0);
});

test('TT hydration and candidate selection preserve existing Fish candidate identities', async () => {
    const f = await fixture();
    const selected = f.host.snapshot().messages[0].key;
    f.live.chat[0].swipes[0] = f.original.swipes[0];
    f.live.chat[0].swipe_info[0] = structuredClone(f.original.swipe_info[0]);
    delete f.live.chat[0].tt_swipe_cold;
    f.live.chat[0].swipe_id = 0; f.live.chat[0].mes = 'older';
    assert.equal(f.host.snapshot().messages[0].key, 'old-key');
    f.live.chat[0].swipe_id = 1; f.live.chat[0].mes = 'selected';
    assert.equal(f.host.snapshot().messages[0].key, selected);
    await f.host.storage.write(f.host.snapshot().chatId, { revision: 1 }, 0);
    assert.equal(f.disk[1].swipe_info[0].extra.otherPlugin, 'keep');
});

test('TT backend object key order is irrelevant but field values remain checked', async () => {
    const f = await fixture({ corrupt: disk => {
        disk[1].swipe_info[0].extra = { dwmCandidateKey: 'old-key', otherPlugin: 'keep' };
    } });
    await f.host.storage.write(f.host.snapshot().chatId, { revision: 1 }, 0);
    assert.equal(f.live.chatMetadata.dwm.revision, 1);
});

test('TT legacy hidden metadata is restored when its cold candidate becomes active', async () => {
    const f = await fixture();
    f.original.swipe_info[0].extra.dwmHidden = { owner: 'dynamic-world-memory' };
    // Unloaded candidates stay untouched; selecting one hydrates it in TT.
    assert.equal(await f.host.restoreLegacyWindow(), 0);
    assert.equal(f.live.chat[0].swipe_info[0], null);
    const message = f.live.chat[0];
    message.swipes = structuredClone(f.original.swipes);
    message.swipe_info = structuredClone(f.original.swipe_info);
    delete message.tt_swipe_cold;
    message.swipe_id = 0; message.mes = 'older';
    message.extra = structuredClone(message.swipe_info[0].extra);
    message.is_system = true;
    assert.equal(await f.host.restoreLegacyWindow(), 2);
    assert.equal(message.is_system, false);
    assert.equal(message.extra.dwmHidden, undefined);
    assert.equal(message.swipe_info[0].extra.dwmHidden, undefined);
    assert.equal(f.disk[1].extra.otherPlugin, 'keep');
    assert.equal(f.disk[1].swipe_info[0].extra.otherPlugin, 'keep');
});
