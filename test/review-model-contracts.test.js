import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient, compatibleConnection, parseObject, serializeAgentInput } from '../src/agents/client.js';
import { select, classifyEntries } from '../src/agents/tasks.js';
import { maintainRequest, compactRequest, requestBatches } from '../src/agents/requests.js';
import { maintenanceView } from '../src/core/views.js';
import { createSave, createEntry, makeSourceEntry } from '../src/core/state.js';
import { createTraceStore } from '../src/diagnostics/trace-store.js';

const fake = result => ({ complete: async () => result });
function saveWithEntries(entries) {
    const save = createSave('review-synthetic', 'book');
    save.data.entries = Object.fromEntries(entries.map(entry => [entry.id, entry]));
    return save;
}

test('JSON wrapper tolerance preserves literal prose and rejects ambiguous or incomplete objects', () => {
    const result = { operations: [{ type: 'summary', text: '<think>角色所说的原文</think> {x} \\"句子"' }] };
    const json = JSON.stringify(result);
    for (const wrapped of [`好的，结果如下：\n${json}`, `${json}\n处理完成。`, `<think>草稿 {"example":true}</think>\n${json}`,
        `下面是结果：\n\`\`\`json\n${json}\n\`\`\`\n说明结束。`]) assert.deepEqual(parseObject(wrapped), result);
    for (const invalid of ['{"ids":[]} {"ids":["other"]}', '{"operations":[{"type":"summary"}', '{"ids":[],}',
        '<think>尚未结束 {"ids":[]}', '[{"ids":[]}]', '"{}"', '“ids”：[]']) assert.throws(() => parseObject(invalid), /JSON/);
});

test('a malformed model response receives one bounded correction without changing source text', async () => {
    const attempts = [], callbacks = [];
    const client = new AgentClient(async request => { attempts.push(request); return attempts.length === 1 ? '{"ids":[],}' : '{"ids":[]}'; });
    const source = { messages: [{ key: 'k', content: '{{user}} 与 <% script %> 只是原文' }] };
    assert.deepEqual(await client.complete({ purpose: 'select', system: '固定协议', input: source, onAttempt: value => callbacks.push(value) }), { ids: [] });
    assert.equal(attempts.length, 2); assert.equal(callbacks.length, 2);
    assert.deepEqual(JSON.parse(attempts[1].input).messages, source.messages);
    assert.equal(attempts[1].input, attempts[0].input);
    assert.match(attempts[1].system, /程序格式校验/);
    assert.equal(attempts[0].signal, attempts[1].signal, 'both attempts share the total deadline');
    assert.equal(attempts[0].responseLength, 2048);
    let calls = 0;
    await assert.rejects(new AgentClient(async () => { calls++; return '坏 JSON'; }).complete({ purpose: 'select', input: {}, system: '' }), /JSON/);
    assert.equal(calls, 2);
});

test('task result correction does not retry transport failures, cancellation or stale state', async () => {
    for (const error of [new Error('HTTP 503'), new DOMException('已停止', 'AbortError')]) {
        let calls = 0;
        await assert.rejects(new AgentClient(async () => { calls++; throw error; }).complete({ purpose: 'select', input: {}, system: '' }), value => value === error);
        assert.equal(calls, 1);
    }
    let calls = 0;
    await assert.rejects(new AgentClient(async () => { calls++; return '{}'; }).complete({ purpose: 'select', input: {}, system: '', validate: () => { throw new Error('版本已经变化'); } }), /版本/);
    assert.equal(calls, 1);
});

test('classification corrects an incomplete format once without granting uncertain permissions', async () => {
    const source = makeSourceEntry('book', { uid: 1, content: '规则：不可改变。\n事实：城门开放。' });
    const outputs = [
        { entries: [{ id: source.id, kind: 'fact', segments: [{ id: 'body' }] }] },
        { strategy: '', entries: [{ id: source.id, kind: 'rule', intro: '', retrieveWhen: '', segments: [{ id: 'body', writable: false }] }] },
    ];
    const client = new AgentClient(async () => JSON.stringify(outputs.shift()));
    const result = await classifyEntries(client, [source]);
    assert.equal(result.entries[0].segments[0].writable, false);
    assert.equal(result.entries[0].segments[0].text, source.segments[0].text);
    assert.equal(outputs.length, 0);
});

