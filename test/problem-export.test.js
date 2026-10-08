import test from 'node:test';
import assert from 'node:assert/strict';
import { createProblemExporter } from '../src/diagnostics/problem-export.js';
import { createTraceStore } from '../src/diagnostics/trace-store.js';
import { createTraceViewer } from '../src/ui/trace-viewer.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
    const current = { chatId: 'same-file', memoryChatId: 'character:a.png:same-file', character: '甲', pluginVersion: 'test' };
    const traces = createTraceStore(), listeners = new Set();
    const view = { chatId: current.memoryChatId, status: '未完成', error: '状态校验失败', enabled: true, saveEnabled: true,
        activity: null, initialization: { state: 'retry', message: '待重试', retry: true }, diagnostics: { pendingCount: 3 } };
    const controller = { traces, diagnostics: { lastPlan: { selectedIds: ['entry'] } }, view: () => structuredClone(view),
        store: { state: { chatId: current.memoryChatId, initialized: true, revision: 5, data: { scopeContext: { activeScopeId: 'source' } } } },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
    const exporter = createProblemExporter({ controller, context: () => ({ ...current }) });
    const trace = (context, label) => { const id = traces.start({ context, label, request: { messages: [{ role: 'user', content: label }] } }); traces.finish(id); return id; };
    return { current, view, controller, exporter, listeners, trace, traces };
}

test('problem export includes only this character chat, including canonical auxiliary traces', async () => {
    const f = fixture();
    f.trace({ chatId: 'same-file', memoryChatId: f.current.memoryChatId, character: '甲' }, '当前网络');
    f.trace({ chatId: f.current.memoryChatId }, '当前辅助');
    f.trace({ chatId: 'same-file', memoryChatId: 'character:b.png:same-file', character: '乙' }, '别的角色');
    f.trace({ chatId: 'same-file', character: '乙' }, '旧记录别的角色');
    f.trace({ chatId: 'different', character: '甲' }, '别的聊天');
    const exported = await f.exporter.export();
    assert.deepEqual(exported.trace.records.map(record => record.label), ['当前网络', '当前辅助']);
    assert.equal(exported.trace.excludedRecords, 3);
    assert.doesNotMatch(JSON.stringify(exported), /别的角色|别的聊天/);
});

test('memory status uses actual controller view fields and never exposes another loaded store', async () => {
    const f = fixture(); const result = await f.exporter.export();
    assert.equal(result.memory.pendingCount, 3);
    assert.equal(result.memory.initialization.state, 'retry');
    f.controller.store.state.chatId = 'character:old.png:old';
    await assert.rejects(f.exporter.export(), /载入|切换|存档/);
});

test('source exceptions and malformed runs do not prevent exporting the remaining evidence', async () => {
    const f = fixture();
    f.exporter.register({ id: 'good', read: () => ({ runs: 'not-an-array', detail: '有用资料' }) });
    f.exporter.register({ id: 'bad', read: () => { throw new Error('读取失败'); } });
    f.exporter.register({ id: 'empty', read: () => null });
    const result = await f.exporter.export();
    assert.equal(result.sources.find(source => source.id === 'good').data.detail, '有用资料');
    assert.match(result.sources.find(source => source.id === 'bad').error, /读取失败/);
    assert.equal(result.trace.selection, 'current-chat-latest-12');
    assert.equal(f.listeners.size, 0);
});

test('switching chat, including away and back during a read, rejects mixed export and releases listeners', async () => {
    for (const variant of ['different', 'back', 'reload']) {
        const f = fixture(), wait = deferred();
        f.exporter.register({ id: 'pending', read: () => wait.promise });
        const exporting = f.exporter.export(); await Promise.resolve();
        if (variant === 'reload') f.controller.store = structuredClone(f.controller.store);
        else {
            for (const listener of f.listeners) listener({ chatId: 'character:other.png:other' });
            if (variant === 'different') f.current.chatId = 'another';
        }
        wait.resolve({ detail: '迟到资料' });
        await assert.rejects(exporting, /切换存档|尚未载入/);
        assert.equal(f.listeners.size, 0);
    }
});

