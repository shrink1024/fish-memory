import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEntries, select, alignStrategy, compact } from '../src/agents/tasks.js';
import { makeSourceEntry, createSave, entryText } from '../src/core/state.js';
import { MemoryStore } from '../src/core/store.js';
import { maintenanceView } from '../src/core/views.js';

const original = '原文：{{user}}在桥边🦊。\r\n叙事规则：不得读心。\n现状：钥匙已经归还。';
const source = () => makeSourceEntry('synthetic', { uid: 1, comment: '合成资料', content: original });
const response = (segments, extra = {}) => ({ strategy: '保持已知事实', entries: [{ id: source().id, kind: 'fact', intro: '桥边现状', retrieveWhen: '提到桥边时', needsReview: false, segments, ...extra }] });
const run = result => classifyEntries({ complete: async () => result }, [source()]);

test('classification takes complete text from source when the model returns only permissions', async () => {
    const input = source(), before = structuredClone(input);
    const result = await classifyEntries({ complete: async () => response([{ id: 'body', writable: true }]) }, [input]);
    assert.equal(entryText(result.entries[0]), original);
    assert.equal(result.entries[0].segments[0].writable, true);
    assert.equal(result.entries[0].needsReview, false);
    assert.deepEqual(input, before);
    assert.equal(result.entries[0].source.original, original);
});

test('unique source anchors preserve every character and the mixed-entry permissions', async () => {
    const { entries: [entry] } = await run(response([
        { id: 'intro', writable: true },
        { id: 'rule', start: '叙事规则：', writable: false },
        { id: 'state', start: '现状：', writable: true },
    ]));
    assert.equal(entryText(entry), original);
    assert.deepEqual(entry.segments.map(s => s.text), ['原文：{{user}}在桥边🦊。\r\n', '叙事规则：不得读心。\n', '现状：钥匙已经归还。']);
    assert.deepEqual(entry.segments.map(s => s.writable), [true, false, true]);
    const save = createSave('synthetic-chat', 'synthetic'); save.data.entries[entry.id] = entry;
    assert.doesNotMatch(JSON.stringify(maintenanceView(save)), /不得读心/);
});

test('a model dropping two characters cannot change the original or grant uncertain write access', async () => {
    const input = makeSourceEntry('synthetic', { uid: 2, comment: '合成事件', content: '桥边发生争执，随后和解。' });
    const answer = { strategy: '', entries: [{ id: input.id, kind: 'fact', intro: '桥边事件', segments: [{ id: 'body', text: '桥边争执，随后和解。', writable: true }] }] };
    const { entries: [entry] } = await classifyEntries({ complete: async () => answer }, [input]);
    assert.equal(entryText(entry), '桥边发生争执，随后和解。');
    assert.equal(entry.needsReview, true);
    assert.ok(entry.segments.every(s => !s.writable));
    const store = new MemoryStore({ read: async () => null, write: async () => {} });
    await store.load('synthetic-chat', 'synthetic');
    await store.initialize([entry], '');
    assert.equal(store.snapshot().initialized, true);
    assert.equal(entryText(store.snapshot().data.entries[entry.id]), input.source.original);
    assert.equal(maintenanceView(store.snapshot()).entries.length, 0);
});

test('legacy exact text partitions remain accepted without changing their permissions', async () => {
    const parts = original.split('现状：');
    const { entries: [entry] } = await run(response([{ id: 'protected', text: parts[0], writable: false }, { id: 'state', text: `现状：${parts[1]}`, writable: true }]));
    assert.equal(entryText(entry), original);
    assert.equal(entry.needsReview, false);
    assert.deepEqual(entry.segments.map(s => s.writable), [false, true]);
});

test('unreliable boundaries preserve the whole entry as protected and awaiting review', async () => {
    for (const segments of [
        [{ id: 'body', writable: true, start: '现状：' }],
        [{ id: 'first', writable: true }, { id: 'second', start: '：', writable: true }],
        [{ id: 'first', writable: true }, { id: 'second', start: '找不到', writable: true }],
        [{ id: 'first', writable: true }, { id: 'second', start: '现状：', writable: true }, { id: 'third', start: '叙事规则：', writable: true }],
        [{ id: 'first', text: '模型改写', writable: false }, { id: 'second', text: '现状：钥匙已经归还。', writable: true }],
        [{ id: 'first', writable: false }, { id: 'second', writable: true }],
    ]) {
        const { entries: [entry] } = await run(response(segments));
        assert.equal(entryText(entry), original);
        assert.equal(entry.needsReview, true);
        assert.ok(entry.segments.every(s => !s.writable));
    }
});

test('rule classification stays protected even when the model requests writable segments', async () => {
    const { entries: [entry] } = await run(response([{ id: 'body', writable: true }], { kind: 'rule' }));
    assert.equal(entryText(entry), original);
    assert.equal(entry.segments[0].writable, false);
});

test('mixing copied text with source anchors cannot bypass the protected fallback', async () => {
    const { entries: [entry] } = await run(response([{ id: 'body', start: '', text: '现状：钥匙已经归还。', writable: true }]));
    assert.equal(entryText(entry), original);
    assert.equal(entry.needsReview, true);
    assert.ok(entry.segments.every(segment => !segment.writable));
});

test('missing entries and malformed permission metadata remain errors, not silent recovery', async () => {
    await assert.rejects(run({ entries: [] }), /完整覆盖/);
    await assert.rejects(run(response([{ id: 'body', writable: 'false' }])), /写权限/);
    await assert.rejects(run(response([{ id: 'body', writable: true }, { id: 'body', writable: false }])), /片段身份/);
    await assert.rejects(run(response([{ id: 'body', writable: true }], { kind: 'invented' })), /未知条目类型/);
});

test('task validation runs inside the instrumented client acceptance boundary', async () => {
    let caught = 0;
    const client = {
        complete: async () => { throw new Error('must use validation boundary'); },
        completeValidated: async (request, accept) => {
            const results = { initialize: { entries: [] }, select: { ids: ['missing'] }, strategy: { strategy: 12 }, compact: { operations: [{ type: 'create' }] } };
            try { return await accept(results[request.purpose]); }
            catch (error) { caught++; throw error; }
        },
    };
    await assert.rejects(classifyEntries(client, [source()]));
    await assert.rejects(select(client, createSave('chat', 'book'), []));
    await assert.rejects(alignStrategy(client, ['a', 'b'], [], ''));
    await assert.rejects(compact(client, createSave('chat', 'book')));
    assert.equal(caught, 4);
});
