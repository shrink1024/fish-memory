// Main worldbook sent only as fish decides (0.3.2). Author declarations
// for entries that must follow keywords or story state: a `trigger` rule and
// the rules' natural-language guidance for selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';
import { compileRules, evaluateRules, formToScript } from '../src/rules/index.js';
import { triggeredIds, TRIGGER_SCAN_MESSAGES } from '../src/core/focus.js';

const msg = (key, role, content) => ({ key, role, content, hidden: false, hiddenBy: null });
const rulesEntry = script => ({ uid: 99, comment: '[DWM Rules]', disable: true,
    content: JSON.stringify({ format: 'dwm-rules', version: 1, naturalLanguage: '剧情大纲条目只在对应事件触发时发送。', script }) });

test('trigger rules compile, merge and come from the visual helper', () => {
    const ast = compileRules('when title contains "大纲" => trigger;');
    assert.equal(evaluateRules(ast, { title: '第一卷大纲' }).trigger, true);
    assert.equal(evaluateRules(ast, { title: '人物' }).trigger, false);
    assert.equal(formToScript({ field: 'title', operator: 'contains', value: '大纲', action: 'trigger' }), 'when title contains "大纲" => trigger;');
});

test('triggered entries match original-book keywords in the input or the latest messages only', () => {
    const entry = (id, key, extra = {}) => ({ id, title: id, enabled: true, segments: [], source: { metadata: { key } }, ...extra });
    const save = { data: { entries: { a: entry('a', ['<事件触发>第十首']), b: entry('b', ['/渡口.?驻唱/']), c: entry('c', ['七夕']), d: entry('d', ['第十首'], { enabled: false }) } } };
    const rules = () => ({ trigger: true });
    const messages = [msg('old', 'assistant', '很久以前的七夕'), ...Array.from({ length: TRIGGER_SCAN_MESSAGES - 1 }, (_, i) => msg(`f${i}`, 'user', '闲聊')), msg('last', 'assistant', '正文…<事件触发>第十首</事件触发>')];
    assert.deepEqual(triggeredIds(save, messages, '今晚去渡口驻唱', { rules }).sort(), ['a', 'b'], 'older floors and disabled entries do not trigger');
    assert.deepEqual(triggeredIds(save, messages, '', { rules: () => ({ trigger: false }) }), []);
});

test('trigger keys may be a single character, and regex keys run on the original text with their own flags', () => {
    const entry = (id, key) => ({ id, title: id, enabled: true, segments: [], source: { metadata: { key } } });
    const save = { data: { entries: { sword: entry('sword', ['剑']), alice: entry('alice', ['/Alice/']), loose: entry('loose', ['/alice/i']), strict: entry('strict', ['/bob/']), plain: entry('plain', ['ALICE']) } } };
    const ids = triggeredIds(save, [msg('m', 'assistant', 'Alice 拔剑。')], '', { rules: () => ({ trigger: true }) }).sort();
    assert.deepEqual(ids, ['alice', 'loose', 'plain', 'sword']);
});

test('a triggered entry is sent even when selection does not pick it, and author guidance reaches selection', async () => {
    const book = [{ uid: 1, comment: '第一卷·第一事件', content: '第十首的剧情。', key: ['<事件触发>第十首'] },
        { uid: 2, comment: '城门', content: '城门白天开放。', key: ['城门'] }, rulesEntry('when title contains "事件" => trigger;')];
    const state = { chatId: 'c', bookName: 'main', templateEnabled: true, generating: false, messages: [msg('m0', 'assistant', '开场')], userInput: '' };
    const db = new Map(), calls = [], plans = [];
    const host = { snapshot: () => structuredClone(state), generationSnapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book),
        storage: { read: async id => structuredClone(db.get(id) ?? null), write: async (id, v) => db.set(id, structuredClone(v)) },
        clearPlan() {}, setPlan: plan => plans.push(structuredClone(plan)), applyWindow: async () => {} };
    const model = { complete: async request => {
        calls.push(structuredClone({ purpose: request.purpose, input: request.input }));
        if (request.purpose === 'initialize') return { strategy: 's', entries: request.input.entries.map(e => ({ id: e.id, kind: 'fact', intro: 'i', retrieveWhen: 'w', segments: [{ id: 'body', writable: true }] })) };
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } };
    const c = new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1000 } });
    await c.start(); await c.initialize();
    state.messages.push(msg('u1', 'user', '继续'), msg('a1', 'assistant', '他们回到出租屋。<事件触发>第十首</事件触发>'));
    state.userInput = '写歌';
    await c.generationBefore({ type: 'normal' });
    const select = calls.findLast(x => x.purpose === 'select');
    assert.match(select.input.authorGuidance, /对应事件触发时发送/);
    const eventId = Object.values(c.store.state.data.entries).find(e => e.title === '第一卷·第一事件').id;
    assert.equal(select.input.catalog.find(e => e.id === eventId).constant, true, 'already sent, so it does not use a pick');
    assert.ok(plans.at(-1).selectedIds.includes(eventId));
    assert.ok(!plans.at(-1).selectedIds.includes(Object.values(c.store.state.data.entries).find(e => e.title === '城门').id));
});

