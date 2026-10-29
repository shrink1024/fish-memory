// FM-040/041, 2026-10-29: the auxiliary provider's content review refused one
// book-scan batch, the whole initialization failed, and every retry resent it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { assertCompleteModelResponse, blockedResponse, modelApiError } from '../src/agents/client.js';
import { SCAN_REFUSAL_BUDGET } from '../src/agents/tasks.js';
import { DEFERRED } from '../src/agents/prescan.js';
import { sourceBookChanges } from '../src/core/source-book.js';

const msg = (key, role = 'assistant', content = `${role} ${key}`) => ({ key, role, content, hidden: false, hiddenBy: null });
const classify = input => ({ strategy: 's', entries: input.entries.map(entry => ({ id: entry.id, kind: 'fact', intro: `简介${entry.title}`, retrieveWhen: '相关时',
    segments: [{ id: 'body', writable: true }] })) });
function fixture({ book, refuse }) {
    const state = { chatId: 'c', bookName: 'main', templateEnabled: true, generating: false, messages: [msg('m0')] };
    const db = new Map(), calls = [];
    const host = { snapshot: () => structuredClone(state), generationSnapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book),
        storage: { read: async id => structuredClone(db.get(id) ?? null), write: async (id, v) => db.set(id, structuredClone(v)) },
        clearPlan() {}, setPlan() {}, applyWindow: async () => {} };
    const model = { complete: async request => {
        const titles = (request.input.entries ?? []).map(entry => entry.title);
        calls.push({ purpose: request.purpose, titles });
        if (request.purpose === 'initialize') {
            if (refuse.current(titles)) throw blockedResponse('PROHIBITED_CONTENT');
            return classify(request.input);
        }
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } };
    const controller = new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1 } });
    return { calls, controller, book };
}
const refusing = predicate => ({ current: predicate });
const titles = n => Array.from({ length: n }, (_, i) => `条目${i}`);
const byTitle = (c, title) => Object.values(c.store.state.data.entries).find(e => e.title === title);

