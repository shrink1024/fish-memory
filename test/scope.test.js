import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { MemoryStore } from '../src/core/store.js';
import { createSave, createEntry, validateSave } from '../src/core/state.js';
import { applyMaintenance } from '../src/core/operations.js';
import { frontCatalog, frontRead, maintenanceView, scopeRead } from '../src/core/views.js';

const message = (key, content, role = 'assistant') => ({ key, content, role, hidden: false });
const entry = (id, scopeId, extra = {}) => createEntry({ id, scopeId, title: id, text: `${id}正文`, intro: `${id}简介`, kind: 'npc', important: true, ...extra });
function fixture(handler) {
    const state = { chatId: 'scope-chat', bookName: 'main', templateEnabled: true, messages: [], userInput: '' };
    const saved = new Map(), calls = [], plans = [];
    const host = {
        snapshot: () => structuredClone(state), loadWorldbook: async () => [{ uid: 1, comment: '通则', content: 'LOCKED_RULE', constant: true }],
        storage: { read: async id => structuredClone(saved.get(id) ?? null), write: async (id, value) => saved.set(id, structuredClone(value)) },
        clearPlan: () => plans.push(null), setPlan: plan => plans.push(plan), eligible: e => e.enabled,
        applyWindow: async () => {},
    };
    const model = { complete: async request => {
        calls.push(structuredClone({ purpose: request.purpose, input: request.input }));
        if (request.purpose === 'initialize') return { strategy: '不改变规则', entries: request.input.entries.map(e => ({ id: e.id, kind: 'rule', intro: '规则', segments: [{ id: 'body', text: e.content, writable: false }] })) };
        if (handler) return handler(request);
        if (request.purpose === 'maintain') return { operations: [
            { type: 'summary', text: request.input.messages.map(m => m.content).join('；') },
            { type: 'create', kind: 'npc', title: request.input.memory.scopeId, intro: '本地重要人物', text: request.input.messages.map(m => m.content).join('；'), important: true, evidence: request.input.messages.map(m => m.key) },
            { type: 'inventory', items: [{ name: request.input.memory.scopeId, description: '当地物品' }] },
        ] };
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } };
    return { state, saved, calls, plans, host, model };
}
async function ready(f) {
    const c = new Controller(f.host, { model: f.model, settings: { enabled: true, batchChars: 10000 } });
    await c.start(); await c.initialize(); return c;
}
async function turn(c, f, { from, to = from, key, text, post = to }) {
    await c.setContext({ owner: 'wxl', activeScopeId: from, requestedScopeIds: to === from ? [] : [to], deferPost: true });
    f.state.messages.push(message(key, text));
    c.messageReceived();
    await c.setContext({ owner: 'wxl', activeScopeId: to, postScopeId: post, deferPost: false });
    await c.whenIdle();
}

test('scope defaults preserve legacy global saves, views and maintenance', () => {
    const save = createSave('chat', 'book');
    delete save.data.scopeContext; delete save.data.scopeSummaries; delete save.data.scopeInventories; delete save.data.messageScopes;
    const old = entry('old', 'global'); delete old.scopeId; save.data.entries.old = old;
    assert.equal(validateSave(save), save);
    assert.equal(frontCatalog(save)[0].scopeId, 'global');
    const next = applyMaintenance(save.data, { operations: [{ type: 'summary', text: '旧卡脉络' }, { type: 'inventory', items: [] }] }).next;
    assert.equal(next.summary, '旧卡脉络');
    assert.equal(maintenanceView({ data: next }).entries[0].id, 'old');
});

