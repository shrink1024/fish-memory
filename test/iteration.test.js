import test from 'node:test';
import assert from 'node:assert/strict';
import { createSave, createEntry, makeSourceEntry } from '../src/core/state.js';
import { applyMaintenance } from '../src/core/operations.js';
import { maintenanceView, frontCatalog } from '../src/core/views.js';
import { classifyEntries, alignStrategy } from '../src/agents/tasks.js';

test('retained source navigation survives reversals while latest-change evidence stays distinct and bounded', () => {
    const save = createSave('chat', 'book');
    let data = save.data;
    data.entries.event = createEntry({ id: 'event', title: '赴约计划', kind: 'event', text: '约定去港口', intro: '赴约', evidence: ['origin'] });
    for (let i = 0; i < 280; i++) {
        const key = `message-${i}`;
        const result = { operations: [{ type: 'update', id: 'event', expectedVersion: i + 1,
            segments: [{ id: 'body', text: i === 279 ? '赴约计划已取消；旧承诺因封港而解除。' : `计划第${i}次变化` }],
            intro: i === 279 ? '封港导致赴约取消，承诺已解除' : '计划待定', retrieveWhen: '回查取消原因时', evidence: [key] }] };
        data = applyMaintenance(data, result, { allowedEvidence: [key] }).next;
    }
    const e = data.entries.event;
    assert.equal(e.evidence.length, 256);
    assert.ok(e.evidence.includes('origin'));
    assert.deepEqual(e.lastEvidence, ['message-279']);
    assert.equal(e.evidenceTrimmed, true);
    assert.match(e.intro, /已解除/);
    const catalog = frontCatalog({ data }, () => true, undefined, ['message-279']);
    assert.equal(catalog[0].recentEvidenceCount, 1);
    assert.equal(catalog[0].contentChars, e.segments[0].text.length);
});

test('maintenance receives retrieval guidance but cannot read protected text copied into another field', () => {
    const save = createSave('chat', 'book');
    save.data.entries.lock = createEntry({ id: 'lock', title: '铁律', kind: 'rule', text: 'LOCK_SECRET' });
    save.data.entries.fact = createEntry({ id: 'fact', title: '现状', text: '已搬家', intro: 'LOCK_SECRET', retrieveWhen: '讨论住址时' });
    save.data.entries.mixed = createEntry({ id: 'mixed', title: '混合', intro: '不可见简介', retrieveWhen: '不可见指导',
        segments: [{ id: 'rule', text: 'LOCK_SECRET', writable: false }, { id: 'fact', text: '公开', writable: true }] });
    save.data.summary = '之前引用LOCK_SECRET';
    const view = maintenanceView(save);
    assert.doesNotMatch(JSON.stringify(view), /LOCK_SECRET|不可见指导|不可见简介/);
    assert.equal(view.entries.find(e => e.id === 'fact').retrieveWhen, '讨论住址时');
});

test('initial scan uses original keyword hints and aligns only differing batch strategies', async () => {
    const calls = [];
    const entry = makeSourceEntry('book', { uid: 7, comment: '旧城', content: '在旧城', key: ['旧城'], keysecondary: ['返回'] });
    const client = { complete: async request => {
        calls.push(request);
        if (request.purpose === 'strategy') return { strategy: '以人物关系为主，旅行事件只保留转折。' };
        return { strategy: '人物关系', entries: [{ id: entry.id, kind: 'fact', intro: '住在旧城', retrieveWhen: '提到住所时',
            segments: [{ id: 'body', text: '在旧城', writable: true }] }] };
    } };
    await classifyEntries(client, [entry]);
    assert.deepEqual(calls[0].input.entries[0].keywordHints, { primary: ['旧城'], secondary: ['返回'] });
    assert.equal(await alignStrategy(client, ['相同', '相同'], [entry], ''), '相同');
    assert.equal(calls.length, 1);
    assert.match(await alignStrategy(client, ['重人物', '重旅行'], [entry], ''), /人物关系/);
    assert.equal(calls[1].purpose, 'strategy');
});

test('protected prose redaction leaves operation identities and source keys intact', () => {
    const save = createSave('chat', 'book');
    save.data.entries.lock = createEntry({ id: 'lock', title: '规则', kind: 'rule', text: 'fact' });
    save.data.entries.fact = createEntry({ id: 'fact', title: 'fact', text: 'fact发生变化', evidence: ['fact'] });
    const entry = maintenanceView(save).entries[0];
    assert.equal(entry.id, 'fact'); assert.equal(entry.kind, 'fact'); assert.deepEqual(entry.evidence, ['fact']);
    assert.equal(entry.title, '[受保护资料]');
    assert.equal(entry.segments[0].text, '[受保护资料]发生变化');
});
