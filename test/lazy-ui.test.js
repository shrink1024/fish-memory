import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from '../src/ui/panel.js';
import { createFloatingManager } from '../src/ui/floating-manager.js';
import { lazyHeadline, lazyRecord, lazyShortStatus, lazyAttention } from '../src/ui/lazy-copy.js';
import { DEFAULT_SETTINGS } from '../src/core/state.js';

// Minimal DOM contract fixture, as in panel-redesign.test.js.
class Node {
    constructor(tag, doc) {
        this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {}; this.style = {};
        this.events = {}; this.attributes = {}; this._text = ''; this.className = ''; this.value = '';
        this.classList = { add: name => { this.className += ` ${name}`; } };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    append(...items) { for (const item of items) { if (typeof item === 'string') { this.children.push(item); continue; } item.remove(); item.parent = this; this.children.push(item); } }
    replaceChildren(...items) { for (const child of this.children) if (typeof child !== 'string') child.parent = null; this.children = []; this._text = ''; this.append(...items); }
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
const NOW = Date.parse('2026-11-02T14:30:00');
const iso = minutes => new Date(NOW - minutes * 60000).toISOString();

function fixture(lazyPatch = {}, extra = {}) {
    const store = new Map();
    const doc = { createElement(tag) { return new Node(tag, this); }, defaultView: { localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } } };
    const root = new Node('main', doc), titleSlot = new Node('span', doc), statusSlot = new Node('div', doc), calls = [], listeners = new Set();
    const lazy = { enabled: true, status: { state: 'ready', stage: null, batch: null, nextRetryAt: null, waitingReason: null, floor: 148, updatedAt: iso(2), deferredTurn: false },
        attention: null, capacityPercent: 71, recent: [{ type: 'maintain', from: 146, to: 148, at: iso(2) }, { type: 'held-kept', title: '北城图书馆', at: iso(20) }], ...lazyPatch };
    const view = { chatId: 'c', enabled: true, status: '', settings: { ...DEFAULT_SETTINGS, lazyMode: lazy.enabled }, sourceBook: 'main', connectionMode: 'raw', lazy,
        save: { id: 's', initialized: true, processedCount: 148, data: { entries: {}, summary: '', inventory: [] }, audit: [] }, saveEnabled: true,
        readiness: { chat: true, book: true, template: true, single: true }, diagnostics: { pendingCount: 0 }, presetApplication: { entries: [] },
        sourceChanges: { held: [], added: [], updated: [], removed: [] }, ...extra.view };
    let variant = null;
    const controller = { view: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        setLazyMode: async value => { calls.push(['setLazyMode', value]); lazy.enabled = value; view.settings.lazyMode = value; listeners.forEach(fn => fn()); return { executed: true }; },
        lazyRetry: async () => { calls.push(['lazyRetry']); }, lazyIgnore: async () => { calls.push(['lazyIgnore']); },
        updateSettings: async patch => { calls.push(['updateSettings', patch]); }, manual: async () => ({ executed: true }) };
    let dock = { visible: false, size: 'compact', edge: 'right', fraction: 0.65 };
    const appearance = { dock: () => ({ ...dock }), setDock: patch => { dock = { ...dock, ...patch }; calls.push(['setDock', patch]); }, setVariant: value => { variant = value; } };
    const panel = mountPanel(root, controller, { titleSlot, statusSlot, appearance, exportProblem: async () => ({}), ...extra.options });
    const find = predicate => walk(root).find(predicate);
    const button = label => { const node = find(n => n.tagName === 'BUTTON' && n.textContent === label); assert.ok(node, `missing ${label}`); return node; };
    const has = label => Boolean(find(n => n.tagName === 'BUTTON' && n.textContent === label));
    return { root, panel, calls, view, lazy, titleSlot, statusSlot, find, button, has, store, variant: () => variant, rerender: () => listeners.forEach(fn => fn()) };
}

test('超级懒人模式 shows one status, the recent automatic work and the way to 高级模式, without tabs', t => {
    const f = fixture(); t.after(() => f.panel.destroy());
    assert.equal(f.variant(), 'lazy'); assert.equal(f.titleSlot.textContent, '超级懒人模式'); assert.equal(f.statusSlot.children.length, 0);
    assert.ok(!f.find(n => n.attributes.role === 'tablist'), 'no workspace tabs');
    const text = f.root.textContent;
    assert.match(text, /记忆正常/); assert.match(text, /已记录至第 148 楼/); assert.match(text, /最近自动处理/);
    assert.match(text, /记录第 146–148 楼/); assert.match(text, /「北城图书馆」原书有新版本.*已保留当前版本/);
    assert.match(text, /如需改用新原文.*点击“复原”/, 'the conflict row says how to change it later');
    assert.ok(f.has('小图标') && f.has('带文字') && f.has('隐藏') && f.has('高级模式'));
    f.button('带文字').click(); assert.deepEqual(f.calls.at(-1), ['setDock', { visible: true, size: 'full' }]);
});

test('a connection stop offers retry and export; retry runs in the background and keeps the window usable', async t => {
    const f = fixture({ attention: { reason: 'connection', task: 'maintain', at: iso(1), attempts: 4, error: '辅助接口 HTTP 504' } }); t.after(() => f.panel.destroy());
    assert.match(f.root.textContent, /记忆暂停更新/); assert.match(f.root.textContent, /已自动重试 4 次，均未成功；最近一次失败于 14:29（辅助接口 HTTP 504）/);
    assert.match(f.root.textContent, /若酒馆本身也无法发送消息，请先检查酒馆的连接设置/);
    f.button('立即重试').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['lazyRetry']); assert.equal(f.button('高级模式').disabled, false, 'a long retry does not lock the window');
    assert.equal(f.root.ownerDocument.activeElement?.dataset.focus, 'lazy-hero');
    assert.ok(f.has('导出本次问题'));
});

