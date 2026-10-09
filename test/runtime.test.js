import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';

const msg = (key, content, role = 'user') => ({ key, content, role, hidden: false, hiddenBy: null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) {
    for (let i = 0; i < 20; i++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Expected asynchronous stage was not reached');
}

function fixture({ messages = [], book = [{ uid: 1, comment: '住址', content: '旧城', constant: true, disable: false }], modelHandler } = {}) {
    const state = { chatId: 'chat-1', bookName: 'main', templateEnabled: true, messages, userInput: '' };
    const saved = new Map(), calls = [], plans = [], windowActions = [];
    let failWrite = false, stopped = 0;
    const host = {
        snapshot: () => structuredClone(state),
        loadWorldbook: async () => structuredClone(book),
        storage: {
            read: async id => structuredClone(saved.get(id) ?? null),
            write: async (id, value, expectedRevision) => {
                if (failWrite) throw new Error('disk failed');
                const previous = saved.get(id);
                assert.equal(previous?.revision ?? 0, expectedRevision);
                saved.set(id, structuredClone(value));
            },
        },
        clearPlan: () => { plans.push(null); },
        setPlan: plan => { plans.push(structuredClone(plan)); },
        applyWindow: async actions => {
            windowActions.push(structuredClone(actions));
            for (const action of actions) Object.assign(state.messages[action.index], { hidden: action.hidden, hiddenBy: action.hiddenBy });
        },
        stopGeneration: async () => { stopped++; },
        eligible: entry => entry.enabled !== false,
    };
    const model = { complete: async request => {
        calls.push({ purpose: request.purpose, input: structuredClone(request.input) });
        if (modelHandler) return modelHandler(request, { state, calls });
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain') return { operations: [] };
        if (request.purpose === 'select') return { ids: [] };
        if (request.purpose === 'compact') return { operations: [] };
        throw new Error('unknown purpose');
    } };
    return { state, saved, calls, plans, windowActions, host, model,
        failWrites(value) { failWrite = value; }, get stopped() { return stopped; } };
}

function classify(input) {
    return { strategy: '记录当前事实和重要事件', entries: input.entries.map(e => ({
        id: e.id, kind: 'fact', intro: e.title, retrieveWhen: '相关时提取', needsReview: false,
        segments: [{ id: 'body', text: e.content, writable: true }],
    })) };
}

async function ready(f, settings = {}) {
    const controller = new Controller(f.host, { model: f.model, settings: { enabled: true, maintenanceEvery: 1, batchChars: 30, ...settings } });
    await controller.start();
    await controller.initialize();
    return controller;
}

test('author length limits also apply to newly created entries', async () => {
    const book = [{ uid: 1, comment: '现状', content: '平静', constant: true },
        { uid: 2, comment: '[DWM Rules]', disable: true, content: JSON.stringify({ format: 'dwm-rules', version: 1,
            naturalLanguage: '', script: 'when kind == "event" => maxChars 4;' }) }];
    const f = fixture({ book, modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain') return { operations: [{ type: 'create', kind: 'event', title: '过长事件',
            text: '这段新事件正文超过作者限制', intro: '事件简介', evidence: ['new'] }] };
        return { ids: [] };
    } });
    const c = await ready(f);
    f.state.messages.push(msg('new', '出现新事件'));
    await assert.rejects(c.maintain(), /超出作者长度约束/);
    assert.equal(c.view().save.processedCount, 0);
    assert.equal(Object.values(c.view().save.data.entries).some(e => e.kind === 'event'), false);
});

test('full old save scans every batch: early loss and late recovery yield current item', async () => {
    const history = [msg('early', '徽章丢失'), msg('middle', '在路上寻找'), msg('late', '徽章取回')];
    const f = fixture({ messages: history, modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain') {
            const content = request.input.messages.map(m => m.content).join(' ');
            return { operations: content.includes('取回') ? [{ type: 'inventory', items: [{ name: '徽章', description: '已取回' }] }]
                : content.includes('丢失') ? [{ type: 'inventory', items: [] }] : [] };
        }
        return { ids: [] };
    } });
    const c = await ready(f, { batchChars: 8 });
    assert.deepEqual(c.view().save.data.inventory, [{ name: '徽章', description: '已取回' }]);
    assert.equal(c.view().save.processedCount, 3);
    assert.deepEqual(f.calls.filter(x => x.purpose === 'maintain').flatMap(x => x.input.messages.map(m => m.key)), ['early', 'middle', 'late']);
});

