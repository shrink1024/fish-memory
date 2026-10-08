import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core/store.js';
import { createEntry, entryText, validateSave } from '../src/core/state.js';
import { maintenanceView, frontRead } from '../src/core/views.js';
import { planWindow } from '../src/core/window.js';
import { applyMaintenance } from '../src/core/operations.js';

function storage() {
    const db = new Map();
    return { read: async id => db.get(id), write: async (id, data) => { db.set(id, structuredClone(data)); }, db };
}
async function setup() {
    const persistence = storage();
    const store = new MemoryStore(persistence, { auditLimit: 2 });
    await store.load('chat-a', 'world');
    await store.initialize([
        createEntry({ id: 'home', title: '住址', text: '住港口', source: { original: '住港口', book: 'world', uid: 0 } }),
        createEntry({ id: 'rules', title: '规则', kind: 'rule', text: 'RULE_SECRET' }),
        createEntry({ id: 'mixed', title: '混合', segments: [{ id: 'rule', text: 'MIXED_SECRET', writable: false }, { id: 'fact', text: '昼间', writable: true }] }),
    ], '按人际关系和关键事件维护');
    return { store, persistence };
}
const update = (version, text, key) => ({ operations: [{ type: 'update', id: 'home', expectedVersion: version,
    segments: [{ id: 'body', text }], intro: text, evidence: [key] }, { type: 'summary', text: `进展：${text}` }] });

test('保存成功才推进，持久化失败保持完整旧版本', async () => {
    const { store, persistence } = await setup();
    const before = store.snapshot();
    persistence.write = async () => { throw new Error('disk full'); };
    await assert.rejects(store.commit(update(1, '住北城', 'a'), { expectedRevision: before.revision, sourceKeys: ['a'] }), /disk full/);
    assert.deepEqual(store.snapshot(), before);
});
test('受保护正文和审计不进入后置，写权限由程序拒绝', async () => {
    const { store } = await setup();
    const view = JSON.stringify(maintenanceView(store.snapshot()));
    assert.ok(!view.includes('SECRET'));
    assert.ok(!view.includes('journal') && !view.includes('audit') && !view.includes('original'));
    const result = { operations: [{ type: 'update', id: 'mixed', expectedVersion: 1,
        segments: [{ id: 'rule', text: 'bad' }], evidence: ['a'] }] };
    await assert.rejects(store.commit(result, { expectedRevision: store.state.revision, sourceKeys: ['a'] }), /受保护/);
    assert.equal(frontRead(store.snapshot(), ['rules'])[0].content, 'RULE_SECRET');
});
test('分支回到分叉进度，不继承未来事实；事后文本变化不属于key对账', async () => {
    const { store, persistence } = await setup();
    await store.commit(update(1, '住北城', 'a'), { expectedRevision: store.state.revision, sourceKeys: ['a'] });
    await store.commit(update(2, '住南城', 'b'), { expectedRevision: store.state.revision, sourceKeys: ['a', 'b'] });
    const fork = new MemoryStore(persistence);
    await fork.load('chat-branch', 'world', store.snapshot());
    await fork.reconcile(['a']);
    assert.equal(entryText(fork.state.data.entries.home), '住北城');
    assert.equal(entryText(store.state.data.entries.home), '住南城');
    assert.notEqual(fork.state.id, store.state.id);
    assert.equal((await fork.reconcile(['a'])).changed, false);
});
test('切换选中回复撤去旧回复记忆并保留待补位置', async () => {
    const { store } = await setup();
    await store.commit(update(1, '住北城', 'a:0'), { expectedRevision: store.state.revision, sourceKeys: ['a:0'] });
    await store.reconcile(['a:1']);
    assert.equal(entryText(store.state.data.entries.home), '住港口');
    assert.equal(store.state.processed.length, 0);
});
test('重置仅单条，取消不改变数据，原书与脉络不联动', async () => {
    const { store } = await setup();
    await store.commit(update(1, '住北城', 'a'), { expectedRevision: store.state.revision, sourceKeys: ['a'] });
    await assert.rejects(store.manual({ type: 'reset', id: 'home', confirmed: false }), /确认/);
    await store.manual({ type: 'reset', id: 'home', confirmed: true });
    assert.equal(entryText(store.state.data.entries.home), '住港口');
    assert.equal(store.state.data.summary, '进展：住北城');
    assert.equal(store.state.data.entries.home.source.original, '住港口');
});
test('关闭物品清单保留数据并禁止后台维护', async () => {
    const { store } = await setup();
    await store.commit({ operations: [{ type: 'inventory', items: [{ name: '徽章', description: '友人所赠' }] }] }, { expectedRevision: store.state.revision, sourceKeys: ['a'] });
    await store.manual({ type: 'inventory-toggle', enabled: false });
    assert.equal(store.state.data.inventory.length, 1);
    assert.ok(!('inventory' in maintenanceView(store.snapshot())));
    await assert.rejects(store.commit({ operations: [{ type: 'inventory', items: [] }] }, { expectedRevision: store.state.revision, sourceKeys: ['a', 'b'] }), /关闭/);
});
test('旧在途结果不能覆盖手动编辑，手改不把未处理正文算作已记忆', async () => {
    const { store } = await setup();
    const old = store.state.revision;
    await store.manual({ type: 'edit', id: 'home', segments: [{ id: 'body', text: '玩家修正', writable: true }] }, ['unprocessed']);
    assert.deepEqual(store.state.processed, []);
    await assert.rejects(store.commit(update(1, '旧结果', 'a'), { expectedRevision: old, sourceKeys: ['a'] }), /拒绝/);
});
test('窗口只隐藏已处理旧原文，未补记保留，不冒领外部隐藏', () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({ key: String(i), role: i % 2 ? 'assistant' : 'user', hidden: false }));
    messages[0].hidden = true;
    messages[2] = { ...messages[2], hidden: true, hiddenBy: 'dynamic-world-memory' };
    const actions = planWindow(messages, ['0', '1', '2'], { enabled: true, recentTurns: 1 });
    assert.deepEqual(actions.map(a => a.index), [1]);
    const restore = planWindow(messages, [], { enabled: false });
    assert.deepEqual(restore.map(a => a.index), [2]);
});

