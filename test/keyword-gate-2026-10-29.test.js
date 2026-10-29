// Author `gate` rule, requested by a card author 2026-10-29: the converse of
// `trigger`. An entry gated this way may only be chosen once one of its
// original-book keywords appears, so the panel agrees with what the card sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { compileRules, evaluateRules, formToScript } from '../src/rules/index.js';
import { gatedIds } from '../src/core/focus.js';
import { gatedTier } from '../src/core/state.js';

const msg = (key, role, content) => ({ key, role, content, hidden: false, hiddenBy: null });
const rulesEntry = script => ({ uid: 99, comment: '[DWM Rules]', disable: true,
    content: JSON.stringify({ format: 'dwm-rules', version: 1, naturalLanguage: '', script }) });

test('gate rules compile, merge with trigger and come from the visual helper', () => {
    const ast = compileRules('when title contains "支线" => gate;\nwhen title contains "支线" => trigger;');
    assert.deepEqual(evaluateRules(ast, { title: '支线·渡口' }), { locked: false, maxChars: null, always: false, trigger: true, gate: true });
    assert.equal(evaluateRules(ast, { title: '人物' }).gate, false);
    assert.equal(formToScript({ field: 'title', operator: 'contains', value: '支线', action: 'gate' }), 'when title contains "支线" => gate;');
});

test('a gated entry is held back until a keyword appears; constant entries are not gated', () => {
    const entry = (id, key, extra = {}) => ({ id, title: id, enabled: true, segments: [], source: { metadata: { key } }, ...extra });
    const save = { data: { entries: { ferry: entry('ferry', ['渡口']), nokey: entry('nokey', []), blue: entry('blue', ['城门'], { constant: true }),
        pinned: entry('pinned', ['城门'], { tier: 'constant' }), free: entry('free', ['城门']),
        // Feedback 2026-10-29: the scan marked twelve event entries important, and that alone must not open the gate.
        guessed: entry('guessed', ['城门'], { important: true }), demoted: entry('demoted', ['城门'], { constant: true, tier: 'onDemand' }) } } };
    const rules = entry => ({ gate: entry.id !== 'free' });
    assert.deepEqual(gatedIds(save, [msg('m', 'assistant', '他们走在街上。')], '', { rules }).sort(), ['demoted', 'ferry', 'guessed', 'nokey']);
    assert.deepEqual(gatedIds(save, [msg('m', 'assistant', '他们走在街上。')], '去渡口', { rules }).sort(), ['demoted', 'guessed', 'nokey'], 'the player input opens the gate');
});

test('selection never sees a gated entry without its keyword, and an author always does not override the gate', async () => {
    const book = [{ uid: 1, comment: '支线·渡口驻唱', content: '渡口驻唱的支线。', key: ['渡口'] },
        { uid: 2, comment: '城门', content: '城门白天开放。', key: ['城门'] },
        rulesEntry('when title contains "支线" => gate;\nwhen title contains "支线" => always;')];
    const state = { chatId: 'c', bookName: 'main', templateEnabled: true, generating: false, messages: [msg('m0', 'assistant', '开场')], userInput: '' };
    const db = new Map(), calls = [], plans = [];
    const host = { snapshot: () => structuredClone(state), generationSnapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book),
        storage: { read: async id => structuredClone(db.get(id) ?? null), write: async (id, v) => db.set(id, structuredClone(v)) },
        clearPlan() {}, setPlan: plan => plans.push(structuredClone(plan)), applyWindow: async () => {} };
    let pick = () => [];
    const model = { complete: async request => {
        calls.push(structuredClone({ purpose: request.purpose, input: request.input }));
        if (request.purpose === 'initialize') return { strategy: 's', entries: request.input.entries.map(e => ({ id: e.id, kind: 'fact', intro: 'i', retrieveWhen: 'w', segments: [{ id: 'body', writable: true }] })) };
        return request.purpose === 'select' ? { ids: pick(request.input.catalog) } : { operations: [] };
    } };
    const c = new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1000 } });
    await c.start(); await c.initialize();
    const ferry = Object.values(c.store.state.data.entries).find(e => e.title.startsWith('支线')).id;
    state.messages.push(msg('u1', 'user', '去城门'), msg('a1', 'assistant', '他们到了城门。'));
    await c.generationBefore({ type: 'normal' });
    let select = calls.findLast(x => x.purpose === 'select');
    assert.ok(!select.input.catalog.some(e => e.id === ferry), 'not in the catalog, so no selection slot is spent on it');
    assert.ok(!plans.at(-1).selectedIds.includes(ferry), 'always does not send it past the gate');
    assert.deepEqual(c.diagnostics.lastPlan.gatedIds, [ferry], 'the 本轮 page can show why it was held back');
    state.messages.push(msg('u2', 'user', '今晚去渡口'), msg('a2', 'assistant', '夜色里的渡口。'));
    pick = catalog => catalog.filter(e => e.id === ferry).map(e => e.id);
    await c.generationBefore({ type: 'normal' });
    select = calls.findLast(x => x.purpose === 'select');
    assert.ok(select.input.catalog.some(e => e.id === ferry), 'its keyword appeared, so it may be chosen');
    assert.ok(plans.at(-1).selectedIds.includes(ferry));
    assert.deepEqual(c.diagnostics.lastPlan.gatedIds, []);
});

