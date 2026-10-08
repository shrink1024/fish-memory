import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { Controller } from '../src/runtime/controller.js';
import { sha256Fingerprint } from '../src/core/fingerprint.js';
import { uid } from '../src/core/util.js';

const insecureCrypto = () => ({ getRandomValues: array => webcrypto.getRandomValues(array) });

function withCrypto(t, value) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value });
    t.after(() => Object.defineProperty(globalThis, 'crypto', original));
}
function fixture() {
    let fail = true;
    const state = { chatId: 'http-lan-chat', bookName: 'main', templateEnabled: true,
        messages: [1, 2].map(i => ({ key: `floor-${i}`, content: `合成剧情${i}`, role: i === 1 ? 'user' : 'assistant' })) };
    const book = [{ uid: 1, comment: '合成世界书', content: '中文、emoji 🐟和原样宏 {{user}}' }], saved = new Map(), calls = [];
    const host = { snapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book), clearPlan() {}, applyWindow: async () => {},
        storage: { read: async id => structuredClone(saved.get(id) ?? null), write: async (id, value) => saved.set(id, structuredClone(value)) } };
    const model = { complete: async request => {
        calls.push(request.purpose);
        if (request.purpose === 'initialize') return { entries: request.input.entries.map(entry => ({
            id: entry.id, kind: 'fact', intro: '合成简介', segments: [{ id: 'body', writable: true }],
        })) };
        if (fail && request.input.messages[0].key === 'floor-2') throw Error('合成第二批中断');
        return { operations: [] };
    } };
    return { make: () => new Controller(host, { model, settings: { batchChars: 1 } }), book, saved, calls, succeed: () => { fail = false; } };
}

test('HTTP-like environments without subtle can initialize, retain a checkpoint, and resume after reload', async t => {
    withCrypto(t, insecureCrypto());
    const f = fixture(), first = f.make();
    await first.start(); await assert.rejects(first.initialize(), /合成第二批中断/);
    assert.equal(first.initializationResumeSummary().processedCount, 1);
    const before = f.calls.length; f.succeed();
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    assert.deepEqual(f.calls.slice(before), ['maintain']);
    assert.equal(resumed.store.state.initialized, true);
    assert.equal(resumed.store.state.processed.length, 2);
});

test('a content change invalidates a checkpoint created without subtle', async t => {
    withCrypto(t, insecureCrypto());
    const f = fixture(), first = f.make();
    await first.start(); await assert.rejects(first.initialize(), /合成第二批中断/);
    f.book[0].content += '新版内容'; f.succeed();
    const before = f.calls.length, resumed = f.make();
    await resumed.start(); await resumed.initialize();
    assert.equal(f.calls.slice(before).filter(purpose => purpose === 'initialize').length, 1);
    assert.equal(resumed.store.state.initialized, true);
});

test('pure SHA-256 matches known vectors, UTF-8, padding boundaries, and secure-context output', async t => {
    const samples = ['', 'abc', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '中文 🐟\r\n{{user}}', '\ud800',
        ...[55, 56, 63, 64, 65, 127, 128, 129, 1000000].map(length => 'a'.repeat(length))];
    const native = await Promise.all(samples.map(text => sha256Fingerprint(text)));
    assert.equal(native[0], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(native[1], 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(native.at(-1), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
    withCrypto(t, insecureCrypto());
    for (const [index, sample] of samples.entries()) {
        const actual = await sha256Fingerprint(sample);
        assert.equal(actual, createHash('sha256').update(sample, 'utf8').digest('hex'));
        assert.equal(actual, native[index]);
    }
});

test('an exposed but blocked digest method uses the same standard fallback', async t => {
    withCrypto(t, { ...insecureCrypto(), subtle: { digest: async () => { throw Error('Unavailable in this browser'); } } });
    assert.equal(await sha256Fingerprint('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('secure-context checkpoints remain resumable when the same chat opens over HTTP', async t => {
    const f = fixture(), first = f.make();
    await first.start(); await assert.rejects(first.initialize(), /合成第二批中断/);
    const before = f.calls.length; f.succeed();
    withCrypto(t, insecureCrypto());
    const resumed = f.make(); await resumed.start(); await resumed.initialize();
    assert.deepEqual(f.calls.slice(before), ['maintain']);
    assert.equal(resumed.store.state.initialized, true);
});

test('HTTP UUID fallback preserves RFC 4122 version/variant and uses browser cryptographic randomness', t => {
    let generated = 0;
    withCrypto(t, { getRandomValues: bytes => { generated++; return bytes.fill(0xff); } });
    assert.equal(uid('save'), 'save-ffffffff-ffff-4fff-bfff-ffffffffffff');
    assert.equal(uid(), 'm-ffffffff-ffff-4fff-bfff-ffffffffffff');
    assert.equal(generated, 2);
});

test('UUID creation prefers randomUUID and reports unavailable secure randomness clearly', t => {
    withCrypto(t, { randomUUID: () => 'native-id', getRandomValues: () => { assert.fail('native UUID should be preferred'); } });
    assert.equal(uid('entry'), 'entry-native-id');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    assert.throws(() => uid(), /安全的存档身份.*HTTPS/);
});
