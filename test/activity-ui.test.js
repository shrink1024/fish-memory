import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityIndicator, elapsedLabel } from '../src/ui/activity.js';

class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.events = {}; this.attributes = {}; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, fn) { this.events[name] = fn; }
    remove() { this.removed = true; }
}
function fixture() {
    let time = 10000, stop;
    const intervals = new Set(), calls = [];
    const doc = { createElement: tag => new Element(tag) };
    const timers = { setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); } };
    const ui = createActivityIndicator(doc, { now: () => time, timers, onStop: id => { calls.push(id); return new Promise(resolve => { stop = resolve; }); } });
    const elements = node => [node, ...node.children.flatMap(elements)];
    const get = className => elements(ui.element).find(n => n.className === className);
    return { ui, get, calls, intervals, finishStop: () => stop?.(), advance(ms) { time += ms; for (const fn of intervals) fn(); } };
}
const view = (activity, extra = {}) => ({ save: { id: 'chat-a' }, activity, status: '可用', ...extra });
const activity = (extra = {}) => ({ id: 'task-1', label: '正在选取本轮资料', startedAt: 10000, phase: 'running', cancellable: true, stopLabel: '停止本轮', hint: '下一步生成正文', ...extra });

test('elapsed feedback is real duration and does not invent a completion percentage', () => {
    assert.equal(elapsedLabel(0, 61000), '1 分 1 秒');
    assert.equal(elapsedLabel('invalid'), '');
    assert.equal(elapsedLabel(10000, 9000), '0 秒');
});

test('task feedback updates the clock in place and sends the visible task identity once', async () => {
    const f = fixture(); f.ui.render(view(activity()));
    const button = f.get('dwm-activity-stop'), copy = f.get('dwm-activity-copy');
    assert.equal(f.ui.element.hidden, false); assert.equal(f.intervals.size, 1);
    f.advance(15000);
    assert.equal(f.get('dwm-activity-clock').textContent, '15 秒');
    assert.equal(f.get('dwm-activity-copy'), copy);
    const stopping = button.events.click(); await button.events.click();
    assert.deepEqual(f.calls, ['task-1']); assert.equal(button.disabled, true);
    f.ui.render(view(null, { status: '本次维护已停止，原文保留' }));
    f.finishStop(); await stopping;
    assert.match(f.get('dwm-activity-label').textContent, /已停止/);
    assert.equal(f.intervals.size, 0);
    f.get('dwm-activity-dismiss').events.click(); assert.equal(f.ui.element.hidden, true);
    f.ui.destroy();
});

test('saving is visibly noncancellable and a late stop completion cannot change the newer task', async () => {
    const f = fixture();
    f.ui.render(view(activity({ cancellable: false, label: '正在保存记忆', hint: '保存结束后可以继续' })));
    assert.equal(f.get('dwm-activity-stop').disabled, true);
    await f.get('dwm-activity-stop').events.click(); assert.deepEqual(f.calls, []);
    f.ui.render(view(activity())); const stopping = f.get('dwm-activity-stop').events.click();
    f.ui.render(view(activity({ id: 'task-2', label: '正在维护新一轮' })));
    f.finishStop(); await stopping;
    assert.equal(f.get('dwm-activity-stop').disabled, false);
    assert.match(f.get('dwm-activity-label').textContent, /新一轮/);
    f.ui.render(view(null, { save: { id: 'another-chat' } }));
    assert.equal(f.ui.element.hidden, true); assert.equal(f.intervals.size, 0);
    f.ui.destroy();
});

test('successful feedback folds automatically while failure and paused work retain a recovery action', async () => {
    const deadlines = new Map(); let id = 0, recovered = 0;
    const timers = { setInterval: () => 1, clearInterval() {}, setTimeout(fn) { deadlines.set(++id, fn); return id; }, clearTimeout(key) { deadlines.delete(key); } };
    const ui = createActivityIndicator({ createElement: tag => new Element(tag) }, { timers, onRecover: async () => { recovered++; } });
    const all = node => [node, ...node.children.flatMap(all)];
    const get = name => all(ui.element).find(node => node.className === name);
    ui.render(view(activity())); ui.render(view(null, { status: '补记已完成' }));
    assert.equal(deadlines.size, 1); assert.equal(ui.element.hidden, false);
    [...deadlines.values()][0](); assert.equal(ui.element.hidden, true);
    ui.render(view(activity({ id: 'again', kind: 'maintain' }))); ui.render(view(null, { error: '502', save: { id: 'chat-a', initialized: true }, enabled: true }));
    assert.equal(get('dwm-activity-recover').hidden, false);
    await get('dwm-activity-recover').events.click(); assert.equal(recovered, 1);
    assert.equal(ui.element.hidden, false);
    ui.destroy();
});

test('automatic initialization waiting and failed attempts are visible without first opening the manager', async () => {
    let recovered;
    const ui = createActivityIndicator({ createElement: tag => new Element(tag) }, { timers: {}, onRecover: kind => { recovered = kind; } });
    const all = node => [node, ...node.children.flatMap(all)];
    const get = name => all(ui.element).find(node => node.className === name);
    const pending = { state: 'waiting', message: '辅助模型尚未连接；连接后自动建档', retry: false };
    ui.render(view(null, { initialization: pending, enabled: true }));
    assert.equal(ui.element.hidden, false); assert.match(get('dwm-activity-label').textContent, /辅助模型尚未连接/);
    assert.equal(get('dwm-activity-recover').hidden, true);
    get('dwm-activity-dismiss').events.click(); ui.render(view(null, { initialization: pending, enabled: true }));
    assert.equal(ui.element.hidden, true, 'dismissed waiting notices stay dismissed until their reason changes');
    ui.render(view(null, { initialization: { state: 'retry', message: '初始化未完成，可手动重试', retry: true }, enabled: true }));
    assert.equal(ui.element.hidden, false); assert.equal(get('dwm-activity-recover').hidden, false);
    await get('dwm-activity-recover').events.click(); assert.equal(recovered, 'initialize');
    ui.render(view(null, { initialization: { state: 'retry', message: '初始化未完成，可手动重试', retry: true }, enabled: false }));
    assert.equal(ui.element.hidden, true);
    ui.destroy();
});
