// Discord feedback batch 2026-10-14: FM-001/002/003/004/016/018/019.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';
import { memoryRewriteLength, MEMORY_REWRITE_MAX_TOKENS } from '../src/agents/client.js';
import { maintainRequest, WORLDBOOK_ONLY_NOTE } from '../src/agents/requests.js';
import { createEntry, createSave, entryText } from '../src/core/state.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await tick(); };
const msg = (key, role = 'assistant', content = `${role} ${key}`) => ({ key, role, content, hidden: false, hiddenBy: null });
const classify = input => ({ strategy: 's', entries: input.entries.map(entry => ({ id: entry.id, kind: 'fact', intro: `简介${entry.title}`, retrieveWhen: '相关时',
    segments: [{ id: 'body', writable: !entry.title.includes('锁') }] })) });
function fixture({ book, settings = {}, handler } = {}) {
    const state = { chatId: 'c', bookName: 'main', templateEnabled: true, generating: false, messages: [msg('m0')] };
    const db = new Map(), calls = [];
    const host = { snapshot: () => structuredClone(state), generationSnapshot: () => structuredClone(state), loadWorldbook: async () => structuredClone(book),
        storage: { read: async id => structuredClone(db.get(id) ?? null), write: async (id, v) => db.set(id, structuredClone(v)) },
        clearPlan() {}, setPlan() {}, applyWindow: async () => {} };
    const model = { complete: async request => {
        calls.push(structuredClone({ purpose: request.purpose, input: request.input }));
        const handled = await handler?.(request);
        if (handled !== undefined) return handled;
        if (request.purpose === 'initialize') return classify(request.input);
        if (request.purpose === 'select') return { ids: [] };
        return { operations: [] };
    } };
    const controller = new Controller(host, { model, settings: { enabled: true, maintenanceEvery: 1, ...settings } });
    return { state, db, calls, host, controller };
}

test('FM-019: Prompt Template readiness tolerates zip folder names and explains the actual blocker', async () => {
    const original = globalThis.EjsTemplate;
    const status = async ({ names, disabled = false, api }) => {
        if (api === undefined) delete globalThis.EjsTemplate; else globalThis.EjsTemplate = api;
        const host = await createSillyTavernHost({ context: { chatId: 'x', characterId: 0, characters: [{ avatar: 'a.png', data: { extensions: { world: 'main' } } }], chat: [], chatMetadata: {} },
            eventSource: { on() {}, removeListener() {} }, eventTypes: {}, worldInfo: { loadWorldInfo: async () => ({ entries: {} }) }, script: { setExtensionPrompt() {} },
            extensions: { extensionNames: names, findExtension: name => names.includes(name) || names.includes(`third-party/${name}`) ? { name, enabled: !disabled } : null } });
        return host.snapshot();
    };
    try {
        const ready = { getFeatures: () => ({ enabled: true }) };
        assert.equal((await status({ names: ['third-party/ST-Prompt-Template-main'], api: ready })).templateStatus, 'ready');
        assert.equal((await status({ names: ['third-party/ST-Prompt-Template-main'], api: ready })).templateEnabled, true);
        assert.equal((await status({ names: ['third-party/ST-Prompt-Template'], api: { getFeatures: () => ({ enabled: false }) } })).templateStatus, 'switch-off');
        assert.equal((await status({ names: ['third-party/ST-Prompt-Template'], disabled: true, api: ready })).templateStatus, 'disabled');
        assert.equal((await status({ names: ['third-party/ST-Prompt-Template'] })).templateStatus, 'not-loaded');
        assert.equal((await status({ names: [] })).templateStatus, 'missing');
    } finally { if (original === undefined) delete globalThis.EjsTemplate; else globalThis.EjsTemplate = original; }
});

test('FM-001: the separate connection, key included, is saved and restored', async () => {
    let stored = null;
    const store = { load: () => structuredClone(stored), save: value => { stored = structuredClone(value); } };
    const host = { snapshot: () => ({ chatId: null, messages: [] }), rawGenerate: async () => '{}' };
    const first = new Controller(host, { connectionStore: store });
    await first.updateConnection({ mode: 'compatible', endpoint: 'https://aux.example/v1/', model: 'cheap', apiKey: 'secret' });
    assert.deepEqual(stored, { mode: 'compatible', endpoint: 'https://aux.example/v1', model: 'cheap', apiKey: 'secret' });
    const reloaded = new Controller(host, { connectionStore: store });
    assert.equal(reloaded.connectionMode, 'compatible');
    assert.deepEqual(reloaded.view().connection, { mode: 'compatible', endpoint: 'https://aux.example/v1', model: 'cheap', hasApiKey: true });
    assert.doesNotMatch(JSON.stringify(reloaded.view()), /secret/, 'the key never appears in views or exports');
    await reloaded.updateConnection({ mode: 'raw' });
    assert.equal(stored, null);
    stored = { mode: 'compatible', endpoint: 'not a url', model: 'x' };
    assert.equal(new Controller(host, { connectionStore: store }).connectionMode, 'raw', 'an unusable stored value falls back to ST');
});