test('the panel shows a gated entry the scan judged important as on demand, and a player promotion still counts', async () => {
    const book = [{ uid: 1, comment: '事件·渡口夜袭', content: '渡口夜里遇袭。', key: ['渡口'] },
        rulesEntry('when title contains "事件" => gate;')];
    const state = { chatId: 'c', bookName: 'main', templateEnabled: true, generating: false, messages: [msg('m0', 'assistant', '开场')], userInput: '' };
    const db = new Map();
    const host = { snapshot: () => structuredClone(state), generationSnapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book),
        storage: { read: async id => structuredClone(db.get(id) ?? null), write: async (id, v) => db.set(id, structuredClone(v)) },
        clearPlan() {}, setPlan() {}, applyWindow: async () => {} };
    const model = { complete: async request => {
        if (request.purpose === 'initialize') return { strategy: 's', entries: request.input.entries.map(e => ({ id: e.id, kind: 'npc', important: true, intro: 'i', retrieveWhen: 'w', segments: [{ id: 'body', writable: true }] })) };
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } };
    const c = new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1000 } });
    await c.start(); await c.initialize();
    const id = Object.values(c.store.state.data.entries).find(e => e.title.startsWith('事件')).id;
    assert.equal(c.store.state.data.entries[id].important, true, 'the scan guessed important');
    assert.deepEqual(c.view().gateIds, [id]);
    assert.equal(gatedTier(c.store.state.data.entries[id]), 'onDemand');
    state.messages.push(msg('u1', 'user', '走'), msg('a1', 'assistant', '街上很静。'));
    await c.generationBefore({ type: 'normal' });
    assert.deepEqual(c.diagnostics.lastPlan.gatedIds, [id], 'not sent every turn just because the scan judged it important');
    assert.ok(!c.diagnostics.lastPlan.selectedIds.includes(id));
    await c.manual({ type: 'promote', id });
    assert.equal(c.store.state.data.entries[id].tier, 'constant');
    await c.generationBefore({ type: 'normal' });
    assert.deepEqual(c.diagnostics.lastPlan.gatedIds, [], 'a player promotion is a player-set constant');
    assert.ok(c.diagnostics.lastPlan.selectedIds.includes(id));
});

test('review 10-29: once its keyword appears, a gated entry the scan judged important is on demand, in sending and in the preview', async () => {
    const book = [{ uid: 1, comment: '支线·渡口', content: '渡口有一个传闻。', key: ['渡口'] },
        { uid: 2, comment: '人物·老船夫', content: '老船夫守着渡口。', key: ['船夫'] },
        rulesEntry('when title contains "支线" => gate;')];
    const state = { chatId: 'c', bookName: 'main', templateEnabled: true, generating: false, messages: [msg('m0', 'assistant', '开场')], userInput: '去渡口' };
    const db = new Map(), calls = [];
    const host = { snapshot: () => structuredClone(state), generationSnapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book),
        storage: { read: async id => structuredClone(db.get(id) ?? null), write: async (id, v) => db.set(id, structuredClone(v)) },
        clearPlan() {}, setPlan() {}, applyWindow: async () => {} };
    const model = { complete: async request => {
        calls.push(structuredClone({ purpose: request.purpose, input: request.input }));
        if (request.purpose === 'initialize') return { strategy: 's', entries: request.input.entries.map(e => ({ id: e.id, kind: 'npc', important: true, intro: 'i', retrieveWhen: 'w', segments: [{ id: 'body', writable: true }] })) };
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } };
    const c = new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1000 } });
    await c.start(); await c.initialize();
    const id = title => Object.values(c.store.state.data.entries).find(e => e.title.startsWith(title)).id;
    const [ferry, boatman] = [id('支线'), id('人物')];
    await c.generationBefore({ type: 'normal' });
    const catalog = calls.findLast(x => x.purpose === 'select').input.catalog;
    assert.equal(catalog.find(e => e.id === ferry).constant, false, 'offered as on demand, the tier the panel shows');
    assert.ok(!c.diagnostics.lastPlan.mandatoryIds.includes(ferry) && !c.diagnostics.lastPlan.selectedIds.includes(ferry), 'the model did not pick it, so it is not sent');
    assert.equal(catalog.find(e => e.id === boatman).constant, true, 'an important entry without a gate keeps its meaning');
    assert.ok(c.diagnostics.lastPlan.mandatoryIds.includes(boatman));
    assert.equal(c.store.state.data.entries[ferry].tier, undefined, 'the save itself is unchanged');
    // The preview reads the same gate: held back without the keyword, on demand with it.
    const stage = (result, id) => result.stages.find(s => s.id === id);
    let preview = await c.previewPrompts();
    assert.equal(stage(preview, 'select').input.catalog.find(e => e.id === ferry).constant, false);
    assert.ok(!stage(preview, 'narration').input.worldbookCandidates.some(e => e.id === ferry));
    state.userInput = '走吧';
    preview = await c.previewPrompts();
    assert.ok(!stage(preview, 'select').input.catalog.some(e => e.id === ferry), 'no keyword, no catalog place');
});
