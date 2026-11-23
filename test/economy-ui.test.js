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

function fixture({ settings = {}, maintenance = null, pending = 0, plan = null, forceNext = false, inventory = [], edit = {}, extra = {} } = {}) {
    const doc = { createElement(tag) { return new Node(tag, this); }, defaultView: { confirm: () => true } };
    const root = new Node('main', doc), calls = [], listeners = new Set();
    const view = { chatId: 'c', enabled: true, status: '', settings: { ...DEFAULT_SETTINGS, ...settings }, sourceBook: 'main', maintenance,
        selectionReuse: { mode: settings.rerollSelection ?? 'reuse', forceNext, lastSource: plan?.selectionSource ?? null },
        save: { id: 's', initialized: true, processedCount: 4, data: { entries: {}, summary: '', inventory: structuredClone(inventory), inventoryEnabled: true }, audit: [] },
        readiness: { chat: true, book: true, template: true, single: true }, diagnostics: { pendingCount: pending, lastPlan: plan }, presetApplication: { entries: [] }, ...extra };
    const notify = () => listeners.forEach(fn => fn());
    const editState = { scopeId: 'global', saveId: 's', revision: 7, canEdit: true, reason: null, canUndo: false, undoCommitId: null, ...edit };
    const controller = { view: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        updateSettings: async patch => {
            calls.push(['settings', patch]);
            const override = view.settings.economyMode && !('economyMode' in patch);
            Object.assign(view.settings, patch, override ? { economyMode: false } : {}); notify();
            return { executed: true, economyModeChange: override ? 'manual-override' : null };
        },
        setEconomyMode: async value => { calls.push(['economy', value]); view.settings.economyMode = value; notify(); return { executed: true, economyModeChange: value ? 'enabled' : 'disabled' }; },
        inventoryEditState: scopeId => ({ ...editState, scopeId }),
        manual: async action => { calls.push(['manual', action]); if (action.type === 'inventory-edit') { view.save.data.inventory = action.items; Object.assign(editState, { revision: editState.revision + 1, canUndo: true, undoCommitId: 'c1' }); } notify(); return { executed: true }; },
        setNextSelectionRefresh: value => { calls.push(['force', value]); view.selectionReuse.forceNext = value; notify(); return { executed: true }; },
        maintain: async () => { calls.push(['maintain']); return { executed: true }; }, previewPlan: async () => ({ selectedIds: [] }) };
    const panel = mountPanel(root, controller, {});
    const find = predicate => walk(root).find(predicate);
    const button = label => { const node = find(n => n.tagName === 'BUTTON' && n.textContent === label); assert.ok(node, `missing ${label}`); return node; };
    const type = (node, value) => { node.value = value; for (const callback of node.events.input ?? []) callback({ target: node }); };
    return { root, panel, calls, find, button, view, type, editState };
}
const waiting = { every: 5, pendingReplies: 5, eligibleReplies: 4, retainedReplies: 1, eligibleEnd: 9, covered: 0, trigger: 'waiting', waiting: true };

test('the status bar counts only replies that can be recorded, never the deferred newest one', async t => {
    const f = fixture({ maintenance: waiting, pending: 10 }); t.after(() => f.panel.destroy());
    assert.match(f.root.textContent, /已积累 4\/5 条回复/);
    assert.doesNotMatch(f.root.textContent, /暂缓/);
    f.button('立即整理').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['maintain']);
    const held = fixture({ maintenance: { ...waiting, pendingReplies: 1, eligibleReplies: 0 }, pending: 2 }); t.after(() => held.panel.destroy());
    assert.equal(held.find(n => n.tagName === 'BUTTON' && n.textContent === '立即整理'), undefined);
    assert.match(held.root.textContent, /已就绪/);
    const legacy = fixture({ pending: 10 }); t.after(() => legacy.panel.destroy());
    assert.match(legacy.root.textContent, /10 条消息待整理/);
});

test('one interval, deferral for everyone, and a manual bundled edit that switches 省钱模式 off', async t => {
    const f = fixture(); t.after(() => f.panel.destroy());
    f.button('设置').click(); await tick();
    assert.match(f.root.textContent, /暂缓最新回复/);
    assert.doesNotMatch(f.root.textContent, /提前整理|正文输入可能/);
    f.button('5').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['settings', { maintenanceEvery: 5 }]);
    f.button('2 条').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['settings', { maintenanceKeepRecent: 2 }]);
    f.find(n => n.attributes['aria-label'] === '省钱模式').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['economy', true]);
    assert.match(f.root.textContent, /由省钱模式设定/);
    f.button('高级').click(); await tick();
    assert.match(f.root.textContent, /修改任意一项会关闭省钱模式/);
    f.button('8 轮').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['settings', { selectionRecentTurns: 8 }]);
    assert.match(f.root.textContent, /省钱模式已关闭，其他设置保持不变/);
});