test('a moderation stop offers 忽略 only when the controller marks the floors as safe to skip', async t => {
    const blocked = { reason: 'moderation', task: 'maintain', at: iso(1), attempts: 0, error: '服务方内容审核拒收', floors: { from: 120, to: 126 } };
    const a = fixture({ attention: { ...blocked, canIgnore: true } }); t.after(() => a.panel.destroy());
    assert.match(a.root.textContent, /第 120–126 楼的整理请求/); a.button('忽略').click(); await tick(); assert.deepEqual(a.calls.at(-1), ['lazyIgnore']);
    const b = fixture({ attention: blocked }); t.after(() => b.panel.destroy());
    assert.equal(b.has('忽略'), false); assert.doesNotMatch(b.root.textContent, /点击“忽略”/);
});

test('near capacity the only way on is 高级模式; the switch asks once and keeps the warning there', async t => {
    const f = fixture({ attention: { reason: 'capacity', task: 'compact', at: iso(1), attempts: 0, percent: 96 } }); t.after(() => f.panel.destroy());
    assert.match(f.root.textContent, /存档仍占用容量的 96%。已有记忆仍可使用/); assert.equal(f.has('高级模式'), false, 'no duplicate switch in the footer');
    f.button('切换到高级模式').click();
    assert.match(f.root.textContent, /切换到高级模式？/); assert.match(f.root.textContent, /已记录的记忆不受影响，可随时切换回超级懒人模式。/);
    f.button('确认').click(); await tick(); await tick();
    assert.deepEqual(f.calls.find(c => c[0] === 'setLazyMode'), ['setLazyMode', false]);
    assert.equal(f.variant(), 'full'); assert.match(f.root.textContent, /已切换到高级模式，可在“设置 → 常用”中切换回超级懒人模式。/);
    assert.match(f.root.textContent, /存档已占用容量的 96%/); assert.doesNotMatch(f.root.textContent, /新增超级懒人模式/, 'a deliberate switch dismisses the upgrade note');
});

test('old players see a dismissable note; enabling lists the held entries that will keep the current version', async t => {
    const f = fixture({ enabled: false, recent: [] }, { view: { sourceChanges: { held: [{ id: 'lib', title: '北城图书馆' }, { id: 'tide', title: '潮汐与渡轮' }], added: [], updated: [], removed: [] } } });
    t.after(() => f.panel.destroy());
    assert.equal(f.variant(), 'full'); assert.match(f.root.textContent, /新增超级懒人模式/);
    f.button('去设置开启').click();
    assert.doesNotMatch(f.root.textContent, /新增超级懒人模式/, 'the note stays off the settings tab');
    const toggle = f.find(n => n.attributes['aria-label'] === '超级懒人模式'); assert.ok(toggle); assert.equal(toggle.attributes['aria-checked'], 'false');
    toggle.click();
    assert.match(f.root.textContent, /开启超级懒人模式？/); assert.match(f.root.textContent, /现有 2 条原书更新待处理。开启后将保留当前版本/);
    assert.match(f.root.textContent, /「北城图书馆」「潮汐与渡轮」/); assert.doesNotMatch(f.root.textContent, /费用|计费/);
    f.button('确认').click(); await tick(); await tick();
    assert.deepEqual(f.calls.find(c => c[0] === 'setLazyMode'), ['setLazyMode', true]); assert.equal(f.variant(), 'lazy');
    assert.equal(f.store.get('dwm.lazy-intro-dismissed.v1'), '1');
});

