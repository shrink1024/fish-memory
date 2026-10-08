// Synthetic, in-memory audit only. No network, user chats, or runtime files are changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Controller } from '../src/runtime/controller.js';
import { MemoryStore } from '../src/core/store.js';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';

async function windowScenario({ enabled, changedBranch }) {
    let saved;
    const storage = { read: async () => structuredClone(saved), write: async (_id, value) => { saved = structuredClone(value); } };
    const seed = new MemoryStore(storage);
    await seed.load('ordinary-chat', 'ordinary-book');
    await seed.initialize([], 'remember');
    const previousKeys = ['a', 'b', 'c', 'old-tail'];
    await seed.commit({ operations: [{ type: 'summary', text: 'Synthetic previously remembered history.' }] }, {
        expectedRevision: seed.state.revision, sourceKeys: previousKeys, allowedEvidence: previousKeys,
    });
    const keys = changedBranch ? ['a', 'b', 'c', 'new-tail'] : previousKeys;
    const state = { chatId: 'ordinary-chat', bookName: 'ordinary-book', templateEnabled: true,
        messages: keys.map((key, index) => ({ key, content: key, role: index % 2 ? 'assistant' : 'user',
            hidden: index < 2, hiddenBy: index < 2 ? 'dynamic-world-memory' : null })) };
    const actions = [], plans = [];
    const host = { snapshot: () => structuredClone(state), storage, loadWorldbook: async () => [], clearPlan() {},
        setPlan: plan => plans.push(structuredClone(plan)), applyWindow: async list => {
            actions.push(...list);
            for (const action of list) Object.assign(state.messages[action.index], { hidden: action.hidden, hiddenBy: action.hiddenBy });
        } };
    const controller = new Controller(host, { model: { complete: async () => ({ ids: [] }) },
        settings: { enabled, windowEnabled: true, recentTurns: 1 } });
    await controller.start();
    await controller.generationBefore({ type: 'normal' });
    assert.ok(actions.some(action => !action.hidden), 'restore uncovered original history');
    assert.deepEqual(state.messages.filter(message => message.hidden).map(message => message.key), []);
    if (enabled) {
        assert.deepEqual(controller.store.state.processed, []);
        assert.equal(plans[0].summary, '');
    } else assert.equal(plans.length, 0);
    return { scenario: enabled ? 'Loaded branch loses summary coverage but retains hidden raw text' : 'Global off on another chat; old hidden chat sends without memory or raw history',
        processed: controller.store.state.processed, outgoingSummary: plans[0]?.summary ?? null,
        dynamicPlanCount: plans.length, hiddenKeys: state.messages.filter(message => message.hidden).map(message => message.key), windowActions: actions };
}


for (const enabled of [false, true]) test(`load restores legacy hides: ${enabled ? 'branch rollback' : 'globally disabled'}`, () => windowScenario({ enabled, changedBranch: enabled }));

test('native window omits outgoing copies only; clearing a plan or reloading leaves saved text visible', async () => {
    const live = { chatId: 'window', characterId: 0, characters: [{ avatar: 'ordinary.png', data: { extensions: { world: 'book' } } }],
        chatMetadata: {}, chat: [
            { mes: 'remembered', is_user: true, is_system: false, extra: { dwmKey: 'first' } },
            { mes: 'external', is_user: false, is_system: true, extra: {} },
            { mes: 'recent', is_user: true, is_system: false, extra: { dwmKey: 'recent' } },
        ] };
    let saves = 0;
    const deps = { context: () => live, script: { setExtensionPrompt() {} }, extensions: {}, worldInfo: {}, save: async () => { saves++; } };
    const host = await createSillyTavernHost(deps);
    const first = host.snapshot().messages[0];
    await host.applyWindow([{ ...first, hidden: true }]);
    assert.equal(live.chat[0].is_system, false, 'never persist new hidden state');
    assert.equal(live.chat[0].extra.dwmHidden, undefined);
    assert.equal(saves, 0);
    host.setPlan({ chatId: host.snapshot().chatId, bookName: 'book', summary: 'covers first' });
    const outgoing = live.chat.filter(m => !m.is_system).map(m => ({ ...m }));
    host.filterOutgoingHistory(outgoing, null, null, 'normal');
    assert.deepEqual(outgoing.map(m => m.mes), ['recent']);
    host.clearPlan();
    const next = live.chat.filter(m => !m.is_system).map(m => ({ ...m }));
    host.filterOutgoingHistory(next, null, null, 'normal');
    assert.deepEqual(next.map(m => m.mes), ['remembered', 'recent']);
    const reloaded = await createSillyTavernHost(deps);
    assert.equal(reloaded.snapshot().messages[0].hidden, false);
    assert.equal(live.chat[1].is_system, true);
});

test('failed legacy recovery preserves concurrent external extra fields', async () => {
    const msg = { mes: 'old', is_system: true, extra: { external: 'before', dwmHidden: { owner: 'dynamic-world-memory' } },
        swipe_info: [{ extra: { external: 'before', dwmHidden: { owner: 'dynamic-world-memory' } } }] };
    const live = { chatId: 'legacy', chat: [msg] };
    const host = await createSillyTavernHost({ context: () => live, script: {}, worldInfo: {}, extensions: {}, save: async () => {
        msg.extra.external = 'after'; msg.swipe_info[0].extra.external = 'after'; throw new Error('save failed');
    } });
    await assert.rejects(host.restoreLegacyWindow(), /save failed/);
    assert.equal(msg.extra.external, 'after'); assert.equal(msg.swipe_info[0].extra.external, 'after');
    assert.equal(msg.is_system, true); assert.equal(msg.extra.dwmHidden.owner, 'dynamic-world-memory');
});