test('FM-016: maintenance output budget follows the summary and largest segments', () => {
    assert.equal(memoryRewriteLength({ summary: '', entries: [] }), 8192);
    const long = memoryRewriteLength({ summary: '脉'.repeat(12000), entries: [{ segments: [{ text: '段'.repeat(2000) }] }] });
    assert.ok(long >= 2048 + 14000 * 1.3 && long <= MEMORY_REWRITE_MAX_TOKENS, String(long));
    assert.equal(memoryRewriteLength({ summary: '脉'.repeat(40000), entries: [] }), MEMORY_REWRITE_MAX_TOKENS);
});

test('FM-016: a long summary schedules compaction', async () => {
    const f = fixture({ book: [{ uid: 1, comment: '城', content: '现代' }], handler: request => request.purpose === 'maintain'
        ? { operations: [{ type: 'summary', text: '脉'.repeat(9000) }] } : undefined });
    await f.controller.start(); await f.controller.initialize();
    f.state.messages.push(msg('u1', 'user'), msg('a1'));
    f.controller.messageReceived({ type: 'normal' }); await settle(80);
    assert.ok(f.calls.some(call => call.purpose === 'compact'), 'summary over 8000 characters triggers compaction');
});

test('FM-004: worldbook-only mode keeps entries and selection but no summary, events, inventory or trimming', async () => {
    const save = createSave('w', 'main'); save.initialized = true;
    save.data.summary = '旧脉络'; save.data.inventoryEnabled = true; save.data.inventory = [{ name: '钥匙', description: '铜' }];
    save.data.entries.city = createEntry({ id: 'city', kind: 'fact', title: '城', text: '城门开着' });
    const view = structuredClone(save); view.worldbookOnly = true; view.data.summary = ''; view.data.inventoryEnabled = false;
    const request = maintainRequest(view, [msg('m1')]);
    assert.match(request.system, new RegExp(WORLDBOOK_ONLY_NOTE.slice(0, 12)));
    assert.equal(request.input.memory.summary, ''); assert.equal(request.input.memory.inventory, undefined);

    const f = fixture({ book: [{ uid: 1, comment: '城', content: '城门开着' }], settings: { memoryMode: 'worldbook' }, handler: request => request.purpose === 'maintain'
        ? { operations: [{ type: 'summary', text: '不该保存' }, { type: 'create', kind: 'event', title: '事件', text: '不该保存', intro: 'x', retrieveWhen: 'x', evidence: [request.input.messages[0].key] },
            { type: 'update', id: request.input.memory.entries[0].id, expectedVersion: request.input.memory.entries[0].version, evidence: [request.input.messages[0].key], segments: [{ id: 'body', text: '城门关了' }] }] } : undefined });
    await f.controller.start(); await f.controller.initialize();
    f.state.messages.push(msg('u1', 'user'), msg('a1'));
    await f.controller.maintain();
    const data = f.controller.store.state.data;
    assert.equal(entryText(data.entries['source:main:1']), '城门关了');
    assert.equal(data.summary, '');
    assert.equal(Object.values(data.entries).some(entry => entry.kind === 'event'), false);
    assert.equal((await f.controller.compact()).executed, false);
    const plan = await f.controller.previewPlan();
    assert.equal(plan.summary, ''); assert.equal(plan.inventory, '');
});

test('FM-018: worldbook batches run concurrently and checkpoint in order', async () => {
    let active = 0, peak = 0;
    const book = Array.from({ length: 6 }, (_, i) => ({ uid: i + 1, comment: `条目${i + 1}`, content: `内容${i + 1}` }));
    const f = fixture({ book, settings: { batchChars: 1, scanConcurrency: 3 }, handler: async request => {
        if (request.purpose !== 'initialize') return undefined;
        active++; peak = Math.max(peak, active); await settle(3 + Number(request.input.entries[0].id.at(-1)) % 3); active--;
        return classify(request.input);
    } });
    await f.controller.start(); await f.controller.initialize();
    assert.ok(peak >= 2 && peak <= 3, `peak concurrency ${peak}`);
    assert.deepEqual(Object.keys(f.controller.store.state.base.entries).filter(id => id.startsWith('source:')), book.map(entry => `source:main:${entry.uid}`));
});

