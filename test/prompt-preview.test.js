import test from 'node:test';
import assert from 'node:assert/strict';
import { createSave, createEntry, makeSourceEntry, DEFAULT_SETTINGS } from '../src/core/state.js';
import { buildPromptPreview } from '../src/diagnostics/prompt-preview.js';
import { initializeRequest, strategyRequest, selectRequest, maintainRequest, compactRequest, selectionMessages } from '../src/agents/requests.js';
import { classifyEntries, alignStrategy, select, maintain, compact } from '../src/agents/tasks.js';
import { compileRules } from '../src/rules/index.js';

function fixture() {
    const save = createSave('chat-1', 'main');
    save.initialized = true; save.revision = 3;
    save.data.strategy = '保留发生过的事实'; save.data.summary = '旅人刚刚抵达';
    const fact = createEntry({ id: 'fact-1', title: '渡口', text: '渡口已封闭', intro: '渡口现状', evidence: ['m1'] });
    const event = createEntry({ id: 'event-1', kind: 'event', title: '抵达', text: '旅人抵达', intro: '旅人抵达', evidence: ['m1'] });
    save.data.entries = { [fact.id]: fact, [event.id]: event };
    const snapshot = { chatId: 'chat-1', bookName: 'main', templateEnabled: true, messages: [{ key: 'm1', role: 'assistant', content: '旅人抵达' }], userInput: '' };
    const rawEntries = [{ uid: 1, comment: '原书现状', content: '港口开放', constant: true, key: ['港口'] }];
    return { save, snapshot, rawEntries, settings: { ...DEFAULT_SETTINGS, enabled: true }, at: '2026-10-06T00:00:00.000Z' };
}
const get = (preview, id) => preview.stages.find(stage => stage.id === id);
const inputAndSystem = value => ({ system: value.system, input: value.input });

test('preview batches and conditional stages retain the three explicit Fish Agent responsibilities', () => {
    const f = fixture();
    f.settings.batchChars = 5;
    f.rawEntries = [{ uid: 1, content: '第一批资料' }, { uid: 2, content: '第二批资料' }];
    f.snapshot.messages = [{ key: 'a', role: 'assistant', content: '第一条剧情' }, { key: 'b', role: 'assistant', content: '第二条剧情' }];
    const preview = buildPromptPreview(f), byAgent = {};
    for (const stage of preview.stages) {
        (byAgent[stage.agent.id] ??= []).push(stage.id);
        assert.equal(stage.kind, 'request');
        assert.equal(stage.agent.identified, true);
        assert.ok(stage.agent.title && stage.agent.description);
    }
    assert.deepEqual(byAgent, {
        'fish-initialize': ['initialize-1', 'initialize-2', 'strategy'],
        'fish-select': ['select'],
        'fish-maintain': ['maintain-1', 'maintain-2', 'compact'],
    });
    f.save.initialized = false; f.rawEntries = null;
    assert.deepEqual(buildPromptPreview(f).stages.map(stage => [stage.id, stage.agent.id, stage.kind]), [
        ['initialize', 'fish-initialize', 'request'], ['strategy', 'fish-initialize', 'request'],
        ['select', 'fish-select', 'request'], ['maintain', 'fish-maintain', 'request'], ['compact', 'fish-maintain', 'request'],
    ]);
});

test('executing all five tasks uses the same projections as the request factories', async () => {
    const { save, snapshot, rawEntries } = fixture();
    const entries = rawEntries.map(raw => makeSourceEntry('main', raw));
    const calls = [];
    const client = { complete: async request => {
        calls.push(structuredClone({ purpose: request.purpose, system: request.system, input: request.input }));
        if (request.purpose === 'initialize') return { entries: request.input.entries.map(entry => ({ id: entry.id, kind: 'fact', intro: entry.title, segments: [{ id: 'body', text: entry.content, writable: true }] })) };
        if (request.purpose === 'strategy') return { strategy: '合并策略' };
        if (request.purpose === 'select') return { ids: [] };
        return { operations: [] };
    } };
    await classifyEntries(client, entries, '作者规则');
    await alignStrategy(client, ['甲', '乙', '甲', ''], entries, '作者规则');
    await select(client, save, snapshot.messages, { selectionLimit: 7, selectionChars: 8000 });
    await maintain(client, save, snapshot.messages);
    await compact(client, save);
    assert.deepEqual(calls, [initializeRequest(entries, '作者规则'), strategyRequest(['甲', '乙'], entries, '作者规则'),
        selectRequest(save, snapshot.messages, { selectionLimit: 7, selectionChars: 8000 }), maintainRequest(save, snapshot.messages), compactRequest(save)]);
    assert.equal(await alignStrategy(client, ['', '甲', '甲'], entries, ''), '甲');
    assert.equal(strategyRequest(['甲', '甲'], entries, ''), null);
    assert.equal(calls.length, 5);
});

