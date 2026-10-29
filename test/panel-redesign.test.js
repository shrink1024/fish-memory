import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from '../src/ui/panel.js';
import { DEFAULT_SETTINGS } from '../src/core/state.js';

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
const segment = (text, writable = true) => [{ id: 'body', text, writable }];
const entry = (id, title, extra = {}) => ({ id, title, kind: 'fact', enabled: true, constant: false, intro: '', retrieveWhen: '', evidence: [], version: 1,
    segments: segment(`${title}正文`), source: { book: 'main', uid: id, original: `${title}正文` }, ...extra });

function fixture(extra = {}, options = {}) {
    const doc = { createElement(tag) { return new Node(tag, this); }, defaultView: {} };
    const root = new Node('main', doc), calls = [], listeners = new Set();
    const entries = {
        a: entry('a', '甲', { constant: true }),
        b: entry('b', '乙', { segments: segment('改过的乙'), needsReview: true }),
        c: entry('c', '丙', { source: null, kind: 'npc' }),
        d: entry('d', '丁', { tier: 'off', enabled: false, segments: segment('丁正文', false) }),
    };
    const view = { chatId: 'c', enabled: true, status: '', settings: { ...DEFAULT_SETTINGS }, sourceBook: 'main',
        save: { id: 's', initialized: true, processedCount: 4, data: { entries, summary: '', inventory: [] }, audit: [] },
        readiness: { chat: true, book: true, template: true, single: true }, diagnostics: { pendingCount: 0 }, presetApplication: { entries: [] } };
    const controller = { view: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        manual: async action => { calls.push(['manual', action]); return { executed: true }; },
        setEntryTiers: async (ids, tier) => { calls.push(['tiers', ids, tier]); return { executed: true, message: `已一次保存 ${ids.length} 条的档位` }; }, ...extra };
    const panel = mountPanel(root, controller, options);
    const find = predicate => walk(root).find(predicate);
    const button = label => { const node = find(n => n.tagName === 'BUTTON' && n.textContent === label); assert.ok(node, `missing ${label}`); return node; };
    const focus = key => { const node = find(n => n.dataset.focus === key); assert.ok(node, `missing ${key}`); return node; };
    const rows = () => walk(root).filter(n => n.className.includes('dwm-entry ') || n.className === 'dwm-entry');
    return { root, panel, calls, find, button, focus, rows, view, entries };
}

test('each row shows its lamp and marks, and the lamp opens a tier menu', async t => {
    const f = fixture(); t.after(() => f.panel.destroy());
    const text = f.root.textContent;
    assert.match(text, /甲.*乙待核对改.*丙新.*丁/s, 'review, changed and new marks sit beside the titles');
    assert.ok(f.find(n => n.className.includes('dwm-lamp-constant')), 'a constant entry shows the blue lamp');
    assert.ok(f.find(n => n.className.includes('dwm-lock') && !n.className.includes('dwm-lock-part')), 'a fully protected entry shows a lock');
    f.focus('lamp-b').click();
    assert.equal(f.focus('lamp-b').attributes['aria-expanded'], 'true');
    f.focus('tier-menu-b-constant').click(); await tick();
    assert.deepEqual(f.calls, [['manual', { type: 'tier', id: 'b', tier: 'constant' }]]);
    assert.ok(!f.find(n => n.dataset.focus === 'tier-menu-b-constant'), 'the menu closes after a choice');
});

test('the detail tier switch and the changed-only filter', async t => {
    const f = fixture(); t.after(() => f.panel.destroy());
    f.focus('entry-c').click();
    f.focus('tier-c-off').click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['manual', { type: 'tier', id: 'c', tier: 'off' }]);
    f.focus('chip-changed').click();
    const titles = walk(f.root).filter(n => n.className === 'dwm-entry-title-text').map(n => n.textContent);
    assert.deepEqual(titles, ['乙', '丙'], 'only entries that differ from the source book, or were made by 鱼忆');
    f.focus('chip-constant').click();
    assert.deepEqual(walk(f.root).filter(n => n.className === 'dwm-entry-title-text').map(n => n.textContent), [], 'filters combine');
});

