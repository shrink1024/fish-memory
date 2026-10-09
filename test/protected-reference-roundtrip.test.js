import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntry, createSave, entryText } from '../src/core/state.js';
import { applyMaintenance } from '../src/core/operations.js';
import { maintain, compact } from '../src/agents/tasks.js';
import { AgentClient } from '../src/agents/client.js';
import { Controller } from '../src/runtime/controller.js';

const place = '王都艾尔德兰';
const messages = [{ key: 'm1', role: 'assistant', content: '两人随后去了市场。', hidden: false }];
const reference = text => { const match = text.match(/⟦鱼忆引用:[^⟧]+⟧/u); assert.ok(match, 'projection should use a reversible reference'); return match[0]; };
function fixture() {
    const save = createSave('references', 'book');
    save.initialized = true;
    save.data.entries.place = createEntry({ id: 'place', kind: 'rule', title: '地名', text: place });
    save.data.entries.npc = createEntry({ id: 'npc', kind: 'npc', title: '艾琳', text: `艾琳住在${place}南区。` });
    save.data.summary = `主角抵达${place}，与艾琳结识。`;
    return save;
}
const apply = (save, result) => applyMaintenance(save.data, result, { allowedEvidence: ['m1', 'm0'] });

test('maintenance preserves existing protected references without exposing locked text or retrying', async () => {
    const save = fixture(); let calls = 0;
    const client = new AgentClient(async request => {
        calls++; const memory = JSON.parse(request.input).memory;
        assert.doesNotMatch(request.input, new RegExp(place));
        reference(memory.summary);
        const npc = memory.entries.find(entry => entry.id === 'npc');
        return JSON.stringify({ operations: [
            { type: 'summary', text: memory.summary + '随后去了市场。' },
            { type: 'update', id: 'npc', expectedVersion: 1, evidence: ['m1'], segments: [{ id: 'body', text: npc.segments[0].text + '现在出门了。' }] },
        ] });
    });
    const result = await maintain(client, save, messages, undefined, 'global', null, result => apply(save, result));
    const next = apply(save, result).next;
    assert.equal(calls, 1);
    assert.equal(next.summary, save.data.summary + '随后去了市场。');
    assert.equal(entryText(next.entries.npc), entryText(save.data.entries.npc) + '现在出门了。');
    assert.equal(entryText(next.entries.place), place);
    assert.doesNotMatch(JSON.stringify(next), /鱼忆引用|受保护资料/);
});

test('references cannot move into a different writable field or create a new fact', async () => {
    for (const kind of ['summary-to-segment', 'segment-to-intro', 'new-fact']) {
        const save = fixture();
        await assert.rejects(maintain({ complete: async request => {
            const memory = request.input.memory, npc = memory.entries[0];
            const op = kind === 'new-fact' ? { type: 'create', kind: 'fact', title: '新的资料', text: reference(memory.summary), evidence: ['m1'] }
                : { type: 'update', id: 'npc', expectedVersion: 1, evidence: ['m1'],
                    segments: [{ id: 'body', text: kind === 'summary-to-segment' ? reference(memory.summary) : npc.segments[0].text }],
                    ...(kind === 'segment-to-intro' ? { intro: reference(npc.segments[0].text) } : {}) };
            return { operations: [op] };
        } }, save, messages), /引用.*(?:字段|来源|范围)|(?:字段|来源|范围).*引用/);
    }
});

test('unknown, stale and malformed references never reach persistence', async () => {
    const save = fixture();
    for (const marker of ['⟦鱼忆引用:unknown:999⟧', '⟦鱼忆引用:broken']) {
        const result = { operations: [{ type: 'summary', text: marker }] };
        await assert.rejects(maintain({ complete: async () => result }, save, messages), /引用/);
        assert.throws(() => apply(save, result), /引用/);
    }
});

test('compaction restores only references in its actual event subset and merge sources', async () => {
    const save = fixture(); save.data.summary = '';
    save.data.entries.e1 = createEntry({ id: 'e1', kind: 'event', title: '前事', text: `抵达${place}。`, evidence: ['m0'] });
    save.data.entries.e2 = createEntry({ id: 'e2', kind: 'event', title: '后事', text: `离开${place}。`, evidence: ['m1'] });
    const merged = await compact({ complete: async ({ input }) => ({ operations: [{ type: 'mergeEvents',
        sources: input.memory.entries.map(entry => ({ id: entry.id, expectedVersion: entry.version })), targetId: 'e1',
        title: '旅程', intro: '两次事件', text: input.memory.entries.map(entry => entry.segments[0].text).join(''), evidence: ['m0', 'm1'] }] }) }, save);
    const next = apply(save, merged).next;
    assert.equal(entryText(next.entries.e1), `抵达${place}。离开${place}。`);
    await assert.rejects(compact({ complete: async ({ input }) => {
        assert.deepEqual(input.memory.entries.map(entry => entry.id), ['e1', 'e2']);
        // The hidden NPC reference was allocated first by maintenanceView but
        // was removed from compact's request; guessing its index grants nothing.
        const hidden = reference(input.memory.entries[0].segments[0].text).replace(/:\d+⟧$/u, ':1⟧');
        return { operations: [{ type: 'update', id: 'e1', expectedVersion: 1, evidence: ['m0'], segments: [{ id: 'body', text: hidden }] }] };
    } }, save), /引用.*(?:来源|字段|提供)|(?:来源|字段|提供).*引用/);
});