test('a provider unregistered or replaced during a read cannot attach stale output', async () => {
    const f = fixture(), wait = deferred();
    const disposeOld = f.exporter.register({ id: 'card', read: () => wait.promise });
    const exporting = f.exporter.export(); await Promise.resolve();
    f.exporter.register({ id: 'card', read: () => ({ detail: '新版本' }) }); disposeOld();
    wait.resolve({ detail: '旧版本' });
    assert.deepEqual((await exporting).sources, []);
    assert.equal((await f.exporter.export()).sources[0].data.detail, '新版本');
});

test('providers time out concurrently after at most 3 seconds and all timers are cleared', async () => {
    const f = fixture(), deadlines = new Map(); let sequence = 0;
    const timers = { setTimeout(fn, duration) { deadlines.set(++sequence, { fn, duration }); return sequence; }, clearTimeout(id) { deadlines.delete(id); } };
    const exporter = createProblemExporter({ controller: f.controller, context: () => f.current, timers });
    for (const id of ['stuck-one', 'stuck-two']) exporter.register({ id, read: () => new Promise(() => {}) });
    exporter.register({ id: 'fast', read: () => ({ detail: '正常来源' }) });
    const pending = exporter.export();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(deadlines.size, 2, 'fast provider already cleared its timer');
    assert.ok([...deadlines.values()].every(timer => timer.duration === 3000));
    for (const timer of [...deadlines.values()]) timer.fn();
    const result = await pending;
    assert.equal(result.sources.filter(source => /超时/.test(source.error ?? '')).length, 2);
    assert.equal(result.sources.find(source => source.id === 'fast').data.detail, '正常来源');
    assert.equal(deadlines.size, 0); assert.equal(f.listeners.size, 0);
});

test('credentials and connection addresses are excluded while literal prompt bodies stay intact', async () => {
    const f = fixture();
    f.exporter.register({ id: 'card', read: () => ({ configuration: { apiKey: 'PRIVATE-KEY', headers: { Authorization: 'PRIVATE-AUTH' },
        cookie: 'PRIVATE-COOKIE', connection: { endpoint: 'https://user:pass@example.test/api?token=PRIVATE-QUERY', model: 'model' }, route: 'https://user:pass@example.test/api?token=PRIVATE-QUERY' },
        request: { messages: [{ role: 'user', content: '剧情中的 token 和 password 字样仍是正文' }] } }) });
    const result = await f.exporter.export(), encoded = JSON.stringify(result);
    assert.doesNotMatch(encoded, /PRIVATE-|user:pass/);
    assert.match(encoded, /剧情中的 token 和 password 字样仍是正文/);
    assert.equal(result.sources[0].data.configuration.route, 'https://example.test/api');
});

test('oversized provider data is explicitly truncated without crowding out core memory status or executing getters', async () => {
    const f = fixture(); let getterCalls = 0;
    f.exporter.register({ id: 'large', read: () => ({ get runs() { getterCalls++; throw new Error('getter must not run'); }, text: '长'.repeat(5100000) }) });
    const result = await f.exporter.export();
    assert.equal(getterCalls, 0); assert.equal(result.truncated, true);
    assert.ok(result.truncatedFields.includes('sources'));
    assert.equal(result.memory.pendingCount, 3); assert.ok(JSON.stringify(result).length < 5003000);
});

test('mismatched provider identity and foreign run windows are excluded before trace-window selection', async () => {
    const f = fixture();
    f.exporter.register({ id: 'wrong', read: () => ({ context: { chatId: 'foreign', character: '乙' }, content: 'OTHER-CHAT-SECRET' }) });
    f.exporter.register({ id: 'mixed', read: () => ({ runs: [
        { context: { chatId: f.current.chatId }, startedAt: '2026-10-07T12:00:00Z', detail: '当前流程' },
        { context: { chatId: 'foreign' }, startedAt: '2000-01-01T00:00:00Z', detail: 'FOREIGN-RUN-SECRET' },
    ] }) });
    const result = await f.exporter.export();
    assert.doesNotMatch(JSON.stringify(result), /OTHER-CHAT-SECRET|FOREIGN-RUN-SECRET/);
    assert.match(result.sources.find(source => source.id === 'wrong').error, /其他存档/);
    assert.equal(result.sources.find(source => source.id === 'mixed').excludedRuns, 1);
    assert.equal(result.trace.selection, 'matching-client-turn-window');
});