test('failed reinitialization does not replace the last complete save', async () => {
    let fail = false;
    const f = fixture({ messages: [msg('one', '最初')], modelHandler: async request => {
        if (request.purpose === 'initialize') { if (fail) throw new Error('classification failed'); return classify(request.input); }
        if (request.purpose === 'maintain') return { operations: [] };
        return { ids: [] };
    } });
    const c = await ready(f);
    const before = c.view().save;
    fail = true;
    await assert.rejects(c.initialize(), /classification failed/);
    assert.deepEqual(c.view().save, before);
    assert.match(c.view().status, /初始化未完成/);
});

test('sending during initialization has no dynamic plan and new messages are caught up', async () => {
    const gate = deferred();
    const f = fixture({ messages: [msg('one', '第一段')], modelHandler: async request => {
        if (request.purpose === 'initialize') return gate.promise;
        if (request.purpose === 'maintain') return { operations: [] };
        return { ids: [] };
    } });
    const c = new Controller(f.host, { model: f.model, settings: { enabled: true, batchChars: 8 } });
    await c.start();
    const pending = c.initialize();
    await until(() => f.calls.some(call => call.purpose === 'initialize'));
    await c.generationBefore();
    assert.equal(f.plans.at(-1), null);
    assert.equal(f.calls.some(x => x.purpose === 'select'), false);
    f.state.messages.push(msg('two', '扫描时新消息'));
    gate.resolve(classify(f.calls.find(x => x.purpose === 'initialize').input));
    await pending;
    assert.equal(c.view().save.processedCount, 2);
    assert.deepEqual(f.calls.filter(x => x.purpose === 'maintain').flatMap(x => x.input.messages.map(m => m.key)), ['one', 'two']);
});

test('maintenance failure preserves progress and window boundary, then catches up every gap', async () => {
    let fail = false;
    const f = fixture({ messages: [msg('one', '初始')], modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain') { if (fail) throw new Error('model failed'); return { operations: [] }; }
        return { ids: [] };
    } });
    const c = await ready(f, { windowEnabled: true, recentTurns: 1 });
    fail = true;
    f.state.messages.push(msg('two', '待补一'), msg('three', '待补二'));
    await assert.rejects(c.maintain(), /model failed/);
    assert.equal(c.view().save.processedCount, 1);
    assert.equal(f.state.messages[1].hidden, false);
    assert.equal(f.state.messages[2].hidden, false);
    fail = false;
    await c.maintain();
    assert.equal(c.view().save.processedCount, 3);
    assert.equal(f.state.messages[2].hidden, false);
    assert.deepEqual(f.calls.filter(x => x.purpose === 'maintain').at(-1).input.messages.map(m => m.key), ['two', 'three']);
});

test('failed front selection requires explicit original or cancel choice', async () => {
    const f = fixture({ messages: [msg('one', '初始')], modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain') return { operations: [] };
        if (request.purpose === 'select') throw new Error('selection failed');
        return { operations: [] };
    } });
    const choices = [];
    let choice = 'original';
    const c = new Controller(f.host, { model: f.model, settings: { enabled: true }, chooseFallback: async () => { choices.push(choice); return choice; } });
    await c.start(); await c.initialize();
    await c.generationBefore();
    assert.deepEqual(choices, ['original']);
    assert.equal(f.plans.at(-1), null);
    assert.equal(f.stopped, 0);
    choice = 'cancel';
    assert.deepEqual(await c.generationBefore(), { cancel: true });
    assert.equal(f.stopped, 1);
    assert.equal(f.plans.at(-1), null);
});

