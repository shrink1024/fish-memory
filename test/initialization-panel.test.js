import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from '../src/ui/panel.js';
import { DEFAULT_SETTINGS } from '../src/core/state.js';

// DOM contract fixture for the actual panel actions; model and browser calls are synthetic.
class Node {
    constructor(tag, doc) {
        this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {};
        this.events = {}; this.attributes = {}; this._text = ''; this.className = '';
        this.classList = { add: name => { this.className += ` ${name}`; } };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
    replaceChildren(...items) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...items); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    contains(node) { return walk(this).includes(node); }
    querySelectorAll(selector) { return walk(this).filter(node => selector === '[data-focus]' && node.dataset.focus); }
    querySelector() { return null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, callback) { (this.events[type] ??= new Set()).add(callback); }
    removeEventListener(type, callback) { this.events[type]?.delete(callback); }
    click() { if (!this.disabled) for (const callback of this.events.click ?? []) callback({ target: this, currentTarget: this }); }
    focus() { this.ownerDocument.activeElement = this; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(extra = {}) {
    const doc = { createElement(tag) { return new Node(tag, this); }, defaultView: {} };
    const root = new Node('main', doc), calls = { initialize: 0, preset: 0 }, listeners = new Set();
    const view = { chatId: 'old-chat', enabled: true, status: '未初始化', settings: { ...DEFAULT_SETTINGS },
        save: { id: 'old-save', initialized: false, processedCount: 0 }, sourceBook: 'main',
        readiness: { chat: true, book: true, template: true, single: true },
        preset: { available: true, name: '可读取的合成预设', saved: null }, diagnostics: { pendingCount: 30 }, ...extra };
    const controller = { view: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        scanPreset: async () => { calls.preset++; throw Error('合成可选预设扫描格式错误'); },
        initialize: async () => { calls.initialize++; return { executed: true, message: '合成建档完成' }; } };
    const panel = mountPanel(root, controller);
    const button = label => {
        const node = walk(root).find(node => node.tagName === 'BUTTON' && node.textContent === label);
        assert.ok(node, `Missing panel action: ${label}`); return node;
    };
    return { root, view, panel, calls, button, listeners };
}

test('building memory skips the optional preset scan even when it is available and would fail', async t => {
    const f = fixture(); t.after(() => f.panel.destroy());
    assert.match(f.root.textContent, /预设偏好可在设置中单独扫描，不影响建立记忆/);
    f.button('建立此存档记忆').click(); await tick();
    assert.deepEqual(f.calls, { initialize: 1, preset: 0 });
    assert.match(f.root.textContent, /合成建档完成/);
    f.button('设置').click();
    f.button('扫描当前预设（调用模型）').click(); await tick();
    assert.deepEqual(f.calls, { initialize: 1, preset: 1 });
    assert.match(f.root.textContent, /合成可选预设扫描格式错误/);
    f.button('初始化存档').click(); await tick();
    assert.deepEqual(f.calls, { initialize: 2, preset: 1 });
    assert.match(f.root.textContent, /合成建档完成/);
    assert.doesNotMatch(f.root.textContent, /合成可选预设扫描格式错误/);
});

test('a recovered checkpoint displays saved progress and the retry action initializes directly', async () => {
    const f = fixture({ status: '初始化未完成，保留原资料', error: '合成网络中断',
        initialization: { state: 'retry', retry: true, message: '初始化未完成，可手动重试' },
        initializationResume: { stage: 'history', classifiedBatches: 4, totalBatches: 4, processedCount: 120 } });
    try {
        assert.match(f.root.textContent, /已有扫描进度：世界书 4\/4 批，历史 120 条/);
        assert.match(f.root.textContent, /继续仍有效的进度/);
        const retry = f.button('手动扫描 / 重试初始化');
        assert.equal(retry.disabled, false); retry.click(); await tick();
        assert.deepEqual(f.calls, { initialize: 1, preset: 0 });
        assert.equal(f.view.save.initialized, false, 'the UI must not certify draft progress as formal initialized memory');
    } finally { f.panel.destroy(); }
    assert.equal(f.listeners.size, 0);
});
