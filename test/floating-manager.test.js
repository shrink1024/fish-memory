import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloatingManager } from '../src/ui/floating-manager.js';

class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    fire(type, input = {}) {
        const event = { type, target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...input };
        for (const fn of this.listeners.get(type) ?? []) fn(event);
        return event;
    }
    get listenerCount() { return [...this.listeners.values()].reduce((sum, list) => sum + list.size, 0); }
}
class Element extends Target {
    constructor(tag, doc) {
        super(); this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {}; this.attributes = {};
        this.style = { setProperty(key, value) { this[key] = value; } }; this.hidden = false; this.textContent = '';
        this.classList = { toggle: () => {} }; this.rect = {};
    }
    append(...nodes) { for (const node of nodes) { node.parentNode?.removeChild(node); node.parentNode = this; this.children.push(node); } }
    removeChild(node) { this.children = this.children.filter(item => item !== node); node.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    get isConnected() { return Boolean(this.parentNode?.isConnected); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    removeAttribute(key) { delete this.attributes[key]; }
    focus() { this.ownerDocument.activeElement = this; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 112, height: 58, right: 112, bottom: 58, ...this.rect }; }
    setPointerCapture() {}
    releasePointerCapture() {}
    querySelector() { return null; }
}
function fixture({ saved, storageError = false, tauriHost } = {}) {
    const win = new Target(); win.__TAURITAVERN__ = tauriHost; win.innerWidth = 375; win.innerHeight = 812;
    win.visualViewport = new Target(); Object.assign(win.visualViewport, { width: 375, height: 812, offsetLeft: 0, offsetTop: 0 });
    win.getComputedStyle = () => ({ paddingTop: '20px', paddingRight: '8px', paddingBottom: '24px', paddingLeft: '8px' });
    const doc = new Target(); doc.defaultView = win; doc.createElement = tag => new Element(tag, doc); doc.createElementNS = (_, tag) => new Element(tag, doc);
    doc.body = doc.createElement('body'); Object.defineProperty(doc.body, 'isConnected', { value: true });
    doc.querySelector = () => null;
    let value = saved; const writes = [];
    const storage = { getItem() { if (storageError) throw Error('unavailable'); return value; }, setItem(key, next) { if (storageError) throw Error('unavailable'); value = next; writes.push({ key, value: JSON.parse(next) }); } };
    const ui = createFloatingManager(doc, { window: win, storage });
    const all = node => [node, ...node.children.flatMap(all)];
    const get = className => all(ui.element).find(node => node.className?.split(' ').includes(className));
    return { ui, win, doc, get, writes };
}

test('manager uses a nonmodal persistent surface and restores focus after collapse', () => {
    const f = fixture(), entry = f.doc.createElement('button'), draft = f.doc.createElement('textarea');
    f.doc.body.append(entry); f.ui.body.append(draft); draft.value = '尚未保存的草稿'; f.ui.bindEntry(entry);
    assert.equal(f.ui.panel.tagName, 'SECTION'); assert.equal(f.ui.panel.hidden, true);
    entry.fire('click'); assert.equal(f.ui.panel.hidden, false); assert.equal(entry.getAttribute('aria-expanded'), 'true');
    assert.equal(f.ui.panel.getAttribute('aria-modal'), 'false');
    f.doc.fire('keydown', { key: 'Escape' });
    assert.equal(f.ui.panel.hidden, true); assert.equal(f.ui.bubble.hidden, false); assert.equal(f.doc.activeElement, entry);
    f.ui.bubble.fire('click'); assert.equal(f.ui.body.children[0], draft); assert.equal(draft.value, '尚未保存的草稿');
    f.get('dwm-management-close').fire('click'); assert.equal(f.doc.activeElement, f.ui.bubble);
    assert.equal(entry.getAttribute('aria-expanded'), 'false'); f.ui.destroy();
});

test('small pointer movements remain taps, while dragging snaps, persists and does not open', () => {
    const f = fixture();
    f.ui.bubble.fire('pointerdown', { button: 0, pointerId: 1, clientX: 320, clientY: 400 });
    f.win.fire('pointermove', { pointerId: 1, clientX: 322, clientY: 402 });
    f.win.fire('pointerup', { pointerId: 1 }); f.ui.bubble.fire('click', { detail: 1 });
    assert.equal(f.ui.panel.hidden, false); f.ui.close();
    f.ui.bubble.fire('pointerdown', { button: 0, pointerId: 2, clientX: 320, clientY: 400 });
    f.win.fire('pointermove', { pointerId: 2, clientX: 28, clientY: 300 });
    f.win.fire('pointerup', { pointerId: 2 }); f.ui.bubble.fire('click', { detail: 1 });
    assert.equal(f.ui.panel.hidden, true); assert.equal(f.writes.at(-1).value.edge, 'left');
    assert.equal(f.ui.bubble.style.left, '8px');
    f.ui.bubble.fire('pointerdown', { button: 0, pointerId: 3, clientX: 28, clientY: 300 });
    f.win.fire('pointerup', { pointerId: 3 }); f.ui.bubble.fire('click', { detail: 1 });
    assert.equal(f.ui.panel.hidden, false); f.ui.destroy();
});

test('keyboard and single tap position controls work without dragging', () => {
    const f = fixture(); f.ui.open();
    const position = f.get('dwm-bubble-position'); position.value = 'left:0.2'; position.fire('change');
    assert.equal(f.writes.at(-1).value.edge, 'left'); assert.equal(f.writes.at(-1).value.fraction, 0.2);
    f.ui.close(); f.ui.bubble.fire('keydown', { key: 'ArrowRight', shiftKey: true });
    assert.equal(f.writes.at(-1).value.edge, 'right'); f.ui.destroy();
});

test('viewport resize and keyboard pan keep the bubble visible without rewriting the saved dock', () => {
    const f = fixture({ saved: JSON.stringify({ edge: 'right', fraction: 0.95 }) });
    Object.assign(f.win.visualViewport, { width: 320, height: 280, offsetLeft: 5, offsetTop: 120 });
    f.win.visualViewport.fire('resize'); f.win.visualViewport.fire('scroll');
    assert.equal(f.ui.element.style.width, '320px'); assert.equal(f.ui.element.style.top, '120px');
    assert.ok(parseFloat(f.ui.bubble.style.top) >= 20); assert.ok(parseFloat(f.ui.bubble.style.top) + 58 <= 256);
    assert.equal(f.writes.length, 0); f.ui.destroy();
});

test('bubble stays above the host composer and ignores offscreen composer geometry', () => {
    const f = fixture({ saved: JSON.stringify({ edge: 'right', fraction: 1 }) });
    f.doc.querySelector = () => ({ getBoundingClientRect: () => ({ top: 600, bottom: 812, width: 375, height: 212 }) });
    f.win.fire('resize'); assert.ok(parseFloat(f.ui.bubble.style.top) + 58 <= 592);
    f.doc.querySelector = () => ({ getBoundingClientRect: () => ({ top: -300, bottom: -100, width: 375, height: 200 }) });
    f.win.fire('resize'); assert.ok(parseFloat(f.ui.bubble.style.top) > 400); f.ui.destroy();
});

test('state labels remain short and do not disclose chat text or hide the recovery entry', () => {
    const f = fixture(); f.ui.render({ enabled: true, initialized: true, pendingCount: 9 });
    assert.equal(f.get('dwm-bubble-status').textContent, '9 条待补记');
    f.ui.render({ enabled: true, activityClaimed: true, activity: { label: '私有剧情，不应出现在气泡', phase: 'running' } });
    assert.equal(f.get('dwm-bubble-status').textContent, '正在处理'); assert.equal(f.ui.bubble.hidden, false, 'a card claiming the activity line must not hide the manager entry');
    f.ui.render({ enabled: true, error: 'secret response' }); assert.equal(f.get('dwm-bubble-status').textContent, '需要处理');
    f.ui.render({ enabled: false }); assert.equal(f.get('dwm-bubble-status').textContent, '已暂停'); assert.equal(f.ui.bubble.hidden, false);
    f.ui.destroy();
});

test('blocked or malformed browser storage cannot break the manager', () => {
    for (const options of [{ storageError: true }, { saved: '{oops' }, { saved: '{"edge":"up","fraction":null}' }]) {
        const f = fixture(options); f.ui.open(); assert.equal(f.ui.panel.hidden, false); f.ui.destroy();
    }
});

test('destroy removes every viewport, pointer and entry listener and is idempotent', () => {
    const f = fixture(), entry = f.doc.createElement('button'); f.doc.body.append(entry); f.ui.bindEntry(entry);
    assert.ok(f.win.listenerCount > 0); f.ui.destroy(); f.ui.destroy();
    assert.equal(f.win.listenerCount, 0); assert.equal(f.win.visualViewport.listenerCount, 0); assert.equal(f.doc.listenerCount, 0);
    assert.equal(entry.listenerCount, 0); assert.equal(f.ui.element.isConnected, false); entry.fire('click');
});

function ttLayout() {
    let listener, disposed = 0;
    const snapshot = { viewport: { left: 0, top: 0, width: 375, height: 812 },
        safeInsets: { top: 44, right: 12, bottom: 34, left: 12 }, ime: { keyboardOffset: 0 } };
    const host = { ready: Promise.resolve(), api: { layout: { subscribe: handler => { listener = handler; handler(snapshot); return () => { disposed++; }; } } } };
    return { host, snapshot, emit() { listener(snapshot); }, get disposed() { return disposed; } };
}
const settleLayout = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('TT native keyboard inset shrinks the reachable surface without changing dock preference', async () => {
    const tt = ttLayout(), f = fixture({ tauriHost: tt.host, saved: JSON.stringify({ edge: 'right', fraction: 1 }) });
    await settleLayout();
    assert.equal(f.ui.panel.dataset.ttMobileSurface, 'free-window');
    assert.equal(f.ui.bubble.dataset.ttMobileSurface, 'free-window');
    assert.equal(f.ui.element.dataset.ttMobileSurface, 'none');
    tt.snapshot.ime.keyboardOffset = 286; tt.emit();
    assert.equal(f.win.visualViewport.height, 812);
    assert.equal(f.ui.element.style.height, '526px');
    assert.ok(parseFloat(f.ui.bubble.style.top) >= 44);
    assert.ok(parseFloat(f.ui.bubble.style.top) + 58 < 526 - 34);
    assert.equal(f.writes.length, 0);
    tt.snapshot.ime.keyboardOffset = 0; tt.emit();
    assert.equal(f.ui.element.style.height, '812px');
    f.ui.destroy(); assert.equal(tt.disposed, 1);
});

test('TT layout supports landscape safe areas and viewport pan without double keyboard subtraction', async () => {
    const tt = ttLayout(), f = fixture({ tauriHost: tt.host }); await settleLayout();
    Object.assign(tt.snapshot.viewport, { width: 812, height: 220, left: 5, top: 90 });
    Object.assign(tt.snapshot.safeInsets, { top: 0, left: 44, right: 44, bottom: 21 });
    tt.emit();
    assert.equal(f.ui.element.style.height, '220px'); assert.equal(f.ui.element.style.top, '90px');
    assert.equal(f.ui.bubble.style.left, '656px');
    f.ui.destroy();
});

test('TT late subscription cleanup cannot revive a destroyed floating manager', async () => {
    let resolve, release, disposed = 0;
    const ready = new Promise(done => { resolve = done; });
    const subscription = new Promise(done => { release = done; });
    const tt = ttLayout(); tt.host.ready = ready;
    tt.host.api.layout.subscribe = handler => { handler(tt.snapshot); return subscription; };
    const f = fixture({ tauriHost: tt.host }); resolve(); await settleLayout();
    f.ui.destroy(); release(() => { disposed++; }); await settleLayout();
    assert.equal(disposed, 1); assert.equal(f.ui.element.isConnected, false);
});

test('destroying before TT readiness prevents subscription and native ST remains unmarked', async () => {
    let resolve, subscribed = 0;
    const ready = new Promise(done => { resolve = done; });
    const f = fixture({ tauriHost: { ready, api: { layout: { subscribe() { subscribed++; } } } } });
    f.ui.destroy(); resolve(); await settleLayout(); assert.equal(subscribed, 0);
    const st = fixture(); assert.equal(st.ui.panel.dataset.ttMobileSurface, undefined); st.ui.destroy();
});

test('TT keyboard layout scrolls only the manager body to reveal its focused field', async () => {
    const tt = ttLayout(), f = fixture({ tauriHost: tt.host }); await settleLayout(); f.ui.open();
    const field = f.doc.createElement('input'); f.ui.body.append(field); field.focus();
    f.ui.body.scrollTop = 0; f.ui.body.rect = { top: 100, bottom: 450 };
    field.rect = { top: 480, bottom: 520 };
    tt.snapshot.ime.keyboardOffset = 286; tt.emit();
    assert.equal(f.ui.body.scrollTop, 82);
    assert.equal(f.doc.body.scrollTop, undefined);
    f.ui.destroy();
});
