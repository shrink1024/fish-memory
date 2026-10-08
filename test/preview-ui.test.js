import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptPreview } from '../src/ui/prompt-preview.js';

class Node {
    constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {}; this.events = {}; this.attributes = {}; this._text = ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...children); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, fn) { this.events[name] = fn; }
    async click() { if (!this.disabled) await this.events.click?.(); }
    focus() { this.ownerDocument.activeElement = this; }
    querySelector() { return null; }
}
const walk = root => [root, ...root.children.flatMap(walk)];
const button = (root, label) => walk(root).find(node => node.tagName === 'BUTTON' && node.textContent === label);
const data = label => ({ at: '2026-10-06T12:00:00Z', revision: 1, warnings: [], stages: [
    { id: 'select', title: label, agent: { id: 'fish-select', title: '鱼忆 · 前置 Agent', description: '挑选本轮资料。' }, kind: 'request', status: 'conditional', explanation: '按当前草稿', system: '<script>do not execute</script>', input: { messages: [{ role: 'user', content: '草稿正文' }] }, uncertainties: ['选中条目仍未知'] },
] });
function setup(read) {
    const doc = { createElement(tag) { return new Node(tag, this); } };
    const viewer = createPromptPreview(doc, { previewPrompts: read }); viewer.setContext('chat-a'); return viewer;
}

test('preview requires an explicit read, renders uncertainty and never executes HTML', async () => {
    let reads = 0; const viewer = setup(async () => { reads++; return data('前置选材'); });
    assert.equal(reads, 0);
    await button(viewer.element, '刷新预览').click();
    assert.equal(reads, 1); assert.match(viewer.element.textContent, /选中条目仍未知/);
    await button(viewer.element, '原文').click();
    assert.match(viewer.element.textContent, /<script>do not execute<\/script>/);
    assert.match(viewer.element.textContent, /草稿正文/);
    assert.equal(walk(viewer.element).some(node => ['SCRIPT', 'IFRAME', 'IMG'].includes(node.tagName)), false);
});

test('switching chats discards a late preview and clears old content', async () => {
    let resolve; const viewer = setup(() => new Promise(done => { resolve = done; }));
    const refresh = button(viewer.element, '刷新预览'); const pending = refresh.click();
    viewer.setContext('chat-b'); resolve(data('旧档不许显示')); await pending;
    assert.doesNotMatch(viewer.element.textContent, /旧档不许显示/); assert.equal(refresh.disabled, false);
});

test('failed refresh clears the previous snapshot rather than presenting it as current', async () => {
    let failure = false; const viewer = setup(async () => { if (failure) throw Error('读取失败'); return data('过期资料'); });
    await button(viewer.element, '刷新预览').click(); assert.match(viewer.element.textContent, /过期资料/);
    failure = true; await button(viewer.element, '刷新预览').click();
    assert.match(viewer.element.textContent, /读取失败/); assert.doesNotMatch(viewer.element.textContent, /过期资料/);
});

test('navigation selects agents first, keeps their stages together and separates narration fragments', async () => {
    const fixture = data('前置选材');
    const post = { id: 'fish-maintain', title: '鱼忆 · 后置 Agent', description: '维护和整理记忆。' };
    const narration = { id: 'narration', title: '正文叙事 Agent', description: '各来源提供的正文片段。' };
    fixture.stages.push(
        { ...fixture.stages[0], id: 'maintain', title: '后置维护', agent: post, system: 'maintenance-only' },
        { ...fixture.stages[0], id: 'compact', title: '整理事件', agent: post, system: 'compact-only' },
        { ...fixture.stages[0], id: 'fish-body', title: '鱼忆记忆', agent: narration, kind: 'injection' },
        { ...fixture.stages[0], id: 'card-body', title: '卡内规则', agent: narration, kind: 'injection' },
    );
    const viewer = setup(async () => fixture); await button(viewer.element, '刷新预览').click();
    const sidebar = walk(viewer.element).find(node => node.attributes['aria-label'] === 'Agent 列表');
    assert.equal(walk(sidebar).filter(node => node.tagName === 'BUTTON').length, 3);
    assert.doesNotMatch(sidebar.textContent, /后置维护|整理事件|卡内规则/);
    assert.match(viewer.element.textContent, /3 个 Agent · 5 个阶段/);
    await button(sidebar, '鱼忆 · 后置 Agent2 个提示词阶段').click();
    await button(viewer.element, '整理事件').click();
    await button(viewer.element, '原文').click();
    assert.match(viewer.element.textContent, /compact-only/); assert.doesNotMatch(viewer.element.textContent, /maintenance-only/);
    await button(sidebar, '正文叙事 Agent2 个注入片段').click();
    assert.match(viewer.element.textContent, /正文注入片段 · 非完整请求/);
    assert.ok(button(viewer.element, '鱼忆记忆')); assert.ok(button(viewer.element, '卡内规则'));
    await button(sidebar, '鱼忆 · 后置 Agent2 个提示词阶段').click();
    assert.match(viewer.element.textContent, /compact-only/);
});

test('unlabelled providers remain inspectable without claiming a known agent', async () => {
    const fixture = data('来源的一个阶段'); delete fixture.stages[0].agent; delete fixture.stages[0].kind;
    fixture.stages[0].provider = { id: 'external', title: '外部卡' };
    const viewer = setup(async () => fixture); await button(viewer.element, '刷新预览').click();
    assert.match(viewer.element.textContent, /外部卡 · 未标注 Agent/);
    assert.match(viewer.element.textContent, /0 个 Agent \/ 1 个来源待标注/);
    assert.match(viewer.element.textContent, /请求类型未标注/);
});
