import test from 'node:test';
import assert from 'node:assert/strict';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';

async function fixture({ corrupt, gate, duringSave } = {}) {
    const live = { chatId: 'synthetic', characterId: 0, characters: [{ avatar: 'fixture.png', name: 'Fixture' }],
        chatMetadata: { integrity: 'v0', foreign: { keep: true } }, getRequestHeaders: () => ({}),
        chat: [{ mes: 'selected', is_user: false, extra: { foreign: 'keep' }, swipe_id: 0,
            swipes: ['selected', 'other'], swipe_info: [{ extra: {} }, { extra: { foreign: 'candidate' } }] }] };
    let disk = [{ chat_metadata: structuredClone(live.chatMetadata) }, ...structuredClone(live.chat)];
    let writes = 0, queued = 0, seeded = null, invalidated = 0;
    const script = {
        setExtensionPrompt() {},
        runSerializedChatWrite: async task => { queued++; await gate; return task(); },
        applyIntegrityFromWritePayloadToTarget: (payload, target) => { if (target.file_name === live.chatId) live.chatMetadata.integrity = payload.integrity; },
        seedChatMetadataSnapshot: (target, metadata) => { seeded = { target, metadata: structuredClone(metadata) }; },
        seedChatMessageSnapshot: (_target, messages) => { seeded.messages = structuredClone(messages); },
        invalidateChatWriteSnapshot: () => { invalidated++; },
    };
    const host = await createSillyTavernHost({ context: () => live, lukerHost: {}, script, worldInfo: {}, extensions: {}, fetch: async (url, options) => {
        if (url.endsWith('/save')) {
            const incoming = JSON.parse(options.body).chat;
            assert.equal(incoming[0].chat_metadata.integrity, disk[0].chat_metadata.integrity);
            disk = incoming; const integrity = `v${++writes}`;
            disk[0].chat_metadata.integrity = integrity;
            corrupt?.(disk); duringSave?.(live);
            return { ok: true, json: async () => ({ ok: true, integrity }) };
        }
        return { ok: true, json: async () => structuredClone(disk) };
    } });
    return { host, live, get disk() { return disk; }, get writes() { return writes; }, get queued() { return queued; },
        get seeded() { return seeded; }, get invalidated() { return invalidated; } };
}

test('Luker rotated integrity is verified and published for the next save with matching incremental snapshots', async () => {
    const f = await fixture(), id = f.host.snapshot().chatId;
    await f.host.storage.write(id, { revision: 1 }, 0);
    assert.equal(f.live.chatMetadata.integrity, 'v1');
    assert.deepEqual(f.seeded.metadata, f.disk[0].chat_metadata);
    assert.deepEqual(f.seeded.messages, f.disk.slice(1));
    await f.host.storage.write(id, { revision: 2 }, 1);
    assert.equal(f.queued, 2); assert.equal(f.live.chatMetadata.integrity, 'v2');
    assert.equal(f.disk[1].swipe_info[1].extra.foreign, 'candidate');
});

for (const [label, corrupt] of [
    ['integrity', disk => { disk[0].chat_metadata.integrity = 'unacknowledged'; }],
    ['memory', disk => { disk[0].chat_metadata.dwm.revision = 999; }],
    ['other plugin', disk => { disk[0].chat_metadata.foreign.keep = false; }],
    ['candidate', disk => { disk[1].swipes[1] = 'lost'; }],
]) test(`Luker verification still rejects changed ${label}`, async () => {
    const f = await fixture({ corrupt });
    await assert.rejects(f.host.storage.write(f.host.snapshot().chatId, { revision: 1 }, 0), /聊天保存结果与提交不符/);
    assert.equal(f.live.chatMetadata.dwm, undefined);
    assert.equal(f.seeded, null); assert.ok(f.invalidated > 0);
});

test('Luker queued write publishes no pending memory and rejects a switched chat before writing', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture({ gate });
    const pending = f.host.storage.write(f.host.snapshot().chatId, { revision: 1 }, 0);
    assert.equal(f.live.chatMetadata.dwm, undefined);
    f.live.chatId = 'other'; release();
    await assert.rejects(pending, /存档已经切换/); assert.equal(f.writes, 0);
});

test('Luker receipt from old chat never updates new chat integrity or snapshots', async () => {
    const f = await fixture({ duringSave: live => { live.chatId = 'other'; live.chatMetadata = { integrity: 'new-chat' }; } });
    await assert.rejects(f.host.storage.write(f.host.snapshot().chatId, { revision: 1 }, 0), /存档已经切换/);
    assert.equal(f.live.chatMetadata.integrity, 'new-chat'); assert.equal(f.seeded, null);
});