test('journal uses one story path and scalar anchors instead of copying every prefix', async () => {
    const { store } = await setup();
    for (let i = 1; i <= 60; i++) {
        const sourceKeys = Array.from({ length: i }, (_, n) => `message-${n}`);
        await store.commit({ operations: [] }, { expectedRevision: store.state.revision, sourceKeys });
    }
    const saved = store.snapshot();
    assert.equal(saved.storyKeys.length, 60);
    assert.equal(saved.processed.length, 60);
    assert.equal(saved.journal.length, 60);
    assert.ok(saved.journal.every((commit, i) => commit.anchorLength === i + 1 && !('anchor' in commit)));
    assert.equal(saved.journal[59].endKey, 'message-59');
    assert.ok(JSON.stringify(saved.journal).length < 25000);
});

test('manual edit anchored to an unprocessed swipe rolls back without certifying progress', async () => {
    const { store } = await setup();
    await store.commit(update(1, '住北城', 'a'), { expectedRevision: store.state.revision, sourceKeys: ['a'] });
    await store.manual({ type: 'edit', id: 'home', segments: [{ id: 'body', text: '玩家暂改', writable: true }] }, ['a', 'reply:0']);
    assert.deepEqual(store.state.processed, ['a']);
    assert.deepEqual(store.state.storyKeys, ['a', 'reply:0']);
    await store.reconcile(['a', 'reply:1']);
    assert.equal(entryText(store.state.data.entries.home), '住北城');
    assert.deepEqual(store.state.processed, ['a']);
    assert.deepEqual(store.state.storyKeys, ['a']);
    await store.manual({ type: 'edit', id: 'home', segments: [{ id: 'body', text: '新分支修正', writable: true }] }, ['a', 'reply:1']);
    assert.deepEqual(store.state.processed, ['a']);
    assert.equal(entryText(store.state.data.entries.home), '新分支修正');
});

test('inventory disabled anchor follows branch replay and successful catch-up clears it', async () => {
    const { store } = await setup();
    await store.commit({ operations: [] }, { expectedRevision: store.state.revision, sourceKeys: ['a'] });
    await store.manual({ type: 'inventory-toggle', enabled: false }, ['a', 'reply:0']);
    assert.equal(store.state.inventoryDisabledAt, 1);
    await store.reconcile(['a', 'reply:1']);
    assert.equal(store.state.data.inventoryEnabled, true);
    assert.equal(store.state.inventoryDisabledAt, null);
    await store.manual({ type: 'inventory-toggle', enabled: false }, ['a', 'reply:1']);
    await store.manual({ type: 'inventory-toggle', enabled: true }, ['a', 'reply:1']);
    assert.equal(store.state.inventoryDisabledAt, 1);
    await store.commit({ operations: [{ type: 'inventory', items: [] }] }, {
        expectedRevision: store.state.revision, sourceKeys: ['a'], reason: 'inventory-catchup',
    });
    assert.equal(store.state.inventoryDisabledAt, null);
    await store.manual({ type: 'inventory-toggle', enabled: false }, ['a', 'reply:1']);
    await store.manual({ type: 'inventory-toggle', enabled: true }, ['a', 'reply:1']);
    await store.finishInventoryCatchUp(store.state.revision);
    assert.equal(store.state.inventoryDisabledAt, null);
});