test('successful selection retry clears the previous failure without accepting changed candidates', async () => {
    let changeCandidate = false;
    const f = fixture({ messages: [msg('one', '初始', 'assistant')], modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain') return { operations: [] };
        if (request.purpose === 'select') {
            if (changeCandidate) f.state.messages[0].key = 'another-candidate';
            return { ids: [] };
        }
    } });
    const failures = [];
    const c = new Controller(f.host, { model: f.model, settings: { enabled: true },
        chooseFallback: async error => { failures.push(error.message); return 'cancel'; } });
    await c.start(); await c.initialize();
    changeCandidate = true;
    assert.deepEqual(await c.generationBefore(), { cancel: true });
    assert.match(c.view().error, /剧情候选已变化/);
    assert.equal(f.plans.at(-1), null);
    changeCandidate = false;
    await c.generationBefore();
    assert.equal(failures.length, 1);
    assert.ok(f.plans.at(-1));
    assert.equal(c.view().error, '');
    assert.equal(c.view().status, '本轮资料已就绪');
});

test('a superseded native preflight cannot install a late plan or offer stale fallback', async () => {
    for (const fail of [false, true]) {
        const pending = deferred(); let current = true, selecting = false, fallback = 0;
        const f = fixture({ modelHandler: async request => {
            if (request.purpose === 'initialize') return classify(request.input);
            if (request.purpose === 'maintain') return { operations: [] };
            if (request.purpose === 'select') { selecting = true; return pending.promise; }
        } });
        const c = new Controller(f.host, { model: f.model, settings: { enabled: true },
            chooseFallback: async () => { fallback++; return 'cancel'; } });
        await c.start(); await c.initialize();
        const old = c.generationBefore({ isCurrent: () => current });
        await until(() => selecting);
        current = false;
        const newerPlan = { requestId: 'newer-native-send' };
        f.host.setPlan(newerPlan);
        if (fail) pending.reject(new Error('late model failure'));
        else pending.resolve({ ids: [] });
        await old;
        assert.deepEqual(f.plans.at(-1), newerPlan);
        assert.equal(fallback, 0); assert.equal(f.stopped, 0);
    }
});

test('native bypass keeps owned history visible through initialization and original fallback while quiet keeps the foreground plan', async () => {
    let gate = null, failSelect = false;
    const messages = [msg('u1', '旧提问'), msg('a1', '旧回答', 'assistant'), msg('u2', '近提问'), msg('a2', '近回答', 'assistant')];
    messages[1].hidden = true; messages[1].hiddenBy = 'other-extension';
    const f = fixture({ messages, modelHandler: async request => {
        if (request.purpose === 'initialize') return gate ? gate.promise : classify(request.input);
        if (request.purpose === 'maintain') return { operations: [{ type: 'summary', text: '已保存的历史脉络' }] };
        if (request.purpose === 'select') { if (failSelect) throw new Error('selector failed'); return { ids: [] }; }
        return { operations: [] };
    } });
    const c = new Controller(f.host, { model: f.model,
        settings: { enabled: true, windowEnabled: true, recentTurns: 1 }, chooseFallback: async () => 'original' });
    await c.start(); await c.initialize();
    assert.deepEqual([f.state.messages[0].hiddenBy, f.state.messages[1].hiddenBy], ['dynamic-world-memory', 'other-extension']);

    gate = deferred();
    const reinitializing = c.initialize();
    await until(() => f.calls.filter(call => call.purpose === 'initialize').length === 2);
    await c.generationBefore({ type: 'normal' });
    assert.equal(f.state.messages[0].hidden, false);
    assert.equal(f.state.messages[1].hidden, true);
    assert.equal(f.state.messages[1].hiddenBy, 'other-extension');
    assert.equal(f.calls.some(call => call.purpose === 'select'), false);
    gate.resolve(classify(f.calls.filter(call => call.purpose === 'initialize')[1].input));
    await reinitializing;
    assert.equal(f.state.messages[0].hidden, false); // Native prompt has not finished assembling.
    await c.generationEnded();
    await until(() => f.state.messages[0].hidden);
    assert.equal(f.state.messages[0].hiddenBy, 'dynamic-world-memory');

    await c.generationBefore({ type: 'quiet' });
    assert.equal(f.state.messages[0].hidden, true);
    assert.equal(f.state.messages[1].hiddenBy, 'other-extension');
    assert.equal(f.calls.some(call => call.purpose === 'select'), false);
    await c.generationEnded();
    await until(() => f.state.messages[0].hidden);

    failSelect = true;
    await c.generationBefore({ type: 'normal' });
    assert.equal(f.state.messages[0].hidden, false);
    assert.equal(f.state.messages[1].hidden, true);
    assert.equal(f.state.messages[1].hiddenBy, 'other-extension');
    assert.equal(f.plans.at(-1), null);
    assert.equal(f.stopped, 0);
    assert.equal(f.windowActions.flat().filter(action => action.hidden === false && action.index === 0).length, 2);
    assert.equal(f.windowActions.flat().some(action => action.index === 1), false);
});

