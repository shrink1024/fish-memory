import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient, classifyUnparsed, parseObject, requestMessages } from '../src/agents/client.js';
import { sourceRole } from '../src/agents/requests.js';

test('unparsed replies are classified so a declined reply is not retried as a format slip', () => {
    assert.equal(classifyUnparsed(''), 'empty');
    assert.equal(classifyUnparsed('   '), 'empty');
    // A reply that starts a JSON object but fails to parse is a format problem.
    assert.equal(classifyUnparsed('{"operations": ['), 'malformed');
    // Prose without JSON and without declining wording is a stray format.
    assert.equal(classifyUnparsed('这里是本批资料的整理结果，请查收。'), 'nojson');
    for (const reply of [
        "I'm sorry, but I can't help with that.",
        'I am unable to assist with this request.',
        'As an AI, I must decline to process this material.',
        '抱歉，我无法处理这类内容。',
        '对不起，我不能协助整理这些文字。',
        '作为一个人工智能，我不便提供这类帮助。',
    ]) assert.equal(classifyUnparsed(reply), 'declined', reply);
});

test('a reply without a JSON object carries its classification to the caller', () => {
    for (const [reply, kind] of [["I'm sorry, I can't help with that.", 'declined'], ['普通散文，没有 JSON。', 'nojson']]) {
        assert.throws(() => parseObject(reply), error => error.dwmResponseInvalid === true && error.dwmResponseKind === kind);
    }
    // Non-JSON transport faults keep their own kinds.
    assert.throws(() => parseObject(''), error => error.dwmResponseKind === 'empty');
    assert.throws(() => parseObject('{"a":1'), error => error.dwmResponseKind === 'incomplete');
});

test('a declined first reply is reframed on the second attempt and placed after the material', async () => {
    const calls = [];
    const client = new AgentClient(async request => {
        calls.push(request);
        return calls.length === 1 ? "I'm sorry, but I can't help with that." : '{"operations":[]}';
    }, { timeoutMs: 5000 });
    const result = await client.complete({ purpose: 'maintain', system: '任务说明', input: '{"messages":[]}' });
    assert.deepEqual(result, { operations: [] });
    assert.equal(calls.length, 2);
    // The restatement is attached to the task text and the material follows it.
    assert.match(calls[1].system, /已经写定的资料/);
    assert.match(calls[1].system, /不需要你对内容作出任何判断或评价/);
    assert.equal(calls[1].recovery, true);
    assert.equal(calls[0].recovery, undefined);
    const wire = requestMessages({ system: calls[1].system, input: calls[1].input, recovery: true });
    assert.deepEqual(wire.map(message => message.role), ['user', 'system']);
});

test('a stray format is retried with the output contract restated, not the material reframed', async () => {
    const calls = [];
    const client = new AgentClient(async request => {
        calls.push(request);
        return calls.length === 1 ? '这里是整理结果，请查收。' : '{"operations":[]}';
    }, { timeoutMs: 5000 });
    await client.complete({ purpose: 'maintain', system: '任务说明', input: '{"messages":[]}' });
    assert.match(calls[1].system, /未通过程序格式校验/);
    assert.equal(calls[1].recovery, undefined);
});

test('story material is projected as archival records rather than live turns', () => {
    assert.equal(sourceRole('user'), 'player');
    assert.equal(sourceRole('assistant'), 'character');
    assert.equal(sourceRole('system'), 'narration');
    assert.equal(sourceRole('other'), 'material');
    // The wire envelope still uses provider roles; only the task projection is relabelled.
    const wire = requestMessages({ system: 's', input: 'i' });
    assert.deepEqual(wire.map(message => message.role), ['system', 'user']);
});

test('the separate connection also places a declined-reply restatement after the material', async () => {
    const bodies = [];
    const fetchImpl = async (_url, options) => { bodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: bodies.length === 1 ? "I'm sorry, I can't help with that." : '{"operations":[]}' }, finish_reason: 'stop' }] }), { status: 200 }); };
    const { compatibleConnection } = await import('../src/agents/client.js');
    const client = new AgentClient(compatibleConnection({ endpoint: 'https://aux.example/v1', model: 'm', fetchImpl }), { timeoutMs: 5000 });
    await client.complete({ purpose: 'maintain', system: '任务说明', input: '{"messages":[]}' });
    assert.deepEqual(bodies[0].messages.map(m => m.role), ['system', 'user']);
    assert.deepEqual(bodies[1].messages.map(m => m.role), ['user', 'system']);
});
