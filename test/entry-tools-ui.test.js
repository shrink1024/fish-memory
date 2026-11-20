import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from '../src/ui/panel.js';
import { DEFAULT_SETTINGS } from '../src/core/state.js';
import { lazyAttention, lazyShortStatus } from '../src/ui/lazy-copy.js';

// Minimal DOM contract fixture, as in model-list.test.js; clicks may carry modifier keys.
class Node {
    constructor(tag, doc) {
        this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {};
        this.events = {}; this.attributes = {}; this._text = ''; this.className = ''; this.value = '';
        this.classList = { add: name => { this.className += ` ${name}`; } };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    append(...items) { for (const item of items) { if (typeof item === 'string') { this.children.push(item); continue; } item.remove(); item.parent = this; this.children.push(item); } }
    replaceChildren(...items) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...items); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    contains(node) { return walk(this).includes(node); }
    querySelectorAll(selector) { return walk(this).filter(node => (selector === '[data-focus]' && node.dataset.focus) || (selector === '[data-scroll]' && node.dataset.scroll)); }
    querySelector() { return null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, callback) { (this.events[type] ??= new Set()).add(callback); }
    removeEventListener(type, callback) { this.events[type]?.delete(callback); }
    click(extra = {}) { if (!this.disabled) for (const callback of this.events.click ?? []) callback({ target: this, currentTarget: this, ...extra }); }
    focus() { this.ownerDocument.activeElement = this; }
}
const walk = node => [node, ...node.children.filter(child => typeof child !== 'string').flatMap(walk)];
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ entries = {}, editing = {}, extra = {}, controllerExtra = {} } = {}) {
    const doc = { createElement(tag) { return new Node(tag, this); }, defaultView: { confirm: () => true } };
    const root = new Node('main', doc), calls = [], listeners = new Set();
    const view = { chatId: 'c', enabled: true, status: '', settings: { ...DEFAULT_SETTINGS }, sourceBook: 'main', maintenance: null,
        save: { id: 's', initialized: true, processedCount: 4, data: { entries: structuredClone(entries), summary: '', inventory: [], inventoryEnabled: true }, audit: [] },
        entryEditing: { saveId: 's', revision: 9, canEdit: true, deleteIds: [], changeIds: [], ...editing },
        readiness: { chat: true, book: true, template: true, single: true }, diagnostics: { pendingCount: 0, lastPlan: null }, presetApplication: { entries: [] }, ...extra };
    const notify = () => listeners.forEach(fn => fn());
    const controller = { view: () => view, subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
        manual: async action => { calls.push(['manual', action]); return { executed: true }; },
        updateSettings: async () => ({ executed: true }), maintain: async () => ({ executed: true }), previewPlan: async () => ({ selectedIds: [] }), ...controllerExtra(calls, view, notify) };
    const panel = mountPanel(root, controller, {});
    const find = predicate => walk(root).find(predicate);
    const button = label => { const node = find(n => n.tagName === 'BUTTON' && n.textContent === label); assert.ok(node, `missing ${label}`); return node; };
    return { root, panel, calls, find, button, view, notify };
}
const entry = (id, title, extra = {}) => ({ id, title, kind: 'event', enabled: true, constant: false, intro: '', retrieveWhen: '', evidence: [], version: 1, segments: [{ id: 'body', text: `${title}正文`, writable: true }], ...extra });

test('delete uses the backend list of deletable entries and sends confirmation with the offered revision', async t => {
    const entries = { a: entry('a', '旧港夜谈'), b: entry('b', '北城图书馆', { kind: 'fact', source: { book: 'main', uid: 1, original: '北城图书馆正文' } }) };
    const f = fixture({ entries, editing: { deleteIds: ['a'], changeIds: ['a'] }, controllerExtra: () => ({}) }); t.after(() => f.panel.destroy());
    await tick();
    f.button('删除').click(); await tick();
    assert.match(f.root.textContent, /删除这条资料？/);
    walk(f.root).filter(n => n.tagName === 'BUTTON' && n.textContent === '删除').at(-1).click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['manual', { type: 'delete-entries', ids: ['a'], confirmed: true, expectedSaveId: 's', expectedRevision: 9 }]);
});