test('不再提示 hides the upgrade note for this browser', t => {
    const f = fixture({ enabled: false, recent: [] }); t.after(() => f.panel.destroy());
    f.button('不再提示').click(); assert.doesNotMatch(f.root.textContent, /新增超级懒人模式/); assert.equal(f.store.get('dwm.lazy-intro-dismissed.v1'), '1');
});

test('building shows the step, batch and progress, and the deferred turn note while a reply is generated', t => {
    const f = fixture({ status: { state: 'building', stage: { index: 3, total: 3, label: 'history' }, batch: { done: 3, total: 12 }, floor: 0, deferredTurn: true } },
        { view: { activity: { id: 'a', kind: 'initialize' } } }); t.after(() => f.panel.destroy());
    const text = f.root.textContent;
    assert.match(text, /正在建立记忆/); assert.match(text, /扫描已有剧情：第 4 批，共 12 批 · 第 3 步，共 3 步/);
    assert.match(text, /本存档已有剧情，首次建立记忆需要多次调用模型/); assert.match(text, /本轮按原世界书发送，扫描将在回复结束后继续/);
    const bar = f.find(n => n.attributes.role === 'progressbar'); assert.equal(bar.attributes['aria-valuenow'], '75');
});

test('lazy copy: records, retries and short status read the controller fields as given', () => {
    assert.equal(lazyRecord({ type: 'init', floors: 312, entries: 42 }).text, '建立记忆：扫描已有剧情 312 楼，整理 42 条世界书条目');
    assert.equal(lazyRecord({ type: 'init', floors: 1, entries: 42 }).text, '建立记忆：整理 42 条世界书条目，记录开场');
    assert.equal(lazyRecord({ type: 'retry', attempt: 3, ok: false }).text, '第 3 次重试失败，将在下次发送消息后重试');
    assert.equal(lazyRecord({ type: 'retry', attempt: 4, ok: false }).text, '第 4 次重试失败，自动重试已停止');
    assert.equal(lazyRecord({ type: 'retry', ok: true, floors: { from: 149, to: 151 } }).text, '重试成功，已补记第 149–151 楼');
    assert.equal(lazyRecord({ type: 'retry', ok: true, task: 'sync', completion: { type: 'sync', count: 2 } }).text, '同步原世界书的更新：2 条（重试成功）');
    assert.equal(lazyRecord({ type: 'retry', ok: true, task: 'maintain', floors: { from: 3, to: 3 }, completion: { type: 'maintain', from: 3, to: 3 } }).text, '重试成功，已补记第 3 楼');
    const waitingOutput = lazyHeadline({ settings: { enabled: true }, lazy: { status: { state: 'waiting-retry', retryReason: 'output', nextRetryAt: null } } });
    assert.equal(waitingOutput.title, '等待自动重试');
    const waitingConnection = lazyHeadline({ settings: { enabled: true }, lazy: { status: { state: 'waiting-retry', retryReason: 'connection', nextRetryAt: null } } });
    assert.equal(waitingConnection.title, '连接暂时中断'); assert.equal(waitingConnection.sub, '将在下次发送消息后重试，剧情不受影响。');
    assert.equal(lazyRecord({ type: 'paused', reason: 'quota' }).text, '接口额度不足，自动重试已停止');
    assert.equal(lazyRecord({ type: 'ignored', from: 120, to: 126 }).text, '已忽略第 120–126 楼，不再重试');
    assert.equal(lazyRecord({ type: 'compact', merged: 3, condensed: 0 }).text, '整理记忆：合并 3 条重复条目');
    const ui = status => ({ enabled: true, activity: null, lazy: { enabled: true, status: { state: 'ready' }, attention: null, ...status } });
    assert.equal(lazyShortStatus(ui({})), '记忆正常');
    assert.equal(lazyShortStatus(ui({ attention: { reason: 'quota' } })), '记忆暂停更新：接口额度不足');
    assert.equal(lazyShortStatus(ui({ attention: { reason: 'capacity' } })), '存档容量即将用尽');
    assert.equal(lazyShortStatus({ ...ui({}), enabled: false }), '记忆已暂停');
    const waiting = lazyHeadline({ settings: { enabled: true }, lazy: { status: { state: 'waiting-retry', nextRetryAt: null } } });
    assert.equal(waiting.tone, 'quiet'); assert.match(waiting.sub, /将在下次发送消息后重试/);
    assert.deepEqual(lazyAttention({ reason: 'output', attempts: 4 }).actions, ['retry', 'export']);
});

