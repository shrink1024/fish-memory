import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMaintenance } from '../src/core/operations.js';
import { createEntry, createSave, entryText } from '../src/core/state.js';
import { Controller } from '../src/runtime/controller.js';

function data() {
    const data = createSave('length-test', 'main').data;
    data.entries.legacy = createEntry({ id: 'legacy', title: '既有超长条目', kind: 'npc', text: '原书已有长文本必须完整保留' });
    return data;
}
test('empty maintenance, promotion, and unchanged text retain pre-existing text above the author limit', () => {
    const before = data(), text = entryText(before.entries.legacy), options = { allowedEvidence: ['one'], maxChars: { legacy: 8 } };
    for (const operations of [[], [{ type: 'promote', id: 'legacy', evidence: ['one'] }], [{ type: 'update', id: 'legacy', expectedVersion: 1,
        segments: [{ id: 'body', text }], intro: '只改简介', evidence: ['one'] }]]) {
        const after = applyMaintenance(before, { operations }, options).next;
        assert.equal(entryText(after.entries.legacy), text);
    }
    assert.throws(() => applyMaintenance(before, { operations: [{ type: 'update', id: 'legacy', expectedVersion: 1,
        segments: [{ id: 'body', text: text + '新写入' }], evidence: ['one'] }] }, options), /长度|长度约束/);
    assert.equal(entryText(applyMaintenance(before, { operations: [{ type: 'update', id: 'legacy', expectedVersion: 1,
        segments: [{ id: 'body', text: '缩短后的正文' }], evidence: ['one'] }] }, options).next.entries.legacy), '缩短后的正文');
});

test('untouched oversized source text does not block real old-chat initialization or metadata-only promotion', async () => {
    const state = { chatId: 'length-chat', bookName: 'main', templateEnabled: true,
        messages: [{ key: 'one', role: 'user', content: '合成剧情依据' }] };
    const original = '原书已有超限正文也不能截断';
    let saved;
    const host = { snapshot: () => structuredClone(state), clearPlan() {}, applyWindow: async () => {},
        storage: { read: async () => structuredClone(saved ?? null), write: async (_, value) => { saved = structuredClone(value); } },
        loadWorldbook: async () => [{ uid: 1, comment: '既有超长条目', content: original }, { uid: 2, comment: '[DWM Rules]', disable: true,
            content: JSON.stringify({ format: 'dwm-rules', version: 1, naturalLanguage: '', script: 'when title == "既有超长条目" => maxChars 8;' }) }],
    };
    const controller = new Controller(host, { model: { complete: async request => request.purpose === 'initialize'
        ? { entries: request.input.entries.map(entry => ({ id: entry.id, kind: 'npc', intro: '', segments: [{ id: 'body', writable: true }] })) }
        : { operations: [{ type: 'promote', id: 'source:main:1', evidence: ['one'] }] } } });
    await controller.start(); await controller.initialize();
    assert.equal(controller.store.state.initialized, true);
    assert.equal(entryText(controller.store.state.data.entries['source:main:1']), original);
    assert.equal(controller.store.state.data.entries['source:main:1'].important, true);
});
