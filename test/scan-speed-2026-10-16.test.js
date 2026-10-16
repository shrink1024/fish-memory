// Scan speed and preset wrapping, 2026-10-16: FM-014/016/018 follow-up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { compatibleConnection } from '../src/agents/client.js';
import { prescan, scriptOnly, DEFERRED } from '../src/agents/prescan.js';
import { maintenanceFocus, FOCUS_CHARS } from '../src/core/focus.js';
import { applyMaintenance } from '../src/core/operations.js';
import { FOLLOW_UP_NOTE } from '../src/agents/requests.js';
import { createEntry, createSave, makeSourceEntry } from '../src/core/state.js';

const msg = (key, role = 'assistant', content = `${role} ${key}`) => ({ key, role, content, hidden: false, hiddenBy: null });
const classify = input => ({ strategy: 's', entries: input.entries.map(entry => ({ id: entry.id, kind: 'fact', intro: `简介${entry.title}`, retrieveWhen: '相关时',
    segments: [{ id: 'body', writable: true }] })) });
function fixture({ book, settings = {}, messages = [msg('m0')], handler } = {}) {
    const state = { chatId: 'c', bookName: 'main', templateEnabled: true, generating: false, messages };
    const db = new Map(), calls = [];
    const host = { snapshot: () => structuredClone(state), generationSnapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book),
        storage: { read: async id => structuredClone(db.get(id) ?? null), write: async (id, v) => db.set(id, structuredClone(v)) },
        clearPlan() {}, setPlan() {}, applyWindow: async () => {} };
    const model = { complete: async request => {
        calls.push(structuredClone({ purpose: request.purpose, system: request.system, input: request.input }));
        const handled = await handler?.(request);
        if (handled !== undefined) return handled;
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'select') return { ids: [] };
        return { operations: [] };
    } };
    const controller = new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1, ...settings } });
    return { state, book, calls, controller };
}

test('prescan settles disabled and pure-script entries without a model call', () => {
    assert.equal(scriptOnly('<% setvar("hp", 10) %>\n@@preprocessing\n<%- include("x") %>'), true);
    assert.equal(scriptOnly('<% if (night) { %>城门已经关闭，守卫换岗。<% } %>'), false, 'conditional prose still needs classification');
    assert.equal(scriptOnly('没有脚本的普通设定'), false);
    const entries = [{ uid: 1, comment: '城门', content: '城门白天开放。' }, { uid: 2, comment: '旧设定', content: '已弃用的设定。', disable: true },
        { uid: 3, comment: '变量初始化', content: '<% setvar("hp", 10) %>', key: ['战斗'] }].map(raw => makeSourceEntry('main', raw));
    const { settled, pending } = prescan(entries);
    assert.deepEqual(pending.map(e => e.title), ['城门']);
    const deferred = settled.get(entries[1].id), script = settled.get(entries[2].id);
    assert.equal(deferred.status, DEFERRED); assert.equal(deferred.enabled, false); assert.equal(deferred.needsReview, false);
    assert.equal(script.kind, 'rule'); assert.ok(script.segments.every(s => !s.writable));
    assert.match(script.retrieveWhen, /战斗/);
});

test('initialization skips disabled entries, and enabling one later classifies it on sync', async () => {
    const book = [{ uid: 1, comment: '城门', content: '城门白天开放。' }, { uid: 2, comment: '密道', content: '城北有一条密道。', disable: true },
        { uid: 3, comment: '脚本', content: '<% setvar("x", 1) %>' }];
    const f = fixture({ book });
    await f.controller.start(); await f.controller.initialize();
    const scanned = f.calls.filter(c => c.purpose === 'initialize').flatMap(c => c.input.entries.map(e => e.title));
    assert.deepEqual(scanned, ['城门']);
    const entries = Object.values(f.controller.store.state.data.entries);
    assert.equal(entries.find(e => e.title === '密道').status, DEFERRED);
    assert.equal(entries.find(e => e.title === '脚本').kind, 'rule');
    book[1].disable = false;
    f.calls.length = 0;
    await f.controller.syncSourceChanges();
    assert.deepEqual(f.calls.filter(c => c.purpose === 'initialize').flatMap(c => c.input.entries.map(e => e.title)), ['密道']);
    const synced = Object.values(f.controller.store.state.data.entries).find(e => e.title === '密道');
    assert.equal(synced.enabled, true); assert.equal(synced.status, 'confirmed'); assert.ok(synced.segments.some(s => s.writable));
});