test('current preview matches real task inputs while preserving backlog and unsent draft boundaries', async () => {
    const f = fixture();
    f.snapshot.messages = Array.from({ length: 8 }, (_, i) => ({ key: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }));
    f.save.processed = ['m0', 'm1']; f.snapshot.userInput = '继续去渡口'; f.settings.recentTurns = 1;
    const expectedRecent = [...f.snapshot.messages.slice(2), { key: 'current-input', role: 'user', content: '继续去渡口' }];
    const preview = buildPromptPreview(f);
    assert.deepEqual(get(preview, 'select').input.messages, expectedRecent);
    assert.deepEqual(inputAndSystem(get(preview, 'select')), inputAndSystem(selectRequest(f.save, expectedRecent)));
    assert.deepEqual(inputAndSystem(get(preview, 'maintain-1')), inputAndSystem(maintainRequest(f.save, f.snapshot.messages.slice(2))));
    assert.equal(get(preview, 'maintain-1').input.messages.some(message => message.key === 'current-input'), false);
    f.save.processed = f.snapshot.messages.map(message => message.key);
    assert.deepEqual(selectionMessages(f.snapshot, f.save, 1), [...f.snapshot.messages.slice(6), expectedRecent.at(-1)]);
    const next = buildPromptPreview(f);
    assert.equal(get(next, 'maintain').status, 'conditional');
    assert.equal('messages' in get(next, 'maintain').input, false);
    assert.match(get(next, 'maintain').uncertainties.join(''), /尚不存在/);
});

test('initialization preserves the actual batch limit, excludes config, and leaves strategy outputs unknown', () => {
    const f = fixture(); f.save.initialized = false;
    f.settings.batchChars = 5;
    f.rawEntries = [{ uid: 1, content: '第一条四字' }, { uid: 2, content: '第二条四字' },
        { uid: 3, comment: '[DWM Rules]', content: JSON.stringify({ format: 'dwm-rules', version: 1, naturalLanguage: '只记事实', script: '' }) }];
    const preview = buildPromptPreview(f), scans = preview.stages.filter(stage => stage.id.startsWith('initialize-'));
    assert.equal(scans.length, 2);
    assert.deepEqual(scans.flatMap(stage => stage.input.entries).map(entry => entry.id), ['source:main:1', 'source:main:2']);
    assert.equal(scans[0].input.naturalLanguage, '只记事实');
    assert.equal(get(preview, 'strategy').status, 'conditional');
    assert.equal(get(preview, 'strategy').input, null);
    for (const id of ['select', 'maintain', 'compact']) {
        assert.equal(get(preview, id).input, null); assert.ok(get(preview, id).system);
    }
    f.rawEntries = f.rawEntries.slice(0, 1);
    assert.equal(get(buildPromptPreview(f), 'strategy').status, 'skipped');
    f.settings = { enabled: true };
    f.rawEntries = [{ uid: 1, content: 'a'.repeat(18000) }, { uid: 2, content: 'b' }];
    assert.equal(buildPromptPreview(f).stages.filter(stage => stage.id.startsWith('initialize-')).length, 2);
});

test('maintenance splits contiguous scopes and marks later memories as unknown', () => {
    const f = fixture();
    f.snapshot.messages = [
        { key: 'a', role: 'assistant', content: 'aaaa' }, { key: 'b', role: 'assistant', content: 'bbbb' },
        { key: 'c', role: 'assistant', content: 'c' }, { key: 'd', role: 'assistant', content: 'd' },
    ];
    f.save.data.messageScopes = { a: 'global', b: 'global', c: 'world:2', d: 'global' }; f.settings.batchChars = 5;
    const stages = buildPromptPreview(f).stages.filter(stage => stage.id.startsWith('maintain-'));
    assert.equal(stages.length, 4);
    assert.equal(stages[0].status, 'ready'); assert.ok(stages[0].input.memory);
    assert.deepEqual(stages.map(stage => stage.input.messages[0].scopeId), ['global', 'global', 'world:2', 'global']);
    for (const stage of stages.slice(1)) {
        assert.equal(stage.status, 'conditional'); assert.equal('memory' in stage.input, false);
        assert.match(stage.uncertainties.join(''), /前面批次成功保存/);
    }
    f.save.data.scopeContext = { owner: 'test', activeScopeId: 'global', requestedScopeIds: [], deferPost: true };
    assert.equal(get(buildPromptPreview(f), 'maintain-1').status, 'conditional');
});