test('entries gated by Prompt Template activation stay with the template runtime', async () => {
    const live = { chatId: 'chat-1', characterId: 0, characters: [{ avatar: 'a.png', data: { extensions: { world: 'main' } } }], chatMetadata: {}, chat: [] };
    const host = await createSillyTavernHost({ context: () => live, worldInfo: { loadWorldInfo: async () => ({ entries: {} }) },
        script: { extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0 }, setExtensionPrompt() {} }, extensions: { findExtension: () => ({ enabled: true }) } });
    const gated = { world: 'main', uid: 1, constant: false, disable: false, content: '@@if stage == 2\n第二阶段设定' };
    host.setPlan({ chatId: host.snapshot().chatId, bookName: 'main', selectedIds: [],
        dynamicEntries: [{ id: 'source:main:1', source: { book: 'main', uid: 1 }, segments: [{ text: '动态' }], enabled: true }] });
    const data = { characterLore: [structuredClone(gated)] };
    host.applyWorldInfoEntries(data);
    assert.deepEqual(data.characterLore, [gated]);
});

test('a card script flipping switches in the original book steers selection without blocking the send', async () => {
    const { Controller: C } = await import('../src/runtime/controller.js');
    const book = [{ uid: 1, comment: '城门', content: '城门白天开放。' }, { uid: 2, comment: '密令', content: '只在夜里生效的规则。', disable: true },
        { uid: 3, comment: '夜巡', content: '已扫描、后被关闭的条目。' }];
    const state = { chatId: 'c', bookName: 'main', templateEnabled: true, generating: false, messages: [msg('m0', 'assistant', '开场')], userInput: '' };
    const db = new Map(), calls = [], plans = [];
    const host = { snapshot: () => structuredClone(state), generationSnapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book),
        storage: { read: async id => structuredClone(db.get(id) ?? null), write: async (id, v) => db.set(id, structuredClone(v)) },
        clearPlan() {}, setPlan: plan => plans.push(structuredClone(plan)), applyWindow: async () => {} };
    const model = { complete: async request => {
        calls.push(structuredClone({ purpose: request.purpose, input: request.input }));
        if (request.purpose === 'initialize') return { strategy: 's', entries: request.input.entries.map(e => ({ id: e.id, kind: 'fact', intro: 'i', retrieveWhen: 'w', segments: [{ id: 'body', writable: true }] })) };
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } };
    const c = new C(host, { model, settings: { enabled: true, maintenanceEvery: 1000 } });
    await c.start(); await c.initialize();
    const id = title => Object.values(c.store.state.data.entries).find(e => e.title === title).id;
    book[1].disable = false; book[2].disable = true; book[0].constant = true; // script flips
    await c.generationBefore({ type: 'normal' });
    assert.equal(c.view().sourceChanges.changed, false, 'no "原书已变化" block');
    assert.deepEqual(c.view().sourceChanges.pendingScan, ['密令']);
    const catalog = calls.findLast(x => x.purpose === 'select').input.catalog.map(e => e.id);
    assert.ok(!catalog.includes(id('夜巡')), 'switched off: not offered');
    assert.ok(!catalog.includes(id('密令')), 'never scanned: left to the native path');
    assert.ok(plans.at(-1).selectedIds.includes(id('城门')), 'switched to blue: always sent');
    assert.equal(c.store.state.data.entries[id('城门')].constant, false, 'stored data is untouched');
    assert.equal(calls.findLast(x => x.purpose === 'select').input.progress.messageCount, 1);
});

test('native timers become hints for the initialization agent', async () => {
    const { initializeRequest } = await import('../src/agents/requests.js');
    const { makeSourceEntry } = await import('../src/core/state.js');
    const request = initializeRequest([makeSourceEntry('main', { uid: 1, comment: '秘密', content: '真相。', delay: 50, sticky: 3 }), makeSourceEntry('main', { uid: 2, comment: '普通', content: '日常。' })]);
    assert.deepEqual(request.input.entries[0].nativeTiming, { sticky: 3, delay: 50 });
    assert.equal('nativeTiming' in request.input.entries[1], false);
    assert.match(request.system, /nativeTiming/);
});

test('a never-scanned entry that the book now turns on is sent natively, untouched', async () => {
    const live = { chatId: 'chat-1', characterId: 0, characters: [{ avatar: 'a.png', data: { extensions: { world: 'main' } } }], chatMetadata: {}, chat: [] };
    const host = await createSillyTavernHost({ context: () => live, worldInfo: { loadWorldInfo: async () => ({ entries: {} }) },
        script: { extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0 }, setExtensionPrompt() {} }, extensions: { findExtension: () => ({ enabled: true }) } });
    const native = { world: 'main', uid: 7, constant: false, disable: false, key: ['夜里'], content: '原书正文' };
    host.setPlan({ chatId: host.snapshot().chatId, bookName: 'main', selectedIds: [],
        dynamicEntries: [{ id: 'source:main:7', status: 'deferred', enabled: false, source: { book: 'main', uid: 7 }, segments: [{ text: '原书正文' }] }] });
    const data = { characterLore: [structuredClone(native)] };
    host.applyWorldInfoEntries(data);
    assert.deepEqual(data.characterLore, [native]);
    const off = { characterLore: [{ ...native, disable: true }] };
    host.applyWorldInfoEntries(off);
    assert.deepEqual(off.characterLore, [], 'still off in the book: not sent');
});