test('FM-002: only changed source entries are synced; story-changed ones are merged without protected text', async () => {
    const book = [
        { uid: 1, comment: '原样', content: '旧A' },
        { uid: 2, comment: '剧情改过', content: '旧B' },
        { uid: 3, comment: '将删除', content: '旧D' },
        { uid: 4, comment: '只改键', content: 'E', key: ['a'] },
        { uid: 5, comment: '锁定条目', content: '机密原文' },
    ];
    let merged;
    const f = fixture({ book, handler: request => {
        if (request.purpose === 'maintain' && request.input.messages.some(m => m.key === 'a1')) {
            const target = request.input.memory.entries.find(entry => entry.title === '剧情改过');
            return { operations: [{ type: 'update', id: target.id, expectedVersion: target.version, evidence: ['a1'], segments: [{ id: 'body', text: '旧B，后来被烧毁' }] }] };
        }
        if (request.purpose === 'sourceMerge') {
            merged = request.input;
            return { entries: request.input.entries.map(entry => ({ id: entry.id, segments: [{ id: 'body', text: '新B，后来被烧毁' }] })) };
        }
    } });
    await f.controller.start(); await f.controller.initialize();
    f.state.messages.push(msg('u1', 'user'), msg('a1')); await f.controller.maintain();
    f.state.messages.push(msg('u2', 'user'), msg('a2')); await f.controller.maintain();
    book[0].content = '新A'; book[1].content = '新B'; book.splice(2, 1); book[2].key = ['b'];
    book[3].content = '机密原文v2';
    book.push({ uid: 6, comment: '新增', content: '新F' });
    await f.controller.previewPrompts().catch(() => {});
    await f.controller.chatChanged();
    assert.equal(f.controller.view().sourceChanges.changed, true);
    const before = f.calls.length;
    await f.controller.syncSourceChanges();
    const entries = f.controller.store.state.data.entries;
    assert.equal(entryText(entries['source:main:1']), '新A', 'untouched entry takes the new source');
    assert.equal(entryText(entries['source:main:2']), '新B，后来被烧毁', 'story-changed entry is merged');
    assert.equal(entries['source:main:3'], undefined, 'removed from the book');
    assert.deepEqual(entries['source:main:4'].source.metadata.key, ['b'], 'metadata-only change');
    assert.equal(entryText(entries['source:main:6']), '新F', 'new entry classified');
    assert.equal(entryText(entries['source:main:5']), '机密原文v2', 'locked entry takes the new source');
    assert.deepEqual(merged.entries.map(entry => entry.id), ['source:main:2']);
    assert.deepEqual(merged.entries[0], { id: 'source:main:2', title: '剧情改过', oldSource: '旧B', current: '旧B，后来被烧毁',
        newSource: [{ id: 'body', writable: true, text: '新B' }] });
    // Classification of a changed source necessarily reads it (as initialization does); the merge never sees protected text.
    assert.doesNotMatch(JSON.stringify(f.calls.slice(before).filter(call => call.purpose === 'sourceMerge')), /机密原文/);
    const classified = f.calls.slice(before).filter(call => call.purpose === 'initialize').flatMap(call => call.input.entries.map(entry => entry.id));
    assert.deepEqual(classified.sort(), ['source:main:1', 'source:main:2', 'source:main:5', 'source:main:6'], 'only changed text is reclassified');
    assert.equal(f.controller.view().sourceChanges.changed, false);
    // Rolling back to a path that keeps the old story edit but not the sync brings the old source back: sync is requested again.
    f.state.messages = [msg('m0'), msg('u1', 'user'), msg('a1'), msg('u2', 'user'), msg('a2-alt')];
    await f.controller.chatChanged();
    assert.equal(entryText(f.controller.store.state.data.entries['source:main:2']), '旧B，后来被烧毁');
    assert.equal(f.controller.view().sourceChanges.changed, true);
    // Rolling back before any story edit leaves the new source in place: nothing to sync.
    f.state.messages = [msg('m0')];
    await f.controller.chatChanged();
    assert.equal(entryText(f.controller.store.state.data.entries['source:main:2']), '新B');
    assert.equal(f.controller.view().sourceChanges.changed, false);
});