test('agent inputs exclude audit and journal; locked body is absent from post agents', async () => {
    const book = [
        { uid: 1, comment: '秘密规则', content: 'LOCKED_BODY_SENTINEL', constant: true, disable: false },
        { uid: 2, comment: '现状', content: '公开状态', constant: false, disable: false },
        { uid: 3, comment: '[DWM Rules]', content: JSON.stringify({ format: 'dwm-rules', version: 1, naturalLanguage: '规则不可改', script: 'when title == "秘密规则" => lock;' }), disable: true },
    ];
    const f = fixture({ book, messages: [msg('one', '初始')] });
    const c = await ready(f);
    await c.previewPlan();
    await c.compact();
    for (const call of f.calls) {
        const serialized = JSON.stringify(call.input);
        assert.doesNotMatch(serialized, /"audit"|"journal"/);
        if (call.purpose === 'maintain' || call.purpose === 'compact') assert.doesNotMatch(serialized, /LOCKED_BODY_SENTINEL/);
    }
    assert.equal(f.calls.filter(x => x.purpose === 'initialize').length, 1);
    assert.equal(c.view().save.data.entries['source:main:1'].segments[0].writable, false);
});

test('compaction racing with new maintenance cannot erase newer summary', async () => {
    const gate = deferred();
    const f = fixture({ messages: [msg('one', '初始')], modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain') return { operations: [{ type: 'summary', text: request.input.messages.at(-1).content }] };
        if (request.purpose === 'compact') return gate.promise;
        return { ids: [] };
    } });
    const c = await ready(f);
    const compacting = c.compact();
    await Promise.resolve();
    f.state.messages.push(msg('two', '新约定'));
    await c.maintain();
    gate.resolve({ operations: [{ type: 'summary', text: '过时整理' }] });
    await compacting;
    assert.equal(c.view().save.data.summary, '新约定');
    assert.equal(c.view().save.processedCount, 2);
});

test('inventory off stops maintenance, preserves data, and reenable replays disabled interval', async () => {
    const f = fixture({ messages: [msg('one', '获得徽章')], modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain') {
            const content = request.input.messages.map(m => m.content).join(' ');
            if (!request.input.memory.inventory) return { operations: [] };
            if (content.includes('交出')) return { operations: [{ type: 'inventory', items: [] }] };
            if (content.includes('获得')) return { operations: [{ type: 'inventory', items: [{ name: '徽章', description: '持有' }] }] };
            return { operations: [] };
        }
        return { ids: [] };
    } });
    const c = await ready(f);
    assert.equal(c.view().save.data.inventory.length, 1);
    await c.manual({ type: 'inventory-toggle', enabled: false });
    f.state.messages.push(msg('two', '交出徽章'));
    await c.maintain();
    assert.equal(c.view().save.data.inventory.length, 1);
    await c.manual({ type: 'inventory-toggle', enabled: true });
    assert.deepEqual(c.view().save.data.inventory, []);
});

