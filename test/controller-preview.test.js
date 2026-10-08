import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { createSave, createEntry, makeSourceEntry } from '../src/core/state.js';

const clone = value => structuredClone(value);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const find = (preview, id) => preview.stages.find(stage => stage.id === id);

async function fixture() {
    const snapshot = { chatId: 'chat-1', bookName: 'main', templateEnabled: true, userInput: '去码头',
        messages: [{ key: 'm1', role: 'user', content: '我抵达了码头', hidden: false, hiddenBy: null }] };
    const rawBook = [{ uid: 1, comment: '航路铁律', content: '船只能顺水', constant: true },
        { uid: 2, comment: '[DWM Rules]', disable: true, content: JSON.stringify({ format: 'dwm-rules', version: 1, naturalLanguage: '记录明确事实', script: 'when id == "author-required" => always;' }) }];
    const save = createSave(snapshot.chatId, snapshot.bookName);
    save.initialized = true; save.revision = 2;
    save.data.summary = '当前脉络 <% ordinary text'; save.data.strategy = '记录事实';
    save.data.inventory = [{ name: '船票', description: '当天有效' }];
    const entries = [makeSourceEntry('main', rawBook[0]),
        createEntry({ id: 'important', title: '船夫', kind: 'npc', text: '愿意同行', important: true }),
        createEntry({ id: 'author-required', title: '天气', text: '正在下雨' }),
        createEntry({ id: 'optional', title: '旧桥', text: '桥上有灯' }),
        createEntry({ id: 'disabled', title: '不启用', text: '不可加入', enabled: false, constant: true }),
        createEntry({ id: 'foreign', scopeId: 'world:2', title: '另一个世界', text: '不在当前范围', important: true })];
    save.data.entries = Object.fromEntries(entries.map(entry => [entry.id, entry]));
    save.base = clone(save.data);
    const stored = new Map([[snapshot.chatId, clone(save)]]), calls = [];
    let bookRead = null, mvuRead = null, modelAnswer = { ids: [] };
    const host = {
        snapshot() { calls.push(['snapshot']); return clone(snapshot); },
        previewSnapshot() { calls.push(['previewSnapshot']); return clone(snapshot); },
        async loadWorldbook(bookName = host.snapshot().bookName) {
            calls.push(['loadWorldbook', bookName]); return bookRead ? bookRead(bookName) : clone(rawBook);
        },
        storage: {
            async read(id) { calls.push(['storage.read', id]); return clone(stored.get(id) ?? null); },
            async write(id, value) { calls.push(['storage.write', id]); stored.set(id, clone(value)); },
        },
        eligible(entry) { calls.push(['eligible', entry.id]); return entry.enabled && entry.id !== 'ineligible'; },
        previewEligible(entry) { calls.push(['previewEligible', entry.id]); return entry.enabled && entry.id !== 'ineligible'; },
        clearPlan() { calls.push(['clearPlan']); },
        setPlan(plan) { calls.push(['setPlan', clone(plan)]); },
        async applyWindow(actions) { calls.push(['applyWindow', clone(actions)]); },
        async readMvu(settings) { calls.push(['readMvu']); return mvuRead ? mvuRead(settings) : { status: 'unavailable', fields: [] }; },
    };
    const model = { complete: async request => { calls.push(['model', clone({ purpose: request.purpose, system: request.system, input: request.input })]); return clone(modelAnswer); } };
    const controller = new Controller(host, { model, settings: { enabled: true, windowEnabled: true } });
    await controller.start(); calls.length = 0;
    return { controller, host, snapshot, rawBook, calls, stored,
        setBookRead(value) { bookRead = value; }, setMvuRead(value) { mvuRead = value; }, setModelAnswer(value) { modelAnswer = value; } };
}
function assertNoEffects(calls) {
    assert.deepEqual(calls.filter(([kind]) => ['model', 'storage.write', 'clearPlan', 'setPlan', 'applyWindow', 'eligible', 'snapshot'].includes(kind)), []);
}

test('Controller prompt preview is a read-only projection with no model, save, plan or window effects', async () => {
    const f = await fixture(), before = f.controller.store.snapshot();
    f.controller.store.state.audit.push({ text: 'PLAYER-PRIVATE-AUDIT' });
    const expectedSave = f.controller.store.snapshot(), diagnostics = clone(f.controller.diagnostics);
    const result = await f.controller.previewPrompts();
    assert.equal(result.chatId, f.snapshot.chatId); assert.equal(result.revision, before.revision);
    assert.ok(find(result, 'select').input.messages.some(message => message.key === 'current-input'));
    assertNoEffects(f.calls);
    assert.deepEqual(f.controller.store.snapshot(), expectedSave);
    assert.deepEqual(f.controller.diagnostics, diagnostics);
    assert.doesNotMatch(JSON.stringify(result), /PLAYER-PRIVATE-AUDIT/);
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'loadWorldbook'), [['loadWorldbook', 'main']]);
});