test('mixed source reset restores original segment boundaries and protected intro stays out of post input', async () => {
    const persistence = storage(), store = new MemoryStore(persistence);
    await store.load('mixed-chat', 'world');
    await store.initialize([createEntry({ id: 'mixed-source', title: '混合原书', kind: 'fact',
        intro: 'SECRET_INTRO 旧状态', source: { book: 'world', uid: 9, original: 'RULE_SECRET住港口' },
        segments: [{ id: 'rule', text: 'RULE_SECRET', writable: false }, { id: 'fact', text: '住港口', writable: true }] })], '策略含 RULE_SECRET');
    assert.doesNotMatch(JSON.stringify(maintenanceView(store.snapshot())), /RULE_SECRET|SECRET_INTRO/);
    await store.manual({ type: 'edit', id: 'mixed-source', intro: '玩家简介', segments: [
        { id: 'rule', text: 'RULE_SECRET', writable: false }, { id: 'fact', text: '住北城', writable: true },
    ] });
    await store.manual({ type: 'reset', id: 'mixed-source', confirmed: true });
    assert.deepEqual(store.state.data.entries['mixed-source'].segments.map(s => [s.id, s.text, s.writable]), [
        ['rule', 'RULE_SECRET', false], ['fact', '住港口', true],
    ]);
    assert.equal(entryText(store.state.data.entries['mixed-source']), 'RULE_SECRET住港口');
});

test('stored rule entry cannot regain write access by malformed metadata', async () => {
    const { store } = await setup();
    const malformed = store.snapshot();
    malformed.data.entries.rules.segments[0].writable = true;
    assert.throws(() => validateSave(malformed), /规则条目不可写/);
});

test('mergeEvents atomically shortens the event directory and keeps evidence lineage', async () => {
    const persistence = storage(), store = new MemoryStore(persistence);
    await store.load('merge-chat', 'world');
    await store.initialize([
        createEntry({ id: 'event-1', kind: 'event', title: '相遇', intro: '初见', text: '桥上相遇', evidence: ['m1'] }),
        createEntry({ id: 'event-2', kind: 'event', title: '约定', intro: '许诺', text: '次日相约', evidence: ['m2'] }),
        createEntry({ id: 'world', kind: 'fact', title: '现状', text: '住北城' }),
        createEntry({ id: 'npc', kind: 'npc', title: '友人', text: '仍在城内' }),
    ], '按关系维护');
    await store.commit({ operations: [{ type: 'inventory', items: [{ name: '徽章', description: '仍持有' }] }] },
        { expectedRevision: store.state.revision, sourceKeys: ['m1'] });
    const before = store.snapshot();
    const merged = { type: 'mergeEvents', sources: [{ id: 'event-1', expectedVersion: 1 }, { id: 'event-2', expectedVersion: 1 }],
        title: '桥上约定', intro: '相遇并约好次日再见', text: '桥上相遇，次日相约。', retrieveWhen: '提到桥或约定时', evidence: ['m1', 'm2'] };
    await store.commit({ operations: [merged] }, { expectedRevision: store.state.revision,
        sourceKeys: ['m1', 'm2'], allowedEvidence: ['m1', 'm2'] });
    const after = store.snapshot();
    const events = Object.values(after.data.entries).filter(e => e.kind === 'event');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].lineage, ['event-1', 'event-2']);
    assert.deepEqual(events[0].evidence, ['m1', 'm2']);
    assert.equal(events[0].intro, '相遇并约好次日再见');
    assert.deepEqual(after.data.entries.world, before.data.entries.world);
    assert.deepEqual(after.data.entries.npc, before.data.entries.npc);
    assert.deepEqual(after.data.inventory, before.data.inventory);
    assert.equal(after.audit.length > before.audit.length, true);
    assert.doesNotMatch(JSON.stringify(maintenanceView(after)), /"audit"/);
    await store.reconcile(['m1', 'm2:alternate']);
    assert.ok(store.state.data.entries['event-1']);
    assert.ok(store.state.data.entries['event-2']);
    assert.equal(Object.values(store.state.data.entries).filter(e => e.kind === 'event').length, 2);
    assert.deepEqual(store.state.data.inventory, before.data.inventory);
});