test('old initialization and maintenance cannot publish into a newly selected chat', async () => {
    const initGate = deferred();
    const f = fixture({ messages: [msg('one', '旧聊天')], modelHandler: async request => {
        if (request.purpose === 'initialize') return initGate.promise;
        return { operations: [] };
    } });
    const c = new Controller(f.host, { model: f.model, settings: { enabled: true } });
    await c.start();
    const oldInit = c.initialize();
    await until(() => f.calls.some(call => call.purpose === 'initialize'));
    f.state.chatId = 'chat-2'; f.state.messages = [msg('new', '新聊天')];
    await c.chatChanged();
    initGate.resolve(classify(f.calls.find(call => call.purpose === 'initialize').input));
    await assert.rejects(oldInit, /作废|切换|取消/);
    assert.equal(c.store.state.chatId, 'chat-2');
    assert.equal(c.view().save.initialized, false);

    // A separate completed save provides a maintenance task to race with a
    // second switch; the stale result must not change the new controller view.
    const maintainGate = deferred();
    const g = fixture({ messages: [msg('base', '起点')], modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain' && request.input.messages.some(item => item.key === 'late')) return maintainGate.promise;
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } });
    const m = await ready(g);
    g.state.messages.push(msg('late', '旧分支新增'));
    const oldMaintain = m.maintain();
    await until(() => g.calls.some(call => call.purpose === 'maintain' && call.input.messages.some(item => item.key === 'late')));
    g.state.chatId = 'chat-3'; g.state.messages = [msg('fresh', '新分支')];
    await m.chatChanged();
    maintainGate.resolve({ operations: [{ type: 'summary', text: '旧分支结果' }] });
    await assert.rejects(oldMaintain, /作废|切换|取消/);
    assert.equal(m.store.state.chatId, 'chat-3');
    assert.equal(m.view().save.initialized, false);
    assert.notEqual(m.view().save.data.summary, '旧分支结果');
});

test('cancelled initialization can restart while its stale finally remains pending', async () => {
    const first = deferred(), second = deferred();
    let serial = 0;
    const f = fixture({ modelHandler: async request => {
        if (request.purpose === 'initialize') return (++serial === 1 ? first : second).promise;
        return { operations: [] };
    } });
    const c = new Controller(f.host, { model: f.model, settings: { enabled: true } });
    await c.start();
    const stale = c.initialize();
    stale.catch(() => {}); // Cancellation now rejects promptly, before a late model response.
    await until(() => serial === 1);
    c.cancel();
    const current = c.initialize();
    await until(() => serial === 2);
    first.resolve(classify(f.calls.filter(call => call.purpose === 'initialize')[0].input));
    await assert.rejects(stale, /作废|切换|取消/);
    await assert.rejects(c.initialize(), /已有处理/);
    second.resolve(classify(f.calls.filter(call => call.purpose === 'initialize')[1].input));
    await current;
    assert.equal(c.view().save.initialized, true);
    assert.equal(c.view().status, '存档扫描已完成，记忆已启用');
});

test('raw AgentClient keeps active maintenance while selecting a stable committed snapshot', async () => {
    const gate = deferred();
    const f = fixture({ messages: [msg('base', '起点')] });
    const rawCalls = [];
    f.host.rawGenerate = async request => {
        const input = JSON.parse(request.input);
        rawCalls.push({ purpose: request.purpose, input });
        if (request.purpose === 'initialize') return JSON.stringify(classify(input));
        if (request.purpose === 'maintain' && input.messages.some(item => item.key === 'later')) return gate.promise;
        if (request.purpose === 'maintain') return JSON.stringify({ operations: [] });
        return JSON.stringify({ ids: [] });
    };
    const c = new Controller(f.host, { settings: { enabled: true, timeoutMs: 5000 } });
    await c.start(); await c.initialize();
    f.state.messages.push(msg('later', '后续事件'));
    const maintaining = c.maintain();
    await until(() => rawCalls.some(call => call.purpose === 'maintain' && call.input.messages.some(item => item.key === 'later')));
    const before = c.generationBefore({ type: 'normal' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rawCalls.some(call => call.purpose === 'select'), true);
    gate.resolve(JSON.stringify({ operations: [{ type: 'summary', text: '维护后的脉络' }] }));
    await maintaining; await before;
    assert.equal(rawCalls.find(call => call.purpose === 'select').input.summary, '');
    assert.equal(f.plans.at(-1).summary, '');
    assert.equal(c.view().save.processedCount, 2);
    assert.equal(c.store.state.data.summary, '维护后的脉络');
});

test('preflight waiting on old maintenance cancels when the chat changes before selection', async () => {
    const gate = deferred();
    const f = fixture({ messages: [msg('base', '旧聊天起点')], modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain' && request.input.messages.some(item => item.key === 'late')) return gate.promise;
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } });
    const c = await ready(f);
    f.state.messages.push(msg('late', '旧聊天后续'));
    const oldMaintenance = c.maintain();
    const cancelled = assert.rejects(oldMaintenance, /取消|切换/);
    await until(() => f.calls.some(call => call.purpose === 'maintain' && call.input.messages.some(item => item.key === 'late')));
    const oldPreflight = c.generationBefore({ type: 'normal' });
    f.state.chatId = 'chat-2'; f.state.messages = [msg('new', '新聊天起点')];
    await c.chatChanged();
    await c.initialize(); // Make the new chat ready, so stale preflight could otherwise select for it.
    const newChatId = c.store.state.chatId;
    gate.resolve({ operations: [{ type: 'summary', text: '旧聊天脉络' }] });
    await cancelled;
    assert.deepEqual(await oldPreflight, { cancel: true });
    assert.equal(c.store.state.chatId, newChatId);
    assert.equal(c.store.state.chatId, 'chat-2');
    assert.equal(f.calls.some(call => call.purpose === 'select'), false);
    assert.equal(f.plans.some(Boolean), false);
});