test('without a client turn window only the latest twelve current-chat traces are exported', async () => {
    const f = fixture();
    for (let i = 0; i < 15; i++) f.trace({ chatId: f.current.memoryChatId }, `当前-${i}`);
    f.trace({ chatId: 'foreign' }, '别的档');
    const result = await f.exporter.export();
    assert.equal(result.trace.records.length, 12); assert.equal(result.trace.records[0].label, '当前-3');
    assert.equal(result.trace.excludedRecords, 1);
    assert.equal(result.trace.totalChars, JSON.stringify(result.trace.records).length);
});

class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.events = {}; this.textContent = ''; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    setAttribute() {}
    addEventListener(type, fn) { this.events[type] = fn; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    click() { this.clicks = (this.clicks ?? 0) + 1; this.events.click?.(); }
}
function viewerFixture(exportProblem, failDownload = false) {
    const downloads = [], revoked = [];
    const doc = { createElement: tag => new Element(tag), defaultView: {
        Blob: class { constructor(parts) { this.parts = parts; } },
        URL: { createObjectURL(blob) { if (failDownload) throw new Error('blocked download'); downloads.push(JSON.parse(blob.parts[0])); return `blob:test-${downloads.length}`; }, revokeObjectURL(url) { revoked.push(url); } },
    } };
    const viewer = createTraceViewer(doc, null, { exportProblem });
    const walk = node => [node, ...node.children.flatMap(walk)];
    const elements = walk(viewer.element);
    return { viewer, downloads, revoked, link: () => walk(viewer.element).find(node => node.tagName === 'a'),
        button: elements.find(node => node.textContent === '导出本次问题'), feedback: elements.find(node => node.className === 'dwm-hint') };
}

test('problem button provides in-progress feedback, exports the returned package and reenables itself', async () => {
    const pending = deferred(), f = viewerFixture(() => pending.promise);
    const clicking = f.button.events.click();
    assert.equal(f.button.disabled, true); assert.match(f.feedback.textContent, /正在整理/);
    pending.resolve({ format: 'fish-memory-problem', evidence: '当前档' }); await clicking;
    assert.deepEqual(f.downloads, [{ format: 'fish-memory-problem', evidence: '当前档' }]);
    assert.equal(f.button.disabled, false); assert.match(f.feedback.textContent, /已发起下载.*确认浏览器保存结果/);
    f.viewer.destroy();
});

test('a visible real link retries the prepared file without collecting again and URLs release only on replacement or disposal', async () => {
    let collected = 0;
    const f = viewerFixture(async () => ({ evidence: `当前档-${++collected}` }));
    await f.button.events.click();
    const first = f.link();
    assert.ok(first); assert.notEqual(first.hidden, true); assert.equal(first.download, '鱼忆-本次问题.json');
    assert.equal(first.href, 'blob:test-1'); assert.equal(first.clicks, 1); assert.deepEqual(f.revoked, []);
    first.click();
    assert.equal(first.clicks, 2); assert.equal(collected, 1); assert.equal(f.downloads.length, 1);
    assert.match(f.feedback.textContent, /已发起下载.*确认浏览器保存结果/);
    const next = f.button.events.click();
    assert.deepEqual(f.revoked, ['blob:test-1']); assert.equal(first.parent, null);
    await next;
    assert.equal(f.link().href, 'blob:test-2'); assert.equal(collected, 2);
    f.viewer.destroy(); assert.deepEqual(f.revoked, ['blob:test-1', 'blob:test-2']);
});

test('destroying the viewer before preparation finishes never creates a late download or retained Blob URL', async () => {
    const pending = deferred(), f = viewerFixture(() => pending.promise);
    const clicking = f.button.events.click(); f.viewer.destroy();
    pending.resolve({ evidence: '迟到结果' }); await clicking;
    assert.equal(f.downloads.length, 0); assert.deepEqual(f.revoked, []);
});

test('problem button never reports success after provider rejection or a blocked download', async () => {
    const rejected = viewerFixture(() => Promise.reject(new Error('切换存档')));
    await rejected.button.events.click();
    assert.match(rejected.feedback.textContent, /导出未完成.*切换存档/); assert.equal(rejected.button.disabled, false);
    assert.equal(rejected.downloads.length, 0); rejected.viewer.destroy();
    const blocked = viewerFixture(async () => ({ evidence: '当前档' }), true);
    await blocked.button.events.click();
    assert.match(blocked.feedback.textContent, /无法下载/); assert.doesNotMatch(blocked.feedback.textContent, /已导出/);
    assert.equal(blocked.button.disabled, false); blocked.viewer.destroy();
});