// floating-manager: the new-install default, the dot on every entry and the narrow lazy card.
class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    fire(type, input = {}) { const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...input }; for (const fn of this.listeners.get(type) ?? []) fn(event); return event; }
}
class Element extends Target {
    constructor(tag, doc) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {}; this.attributes = {}; this.style = { setProperty() {} }; this.hidden = false; this.textContent = ''; this.classList = { toggle: () => {} }; }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    remove() {} contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    get isConnected() { return true; }
    setAttribute(key, value) { this.attributes[key] = String(value); } getAttribute(key) { return this.attributes[key]; }
    focus() { this.ownerDocument.activeElement = this; } getBoundingClientRect() { return { left: 0, top: 0, width: 44, height: 44 }; }
}
function manager({ saved = {}, bubbleVisible } = {}) {
    const win = new Target(); Object.assign(win, { innerWidth: 1280, innerHeight: 800, getComputedStyle: () => ({}) });
    const doc = new Target(); doc.defaultView = win; doc.createElement = tag => new Element(tag, doc); doc.createElementNS = (_, tag) => new Element(tag, doc);
    doc.body = doc.createElement('body'); doc.querySelector = () => null;
    const values = new Map(Object.entries(saved)), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    return { ui: createFloatingManager(doc, { window: win, storage, bubbleVisible }), values, doc };
}

test('a new install hides the bubble and keeps that choice; existing players keep their bubble', () => {
    const fresh = manager({ bubbleVisible: false });
    assert.equal(fresh.ui.dock().visible, false); assert.equal(JSON.parse(fresh.values.get('dwm.floating-position.v1')).visible, false, 'persisted for later loads');
    const later = manager({ saved: Object.fromEntries(fresh.values) }); assert.equal(later.ui.dock().visible, false);
    const old = manager(); assert.equal(old.ui.dock().visible, true);
    const chosen = manager({ bubbleVisible: false, saved: { 'dwm.floating-position.v1': JSON.stringify({ edge: 'left', fraction: 0.2, visible: true }) } }); assert.equal(chosen.ui.dock().visible, true);
    for (const m of [fresh, later, old, chosen]) m.ui.destroy();
});

test('in 超级懒人模式 only a stop marks the entries, and the window becomes a narrow card', () => {
    const { ui, doc } = manager(), entry = doc.createElement('button'); ui.bindEntry(entry);
    const status = attention => ({ enabled: true, initialized: true, activity: null, lazy: { enabled: true, status: { state: 'ready' }, attention } });
    ui.render(status(null)); assert.equal(entry.dataset.dwmAttention, 'false'); assert.equal(ui.bubble.dataset.state, 'idle');
    ui.render(status({ reason: 'connection' }));
    assert.equal(entry.dataset.dwmAttention, 'true'); assert.equal(ui.bubble.dataset.attention, 'true'); assert.equal(ui.bubble.dataset.state, 'attention');
    assert.equal(entry.getAttribute('aria-label'), '打开鱼忆管理窗口：记忆暂停更新：无法连接模型');
    ui.render({ ...status({ reason: 'connection' }), lazy: { ...status(null).lazy, enabled: false, attention: { reason: 'connection' } } });
    assert.equal(entry.dataset.dwmAttention, 'false', '高级模式 keeps its own error display');
    ui.open(); ui.setVariant('lazy');
    assert.equal(ui.panel.dataset.variant, 'lazy'); assert.equal(ui.panel.style.width, '440px'); assert.equal(ui.panel.style.height, '');
    const maximize = ui.panel.children[0].children.find(node => node.attributes['aria-label'] === '最大化' || node.attributes['aria-label'] === '还原');
    assert.equal(maximize.hidden, true);
    ui.setVariant('full'); assert.equal(maximize.hidden, false); assert.notEqual(ui.panel.style.width, '440px');
    ui.destroy();
});

test('a stopped task shows 继续 in the window, which resumes through lazyRetry', async t => {
    const f = fixture({ status: { state: 'stopped', stoppedTask: 'init', floor: 0 } }); t.after(() => f.panel.destroy());
    assert.ok(f.find(n => n.tagName === 'H3' && n.textContent === '已停止建立记忆'));
    f.button('继续').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['lazyRetry']);
});