test('new author lock after initialization blocks a malicious post update and hides its body', async () => {
    const book = [{ uid: 1, comment: '秘密规则', content: 'LOCKED_BODY_SENTINEL', constant: true, disable: false }];
    const f = fixture({ book, messages: [msg('one', '起点')], modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain' && request.input.messages.some(item => item.key === 'two')) return { operations: [{
            type: 'update', id: 'source:main:1', expectedVersion: 1, evidence: ['two'],
            segments: [{ id: 'body', text: '恶意改写' }],
        }] };
        return request.purpose === 'select' ? { ids: [] } : { operations: [] };
    } });
    const c = await ready(f);
    const before = c.view().save.data.entries['source:main:1'];
    assert.equal(before.segments[0].writable, true);
    book.push({ uid: 2, comment: '[DWM Rules]', content: JSON.stringify({ format: 'dwm-rules', version: 1,
        naturalLanguage: '', script: 'when title == "秘密规则" => lock;' }), disable: true });
    f.state.messages.push(msg('two', '试图修改'));
    await assert.rejects(c.maintain(), /锁定|保护|读写/);
    const postInput = f.calls.filter(call => call.purpose === 'maintain').at(-1).input;
    assert.doesNotMatch(JSON.stringify(postInput), /LOCKED_BODY_SENTINEL/);
    assert.equal(c.view().save.data.entries['source:main:1'].segments[0].text, 'LOCKED_BODY_SENTINEL');
    assert.equal(c.view().save.processedCount, 1);
});

test('editing ordinary text under the same message key does not trigger retroactive maintenance', async () => {
    const f = fixture({ messages: [msg('stable', '最初正文')] });
    const c = await ready(f);
    const callsBefore = f.calls.filter(call => call.purpose === 'maintain').length;
    f.state.messages[0].content = '后来直接编辑的正文';
    await c.maintain();
    assert.equal(f.calls.filter(call => call.purpose === 'maintain').length, callsBefore);
    assert.equal(c.view().save.processedCount, 1);
});

test('failed inventory catch-up cannot inject stale inventory after reenable', async () => {
    let failCatchup = false;
    const f = fixture({ messages: [msg('one', '获得徽章')], modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain') {
            if (failCatchup) throw new Error('补记失败');
            if (!request.input.memory.inventory) return { operations: [] };
            return { operations: [{ type: 'inventory', items: [{ name: '徽章', description: '持有' }] }] };
        }
        return { ids: [] };
    } });
    const c = await ready(f);
    await c.manual({ type: 'inventory-toggle', enabled: false });
    f.state.messages.push(msg('two', '交出徽章'));
    await c.maintain();
    failCatchup = true;
    await assert.rejects(c.manual({ type: 'inventory-toggle', enabled: true }), /补记失败/);
    assert.equal(c.view().save.inventoryNeedsCatchUp, true);
    assert.equal(c.view().save.data.inventory.length, 1);
    assert.equal((await c.previewPlan()).inventory, '');
});

