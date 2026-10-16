import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedPresetEntries, applicationSnapshot, validateApplicationSelection, validateApplicationPositions, selectedApplicationEntries, applyPresetApplication } from '../src/agents/preset-application.js';
import { requestMessages } from '../src/agents/client.js';
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
test('applied text wraps the task verbatim with its own roles, never recursively wraps its own scan', () => {
    const req = { purpose: 'maintain', system: '固定JSON任务', input: { memory: {} } }, entries = applicationSnapshot(source).entries;
    const out = applyPresetApplication(req, entries);
    assert.equal(out.system, '固定JSON任务');
    assert.deepEqual(out.head, [{ role: 'system', content: '使用中文记录。' }, { role: 'system', content: '术语使用原文。' }]);
    assert.equal(out.tail, undefined);
    assert.equal(out.input, req.input); assert.equal(req.system, '固定JSON任务');
    const scan = { ...req, purpose: 'preferences' };
    assert.equal(applyPresetApplication(scan, entries), scan);
    assert.equal(applyPresetApplication(req, []), req);
});
test('preset placement follows the chat history marker and depth injection, and the player can override it', () => {
    const prompts = [{ identifier: 'main', role: 'system', content: '主提示' }, { identifier: 'chatHistory', marker: true },
        { identifier: 'jb', role: 'user', content: '后置破限' }, { identifier: 'prefill', role: 'assistant', content: '好的，' },
        { identifier: 'depth', role: 'system', content: '深度注入', injection_position: 1 }];
    const order = ['main', 'depth', 'chatHistory', 'jb', 'prefill'].map(identifier => ({ identifier, enabled: true }));
    const rows = orderedPresetEntries(prompts, order);
    assert.deepEqual(rows.map(e => [e.id, e.role, e.position]), [['main', 'system', 'head'], ['depth', 'system', 'tail'], ['jb', 'user', 'tail'], ['prefill', 'assistant', 'tail']]);
    const snap = applicationSnapshot({ name: 'P', entries: rows });
    const legacy = applicationSnapshot({ name: 'P', entries: rows.map(({ role: _r, position: _p, ...rest }) => rest) });
    assert.equal(snap.fingerprint, legacy.fingerprint, 'placement metadata never invalidates saved selections');
    const ids = ['main', 'jb', 'prefill', 'depth'];
    const positions = validateApplicationPositions({ depth: 'head', jb: 'tail', main: 'head' }, snap, ids);
    assert.deepEqual(positions, { depth: 'head' }, 'only overrides of the preset placement are stored');
    assert.throws(() => validateApplicationPositions({ jb: 'middle' }, snap, ids), /插入位置/);
    const entries = selectedApplicationEntries({ fingerprint: snap.fingerprint, selectedIds: ids, positions }, snap);
    const messages = requestMessages(applyPresetApplication({ purpose: 'initialize', system: '任务', input: '{}' }, entries));
    assert.deepEqual(messages.map(m => [m.role, m.content]), [['system', '主提示'], ['system', '深度注入'], ['system', '任务'], ['user', '{}'], ['user', '后置破限'], ['assistant', '好的，']]);
});
