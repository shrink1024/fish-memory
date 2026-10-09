import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSave, decodeSave, STORAGE_ENCODING } from '../src/core/storage-codec.js';
import { createSave, createEntry } from '../src/core/state.js';
import { MemoryStore } from '../src/core/store.js';

function fixture() {
    const save = createSave('synthetic-chat', 'synthetic-book');
    const text = '原书正文。\n<% untouched %> {"$ref":2,"schema":3,"encoding":"fish-memory-pool-v1"} '.repeat(40);
    const entry = createEntry({ id: 'source:synthetic-book:1', title: '资料', text,
        source: { original: text, metadata: { content: text, uid: 1 }, book: save.bookName, uid: 1,
            baselineSegments: [{ id: 'body', text, writable: true }] } });
    save.data.entries[entry.id] = entry;
    save.base = structuredClone(save.data);
    save.initialized = true;
    save.initializationCheckpoint = { version: 1, stage: 'history', draft: structuredClone(save),
        identity: { saveId: save.id, chatId: save.chatId, bookName: save.bookName, revision: 2 },
        classifiedBatches: 1, totalBatches: 1, sourceFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64) };
    save.audit = [{ reason: 'edit', before: text, after: text, evidence: ['message-a'] }];
    save.journal = [{ anchorLength: 1, endKey: 'message-a', inventoryDisabledAt: null, patch: { entries: { [entry.id]: structuredClone(entry) } } }];
    save.processed = ['message-a']; save.storyKeys = ['message-a']; save.revision = 2;
    return save;
}

test('pooled persistence roundtrips all save fields, drafts and literal JSON strings without changing in-memory schema', () => {
    const save = fixture(), before = structuredClone(save);
    const encoded = encodeSave(save);
    assert.equal(encoded.schema, 3); assert.equal(encoded.encoding, STORAGE_ENCODING);
    for (const key of ['id', 'chatId', 'bookName', 'revision']) assert.equal(encoded[key], save[key]);
    assert.deepEqual(decodeSave(JSON.parse(JSON.stringify(encoded))), save);
    assert.deepEqual(save, before);
    assert.equal(save.schema, 2);
    assert.ok(JSON.stringify(encoded).length < JSON.stringify(save).length * 0.5);
});

test('decoded equal containers are detached so an entry edit cannot mutate its source or baseline', () => {
    const decoded = decodeSave(encodeSave(fixture()));
    const id = 'source:synthetic-book:1';
    assert.notEqual(decoded.data, decoded.base);
    assert.notEqual(decoded.data.entries[id], decoded.base.entries[id]);
    const original = decoded.base.entries[id].segments[0].text;
    decoded.data.entries[id].segments[0].text = '单处修改';
    assert.equal(decoded.base.entries[id].segments[0].text, original);
    assert.equal(decoded.initializationCheckpoint.draft.data.entries[id].segments[0].text, original);
});

test('legacy schema 2 reads remain detached and unknown encoded versions fail explicitly', () => {
    const save = fixture(), decoded = decodeSave(save);
    assert.deepEqual(decoded, save); assert.notEqual(decoded, save);
    assert.equal(decodeSave(null), null); assert.equal(decodeSave(undefined), undefined);
    for (const changed of [{ schema: 4 }, { encoding: 'unknown-v99' }, { revision: 900 }]) {
        assert.throws(() => decodeSave({ ...encodeSave(save), ...changed }), /存档|格式|身份/);
    }
});

test('invalid, forward and circular pool references fail before expansion', () => {
    const encoded = encodeSave(fixture());
    for (const pool of [[['a', [0]]], [['a', [-1]]], [['a', [0.5]]], [['a', [999999]]], [['bogus']], [0, ['o', [0, 0]]]]) {
        assert.throws(() => decodeSave({ ...encoded, pool, root: pool.length - 1 }), /存档|引用|节点/);
    }
    assert.throws(() => decodeSave({ ...encoded, root: -1 }), /存档|引用/);
    assert.throws(() => decodeSave({ ...encoded, pool: ['same-key', 1, 2, ['o', [0, 1, 0, 2]]], root: 3 }), /重复|存档/);
});

test('a small malicious DAG cannot expand exponentially beyond the bounded decoder', () => {
    const encoded = encodeSave(fixture());
    const pool = ['text'];
    for (let i = 1; i < 50; i++) pool.push(['a', [i - 1, i - 1]]);
    assert.throws(() => decodeSave({ ...encoded, pool, root: pool.length - 1 }), /上限|过大/);
});

test('prototype-looking keys are literal own data and accessors, cycles and unsupported objects are refused', () => {
    const save = fixture();
    save.literal = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"key":"故事字段"}');
    save.dictionary = Object.assign(Object.create(null), { literal: '保留无原型字典' });
    save.optional = undefined;
    save.literalNumbers = [0, -0, 1.5];
    const decoded = decodeSave(encodeSave(save));
    assert.deepEqual(decoded.literal, save.literal);
    assert.deepEqual(decoded.dictionary, save.dictionary);
    assert.equal(Object.getPrototypeOf(decoded.literal), Object.prototype);
    assert.equal({}.polluted, undefined);
    const cycle = fixture(); cycle.cycle = cycle;
    assert.throws(() => encodeSave(cycle), /循环/);
    const accessor = fixture();
    Object.defineProperty(accessor, 'secret', { enumerable: true, get() { throw new Error('accessor was invoked'); } });
    assert.throws(() => encodeSave(accessor), error => /属性|访问器/.test(error.message) && !/was invoked/.test(error.message));
    const unsupported = fixture(); unsupported.map = new Map();
    assert.throws(() => encodeSave(unsupported), /存档|对象/);
    const nested = fixture(); let tail = nested;
    for (let i = 0; i < 150; i++) tail = tail.nested = {};
    assert.throws(() => encodeSave(nested), /深度|上限/);
});

test('pooled storage preserves real journal replay, selected replies and reload after maintenance', async () => {
    let disk = null;
    const storage = { read: async () => decodeSave(disk), write: async (_id, value) => { disk = JSON.parse(JSON.stringify(encodeSave(value))); } };
    const store = new MemoryStore(storage);
    await store.load('chat', 'book');
    await store.initialize([createEntry({ id: 'npc', kind: 'npc', title: '甲', text: '住城南' })], '关系');
    for (let i = 1; i <= 20; i++) {
        await store.commit({ operations: [{ type: 'update', id: 'npc', expectedVersion: i,
            segments: [{ id: 'body', text: `第${i}天住城北` }], evidence: [`key-${i}`] }, { type: 'summary', text: `第${i}天进展` }] },
        { expectedRevision: store.state.revision, sourceKeys: Array.from({ length: i }, (_, j) => `key-${j + 1}`), allowedEvidence: [`key-${i}`] });
    }
    const expected = store.snapshot();
    const reloaded = new MemoryStore(storage); await reloaded.load('chat', 'book');
    assert.deepEqual(reloaded.snapshot(), expected);
    await reloaded.reconcile(['key-1', 'key-2', 'new-selected-candidate']);
    assert.equal(reloaded.state.data.entries.npc.segments[0].text, '第2天住城北');
    assert.equal(reloaded.state.data.summary, '第2天进展');
    assert.equal(reloaded.state.journal.length, 2);
    assert.equal(disk.schema, 3);
    assert.deepEqual(decodeSave(disk), reloaded.state);
});