test('current and requested scopes bound catalog, mandatory NPCs and native constant entries', async () => {
    const f = fixture(), c = await ready(f);
    await c.setContext({ owner: 'wxl', activeScopeId: 'A' }); await c.whenIdle();
    await turn(c, f, { from: 'A', key: 'a', text: 'A的老朋友' });
    await turn(c, f, { from: 'A', to: 'B', key: 'b', text: 'B的老朋友' });
    const planB = await c.previewPlan();
    assert.match(planB.details, /B的老朋友/); assert.doesNotMatch(planB.details, /A的老朋友/);
    assert.match(planB.summary, /B的老朋友/); assert.doesNotMatch(planB.summary, /A的老朋友/);
    assert.match(planB.inventory, /B/); assert.doesNotMatch(planB.inventory, /【A/);
    assert.ok(planB.selectedIds.includes('source:main:1'));
    await c.setContext({ owner: 'wxl', activeScopeId: 'B', requestedScopeIds: ['A'], deferPost: true });
    const prepared = await c.previewPlan();
    assert.match(prepared.details, /A的老朋友/); assert.match(prepared.details, /B的老朋友/);
    assert.equal(c.store.state.data.scopeContext.activeScopeId, 'B');
    // Even a future scoped source with native constant semantics cannot escape filtering.
    c.store.state.data.entries.cross = entry('cross', 'C', { constant: true, source: { book: 'main', uid: 99 } });
    const guarded = await c.previewPlan();
    assert.equal(guarded.entries.find(e => e.id === 'cross').enabled, false);
    assert.equal(guarded.selectedIds.includes('cross'), false);
    assert.throws(() => frontRead(c.store.state, ['cross']), /不可读取/);
});

test('deferred finalization persists attribution separate from next active world and survives reload', async () => {
    const f = fixture(), c = await ready(f);
    await c.setContext({ owner: 'wxl', activeScopeId: 'domain-A' }); await c.whenIdle();
    await c.setContext({ owner: 'wxl', activeScopeId: 'domain-A', requestedScopeIds: ['hub'], deferPost: true });
    const before = f.calls.filter(x => x.purpose === 'maintain').length;
    f.state.messages.push(message('exit', '在迷域完成结算，回到域枢。'));
    c.messageReceived(); await c.whenIdle();
    assert.equal(f.calls.filter(x => x.purpose === 'maintain').length, before);
    const response = await c.setContext({ owner: 'wxl', activeScopeId: 'hub', postScopeId: 'domain-A', deferPost: false });
    assert.equal(response.context.activeScopeId, 'hub'); await c.whenIdle();
    assert.equal(c.store.state.data.messageScopes.exit, 'domain-A');
    assert.equal(c.store.state.data.scopeSummaries['domain-A'], '在迷域完成结算，回到域枢。');
    assert.equal(c.store.state.data.scopeSummaries.hub, undefined);
    assert.equal((await c.previewPlan()).details, '');
    const reopened = new Controller(f.host, { model: f.model, settings: { enabled: true } });
    await reopened.start();
    assert.equal(reopened.store.state.data.scopeContext.activeScopeId, 'hub');
    assert.match((await reopened.readScope('domain-A')).summary, /完成结算/);
    assert.equal((await reopened.readScope('hub')).summary, '');
});

test('regenerating a remembered tail preserves the card pause through deletion, replay and reload', async () => {
    const f = fixture(); let c = await ready(f);
    await c.setContext({ owner: 'wxl', activeScopeId: 'domain' }); await c.whenIdle();
    for (let i = 1; i <= 6; i++) f.state.messages.push(message(`m${i}`, `迷域共同经历${i}`));
    await c.maintain();
    await turn(c, f, { from: 'domain', key: 'old-tail', text: '原候选的结局' });
    assert.equal(c.store.state.processed.length, 7);

    await c.setContext({ owner: 'wxl', activeScopeId: 'domain', requestedScopeIds: ['hub'], deferPost: true });
    const maintenanceCount = f.calls.filter(x => x.purpose === 'maintain').length;
    // ST regenerate removes the old selected AI reply before the new generation.
    f.state.messages.pop();
    await c.messageDeleted();
    await c.generationBefore({ type: 'regenerate' });
    assert.equal(c.store.state.processed.length, 6);
    assert.equal(c.store.state.data.messageScopes['old-tail'], undefined);
    assert.equal(c.store.state.data.scopeContext.deferPost, true);
    assert.doesNotMatch((await c.readScope('domain')).summary, /原候选/);
    assert.equal(f.calls.filter(x => x.purpose === 'maintain').length, maintenanceCount);

    // The pause must survive disk reload, not only a Controller field.
    c = new Controller(f.host, { model: f.model, settings: { enabled: true } });
    await c.start();
    assert.equal((await c.whenIdle()).context.deferPost, true);
    f.state.messages.push(message('new-tail', '在迷域完成结算，回到域枢。'));
    c.messageReceived(); await c.whenIdle();
    assert.equal(c.store.state.processed.length, 6);
    const commit = { owner: 'wxl', activeScopeId: 'hub', requestedScopeIds: [], postScopeId: 'domain', deferPost: false };
    await c.setContext(commit);
    const idle = await c.whenIdle();
    assert.equal(idle.pendingCount, 0);
    assert.equal(c.store.state.processed.length, 7);
    assert.equal(c.store.state.data.messageScopes['new-tail'], 'domain');
    assert.match((await c.readScope('domain')).summary, /完成结算/);
    assert.equal((await c.readScope('hub')).summary, '');
    assert.deepEqual(idle.context, { owner: 'wxl', activeScopeId: 'hub', requestedScopeIds: [], deferPost: false });
    // An uncertain caller can read the committed context instead of replaying
    // post attribution without an outstanding pause.
    await assert.rejects(c.setContext(commit), /只能用于提交已暂停/);
    idle.context.requestedScopeIds.push('not-persisted');
    assert.deepEqual((await c.whenIdle()).context.requestedScopeIds, []);
});