test('worldbook read failures reject cleanly without replacing the active plan or memory', async () => {
    const f = await fixture(), before = f.controller.store.snapshot();
    f.setBookRead(async () => { throw new Error('worldbook unavailable'); });
    await assert.rejects(f.controller.previewPrompts(), /worldbook unavailable/);
    assertNoEffects(f.calls); assert.deepEqual(f.controller.store.snapshot(), before);
});

test('a changed chat while an asynchronous worldbook read is pending invalidates the whole preview', async () => {
    const f = await fixture(), gate = deferred();
    f.setBookRead(() => gate.promise);
    const running = f.controller.previewPrompts();
    f.snapshot.chatId = 'chat-2'; f.snapshot.bookName = 'other';
    gate.resolve(clone(f.rawBook));
    await assert.rejects(running, /有变化/); assertNoEffects(f.calls);
});

test('changing the unsent draft during a read rejects the old assembled request', async () => {
    const f = await fixture(), gate = deferred();
    f.setBookRead(() => gate.promise);
    const running = f.controller.previewPrompts();
    f.snapshot.userInput = '我改变主意，回城'; gate.resolve(clone(f.rawBook));
    await assert.rejects(running, /有变化/); assertNoEffects(f.calls);
});

test('a memory revision change or reply edit during provider read invalidates the entire preview', async () => {
    for (const change of [f => { f.controller.store.state.revision++; }, f => { f.snapshot.messages[0].content = '修改后的当前正文'; }]) {
        const f = await fixture(), gate = deferred(), started = deferred();
        f.controller.registerPreviewSource({ id: 'card', title: '测试卡', read: async () => { started.resolve(); return gate.promise; } });
        const running = f.controller.previewPrompts(); await started.promise;
        change(f); gate.resolve({ stages: [{ id: 'old', title: '旧结果', input: { text: '旧版本' }, system: '', status: 'ready' }] });
        await assert.rejects(running, /有变化/); assertNoEffects(f.calls);
    }
});

test('provider registration prefixes stages, isolates returned data, and disposes only the matching registration', async () => {
    const f = await fixture();
    const payload = { stages: [{ id: 'flow', title: '流程', input: { known: 'current' }, system: '规则', status: 'conditional', uncertainties: ['稍后判定'] }], warnings: ['尚未发送'] };
    const disposeOld = f.controller.registerPreviewSource({ id: 'card', title: '旧卡', read: () => ({ stages: [] }) });
    const dispose = f.controller.registerPreviewSource({ id: 'card', title: '当前卡', read: () => payload });
    disposeOld();
    const result = await f.controller.previewPrompts();
    assert.equal(find(result, 'card:flow').title, '当前卡 · 流程');
    assert.deepEqual(find(result, 'card:flow').provider, { id: 'card', title: '当前卡' });
    assert.equal(find(result, 'card:flow').agent.title, '当前卡 · 未标注 Agent');
    assert.equal(find(result, 'card:flow').agent.identified, false);
    assert.equal(find(result, 'card:flow').kind, 'unknown');
    assert.ok(result.warnings.includes('当前卡：尚未发送'));
    find(result, 'card:flow').input.known = 'changed by viewer'; assert.equal(payload.stages[0].input.known, 'current');
    dispose(); const next = await f.controller.previewPrompts(); assert.equal(next.stages.some(stage => stage.id.startsWith('card:')), false);
    assertNoEffects(f.calls);
});

test('provider Agent identities are isolated across sources while explicit narration injections share one Agent', async () => {
    const f = await fixture();
    const payload = { stages: [
        { id: 'flow', title: '流程', agent: { id: 'flow', title: '流程 Agent', description: '判定本轮流程' }, kind: 'request', system: '规则', input: { current: true } },
        { id: 'body', title: '正文片段', agent: { id: 'narration', title: '正文叙事 Agent', description: '当前来源的正文片段' }, kind: 'injection', system: '片段', input: null },
    ] };
    for (const id of ['card', 'another']) f.controller.registerPreviewSource({ id, title: id, read: () => payload });
    const result = await f.controller.previewPrompts(), flow = find(result, 'card:flow');
    assert.equal(flow.agent.id, 'card:agent:flow');
    assert.equal(find(result, 'another:flow').agent.id, 'another:agent:flow');
    assert.equal(flow.agent.title, payload.stages[0].agent.title);
    assert.equal(flow.agent.description, payload.stages[0].agent.description);
    assert.equal(flow.agent.identified, true);
    assert.equal(flow.kind, 'request');
    for (const id of ['narration', 'card:body', 'another:body']) {
        assert.equal(find(result, id).agent.id, 'narration');
        assert.equal(find(result, id).kind, 'injection');
    }
    flow.agent.description = '仅修改预览';
    assert.equal(payload.stages[0].agent.description, '判定本轮流程');
    assertNoEffects(f.calls);
});