test('literal reference-like story text is escaped without colliding with internal references', async () => {
    const save = fixture(), literal = '⟦鱼忆引用:existing:1⟧';
    save.data.summary = `档案写着${literal}。`;
    const result = await maintain({ complete: async ({ input }) => {
        assert.ok(!input.memory.summary.includes(literal));
        return { operations: [{ type: 'summary', text: input.memory.summary + '档案已封存。' }] };
    } }, save, messages);
    assert.equal(apply(save, result).next.summary, save.data.summary + '档案已封存。');
});

test('legacy placeholders already in a field may be carried forward but never introduced or multiplied', async () => {
    // Earlier versions saved the generic marker; it cannot be decoded, but it
    // must not freeze maintenance (each failure is a paid call).
    const save = fixture(); save.data.summary = '城门[受保护资料]守卫。';
    const carried = await maintain({ complete: async ({ input }) => ({ operations: [{ type: 'summary', text: `${input.memory.summary}后来下雨了。` }] }) },
        save, messages, undefined, 'global', null, result => apply(save, result));
    assert.equal(apply(save, carried).next.summary, '城门[受保护资料]守卫。后来下雨了。');
    const dropped = await maintain({ complete: async () => ({ operations: [{ type: 'summary', text: '城门守卫。后来下雨了。' }] }) },
        save, messages, undefined, 'global', null, result => apply(save, result));
    assert.equal(apply(save, dropped).next.summary, '城门守卫。后来下雨了。');
    await assert.rejects(maintain({ complete: async ({ input }) => ({ operations: [{ type: 'summary', text: `${input.memory.summary}[受保护资料]` }] }) },
        save, messages, undefined, 'global', null, result => apply(save, result)), /手动.*纠正|手动.*修正/);
    const clean = fixture();
    await assert.rejects(maintain({ complete: async () => ({ operations: [{ type: 'summary', text: '城门[受保护资料]守卫。' }] }) },
        clean, messages, undefined, 'global', null, result => apply(clean, result)), /手动.*纠正|手动.*修正/);
    assert.equal(save.data.summary, '城门[受保护资料]守卫。');
});

test('Controller validates and commits restored narrative while preserving original locked book text', async () => {
    const state = { chatId: 'controller-references', bookName: 'book', templateEnabled: true, messages: [] }, db = new Map();
    const book = [{ uid: 1, comment: '地名', content: place }, { uid: 2, comment: '艾琳', content: `艾琳住在${place}南区。` }];
    const host = { snapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book), clearPlan() {}, applyWindow: async () => {},
        storage: { read: async id => structuredClone(db.get(id)), write: async (id, value) => db.set(id, structuredClone(value)) } };
    const calls = [];
    const c = new Controller(host, { model: { complete: async request => {
        calls.push(request.purpose);
        if (request.purpose === 'initialize') return { strategy: '', entries: request.input.entries.map((entry, index) => ({ id: entry.id,
            kind: index === 0 ? 'rule' : 'npc', segments: [{ id: 'body', writable: index !== 0 }] })) };
        const npc = request.input.memory.entries[0];
        assert.doesNotMatch(JSON.stringify(request.input.memory), new RegExp(place));
        return { operations: [{ type: 'update', id: npc.id, expectedVersion: npc.version, evidence: ['m1'],
            segments: [{ id: 'body', text: npc.segments[0].text + '现在出门了。' }] }] };
    } }, settings: { enabled: true, maintenanceEvery: 1 } });
    await c.start(); await c.initialize(); state.messages.push(messages[0]); await c.maintain();
    assert.equal(entryText(c.store.state.data.entries['source:book:2']), `艾琳住在${place}南区。现在出门了。`);
    assert.equal(entryText(c.store.state.data.entries['source:book:1']), place);
    assert.deepEqual(c.store.state.processed, ['m1']);
    assert.deepEqual(calls, ['initialize', 'maintain']);
});


test('inventory references stay in their original item fields and copied stale tokens are rejected', async () => {
    const save = fixture(); save.data.inventory = [{ name: '地图', description: `${place}的地图` }];
    let oldToken;
    const result = await maintain({ complete: async ({ input }) => {
        oldToken = reference(input.memory.inventory[0].description);
        return { operations: [{ type: 'inventory', items: input.memory.inventory }] };
    } }, save, messages);
    assert.deepEqual(apply(save, result).next.inventory, save.data.inventory);
    await assert.rejects(maintain({ complete: async () => ({ operations: [{ type: 'inventory', items: [{ name: '地图', description: oldToken }] }] }) }, save, messages), /未知|过期/);
    await assert.rejects(maintain({ complete: async ({ input }) => ({ operations: [{ type: 'inventory', items: [{
        name: reference(input.memory.inventory[0].description), description: '转移引用' }] }] }) }, save, messages), /字段/);
});

test('restored literal marker permission cannot be reused after changing a validated operation', async () => {
    const save = fixture(); save.data.summary = '档案⟦鱼忆引用:literal:1⟧。';
    const result = await maintain({ complete: async ({ input }) => ({ operations: [{ type: 'summary', text: input.memory.summary }] }) }, save, messages);
    assert.equal(apply(save, result).next.summary, save.data.summary);
    result.operations[0].text += '⟦鱼忆引用:invented:1⟧';
    assert.throws(() => apply(save, result), /未还原/);
});