function bigSave() {
    const save = createSave('c', 'main');
    const filler = '设定'.repeat(Math.ceil(FOCUS_CHARS / 20));
    const add = input => { const e = createEntry({ kind: 'fact', intro: '简介', ...input }); save.data.entries[e.id] = e; return e; };
    const ids = {
        hero: add({ id: 'hero', title: '艾琳', kind: 'npc', text: '艾琳是骑士。' }).id,
        keyed: add({ id: 'keyed', title: '王都', text: '王都概况。', source: { book: 'main', uid: 9, original: '王都概况。', metadata: { key: ['白塔', '/银[色白]之门/'] } } }).id,
        constant: add({ id: 'constant', title: '世界现状', text: '和平。', constant: true }).id,
        other: [],
    };
    for (let i = 0; i < 12; i++) ids.other.push(add({ id: `far${i}`, title: `远方${i}`, text: filler }).id);
    return { save, ids };
}

test('maintenance focus keeps small memories whole and narrows large ones to touched entries', () => {
    const small = createSave('c', 'main');
    const e = createEntry({ id: 'a', title: '甲', kind: 'npc', text: '短' }); small.data.entries.a = e;
    assert.equal(maintenanceFocus(small, 'global', [msg('k', 'assistant', '无关')]), null);
    const { save, ids } = bigSave();
    const focus = maintenanceFocus(save, 'global', [msg('k', 'assistant', '艾琳穿过银白之门。')]);
    assert.ok(focus.has(ids.hero), 'title hit'); assert.ok(focus.has(ids.keyed), 'author regex key hit'); assert.ok(focus.has(ids.constant), 'constant');
    assert.ok(ids.other.every(id => !focus.has(id)));
    save.journal.push({ reason: 'maintenance', patch: { entries: { far3: {} } } });
    assert.ok(maintenanceFocus(save, 'global', [msg('k', 'assistant', '无关')]).has('far3'), 'recently maintained entries stay in focus');
});

test('appendSummary extends the running summary; a full summary still replaces it', () => {
    const data = createSave('c', 'main').data;
    data.summary = '第一段。';
    const once = applyMaintenance(data, { operations: [{ type: 'appendSummary', text: '第二段。' }] }).next;
    assert.equal(once.summary, '第一段。\n第二段。');
    const scoped = applyMaintenance(once, { operations: [{ type: 'appendSummary', text: '异界。' }] }, { scopeId: 'world:2' }).next;
    assert.equal(scoped.scopeSummaries['world:2'], '异界。');
    assert.equal(applyMaintenance(once, { operations: [{ type: 'summary', text: '重写。' }] }).next.summary, '重写。');
});

test('large memories send a catalog; requested entries get one targeted follow-up pass', async () => {
    const filler = '设定'.repeat(Math.ceil(FOCUS_CHARS / 20));
    const book = [{ uid: 1, comment: '艾琳', content: '艾琳是骑士。' }, { uid: 2, comment: '密室', content: '密室在地下。' },
        ...Array.from({ length: 12 }, (_, i) => ({ uid: 10 + i, comment: `远方${i}`, content: filler }))];
    const messages = [msg('u1', 'user', '去地下看看'), msg('a1', 'assistant', '艾琳打开了门，发现地下那间屋子已经坍塌。')];
    let maintainCalls = 0;
    const f = fixture({ book, messages, handler: request => {
        if (request.purpose !== 'maintain') return undefined;
        maintainCalls++;
        const memory = request.input.memory;
        const vault = Object.values(memory.entries).find(e => e.title === '密室') ?? memory.catalog.find(e => e.title === '密室');
        if (maintainCalls === 1) {
            assert.ok(memory.catalog.some(e => e.title === '远方0'), 'unrelated entries are listed, not sent in full');
            assert.ok(!memory.entries.some(e => e.title === '远方0'));
            return { operations: [{ type: 'appendSummary', text: '艾琳发现密室坍塌。' },
                { type: 'update', id: vault.id, expectedVersion: 1, segments: [{ id: 'body', text: '猜测' }], evidence: ['a1'] }], needEntries: [] };
        }
        assert.match(request.system, new RegExp(FOLLOW_UP_NOTE.slice(0, 10)));
        assert.deepEqual(memory.entries.map(e => e.title), ['密室']);
        return { operations: [{ type: 'update', id: vault.id, expectedVersion: vault.version, segments: [{ id: 'body', text: '密室在地下，已经坍塌。' }], evidence: ['a1'] },
            { type: 'appendSummary', text: '不应写入' }] };
    } });
    await f.controller.start(); await f.controller.initialize();
    assert.equal(maintainCalls, 2);
    const data = f.controller.store.state.data;
    assert.equal(Object.values(data.entries).find(e => e.title === '密室').segments[0].text, '密室在地下，已经坍塌。');
    assert.equal(data.summary, '艾琳发现密室坍塌。', 'the follow-up pass cannot touch the summary');
});