test('selection deduplicates before counting and constant entries do not consume discretionary slots', async () => {
    const save = saveWithEntries([
        createEntry({ id: 'constant', title: '常驻', text: '已知', constant: true }),
        createEntry({ id: 'a', title: '甲', text: '事实甲' }), createEntry({ id: 'b', title: '乙', text: '事实乙' }),
        createEntry({ id: 'locked-by-condition', title: '未解锁', text: '秘密' }),
    ]);
    const options = { selectionLimit: 2, eligible: entry => entry.id !== 'locked-by-condition' };
    assert.deepEqual(await select(fake({ ids: ['constant', 'a', 'a', 'b'] }), save, [], options), ['constant', 'a', 'b']);
    await assert.rejects(select(fake({ ids: ['a', 'locked-by-condition'] }), save, [], options), /不允许/);
    await assert.rejects(select(fake({ ids: ['a', 'unknown'] }), save, [], options), /不允许/);
    await assert.rejects(select(fake({ ids: ['a', 'b'] }), save, [], { selectionLimit: 1 }), /数量/);
});

test('maintenance omits source-navigation history while compaction keeps its allowed evidence', () => {
    const entry = createEntry({ id: 'event', kind: 'event', title: '前事', text: '保留全部事实', evidence: ['old-key'], lastEvidence: ['old-key'], lineage: ['former-event'] });
    const save = saveWithEntries([entry]);
    const memory = maintainRequest(save, [{ key: 'new-key', role: 'assistant', content: '新增正文' }]).input.memory;
    assert.equal(memory.entries[0].segments[0].text, '保留全部事实');
    for (const key of ['evidence', 'lastEvidence', 'evidenceTrimmed', 'lineage']) assert.equal(Object.hasOwn(memory.entries[0], key), false);
    assert.deepEqual(compactRequest(save).input.memory.entries[0].evidence, ['old-key']);
    assert.deepEqual(save.data.entries.event.evidence, ['old-key']);
});

test('protection scrubbing ignores separators and single characters while masking meaningful copied text', () => {
    const save = saveWithEntries([
        ...['\n', '无', '——', 'LOCK_SECRET'].map((text, i) => createEntry({ id: `locked-${i}`, title: '规则', kind: 'rule', text })),
        createEntry({ id: 'fact', title: '事实', text: '无力反抗。\n守卫仍在。LOCK_SECRET', intro: '无家可归' }),
    ]);
    save.data.summary = '第一天。\n第二天，无力改变。';
    const view = maintenanceView(save);
    assert.equal(view.summary, save.data.summary);
    assert.match(view.entries[0].segments[0].text, /^无力反抗。\n守卫仍在。⟦鱼忆引用:[^⟧]+⟧$/u);
    assert.equal(view.entries[0].intro, '无家可归');
    assert.doesNotMatch(JSON.stringify(view), /LOCK_SECRET/);
});

test('literal EJS and legacy macros roundtrip without template execution delimiters', () => {
    const input = { content: '<%= getvar("x") %> <USER> <BOT> <CHAR> {{user}} <user> <%_ script _%>' };
    const wire = serializeAgentInput(input);
    assert.deepEqual(JSON.parse(wire), input);
    assert.doesNotMatch(wire, /<%|<(?:user|bot|char)>|\{\{/i);
});

test('config credentials stay out of diagnostics while story objects keep the same field names', () => {
    const secrets = { api_server: 'https://alice:pw@example.test', access_key: 's-access', key: 's-key', auth: 's-auth', bearer: 's-bearer', api_key_makersuite: 's-provider', session: 's-session' };
    const store = createTraceStore();
    store.start({ request: { ...secrets, model: 'kept', messages: [{ role: 'user', content: secrets }] } });
    const request = store.snapshot().records[0].request;
    assert.deepEqual(Object.keys(request), ['model', 'messages']);
    assert.deepEqual(request.messages[0].content, secrets);
});

test('compatible calls set an auxiliary output budget and reject a truncated response before parsing', async () => {
    let body;
    const generate = compatibleConnection({ endpoint: 'https://model.example/v1', model: 'test', fetchImpl: async (_, request) => {
        body = JSON.parse(request.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"operations":[]}' }, finish_reason: 'length' }] }) };
    } });
    await assert.rejects(generate({ purpose: 'maintain', system: '', input: '{}', responseLength: 8192 }), /输出.*上限|截断/);
    assert.equal(body.max_tokens, 8192);
});

test('batching supports a separate item cap without splitting or dropping source entries', () => {
    const entries = Array.from({ length: 61 }, (_, id) => ({ id, content: '短条目' }));
    const batches = requestBatches(entries, 18000, entry => entry.content, 24);
    assert.deepEqual(batches.map(batch => batch.length), [24, 24, 13]);
    assert.deepEqual(batches.flat(), entries);
});
