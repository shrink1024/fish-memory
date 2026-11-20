import test from 'node:test';
import assert from 'node:assert/strict';
import { createRerollDialog } from '../src/ui/reroll-dialog.js';

class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this.open = false; this.attrs = {}; }
    set textContent(v) { this._text = String(v); this.children = []; } get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    append(...xs) { for (const x of xs) { x.parent = this; this.children.push(x); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(x => x !== fn); }
    setAttribute(k, v) { this.attrs[k] = v; }
    show() { this.open = true; } close() { this.open = false; } focus() {}
    click() { for (const fn of this.listeners.click ?? []) fn({}); }
    fire(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
}
const walk = n => [n, ...n.children.flatMap(walk)];
function fixture() {
    const doc = { body: new El('body'), createElement: tag => new El(tag) };
    const ui = createRerollDialog(doc);
    const press = label => { const b = walk(doc.body).find(n => n.tagName === 'BUTTON' && n.textContent === label); assert.ok(b, `missing ${label}`); b.click(); };
    return { doc, ui, press, text: () => doc.body.textContent, dialog: () => walk(doc.body).find(n => n.tagName === 'DIALOG') };
}

test('asks with the last picks and resolves reuse or refresh, then closes', async () => {
    const f = fixture();
    const entries = [1, 2, 3, 4, 5, 6].map(n => ({ id: `e${n}`, title: `条目${n}` }));
    const first = f.ui.present({ type: 'swipe', count: 6, entries });
    assert.match(f.text(), /生成新回复：沿用上次挑选的资料吗/);
    assert.match(f.text(), /挑选了 6 条资料：「条目1」.*「条目5」 等 6 条/);
    f.press('重新挑选');
    assert.equal(await first, 'refresh');
    assert.equal(f.dialog(), undefined);
    const second = f.ui.present({ type: 'regenerate', count: 0, entries: [] });
    assert.match(f.text(), /重新生成：.*没有为这一轮挑选按需资料/);
    f.press('沿用上次');
    assert.equal(await second, 'reuse');
});

test('Esc and abort settle as undefined so generation never hangs', async () => {
    const f = fixture();
    const esc = f.ui.present({ type: 'regenerate', count: 1, entries: [{ id: 'a', title: 'A' }] });
    f.dialog().fire('keydown', { key: 'Escape', preventDefault() {} });
    assert.equal(await esc, undefined);
    const controller = new AbortController();
    const aborted = f.ui.present({ type: 'regenerate', count: 1, entries: [], signal: controller.signal });
    controller.abort();
    assert.equal(await aborted, undefined);
    assert.equal(f.dialog(), undefined);
    const replaced = f.ui.present({ type: 'regenerate' });
    const latest = f.ui.present({ type: 'swipe' });
    assert.equal(await replaced, undefined);
    f.ui.destroy();
    assert.equal(await latest, undefined);
});
