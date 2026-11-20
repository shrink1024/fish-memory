import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackCopy } from '../src/ui/fallback-copy.js';
import { createFallbackDialog } from '../src/ui/fallback-dialog.js';

class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; this.className = ''; this._text = ''; this.open = false; this.attrs = {}; }
    set textContent(v) { this._text = String(v); this.children = []; } get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    append(...xs) { for (const x of xs) { x.parent = this; this.children.push(x); } }
    replaceChildren() { this.children = []; this._text = ''; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    setAttribute(k, v) { this.attrs[k] = v; }
    show() { this.open = true; } close() { this.open = false; } focus() {}
    click() { for (const fn of this.listeners.click ?? []) fn({}); }
}
const walk = n => [n, ...n.children.flatMap(walk)];
function fixture() {
    const doc = { body: new El('body'), createElement: tag => new El(tag) };
    let selecting = false; const listeners = new Set(), calls = [];
    const ui = createFallbackDialog(doc, { openManager: () => calls.push('open'), stop: () => calls.push('stop'), isSelecting: () => selecting,
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } });
    const buttons = () => walk(doc.body).filter(n => n.tagName === 'BUTTON');
    const press = label => { const b = buttons().find(n => n.textContent === label); assert.ok(b, `missing ${label}`); b.click(); };
    return { doc, ui, calls, buttons, press, text: () => doc.body.textContent, setSelecting: v => { selecting = v; for (const fn of listeners) fn(); } };
}

test('copy explains the reason and never offers a retry that must fail again', () => {
    const source = fallbackCopy(new Error('原书已变化：请先在“资料”页同步变化的条目，或选择本轮按原世界书发送。'));
    assert.equal(source.reason, 'source'); assert.ok(!source.actions.includes('retry')); assert.ok(source.actions.includes('sync'));
    const rebound = fallbackCopy(Object.assign(new Error('x'), { kind: 'source-rebound', dwmSourceRebound: true }));
    assert.equal(rebound.reason, 'rebound'); assert.ok(!rebound.actions.includes('retry'));
    assert.equal(fallbackCopy(Object.assign(new Error('quota'), { kind: 'quota', httpStatus: 402 })).reason, 'quota');
    const connection = fallbackCopy(Object.assign(new Error('辅助接口网关等待超时'), { httpStatus: 504, kind: 'timeout' }));
    assert.equal(connection.primary, 'retry'); assert.match(connection.body, /HTTP 504/);
    assert.equal(fallbackCopy(Object.assign(new Error('bad'), { dwmResponseInvalid: true })).reason, 'output');
    assert.equal(fallbackCopy(new Error('奇怪的错误')).reason, 'other');
});

test('retry keeps the dialog open with progress, closes on success and shows a new reason on failure', async () => {
    const f = fixture();
    const first = f.ui.choose(Object.assign(new Error('timeout'), { kind: 'timeout' }));
    assert.match(f.text(), /没能连上辅助模型/);
    f.setSelecting(true); f.press('重新选材（调用模型）');
    assert.equal(await first, 'retry');
    assert.equal(f.ui.element?.open, true); assert.match(f.text(), /正在重新选材/);
    // The retry fails again: the same dialog shows the new reason.
    const second = f.ui.choose(new Error('原书已变化：请先同步。'));
    assert.match(f.text(), /原世界书有更新/); assert.doesNotMatch(f.text(), /正在重新选材/);
    f.press('停止本轮，去同步');
    assert.equal(await second, 'cancel'); assert.deepEqual(f.calls, ['open']); assert.equal(f.ui.element, null);
    // A retry that succeeds closes the dialog once selection has ended.
    const third = f.ui.choose(Object.assign(new Error('timeout'), { kind: 'timeout' }));
    f.press('重新选材（调用模型）'); assert.equal(await third, 'retry'); assert.equal(f.ui.retrying, true);
    f.setSelecting(false); assert.equal(f.ui.element, null);
});

test('the dialog is non-modal, can open the manager without answering, and an aborted send closes it', async () => {
    const f = fixture(), controller = new AbortController();
    const pending = f.ui.choose(Object.assign(new Error('x'), { kind: 'source-rebound' }), { signal: controller.signal });
    f.press('打开鱼忆查看'); assert.deepEqual(f.calls, ['open']); assert.equal(f.ui.element?.open, true);
    controller.abort(); assert.equal(await pending, 'cancel'); assert.equal(f.ui.element, null);
});