test('batch rollback preserves surviving messages original scope before a different post commit', async () => {
    const f = fixture(), c = await ready(f);
    await c.setContext({ owner: 'wxl', activeScopeId: 'A' }); await c.whenIdle();
    await turn(c, f, { from: 'A', key: 'a', text: 'A中旧事' });
    await c.setContext({ owner: 'wxl', activeScopeId: 'A', requestedScopeIds: ['B'], deferPost: true });
    f.state.messages.push(message('b1', 'B中必须保留的经历'), message('b2', 'B中待重生成的回复'));
    await c.setContext({ owner: 'wxl', activeScopeId: 'B', postScopeId: 'B', deferPost: false }); await c.whenIdle();
    await c.setContext({ owner: 'wxl', activeScopeId: 'B', requestedScopeIds: ['C'], deferPost: true });
    f.state.messages.pop();
    await c.messageDeleted(); await c.generationBefore({ type: 'regenerate' });
    // The batch of two B messages must be reprocessed, but its first message's
    // confirmed origin must not be overwritten by the replacement reply's C.
    assert.equal(c.store.state.processed.length, 1);
    assert.equal(c.store.state.data.messageScopes.b1, 'B');
    assert.equal(c.store.state.data.messageScopes.b2, undefined);
    f.state.messages.push(message('c', 'C中替代后的事件'));
    await c.setContext({ owner: 'wxl', activeScopeId: 'hub', postScopeId: 'C', deferPost: false }); await c.whenIdle();
    const last = f.calls.filter(x => x.purpose === 'maintain').slice(-2);
    assert.deepEqual(last.map(x => [x.input.memory.scopeId, x.input.messages.map(m => m.key)]), [['B', ['b1']], ['C', ['c']]]);
    assert.equal(c.store.state.processed.length, 3);
    assert.equal((await c.readScope('B')).summary, 'B中必须保留的经历');
    assert.equal((await c.readScope('C')).summary, 'C中替代后的事件');
});

test('old failed gaps retain their scope and later batches split across worlds', async () => {
    let failing = false;
    const f = fixture(request => {
        if (request.purpose === 'maintain') {
            if (failing) throw new Error('临时故障');
            return { operations: [{ type: 'summary', text: request.input.messages.map(m => m.content).join('；') }] };
        }
        return { ids: [] };
    });
    const c = await ready(f);
    await c.setContext({ owner: 'wxl', activeScopeId: 'A' }); await c.whenIdle();
    failing = true; f.state.messages.push(message('old-gap', 'A的未补事实'));
    await assert.rejects(c.maintain(), /临时故障/);
    await c.setContext({ owner: 'wxl', activeScopeId: 'A', requestedScopeIds: ['B'], deferPost: true });
    assert.equal(c.store.state.data.messageScopes['old-gap'], 'A');
    f.state.messages.push(message('new-turn', 'B的新事实'));
    failing = false;
    await c.setContext({ owner: 'wxl', activeScopeId: 'B', deferPost: false }); await c.whenIdle();
    const calls = f.calls.filter(x => x.purpose === 'maintain').slice(-2);
    assert.deepEqual(calls.map(call => [call.input.memory.scopeId, call.input.messages.map(m => m.key)]), [['A', ['old-gap']], ['B', ['new-turn']]]);
    assert.equal(c.store.state.data.scopeSummaries.A, 'A的未补事实');
    assert.equal(c.store.state.data.scopeSummaries.B, 'B的新事实');
    assert.equal(c.store.state.processed.length, 2);
});