test('物品 is edited one item at a time from its pencil; each save sends the whole list with its revision, then offers undo', async t => {
    const f = fixture({ inventory: [{ name: '怀表', description: '旧的' }, { name: '船票', description: '' }] }); t.after(() => f.panel.destroy());
    f.button('物品').click(); await tick();
    assert.equal(f.find(n => n.attributes['aria-label'] === '编辑物品'), undefined);
    const pencil = name => f.find(n => n.attributes['aria-label'] === `编辑“${name}”`);
    const input = key => f.find(n => n.dataset.focus === key);
    f.button('新增物品').click(); await tick();
    f.button('保存').click(); await tick();
    assert.match(f.root.textContent, /物品名称不能为空/);
    assert.equal(f.calls.filter(c => c[0] === 'manual').length, 0);
    f.type(input('inventory-edit-name'), '借阅证');
    f.button('保存').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['manual', { type: 'inventory-edit', scopeId: 'global', items: [{ name: '怀表', description: '旧的' }, { name: '船票', description: '' }, { name: '借阅证', description: '' }], expectedSaveId: 's', expectedRevision: 7 }]);
    pencil('怀表').click(); await tick();
    assert.equal(pencil('船票').disabled, true);
    f.type(input('inventory-edit-name'), ' 黄铜怀表 ');
    f.button('保存').click(); await tick();
    assert.deepEqual(f.calls.at(-1)[1].items[0], { name: '黄铜怀表', description: '旧的' });
    assert.equal(f.calls.at(-1)[1].expectedRevision, 8);
    pencil('船票').click(); await tick();
    f.button('删除这件物品').click(); await tick();
    assert.deepEqual(f.calls.at(-1)[1].items, [{ name: '黄铜怀表', description: '旧的' }, { name: '借阅证', description: '' }]);
    f.button('撤销上次物品编辑').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['manual', { type: 'inventory-edit-undo', scopeId: 'global', commitId: 'c1', expectedSaveId: 's', expectedRevision: 10 }]);
    const blocked = fixture({ inventory: [{ name: '怀表', description: '' }], edit: { canEdit: false, reason: 'catch-up' } }); t.after(() => blocked.panel.destroy());
    blocked.button('物品').click(); await tick();
    assert.equal(blocked.find(n => n.attributes['aria-label'] === '编辑“怀表”'), undefined);
    assert.match(blocked.root.textContent, /物品正在恢复补记，完成后才能编辑/);
});

test('本轮 queues a one-shot reselection without calling the model, and shows where the last selection came from', async t => {
    const plan = { requestId: 'r', at: new Date().toISOString(), mode: 'send', selectionSource: 'reused', selectedIds: [], mandatoryIds: [], triggeredIds: [], gatedIds: [], entries: [] };
    const f = fixture({ plan }); t.after(() => f.panel.destroy());
    f.button('本轮').click(); await tick();
    assert.match(f.root.textContent, /沿用上次挑选/);
    assert.doesNotMatch(f.root.textContent, /输入和资料都没有变化/);
    f.button('下次重新挑选').click(); await tick();
    assert.deepEqual(f.calls, [['force', true]]);
    assert.match(f.root.textContent, /已安排：下一次发送或重新生成时重新挑选资料，只生效一次/);
    f.button('取消重新挑选').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['force', false]);
    // With “每次重选” every send already reselects; no one-shot control is offered.
    const refresh = fixture({ settings: { rerollSelection: 'refresh' }, plan: { ...plan, selectionSource: 'fresh' } }); t.after(() => refresh.panel.destroy());
    refresh.button('本轮').click(); await tick();
    assert.equal(refresh.find(n => n.tagName === 'BUTTON' && n.textContent === '下次重新挑选'), undefined);
    assert.match(refresh.root.textContent, /重新挑选/);
});

test('current-turn diagnostics show a failed attempt separately from the prior plan', async t => {
    const f = fixture({extra:{diagnostics:{lastPlan:{selectionSource:'reused',selectedIds:[]},lastPreparation:{outcome:'failed',selectionReason:'forced',timingsMs:{total:25,auxiliary:20}}}}});
    t.after(()=>f.panel.destroy());f.button('本轮').click();await tick();
    assert.match(f.root.textContent,/最近一次准备 · 准备失败/);
    assert.match(f.root.textContent,/已指定重新挑选/);assert.match(f.root.textContent,/准备总计：25 ms/);
});

test('a rebound main book asks for a backup and rescan, never a partial sync', async t => {
    const rebound = { changed: true, rebound: true, previousBook: '旧港来信 v0.85', currentBook: '旧港来信 v1.00', added: [], removed: [], updated: [] };
    const f = fixture({ extra: { sourceChanges: rebound } }); t.after(() => f.panel.destroy());
    assert.match(f.root.textContent, /主世界书已从《旧港来信 v0\.85》更换为《旧港来信 v1\.00》/);
    assert.equal(f.find(n => n.tagName === 'BUTTON' && n.textContent === '只同步变化的条目'), undefined);
    f.button('备份后重新扫描…').click(); await tick();
    assert.match(f.root.textContent, /重新扫描整个存档/);
    const card = lazyAttention({ reason: 'source-rebound', previousBook: '旧港来信 v0.85', currentBook: '旧港来信 v1.00' });
    assert.equal(card.sub, '主世界书已更换'); assert.deepEqual(card.actions, ['to-manual']);
    assert.match(card.body.join(''), /《旧港来信 v1\.00》.*《旧港来信 v0\.85》/);
    assert.equal(lazyShortStatus({ lazy: { attention: { reason: 'source-rebound' } }, settings: { enabled: true } }), '主世界书已更换');
});