test('a refusal is reported as the provider review, with only its reason code', () => {
    // Response shape from a player problem export (an OpenAI-compatible Gemini proxy through ST).
    const payload = { choices: [{ index: 0, message: { role: 'assistant', content: 'blockReason: PROHIBITED_CONTENT\nblockReasonMessage: The prompt could not be submitted.' }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 13919, completion_tokens: 0 } };
    assert.throws(() => assertCompleteModelResponse(payload), error => {
        assert.equal(error.dwmBlocked, true); assert.equal(error.blockReason, 'PROHIBITED_CONTENT');
        assert.match(error.message, /服务方拦下了这次请求（内容审核：PROHIBITED_CONTENT）/);
        assert.match(error.message, /设置 → 辅助模型/);
        assert.doesNotMatch(error.message, /could not be submitted/, 'the provider text is not repeated');
        return true;
    });
    for (const shape of [{ candidates: [{ finishReason: 'SAFETY' }] }, { promptFeedback: { blockReason: 'OTHER' } }, { stop_reason: 'refusal' }]) {
        assert.throws(() => assertCompleteModelResponse(shape), error => error.dwmBlocked === true);
    }
    const gateway = modelApiError({ error: { message: 'Google AI Studio API returned no candidate\nPrompt was blocked due to : PROHIBITED_CONTENT' } });
    assert.equal(gateway.dwmBlocked, true); assert.equal(gateway.blockReason, 'PROHIBITED_CONTENT');
    assert.equal(blockedResponse('<b>x</b>').blockReason, undefined, 'free text is never shown as a reason');
    assert.doesNotThrow(() => assertCompleteModelResponse({ choices: [{ finish_reason: 'stop' }] }));
});

test('initialization narrows a refused batch and leaves only the refused entry unscanned', async () => {
    const book = titles(8).map((comment, uid) => ({ uid, comment, content: `${comment}的设定。` }));
    const f = fixture({ book, refuse: refusing(names => names.includes('条目5')) });
    await f.controller.start(); await f.controller.initialize();
    assert.equal(f.controller.store.state.initialized, true, 'the scan finishes instead of failing');
    const refused = byTitle(f.controller, '条目5');
    assert.equal(refused.status, DEFERRED); assert.equal(refused.scanBlocked, true); assert.equal(refused.enabled, false);
    assert.ok(refused.segments.every(segment => !segment.writable), 'maintenance never writes an entry it could not scan');
    for (const name of titles(8).filter(name => name !== '条目5')) {
        const entry = byTitle(f.controller, name);
        assert.equal(entry.status, 'confirmed'); assert.equal(entry.scanBlocked, undefined); assert.equal(entry.intro, `简介${name}`);
    }
    const scans = f.calls.filter(call => call.purpose === 'initialize');
    assert.ok(scans.length <= 1 + 2 * Math.ceil(Math.log2(8)), `bisection stays logarithmic (${scans.length} scans)`);
    assert.match(f.controller.status, /1 条被辅助接口的内容审核拒收，暂按原世界书发送/);
    assert.deepEqual(sourceBookChanges(f.controller.store.state, book, []).pendingScan, [], 'a refused entry is not offered for the same scan again');
});

test('a provider that refuses every scan costs a bounded number of calls', async () => {
    const book = titles(24).map((comment, uid) => ({ uid, comment, content: `${comment}的设定。` }));
    const f = fixture({ book, refuse: refusing(() => true) });
    await f.controller.start(); await f.controller.initialize();
    const scans = f.calls.filter(call => call.purpose === 'initialize').length;
    assert.ok(scans <= 1 + 2 * SCAN_REFUSAL_BUDGET, `${scans} scans`);
    assert.ok(Object.values(f.controller.store.state.data.entries).every(entry => entry.scanBlocked), 'all entries stay with the native book');
});

test('other scan errors still fail initialization, and a later tier change rescans a refused entry', async () => {
    const book = titles(3).map((comment, uid) => ({ uid, comment, content: `${comment}的设定。` }));
    let mode = 'broken';
    const f = fixture({ book, refuse: refusing(names => {
        if (mode === 'broken') throw new Error('接口返回错误');
        return mode === 'refuse' && names.includes('条目1');
    }) });
    await f.controller.start();
    await assert.rejects(f.controller.initialize(), /接口返回错误/);
    assert.equal(f.controller.store.state.initialized, false);
    mode = 'refuse';
    await f.controller.initialize();
    assert.equal(byTitle(f.controller, '条目1').scanBlocked, true);
    // Same provider: a single-entry rescan is refused with the clear message and changes nothing.
    await assert.rejects(f.controller.manual({ type: 'tier', id: byTitle(f.controller, '条目1').id, tier: 'onDemand' }), /内容审核/);
    assert.equal(byTitle(f.controller, '条目1').scanBlocked, true);
    // After switching to a provider that accepts it, the entry is scanned and joins the memory.
    mode = 'accept';
    await f.controller.manual({ type: 'tier', id: byTitle(f.controller, '条目1').id, tier: 'onDemand' });
    const rescanned = byTitle(f.controller, '条目1');
    assert.equal(rescanned.status, 'confirmed'); assert.equal(rescanned.scanBlocked, undefined); assert.equal(rescanned.tier, 'onDemand');
});

test('batch tiers keep refused entries as they were and save the rest', async () => {
    const book = titles(3).map((comment, uid) => ({ uid, comment, content: `${comment}的设定。`, disable: true }));
    let refuseNow = false;
    const f = fixture({ book, refuse: refusing(names => refuseNow && names.includes('条目2')) });
    await f.controller.start(); await f.controller.initialize();
    refuseNow = true;
    const ids = titles(3).map(name => byTitle(f.controller, name).id);
    await f.controller.setEntryTiers(ids, 'onDemand');
    assert.deepEqual(titles(3).map(name => byTitle(f.controller, name).tier), ['onDemand', 'onDemand', undefined]);
    assert.match(f.controller.status, /已一次保存 2 条的档位；1 条被辅助接口的内容审核拒收，档位未变/);
    await assert.rejects(f.controller.setEntryTiers([byTitle(f.controller, '条目2').id], 'onDemand'), /内容审核/);
});

test('review 10-29: a refused source update keeps the story memory and stays pending; a refused new entry goes native', async () => {
    const book = [{ uid: 1, comment: 'NPC', content: '住在港口' }];
    let refuseNow = false;
    const f = fixture({ book, refuse: refusing(() => refuseNow) });
    await f.controller.start(); await f.controller.initialize();
    const id = byTitle(f.controller, 'NPC').id;
    await f.controller.manual({ type: 'edit', id, segments: [{ id: 'body', text: '已搬到北城，持有玩家的钥匙', writable: true }] });
    book[0].content = '住在港口，新增作者设定';
    book.push({ uid: 2, comment: '新条目', content: '作者新加的设定。' });
    refuseNow = true;
    await f.controller.syncSourceChanges();
    const kept = f.controller.store.state.data.entries[id];
    assert.equal(kept.segments.map(s => s.text).join(''), '已搬到北城，持有玩家的钥匙', 'the story memory survives');
    assert.equal(kept.status, 'confirmed'); assert.equal(kept.scanBlocked, undefined);
    assert.equal(f.controller.store.state.base.entries[id].source.original, '住在港口', 'the baseline does not move either');
    assert.equal(f.controller.view().sourceChanges.changed, true, 'the update is still offered for a later sync');
    assert.equal(byTitle(f.controller, '新条目').scanBlocked, true, 'a new entry has no memory to lose and is sent natively');
    assert.match(f.controller.status, /原书部分同步.*1 条的新版被辅助接口的内容审核拒收，没有同步，原资料保留；1 条被内容审核拒收，暂按原世界书发送/);
});

test('review 10-29: a batch rescan that succeeds clears the refusal marker', async () => {
    const book = titles(2).map((comment, uid) => ({ uid, comment, content: `${comment}的设定。` }));
    let refuseNow = true;
    const f = fixture({ book, refuse: refusing(() => refuseNow) });
    await f.controller.start(); await f.controller.initialize();
    assert.ok(titles(2).every(name => byTitle(f.controller, name).scanBlocked));
    refuseNow = false;
    await f.controller.setEntryTiers(titles(2).map(name => byTitle(f.controller, name).id), 'onDemand');
    for (const name of titles(2)) {
        const entry = byTitle(f.controller, name);
        assert.equal(entry.status, 'confirmed'); assert.equal(entry.tier, 'onDemand');
        assert.equal(entry.scanBlocked, undefined, 'no longer shown as refused and sent natively');
    }
});