test('the running summary is condensed once it passes the threshold; initialization uses larger history batches', async () => {
    const book = [{ uid: 1, comment: '城门', content: '城门白天开放。' }];
    const messages = Array.from({ length: 6 }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user', `第${i}段剧情`));
    const f = fixture({ book, messages, settings: { batchChars: 5 }, handler: request => {
        if (request.purpose === 'maintain') return { operations: [{ type: 'appendSummary', text: '长'.repeat(8000) }] };
        if (request.purpose === 'compact') {
            assert.deepEqual(request.input.memory.entries, [], 'summary-only condensation');
            return { operations: [{ type: 'summary', text: '压缩后的脉络' }] };
        }
        return undefined;
    } });
    await f.controller.start(); await f.controller.initialize();
    assert.equal(f.calls.filter(c => c.purpose === 'maintain').length, 1, 'history fits one initialization batch despite a small per-turn batch size');
    assert.equal(f.calls.filter(c => c.purpose === 'compact').length, 1);
    assert.equal(f.controller.store.state.data.summary, '压缩后的脉络');
});

test('separate connection wraps the task with preset head and tail and sends low effort, dropping it if rejected', async () => {
    const bodies = [];
    let reject = true;
    const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body); bodies.push(body);
        if (body.reasoning_effort && reject) return new Response(JSON.stringify({ error: { message: 'Unrecognized request argument: reasoning_effort' } }), { status: 400 });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200 });
    };
    const send = compatibleConnection({ endpoint: 'https://aux.example/v1', model: 'm', fetchImpl });
    const request = { purpose: 'select', system: '任务', input: '{}', head: [{ role: 'system', content: '头' }], tail: [{ role: 'assistant', content: '好的，' }], reasoningEffort: 'low' };
    await send(request);
    assert.deepEqual(bodies[0].messages.map(m => [m.role, m.content]), [['system', '头'], ['system', '任务'], ['user', '{}'], ['assistant', '好的，']]);
    assert.equal(bodies[0].reasoning_effort, 'low');
    assert.equal(bodies[1].reasoning_effort, undefined, 'a rejected parameter is resent once without it');
    await send(request);
    assert.equal(bodies.length, 3, 'later requests omit it directly');
    assert.equal(bodies[2].reasoning_effort, undefined);
    reject = false;
    const fresh = compatibleConnection({ endpoint: 'https://aux.example/v1', model: 'm', fetchImpl });
    await fresh({ ...request, reasoningEffort: 'inherit' });
    assert.equal(bodies.at(-1).reasoning_effort, undefined, 'inherit sends nothing on a separate connection');
});

test('the summary mode switch chooses between appending and rewriting the whole summary', async () => {
    const book = [{ uid: 1, comment: '城门', content: '城门白天开放。' }];
    const messages = [msg('u1', 'user', '进城'), msg('a1', 'assistant', '守卫放行。')];
    const run = async settings => {
        const f = fixture({ book, messages, settings, handler: request => request.purpose === 'maintain'
            ? { operations: [request.system.includes('"type":"appendSummary"') ? { type: 'appendSummary', text: '进城。' } : { type: 'summary', text: '完整脉络：进城。' }] } : undefined });
        await f.controller.start(); await f.controller.initialize();
        return { system: f.calls.find(c => c.purpose === 'maintain').system, summary: f.controller.store.state.data.summary, f };
    };
    const append = await run({});
    assert.match(append.system, /"type":"appendSummary"/); assert.doesNotMatch(append.system, /"type":"summary"/);
    assert.equal(append.summary, '进城。');
    const rewrite = await run({ summaryMode: 'rewrite' });
    assert.match(rewrite.system, /"type":"summary"/); assert.doesNotMatch(rewrite.system, /appendSummary/);
    assert.equal(rewrite.summary, '完整脉络：进城。');
    await assert.rejects(rewrite.f.controller.updateSettings({ summaryMode: 'mixed' }), /脉络写法/);
});