test('an unregistered in-flight provider is discarded and a failing provider does not hide Fish previews', async () => {
    const f = await fixture(), gate = deferred(), started = deferred();
    const dispose = f.controller.registerPreviewSource({ id: 'card', title: '测试卡', read: async () => { started.resolve(); return gate.promise; } });
    const running = f.controller.previewPrompts(); await started.promise; dispose();
    gate.resolve({ stages: [{ id: 'late', title: '迟到', input: { text: '旧数据' } }] });
    const result = await running; assert.equal(result.stages.some(stage => stage.id.startsWith('card:')), false);
    f.controller.registerPreviewSource({ id: 'broken', title: '故障卡', read: () => { throw new Error('card read failed'); } });
    const failed = await f.controller.previewPrompts();
    assert.equal(find(failed, 'broken:unavailable').status, 'unavailable');
    assert.deepEqual(find(failed, 'broken:unavailable').provider, { id: 'broken', title: '故障卡' });
    assert.equal(find(failed, 'broken:unavailable').agent.identified, false);
    assert.equal(find(failed, 'broken:unavailable').kind, 'unknown');
    assert.match(find(failed, 'broken:unavailable').explanation, /card read failed/);
    assert.ok(find(failed, 'select').input); assertNoEffects(f.calls);
});

test('optional MVU read failure stays uncertain and does not refresh controller MVU state', async () => {
    const f = await fixture();
    Object.assign(f.controller.settings, { mvuEnabled: true, mvuBookName: 'main' });
    const before = clone(f.controller.mvu);
    f.setMvuRead(async () => { throw new Error('MVU missing'); });
    const result = await f.controller.previewPrompts();
    assert.equal('observedState' in find(result, 'select').input, false);
    assert.match(find(result, 'select').uncertainties.join(''), /MVU/);
    assert.deepEqual(f.controller.mvu, before); assertNoEffects(f.calls);
});

test('known mandatory narration slots match the actual plan while optional picks stay explicitly unresolved', async () => {
    const f = await fixture();
    const preview = await f.controller.previewPrompts(), narration = find(preview, 'narration');
    assert.equal(narration.agent.id, 'narration');
    assert.equal(narration.agent.title, '正文叙事 Agent');
    assert.equal(narration.kind, 'injection');
    assert.match(narration.agent.description, /鱼忆与已接入来源.*不含完整预设/);
    assertNoEffects(f.calls);
    await f.controller.generationBefore({ type: 'normal' });
    const plan = f.calls.find(([kind]) => kind === 'setPlan')?.[1];
    assert.ok(plan); assert.equal(f.calls.filter(([kind]) => kind === 'model').length, 1);
    assert.deepEqual(plan.selectedIds, ['source:main:1', 'important', 'author-required']);
    for (const key of ['summary', 'inventory', 'details']) {
        const slot = narration.input.slots.find(slot => slot.name === `dwm:${key}`);
        assert.equal(slot.content, plan[key].replaceAll('<%', '<\u200b%'));
        assert.equal(slot.role, 'system'); assert.equal(slot.position, 'in_chat'); assert.equal(slot.depth, 4);
    }
    assert.deepEqual(narration.input.worldbookCandidates.map(entry => entry.id), ['source:main:1']);
    assert.match(narration.uncertainties.join(''), /选中 ID/);
});

test('transitions label inventory provenance without changing active scope', async () => {
    const f = await fixture();
    f.controller.store.state.data.scopeContext = { owner: 'test-card', activeScopeId: 'global', requestedScopeIds: ['world:2'], deferPost: true };
    const preview = await f.controller.previewPrompts(), narration = find(preview, 'narration');
    assert.match(narration.uncertainties.join(''), /来源范围标签/);
    assert.match(narration.input.slots.find(slot => slot.name === 'dwm:inventory').content, /物品来源范围 global/);
    assertNoEffects(f.calls);
    await f.controller.generationBefore({ type: 'normal' });
    assert.match(f.calls.find(([kind]) => kind === 'setPlan')[1].inventory, /物品来源范围 global[\s\S]*【船票｜当天有效】/);
    assert.equal(f.controller.store.state.data.scopeContext.activeScopeId, 'global');
});

test('already-changed chat or selected reply cannot expose stale narration as a current injection preview', async () => {
    for (const change of [f => { f.snapshot.chatId = 'chat-2'; }, f => { f.controller.store.state.processed = ['other-swipe']; }]) {
        const f = await fixture(); change(f);
        const result = await f.controller.previewPrompts();
        assert.equal(find(result, 'select').input, null);
        assert.equal(find(result, 'narration').input, null);
        assertNoEffects(f.calls);
    }
});
