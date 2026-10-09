// Legacy "[受保护资料]" markers saved by alpha.3/alpha.4 may be carried forward
// or dropped in their own field, but never copied, moved or multiplied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntry, createSave, entryText } from '../src/core/state.js';
import { applyMaintenance } from '../src/core/operations.js';
import { maintain, compact } from '../src/agents/tasks.js';

const M = '[受保护资料]';
const messages = [{ key: 'm1', role: 'assistant', content: '路人回到家中。', hidden: false }];
const count = value => JSON.stringify(value).split(M).length - 1;
function fixture() {
    const save = createSave('legacy-marker', 'book'); save.initialized = true;
    save.data.entries.npc = createEntry({ id: 'npc', kind: 'npc', title: '路人', intro: '原本正常的简介', retrieveWhen: '路人出现时',
        segments: [{ id: 'old', text: `旧档正文${M}。`, writable: true }, { id: 'now', text: '路人还在街上。', writable: true }] });
    save.data.entries.clean = createEntry({ id: 'clean', kind: 'fact', title: '城门', text: '城门开着。' });
    save.data.summary = `脉络${M}正常。`;
    save.data.inventoryEnabled = true;
    save.data.inventory = [{ name: '钥匙', description: `旧描述${M}` }, { name: '地图', description: '普通' }];
    return save;
}
const apply = (save, result) => applyMaintenance(save.data, result, { allowedEvidence: ['m1', 'm0'] }).next;
const run = (save, operations) => maintain({ complete: async () => ({ operations }) }, save, messages, undefined, 'global', null, result => apply(save, result));
const update = extra => ({ type: 'update', id: 'npc', expectedVersion: 1, evidence: ['m1'], ...extra });
const rejected = /手动.*纠正/;

test('a field may keep or drop the markers it already had', async () => {
    const save = fixture();
    let next = apply(save, await run(save, [update({ segments: [{ id: 'old', text: `旧档正文${M}，后来回家。` }] })]));
    assert.equal(entryText(next.entries.npc), `旧档正文${M}，后来回家。路人还在街上。`);
    next = apply(save, await run(save, [update({ segments: [{ id: 'old', text: '旧档正文。' }, { id: 'now', text: '路人回到家中。' }] })]));
    assert.equal(count(next.entries.npc), 0);
    next = apply(save, await run(save, [{ type: 'summary', text: `脉络${M}正常。后来下雨。` }]));
    assert.equal(next.summary, `脉络${M}正常。后来下雨。`);
    // Items may be reordered or removed; a marked field stays with its own kind.
    next = apply(save, await run(save, [{ type: 'inventory', items: [{ name: '地图', description: '普通' }, { name: '钥匙', description: `旧描述${M}` }] }]));
    assert.equal(count(next.inventory), 1);
    next = apply(save, await run(save, [{ type: 'inventory', items: [{ name: '钥匙', description: `旧描述${M}，已用旧` }] }]));
    assert.equal(count(next.inventory), 1);
});

test('markers cannot be copied across fields, segments, items or operations, nor multiplied', async () => {
    const cases = {
        'segment update plus intro overwritten by marker': [update({ segments: [{ id: 'now', text: '路人回到家中。' }], intro: M })],
        'retrieveWhen gains a marker': [update({ retrieveWhen: `路人出现时${M}` })],
        'copied into a sibling segment': [update({ segments: [{ id: 'now', text: `路人回家${M}` }] })],
        'moved between segments': [update({ segments: [{ id: 'old', text: '旧档正文。' }, { id: 'now', text: `路人回家${M}` }] })],
        'multiplied in its own segment': [update({ segments: [{ id: 'old', text: `旧档正文${M}${M}` }] })],
        'into an unmarked entry': [{ type: 'update', id: 'clean', expectedVersion: 1, evidence: ['m1'], segments: [{ id: 'body', text: `城门${M}` }] }],
        'into a new entry': [{ type: 'create', kind: 'event', title: '回家', text: `路人回家${M}`, intro: '回家', retrieveWhen: '回家时', evidence: ['m1'] }],
        'summary multiplied': [{ type: 'summary', text: `脉络${M}${M}` }],
        'inventory copied to another item': [{ type: 'inventory', items: [{ name: '钥匙', description: `旧描述${M}` }, { name: '地图', description: M }] }],
        'inventory description moved to a name': [{ type: 'inventory', items: [{ name: `钥匙${M}`, description: '旧描述' }, { name: '地图', description: '普通' }] }],
        'entry marker copied into summary in the same batch': [update({ segments: [{ id: 'old', text: `旧档正文${M}。` }] }), { type: 'summary', text: `脉络${M}正常。${M}` }],
    };
    for (const [name, operations] of Object.entries(cases)) {
        const save = fixture(), before = structuredClone(save.data);
        await assert.rejects(run(save, operations), rejected, name);
        assert.deepEqual(save.data, before, name);
    }
});

test('merged events carry only their sources’ markers, once per batch', async () => {
    const save = createSave('legacy-merge', 'book'); save.initialized = true;
    save.data.entries.e1 = createEntry({ id: 'e1', kind: 'event', title: '初遇', intro: '第一次见面', retrieveWhen: '回忆初遇', text: `初遇${M}。`, evidence: ['m0'] });
    save.data.entries.e2 = createEntry({ id: 'e2', kind: 'event', title: '重逢', intro: '再次见面', retrieveWhen: '回忆重逢', text: '重逢。', evidence: ['m0'] });
    save.data.entries.e3 = createEntry({ id: 'e3', kind: 'event', title: '无关', intro: '无关', retrieveWhen: '无关', text: '无关。', evidence: ['m0'] });
    const merge = extra => ({ type: 'mergeEvents', sources: [{ id: 'e1', expectedVersion: 1 }, { id: 'e2', expectedVersion: 1 }],
        title: '相识', intro: '两次见面', retrieveWhen: '回忆相识', text: `初遇${M}。重逢。`, evidence: ['m0'], ...extra });
    const tidy = operations => compact({ complete: async () => ({ operations }) }, save);
    const merged = apply(save, await tidy([merge()]));
    assert.equal(count(Object.values(merged.entries)), 1);
    for (const operations of [
        [merge({ intro: `两次见面${M}` })],
        [merge({ text: `初遇${M}${M}` })],
        [{ ...merge(), sources: [{ id: 'e2', expectedVersion: 1 }, { id: 'e3', expectedVersion: 1 }] }],
        [merge(), { type: 'update', id: 'e1', expectedVersion: 1, evidence: ['m0'], segments: [{ id: 'body', text: `初遇${M}。` }] }],
    ]) {
        await assert.rejects(tidy(operations).then(result => apply(save, result)), rejected);
    }
});
