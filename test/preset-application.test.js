import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedPresetEntries, applicationSnapshot, validateApplicationSelection, selectedApplicationEntries, applyPresetApplication } from '../src/agents/preset-application.js';
const source = { name: '合成预设', entries: [{ id: 'a', title: '表达约定', enabled: true, content: '使用中文记录。' }, { id: 'b', title: '关闭条目', enabled: false, content: '术语使用原文。' }] };
test('all preset text entries including disabled ones preserve host order without mutating original switches', () => {
    const prompts = [{ identifier: 'a', content: 'A' }, { identifier: 'marker', marker: true, content: 'not text' }, { identifier: 'b', content: 'B' }];
    const order = [{ identifier: 'b', enabled: false }, { identifier: 'a', enabled: true }], before = JSON.stringify([prompts, order]);
    const rows = orderedPresetEntries(prompts, order);
    assert.deepEqual(rows.map(e => [e.id, e.enabled]), [['b', false], ['a', true]]);
    assert.equal(JSON.stringify([prompts, order]), before);
});
test('manual selection can include disabled entries, keeps order, invalidates on source edits and excludes stale ids', () => {
    const snap = applicationSnapshot(source), binding = { fingerprint: snap.fingerprint, selectedIds: ['b', 'a', 'missing'] };
    assert.deepEqual(selectedApplicationEntries(binding, snap).map(e => e.id), ['a', 'b']);
    const changed = structuredClone(source); changed.entries[1].content += '变更';
    assert.deepEqual(selectedApplicationEntries(binding, applicationSnapshot(changed)), []);
    assert.throws(() => validateApplicationSelection({ selectedIds: ['missing'] }, snap), /无效/);
    assert.throws(() => validateApplicationSelection({ selectedIds: ['a', 'a'] }, snap), /重复/);
});
test('applied text is visible in auxiliary system prompts, never recursively wraps its own scan', () => {
    const req = { purpose: 'maintain', system: '固定JSON任务', input: { memory: {} } }, entries = applicationSnapshot(source).entries;
    const out = applyPresetApplication(req, entries);
    assert.match(out.system, /固定JSON任务/); assert.match(out.system, /术语使用原文/);
    assert.equal(out.input, req.input); assert.equal(req.system, '固定JSON任务');
    const scan = { ...req, purpose: 'preferences' };
    assert.equal(applyPresetApplication(scan, entries), scan);
    assert.equal(applyPresetApplication(req, []), req);
});