test('cross-scope writes and mixed evidence batches fail atomically', async () => {
    const store = new MemoryStore({ read: async () => null, write: async () => {} });
    await store.load('chat', 'book'); await store.initialize([entry('a', 'A'), entry('b', 'B')], '');
    await store.manual({ type: 'scope-context', context: { owner: 'wxl', activeScopeId: 'A', requestedScopeIds: [], deferPost: false }, messageScopes: { ma: 'A', mb: 'B' } }, ['ma', 'mb']);
    const revision = store.state.revision;
    await assert.rejects(store.commit({ operations: [{ type: 'summary', text: '混淆' }] }, { expectedRevision: revision, sourceKeys: ['ma', 'mb'], scopeId: 'A' }), /混有其他范围/);
    assert.equal(store.state.revision, revision);
    assert.throws(() => applyMaintenance(store.state.data, { operations: [{ type: 'update', id: 'b', expectedVersion: 1, segments: [{ id: 'body', text: '串世界' }], evidence: ['ma'] }] }, { allowedEvidence: ['ma'], scopeId: 'A' }), /跨范围/);
    assert.throws(() => applyMaintenance(store.state.data, { operations: [{ type: 'summary', scopeId: 'B', text: '串世界' }] }, { scopeId: 'A' }), /改变本批资料归属/);
});

test('readScope gives only requested writable data and redacts locked bodies even in copied summaries', () => {
    const save = createSave('chat', 'book');
    save.audit = [{ before: 'AUDIT_SECRET' }];
    save.data.entries = {
        a: entry('a', 'A'), b: entry('b', 'B'),
        rule: entry('rule', 'A', { kind: 'rule', text: 'LOCKED_BODY' }),
        mixed: entry('mixed', 'A', { intro: 'LOCKED_BODY', segments: [{ id: 'locked', text: 'LOCKED_BODY', writable: false }, { id: 'open', text: '可维护事实', writable: true }] }),
    };
    save.data.scopeSummaries = { A: '摘要误引LOCKED_BODY', B: 'B的摘要' };
    const view = scopeRead(save, 'A'), serialized = JSON.stringify(view);
    assert.match(serialized, /可维护事实/); assert.match(serialized, /a正文/);
    assert.doesNotMatch(serialized, /LOCKED_BODY|AUDIT_SECRET|B的摘要|b正文|baseline|journal/);
    assert.equal(view.entries.find(e => e.id === 'mixed').intro, '');
});

test('clearing owner context restores global card behavior without exposing archived scoped facts', async () => {
    const f = fixture(), c = await ready(f);
    await c.setContext({ owner: 'wxl', activeScopeId: 'A' }); await c.whenIdle();
    await turn(c, f, { from: 'A', key: 'a', text: 'A本地事实' });
    await assert.rejects(c.clearContext('another-card'), /owner/);
    await c.clearContext('wxl');
    assert.equal(c.store.state.data.scopeContext, null);
    const plan = await c.previewPlan(); assert.equal(plan.details, ''); assert.equal(plan.summary, '');
    f.state.messages.push(message('ordinary', '普通卡的后续事实')); await c.maintain();
    assert.equal(c.store.state.data.summary, '普通卡的后续事实');
    assert.equal(c.store.state.data.scopeSummaries.A, 'A本地事实');
    assert.equal(c.store.state.data.messageScopes.ordinary, 'global');
});

