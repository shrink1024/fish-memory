import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSourceUpdates, maintain } from '../src/agents/tasks.js';
import { createSave } from '../src/core/state.js';

test('source merge omits protected bodies and restores them unchanged', async () => {
    const next = { segments: [{ id: 'locked', writable: false, text: 'PRIVATE_SYNTHETIC_RULE' }, { id: 'open', writable: true, text: 'new source' }] };
    let sent;
    const result = await mergeSourceUpdates({ complete: async request => {
        sent = request.input;
        return { entries: [{ id: 'mixed', segments: [{ id: 'open', text: 'merged story' }] }] };
    } }, [{ id: 'mixed', title: 'Mixed', oldSource: 'old', current: 'story', next }]);
    assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_SYNTHETIC_RULE/);
    assert.deepEqual(result[0].segments, [next.segments[0], { ...next.segments[1], text: 'merged story' }]);
});

test('worldbook-only maintenance accepts updates but drops creations and promotions', async () => {
    const operations = [{ type: 'update', id: 'original' }, { type: 'promote', id: 'original' },
        ...['npc', 'npc_pool', 'fact', 'event'].map(kind => ({ type: 'create', kind })), { type: 'summary', text: 'story' }];
    const save = createSave('synthetic', 'book'); save.worldbookOnly = true;
    const client = { complete: async () => ({ operations: structuredClone(operations) }) };
    const result = await maintain(client, save, []);
    assert.deepEqual(result.operations, [operations[0]]);
    delete save.worldbookOnly;
    assert.deepEqual((await maintain(client, save, [])).operations, operations, 'full mode retains the existing operation contract');
});