test('multi-select ticks rows in the list, extends with Shift and applies one batch', async t => {
    const f = fixture(); t.after(() => f.panel.destroy());
    f.button('多选').click();
    f.focus('entry-a').click();
    f.focus('entry-c').click({ shiftKey: true });
    assert.match(f.root.textContent, /已选 3 条/);
    f.focus('pick-b').click();
    assert.match(f.root.textContent, /已选 2 条/, 'ticking a box toggles it');
    f.focus('batch-onDemand').click(); await tick();
    assert.deepEqual(f.calls, [['tiers', ['a', 'c'], 'onDemand']]);
    assert.ok(f.find(n => n.tagName === 'BUTTON' && n.textContent === '多选'), 'the list leaves select mode after applying');
});

test('the more menu opens the export and import dialogs', async t => {
    const f = fixture({ exportMemory: () => ({ entries: {} }), supplementaryBooks: () => [] }); t.after(() => f.panel.destroy());
    f.focus('more-menu').click();
    f.focus('more-导出为世界书').click();
    assert.match(f.root.textContent, /导出为世界书把鱼忆改过的世界书存成一本新的酒馆世界书/);
    f.button('取消').click();
    f.focus('more-menu').click(); f.focus('more-导入旧总结').click();
    assert.match(f.root.textContent, /导入旧总结/);
    assert.ok(f.find(n => n.dataset.focus === 'supplement-file'), 'without attached books, a local file is the source');
    assert.equal(f.button('导入').disabled, true, 'nothing to import until a file is read');
});

test('a background refresh keeps the scroll position of every page', t => {
    const f = fixture(); t.after(() => f.panel.destroy());
    const scrollers = () => walk(f.root).filter(n => n.dataset.scroll);
    const hook = () => { for (const node of scrollers()) { node.getClientRects = () => [{}]; } };
    for (const [tab, key] of [['tab-round', 'content-round-'], ['tab-log', 'content-log-memory'], ['tab-settings', 'settings-basic']]) {
        f.focus(tab).click(); hook();
        const node = scrollers().find(n => n.dataset.scroll === key);
        assert.ok(node, `${key} is a remembered scroll area`);
        node.scrollTop = 240;
        f.panel.render(); hook();
        assert.equal(scrollers().find(n => n.dataset.scroll === key).scrollTop, 240, `${key} survives a rerender`);
    }
});

test('an error offers the problem export, and a refused entry says why it is unscanned', async t => {
    let exported = 0;
    const f = fixture({ traces: { snapshot: () => ({ records: [] }), subscribe: () => () => {} } }, { exportProblem: async () => { exported++; return { format: 'x' }; } });
    t.after(() => f.panel.destroy());
    f.entries.e = entry('e', '戊', { enabled: false, status: 'deferred', scanBlocked: true, segments: segment('戊正文', false) });
    f.view.status = '初始化未完成，保留原资料'; f.view.error = '辅助模型的服务方拦下了这次请求（内容审核：PROHIBITED_CONTENT），没有生成结果。';
    f.panel.render();
    f.focus('entry-e').click();
    assert.match(f.root.textContent, /戊未扫描/, 'the row is marked');
    assert.match(f.root.textContent, /辅助接口拒收，未扫描/);
    assert.match(f.root.textContent, /酒馆仍按原世界书的设置发送/);
    f.focus('error-export-problem').click(); await tick();
    assert.equal(exported, 1, 'the error box starts the same export as the 收发 page');
    assert.match(f.root.textContent, /记忆改动收发/, 'and opens the 收发 page where its download link appears');
});

test('an author gate shows a scan-judged important entry as on demand, and says why', t => {
    const f = fixture(); t.after(() => f.panel.destroy());
    f.entries.g = entry('g', '己', { important: true });
    f.entries.h = entry('h', '庚', { important: true, tier: 'constant' });
    f.view.save.scannedTiers = { g: 'constant', h: 'constant' };
    f.view.gateIds = ['g', 'h', 'a'];
    f.panel.render();
    const lampOf = id => walk(f.focus(`lamp-${id}`)).map(n => n.className).join(' ');
    assert.match(lampOf('g'), /dwm-lamp-onDemand/, 'the gate is not opened by the scan alone');
    assert.match(lampOf('h'), /dwm-lamp-constant/, 'a player-set constant passes the gate');
    assert.match(lampOf('a'), /dwm-lamp-constant/, 'so does a source blue lamp');
    f.focus('entry-g').click();
    assert.match(f.root.textContent, /作者规则要求它的关键词出现后才可选/);
    assert.doesNotMatch(f.root.textContent, /扫描时为常驻/, 'no restore offer that would change nothing');
});