test('mergeEvents can update one target; rejects stale, locked and sourced events without partial deletion', async () => {
    const entries = {
        a: createEntry({ id: 'a', kind: 'event', title: 'A', text: 'A', evidence: ['m1'] }),
        b: createEntry({ id: 'b', kind: 'event', title: 'B', text: 'B', evidence: ['m2'] }),
        locked: createEntry({ id: 'locked', kind: 'event', title: '锁定', text: 'X', segments: [{ id: 'body', text: 'X', writable: false }], evidence: ['m3'] }),
        source: createEntry({ id: 'source', kind: 'event', title: '原书事件', text: 'Y', source: { book: 'world', uid: 2, original: 'Y' }, evidence: ['m4'] }),
    };
    const data = { entries, summary: '原摘要', strategy: '', inventory: [], inventoryEnabled: true };
    const op = { type: 'mergeEvents', sources: [{ id: 'a', expectedVersion: 1 }, { id: 'b', expectedVersion: 1 }],
        targetId: 'a', title: 'A+B', intro: '合并', text: 'AB', evidence: ['m1'] };
    const result = applyMaintenance(data, { operations: [op] }, { allowedEvidence: ['m1', 'm2'] });
    assert.equal(result.next.entries.a.version, 2);
    assert.equal(result.next.entries.b, undefined);
    assert.deepEqual(result.next.entries.a.evidence, ['m1', 'm2']);
    assert.deepEqual(result.next.entries.a.lineage, ['a', 'b']);
    assert.equal(result.next.summary, '原摘要');
    assert.ok(data.entries.b);
    for (const bad of [
        { ...op, sources: [{ id: 'a', expectedVersion: 2 }, { id: 'b', expectedVersion: 1 }] },
        { ...op, sources: [{ id: 'a', expectedVersion: 1 }, { id: 'locked', expectedVersion: 1 }] },
        { ...op, sources: [{ id: 'a', expectedVersion: 1 }, { id: 'source', expectedVersion: 1 }] },
        { ...op, evidence: ['not-provided'] },
        { ...op, sources: [{ id: 'a', expectedVersion: 1 }, { id: 'a', expectedVersion: 1 }] },
    ]) assert.throws(() => applyMaintenance(data, { operations: [bad] }, { allowedEvidence: ['m1', 'm2'] }));
    assert.throws(() => applyMaintenance(data, { operations: [op] }, { allowedEvidence: ['m1', 'm2'], maxChars: { b: 1 } }), /长度约束/);
    assert.equal(data.entries.b.title, 'B');
});

test('player can split one named person from a pool without erasing other people or certifying pending story', async () => {
    const persistence = storage(), store = new MemoryStore(persistence);
    await store.load('pool-chat', 'world');
    const original = '周阿姨经营杂货店；张叔每天清晨送报，两人互不相干。';
    await store.initialize([createEntry({ id: 'pool', kind: 'npc_pool', title: '街坊', text: original,
        intro: '街坊路人合集', evidence: ['earlier'],
        source: { book: 'world', uid: 7, original } })], '重视持续关系');
    await store.commit({ operations: [] }, { expectedRevision: store.state.revision, sourceKeys: ['earlier'] });
    const action = { type: 'promote-from-pool', id: 'pool', title: '周阿姨',
        intro: '与用户形成长期信任的杂货店主',
        text: '周阿姨经营杂货店；她与用户约定长期代收信件，形成持续互助关系。',
        retrieveWhen: '提到周阿姨、代收信件或杂货店时提取。' };
    await store.manual(action, ['earlier', 'pending:0']);
    const independent = Object.values(store.state.data.entries).find(e => e.kind === 'npc');
    assert.ok(independent?.important);
    assert.equal(independent.title, '周阿姨');
    assert.deepEqual(independent.lineage, ['pool']);
    assert.deepEqual(independent.evidence, ['earlier']);
    assert.equal(entryText(store.state.data.entries.pool), original);
    assert.equal(store.state.data.entries.pool.version, 1);
    assert.deepEqual(store.state.processed, ['earlier']);
    assert.ok(store.state.audit.some(record => record.entryId === independent.id));
    await assert.rejects(store.manual(action, ['earlier', 'pending:0']), /已从该合集独立建档/);
    assert.equal(Object.values(store.state.data.entries).filter(e => e.kind === 'npc').length, 1);
    await store.reconcile(['earlier', 'pending:1']);
    assert.equal(Object.values(store.state.data.entries).filter(e => e.kind === 'npc').length, 0);
    assert.equal(entryText(store.state.data.entries.pool), original);
});

test('pool promotion requires explicit useful content and refuses protected pool', async () => {
    const persistence = storage(), store = new MemoryStore(persistence);
    await store.load('pool-locked', 'world');
    await store.initialize([createEntry({ id: 'pool', kind: 'npc_pool', title: '路人',
        segments: [{ id: 'body', text: '受保护合集', writable: false }] })], '策略');
    const action = { type: 'promote-from-pool', id: 'pool', title: '某人', intro: '形成持续关系', text: '独立经历' };
    const before = store.snapshot();
    await assert.rejects(store.manual(action), /可维护的路人合集/);
    assert.deepEqual(store.snapshot(), before);
    await store.manual({ type: 'classify', id: 'pool', segments: [{ id: 'body', text: '受保护合集', writable: true }] });
    const current = store.snapshot();
    await assert.rejects(store.manual({ ...action, text: '  ' }), /请填写/);
    assert.deepEqual(store.snapshot(), current);
});