test('preflight uses uncommitted raw text while retained maintenance completes afterward', async () => {
    const gate = deferred();
    const f = fixture({ messages: [msg('base', '起点')], modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain' && request.input.messages[0].key === 'one') return gate.promise;
        if (request.purpose === 'maintain') return { operations: [] };
        return { ids: [] };
    } });
    const c = await ready(f, { batchChars: 5, windowEnabled: true, recentTurns: 1 });
    f.state.messages.push(msg('one', '第一批长正文'), msg('two', '第二批长正文'), msg('three', '第三批长正文'));
    const work = c.maintain();
    await until(() => f.calls.some(call => call.purpose === 'maintain' && call.input.messages[0].key === 'one'));
    const sending = c.generationBefore({ type: 'normal' });
    await sending;
    assert.equal(c.view().save.processedCount, 1);
    assert.equal(c.view().diagnostics.pendingCount, 3);
    assert.equal(f.calls.some(call => call.purpose === 'maintain' && call.input.messages[0].key === 'two'), false);
    const selection = f.calls.findLast(call => call.purpose === 'select');
    assert.deepEqual(selection.input.messages.map(m => m.key), ['one', 'two', 'three']);
    assert.equal(selection.input.summary, '');
    assert.equal(f.state.messages[2].hidden, false);
    gate.resolve({ operations: [{ type: 'summary', text: '第一批已记住' }] });
    await work;
    assert.equal(c.view().save.processedCount, 4);
});

test('observability separates paid preview from actual plan without exposing metrics to agents', async () => {
    const f = fixture({ messages: [msg('base', '初始')] });
    const c = await ready(f);
    await c.previewPlan();
    assert.equal(c.view().diagnostics.lastPlan, null);
    assert.equal(c.view().diagnostics.lastPreview.mode, 'preview');
    await c.generationBefore();
    const request = c.view().diagnostics.lastPlan;
    assert.equal(request.mode, 'send');
    c.recordObservation({ requestId: 'other', observedIds: ['wrong'], status: 'wrong' });
    assert.equal(c.view().diagnostics.lastPlan.observedIds, undefined);
    c.recordObservation({ requestId: request.requestId, observedIds: [], status: '原生条目未激活' });
    await c.previewPlan();
    assert.equal(c.view().diagnostics.lastPlan.status, '原生条目未激活');
    const metrics = c.view().diagnostics.requests;
    assert.ok(metrics.every(m => m.inputChars > 0 && m.durationMs >= 0 && m.ok));
    assert.equal(metrics.some(m => 'input' in m || 'system' in m), false);
    assert.equal(f.calls.some(call => /diagnostics|lastPlan|lastPreview/.test(JSON.stringify(call.input))), false);
});

test('MVU cooperates only with matching current narrative, never historical initialization or another book', async () => {
    const f = fixture({ messages: [msg('base', '起点', 'assistant')] });
    let reads = 0;
    f.host.readMvu = async () => { reads++; return { enabled: true, available: true, status: 'ready',
        fields: [{ path: 'stat_data.地点', label: '地点', value: '河岸' }],
        freshness: { chatId: f.state.chatId, messageKey: f.state.messages.at(-1).key, persistence: 'unverified' } }; };
    const c = await ready(f, { mvuEnabled: true, mvuBookName: 'main', mvuFields: [{ path: '地点', label: '地点' }], batchChars: 5 });
    assert.equal(f.calls.filter(call => call.purpose === 'maintain').some(call => call.input.observedState), false);
    f.state.messages.push(msg('older', '较早一段长正文', 'assistant'), msg('latest', '最新一段长正文', 'assistant'));
    await c.maintain();
    const post = f.calls.filter(call => call.purpose === 'maintain');
    assert.equal(post.find(call => call.input.messages[0].key === 'older').input.observedState, undefined);
    assert.equal(post.find(call => call.input.messages[0].key === 'latest').input.observedState.messageKey, 'latest');
    await c.generationBefore();
    assert.equal(f.calls.findLast(call => call.purpose === 'select').input.observedState.fields[0].value, '河岸');
    assert.equal(c.view().diagnostics.lastPlan.mvu.messageKey, 'latest');
    assert.doesNotMatch(JSON.stringify(c.store.state), /stat_data|MVU read-only observation/);
    f.state.bookName = 'other';
    const before = reads;
    await c.refreshMvu();
    assert.equal(c.view().mvu.status, 'unconfigured');
    assert.equal(reads, before);
});