test('scope inventory catch-up stays in each original scope', async () => {
    const f = fixture(request => request.purpose === 'maintain'
        ? { operations: request.input.memory.inventory ? [{ type: 'inventory', items: [{ name: request.input.memory.scopeId, description: request.input.messages.at(-1).content }] }] : [] }
        : { ids: [] });
    const c = await ready(f);
    await c.setContext({ owner: 'wxl', activeScopeId: 'A' }); await c.whenIdle();
    await turn(c, f, { from: 'A', key: 'a1', text: 'A初始物品' });
    await c.manual({ type: 'inventory-toggle', enabled: false });
    await turn(c, f, { from: 'A', key: 'a2', text: 'A物品变化' });
    await turn(c, f, { from: 'A', to: 'B', key: 'b', text: 'B物品变化' });
    await c.manual({ type: 'inventory-toggle', enabled: true });
    assert.equal(c.store.state.data.scopeInventories.A[0].description, 'A物品变化');
    assert.equal(c.store.state.data.scopeInventories.B[0].description, 'B物品变化');
    assert.equal(c.store.state.inventoryDisabledAt, null);
});

test('scope lifecycle follows branch replay and context cannot be changed by another owner', async () => {
    const f = fixture(), c = await ready(f);
    await c.setContext({ owner: 'wxl', activeScopeId: 'A' }); await c.whenIdle();
    await turn(c, f, { from: 'A', key: 'a', text: 'A初遇' });
    await turn(c, f, { from: 'A', to: 'B', key: 'b', text: 'B未来事件' });
    await assert.rejects(c.setContext({ owner: 'wrong', activeScopeId: 'C' }), /其他调用方/);
    await c.setContext({ owner: 'wxl', activeScopeId: 'B', requestedScopeIds: ['future'], deferPost: true });
    const branch = structuredClone(f.saved.get('scope-chat'));
    f.state.chatId = 'branch-chat'; f.state.messages = [f.state.messages[0]]; f.saved.set('branch-chat', branch);
    await c.chatChanged();
    assert.equal((await c.readScope('B')).summary, '');
    assert.equal(c.store.state.data.messageScopes.b, undefined);
    assert.equal(c.store.state.data.scopeContext, null);
    // A new branch cannot inherit the original chat's live or future context;
    // the card explicitly restores the branch's own committed state.
    await c.setContext({ owner: 'wxl', activeScopeId: 'A', deferPost: false }); await c.whenIdle();
    assert.match((await c.previewPlan()).details, /A初遇/);
    assert.doesNotMatch((await c.previewPlan()).details, /B未来事件/);
});

test('scope calls waiting for old maintenance cannot publish into a different chat', async () => {
    let resolveGate;
    const gate = new Promise(resolve => { resolveGate = resolve; });
    const f = fixture(request => request.purpose === 'maintain' ? gate : { ids: [] });
    const c = await ready(f);
    await c.setContext({ owner: 'wxl', activeScopeId: 'A' }); await c.whenIdle();
    f.state.messages.push(message('old', '旧聊天正在补记'));
    const maintenance = c.maintain();
    const contextChange = c.setContext({ owner: 'wxl', activeScopeId: 'B' });
    f.state.chatId = 'new-chat'; f.state.messages = []; await c.chatChanged();
    resolveGate({ operations: [] });
    await assert.rejects(maintenance, /作废|切换|取消/);
    await assert.rejects(contextChange, /作废|切换|取消/);
    assert.equal(c.store.state.chatId, 'new-chat');
    assert.equal(c.store.state.data.scopeContext, null);
});

test('cancelled preparation restores the old scope without materializing target history', async () => {
    const f = fixture(), c = await ready(f);
    await c.setContext({ owner: 'wxl', activeScopeId: 'A' }); await c.whenIdle();
    await c.setContext({ owner: 'wxl', activeScopeId: 'A', requestedScopeIds: ['B'], deferPost: true });
    await assert.rejects(c.clearContext('wxl'), /提交或取消/);
    await assert.rejects(c.setContext({ owner: 'wxl', activeScopeId: 'B', deferPost: true }), /等待卡提交/);
    await c.setContext({ owner: 'wxl', activeScopeId: 'A', requestedScopeIds: [], deferPost: false }); await c.whenIdle();
    assert.deepEqual((await c.readScope('B')).entries, []);
    assert.equal(c.store.state.data.scopeContext.activeScopeId, 'A');
    assert.equal(f.calls.filter(call => call.purpose === 'maintain').length, 0);
});