test('protected text, disabled inventory and player audit never enter maintenance or compact projections', () => {
    const f = fixture();
    f.save.data.entries['secret'] = createEntry({ id: 'secret', title: '保护条目', text: 'LOCKED-BODY-ONLY', intro: '不可维护', kind: 'fact' });
    f.save.data.summary = '引用 LOCKED-BODY-ONLY';
    f.save.data.inventory = [{ name: 'INVENTORY-SECRET', description: '清单保留但关闭' }];
    f.save.data.inventoryEnabled = false;
    f.save.audit = [{ text: 'PLAYER-AUDIT-SECRET' }];
    f.save.journal = [{ text: 'PLAYER-JOURNAL-SECRET' }];
    f.compiledRules = compileRules('when id == "secret" => lock;');
    const before = structuredClone(f), preview = buildPromptPreview(f);
    for (const id of ['maintain-1', 'compact']) {
        const input = get(preview, id).input;
        assert.doesNotMatch(JSON.stringify(input), /LOCKED-BODY-ONLY|INVENTORY-SECRET|PLAYER-AUDIT-SECRET|PLAYER-JOURNAL-SECRET/);
        assert.equal('inventory' in input.memory, false);
        assert.equal(input.memory.entries.some(entry => entry.id === 'secret'), false);
    }
    assert.doesNotMatch(JSON.stringify(preview), /PLAYER-AUDIT-SECRET|PLAYER-JOURNAL-SECRET/);
    assert.deepEqual(f, before);
    get(preview, 'select').input.catalog[0].title = '只修改预览';
    assert.equal(f.save.data.entries['fact-1'].title, '渡口');
});

test('MVU projection only belongs to the latest message and never travels to historical batches', () => {
    const f = fixture();
    f.snapshot.messages = [{ key: 'old', role: 'assistant', content: '旧剧情' }, { key: 'latest', role: 'assistant', content: '新剧情' }];
    Object.assign(f.settings, { mvuEnabled: true, mvuBookName: 'main', batchChars: 3 });
    f.observedState = { source: 'MVU read-only observation', messageKey: 'latest', persistence: 'unverified', fields: [{ path: '天气', label: '天气', value: '雨' }] };
    let preview = buildPromptPreview(f);
    assert.equal(get(preview, 'select').input.observedState.messageKey, 'latest');
    assert.equal('observedState' in get(preview, 'maintain-1').input, false);
    assert.equal(get(preview, 'maintain-2').input.observedState.messageKey, 'latest');
    f.observedState.messageKey = 'old'; preview = buildPromptPreview(f);
    assert.equal('observedState' in get(preview, 'select').input, false);
    assert.match(get(preview, 'select').uncertainties.join(''), /可能追加 observedState/);
    f.observedState.messageKey = 'latest'; f.settings.mvuBookName = 'another';
    assert.equal('observedState' in get(buildPromptPreview(f), 'select').input, false);
});

test('eligibility, active scopes and selected history changes have explicit boundaries', () => {
    const f = fixture();
    f.save.data.entries.hidden = createEntry({ id: 'hidden', title: '作者条件未满足', text: '未解锁' });
    f.save.data.entries.foreign = createEntry({ id: 'foreign', scopeId: 'world:2', title: '别的世界', text: '不在当前范围' });
    f.eligible = entry => entry.id !== 'hidden';
    assert.deepEqual(get(buildPromptPreview(f), 'select').input.catalog.map(entry => entry.id), ['fact-1', 'event-1']);
    f.save.processed = ['another-swipe'];
    const changed = buildPromptPreview(f);
    assert.equal(get(changed, 'select').input, null);
    assert.match(changed.warnings.join(''), /回放存档/);
    f.save.chatId = 'other';
    assert.equal(buildPromptPreview(f).revision, null);
});

test('compact preview includes only active-scope events and accurately marks mergeability', () => {
    const f = fixture();
    f.save.data.scopeContext = { owner: 'test', activeScopeId: 'world:2', requestedScopeIds: ['world:3'], deferPost: false };
    f.save.data.scopeSummaries['world:2'] = '第二世界的脉络';
    for (const [id, scopeId, source] of [['local', 'world:2', null], ['original', 'world:2', { uid: 1 }], ['remote', 'world:3', null]]) {
        f.save.data.entries[id] = createEntry({ id, scopeId, source, title: id, kind: 'event', text: id });
    }
    const compactStage = get(buildPromptPreview(f), 'compact');
    assert.equal(compactStage.status, 'conditional');
    assert.equal(compactStage.input.memory.summary, '第二世界的脉络');
    assert.deepEqual(compactStage.input.memory.entries.map(entry => [entry.id, entry.mergeable]), [['local', true], ['original', false]]);
    assert.deepEqual(inputAndSystem(compactStage), inputAndSystem(compactRequest(f.save, 'world:2')));
    assert.match(compactStage.uncertainties.join(''), /48000/);
});