test('a merge proposal keeps protected segments read-only and sends the edited segments with confirmation', async t => {
    const entries = { a: entry('a', '雨夜'), b: entry('b', '后半夜') };
    const proposal = { id: 'p1', mode: 'merge', ids: ['a', 'b'], sources: [{ id: 'a', title: '雨夜', version: 1, text: '雨夜正文' }, { id: 'b', title: '后半夜', version: 1, text: '后半夜正文' }],
        result: [{ title: '旧港雨夜', intro: '', tier: 'onDemand', segments: [{ id: 'keep', text: '受保护原句', writable: false }, { id: 'body', text: '合并后的正文', writable: true }] }], note: '' };
    const f = fixture({ entries, editing: { deleteIds: ['a', 'b'], changeIds: ['a', 'b'] }, controllerExtra: calls => ({
        proposeEntryChange: async input => { calls.push(['propose', input]); return structuredClone(proposal); },
        discardEntryProposal: id => calls.push(['discard', id]) }) });
    t.after(() => f.panel.destroy());
    f.button('多选').click(); await tick();
    // Pick both entries through their list checkboxes.
    for (const id of ['a', 'b']) walk(f.root).find(n => n.tagName === 'INPUT' && n.dataset.focus === `pick-${id}`)?.click?.();
    const rows = walk(f.root).filter(n => n.attributes?.role === 'option'); for (const r of rows) r.click?.();
    await tick();
    f.button('合并为一条').click(); await tick(); await tick();
    assert.deepEqual(f.calls.find(c => c[0] === 'propose'), ['propose', { mode: 'merge', ids: ['a', 'b'] }]);
    assert.match(f.root.textContent, /受保护，不会改动/);
    assert.match(f.root.textContent, /受保护原句/);
    f.button('确认合并').click(); await tick();
    const apply = f.calls.find(c => c[1]?.type === 'entry-change-apply')[1];
    assert.equal(apply.confirmed, true); assert.equal(apply.proposalId, 'p1');
    assert.deepEqual(apply.result[0].segments.map(s => s.writable), [false, true]);
});

test('a fixed preset that disappeared is named, and header errors read as sentences', async t => {
    const f = fixture({ extra: { presetChoices: [{ name: '正文预设', current: true }], presetApplication: { entries: [], followsCurrent: false, sourceName: '已删的预设', sourceMissing: true, name: '已删的预设' } },
        controllerExtra: () => ({ setPresetSource: async () => ({ executed: true }) }) });
    t.after(() => f.panel.destroy());
    f.button('设置').click(); await tick(); f.button('预设应用').click(); await tick();
    assert.match(f.root.textContent, /固定读取的预设「已删的预设」已不存在/);
    const g = fixture({ extra: { connectionMode: 'compatible', connection: { endpoint: 'https://x/v1', model: 'm', headers: [] } },
        controllerExtra: () => ({ updateConnection: async () => { throw Object.assign(new Error('connection-headers:name'), { dwmHeaderIssue: 'name' }); } }) });
    t.after(() => g.panel.destroy());
    g.button('设置').click(); await tick(); g.button('辅助模型').click(); await tick();
    g.button('应用连接').click(); await tick();
    assert.match(g.root.textContent, /请求头名称无效/);
    assert.doesNotMatch(g.root.textContent, /connection-headers:name/);
});

test('editing an entry opens the editor instead of throwing (regression: newDraft went missing in 1469336)', async t => {
    const entries = { a: entry('a', '旧港夜谈') };
    const f = fixture({ entries, controllerExtra: () => ({}) }); t.after(() => f.panel.destroy());
    f.button('编辑').click(); await tick();
    assert.ok(walk(f.root).some(n => n.tagName === 'BUTTON' && n.textContent === '保存修改'));
});