test('unavailable optional MVU never makes preflight fail', async () => {
    const f = fixture();
    f.host.readMvu = async () => { throw new Error('unavailable'); };
    const c = await ready(f, { mvuEnabled: true, mvuBookName: 'main' });
    await c.generationBefore();
    assert.ok(f.plans.at(-1));
    assert.equal(c.view().mvu.status, 'unavailable');
    assert.equal(f.calls.findLast(call => call.purpose === 'select').input.observedState, undefined);
});

test('manual editing rejects a stale draft version instead of replacing a newer entry', async () => {
    const f = fixture(); const c = await ready(f);
    const id = 'source:main:1';
    await c.manual({ type: 'edit', id, expectedVersion: 1, intro: '先保存的版本' });
    await assert.rejects(c.manual({ type: 'edit', id, expectedVersion: 1, intro: '过期草稿' }), /条目已更新/);
    assert.equal(c.store.state.data.entries[id].intro, '先保存的版本');
});

test('turning MVU off while a read is pending revokes that result before model selection', async () => {
    const f = fixture({ messages: [msg('base', '起点', 'assistant')] });
    const c = await ready(f, { mvuEnabled: false, mvuBookName: 'main', mvuFields: [{ path: '地点', label: '地点' }] });
    const gate = deferred(); let reading = false;
    f.host.readMvu = async () => { reading = true; return gate.promise; };
    // Simulate the already-persisted enabled setting without an extra eager read.
    c.settings = { ...c.settings, mvuEnabled: true };
    const pending = c.previewPlan();
    await until(() => reading);
    await c.updateSettings({ mvuEnabled: false });
    gate.resolve({ enabled: true, available: true, status: 'ready', fields: [{ path: 'stat_data.地点', label: '地点', value: '撤销后的敏感值' }], freshness: { chatId: f.state.chatId, messageKey: 'base' } });
    await pending;
    assert.equal(c.view().mvu.status, 'disabled');
    assert.equal(f.calls.findLast(call => call.purpose === 'select').input.observedState, undefined);
});

test('size-driven compaction retries after short failure cooldown instead of treating failure as completion', async () => {
    let compactions = 0;
    const f = fixture({ modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'maintain') return { operations: [{ type: 'summary', text: '阶段脉络'.repeat(300) }] };
        if (request.purpose === 'compact') { compactions++; if (compactions === 1) throw new Error('temporary compact failure'); return { operations: [] }; }
        return { ids: [] };
    } });
    const c = await ready(f, { compactChars: 1000, compactEvery: 20 });
    for (let i = 1; i <= 4; i++) {
        f.state.messages.push(msg(`step-${i}`, '推进', 'assistant'));
        c.messageReceived({ type: 'normal' });
        await until(() => c.view().save.processedCount === i);
        // Let the scheduled compaction continuation complete before the next turn.
        await new Promise(resolve => setImmediate(resolve));
        if (i < 4) assert.equal(compactions, 1);
    }
    await until(() => compactions === 2);
});

test('disabling dynamic memory during selection cannot install a late plan', async () => {
    const gate = deferred(); let selecting = false;
    const f = fixture({ modelHandler: async request => {
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'select') { selecting = true; return gate.promise; }
        return { operations: [] };
    } });
    const c = await ready(f);
    const sending = c.generationBefore(); await until(() => selecting);
    await c.updateSettings({ enabled: false }); gate.resolve({ ids: [] }); await sending;
    assert.equal(f.plans.some(Boolean), false);
});
