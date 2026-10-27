import test from 'node:test';
import assert from 'node:assert/strict';
import { exportMemoryWorldbook, parseSupplementaryMemory } from '../src/core/transfer.js';
import { createSave, createEntry } from '../src/core/state.js';

test('portable export contains current text, tiers and readable summaries but no save internals', () => {
    const save = createSave('private-chat', 'main'); save.initialized = true;
    save.data.entries.a = createEntry({ id: 'a', title: '角色', text: '现在住在北城', tier: 'onDemand',
        source: { book: 'main', uid: 9, original: '原来住在南城', metadata: { uid: 9, key: ['角色'], constant: true, position: 4, depth: 2, role: 1 } } });
    save.data.entries.b = createEntry({ id: 'b', title: '关闭', text: 'disabled text', tier: 'off' });
    save.data.entries.hidden = createEntry({ id: 'hidden', title: 'private scope', text: 'unreadable', scopeId: 'other' });
    save.data.summary = '已发生剧情'; save.data.inventory = [{ name: '钥匙', description: '铁钥匙' }];
    save.audit = [{ secret: 'private audit' }]; const before = JSON.stringify(save);
    const result = exportMemoryWorldbook(save), rows = Object.values(result.entries), person = rows.find(e => e.comment === '角色');
    assert.equal(person.content, '现在住在北城'); assert.equal(person.constant, false); assert.equal(person.depth, 2); assert.equal(person.role, 1);
    assert.equal(rows.find(e => e.comment === '关闭').disable, true);
    assert.deepEqual(person.key, ['角色'], 'native keys are kept');
    assert.ok(rows.some(e => e.content === '已发生剧情')); assert.ok(rows.some(e => e.content.includes('铁钥匙')));
    assert.doesNotMatch(JSON.stringify(result), /private-chat|原来住在南城|private audit|unreadable/);
    assert.equal(JSON.stringify(save), before);
    assert.equal(parseSupplementaryMemory(JSON.stringify(result), { json: true }).entries.length, 3);
});
test('supplement parser distinguishes text memories from disabled entries, rules, scripts and wrong files', () => {
    const result = parseSupplementaryMemory(JSON.stringify({ entries: {
        0: { comment: '历史', content: '曾经到过北城' }, 1: { comment: '关闭', disable: true, content: 'x' },
        2: { comment: '[DWM Rules]', content: '{}' }, 3: { comment: '脚本', content: '<% script %>' },
    } }), { json: true });
    assert.deepEqual(result.entries, [{ title: '历史', content: '曾经到过北城' }]); assert.equal(result.skipped.length, 3);
    assert.throws(() => parseSupplementaryMemory('{"records":[]}', { json: true }), /世界书 JSON/);
    assert.throws(() => parseSupplementaryMemory('broken', { json: true }), /有效/);
    assert.equal(parseSupplementaryMemory('以前的剧情', { name: '旧总结' }).entries[0].title, '旧总结');
});

test('supplementary book picker reads attached books without changing primary binding', async () => {
    const { createSillyTavernHost } = await import('../src/adapters/sillytavern.js');
    const live = { chatId: 'fixture', characterId: 0, characters: [{ avatar: 'card.png', data: { extensions: { world: 'main' } } }], chat: [], chatMetadata: {} };
    const read = [], worldInfo = { world_info: { charLore: [{ name: 'card', extraBooks: ['summary', 'main'] }] },
        loadWorldInfo: async name => { read.push(name); return { entries: { 1: { uid: 1, comment: 'old history', content: 'past events' } } }; } };
    const host = await createSillyTavernHost({ context: () => live, worldInfo, script: { setExtensionPrompt() {} }, extensions: {} });
    assert.deepEqual(host.supplementaryBooks(), ['summary']);
    assert.equal((await host.readSupplementaryBook('summary')).entries[1].content, 'past events');
    await assert.rejects(host.readSupplementaryBook('main'), /绑定已改变/);
    assert.deepEqual(read, ['summary']); assert.equal(live.characters[0].data.extensions.world, 'main');
});

test('an on-demand entry fish created gets its title as key so the exported book can still fire it', () => {
    const save = createSave('c', 'main'); save.initialized = true;
    save.data.entries.p = createEntry({ id: 'p', title: '新人物', text: '港口的船夫', tier: 'onDemand' });
    save.data.entries.k = createEntry({ id: 'k', title: '常驻', text: '每轮', tier: 'constant' });
    const rows = Object.values(exportMemoryWorldbook(save).entries);
    assert.deepEqual(rows.find(e => e.comment === '新人物').key, ['新人物']);
    assert.deepEqual(rows.find(e => e.comment === '常驻').key, [], 'constant entries need no key');
});
