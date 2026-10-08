import test from 'node:test';
import assert from 'node:assert/strict';
import { readableValue, valueChildren, splitTraceText, splitStructuredText, traceMessages, filterTraceRecords, selectedTraceId, createTraceViewer } from '../src/ui/trace-viewer.js';
import { mountPanel } from '../src/ui/panel.js';

test('readable JSON preserves prose and leaves malformed or executable text inert', () => {
    assert.deepEqual(readableValue('```json\n{"title":"车站","content":"灯亮了。"}\n```'), { title: '车站', content: '灯亮了。' });
    for (const text of ['前文 {"a":1} 后文', '{"partial":', '<script>alert(1)</script>', '```js\nalert(1)\n```']) assert.equal(readableValue(text), text);
    const values = valueChildren([{ title: '旧港', content: '海雾未散' }, { name: '旅人' }, { comment: '铁律' }, { id: 'npc-4' }]);
    assert.deepEqual(values.map(item => item.label), ['旧港', '旅人', '铁律', 'npc-4']);
    assert.equal(valueChildren({ summary: '仍在旧港。' })[0].label, '故事脉络');
});

test('provenance is exact and lossless; ambiguous duplicates and overlaps stay unattributed', () => {
    const raw = '序言\n【旧港】灯亮了。\n结束';
    const parts = splitTraceText(raw, [{ title: '旧港', text: '【旧港】灯亮了。' }, { title: '不在原文', text: '灯灭了。' }]);
    assert.equal(parts.map(part => part.text).join(''), raw);
    assert.equal(parts.filter(part => part.matched)[0].title, '旧港');
    assert.ok(!splitTraceText('重复重复', [{ title: 'A', text: '重复' }]).some(part => part.matched));
    assert.ok(!splitTraceText('abcdef', [{ title: 'A', text: 'abcde' }, { title: 'B', text: 'bcd' }]).some(part => part.matched));
    assert.ok(!splitTraceText('单段', [{ title: 'A', text: '单段' }, { title: 'B', text: '单段' }]).some(part => part.matched));
});

test('actual messages retain roles, ordering, tool calls and multiple output choices', () => {
    const messages = [{ role: 'system', content: '规则' }, { role: 'user', content: '行动' }];
    assert.deepEqual(traceMessages({ request: { messages } }).map(({ index, ...message }) => message), messages);
    assert.equal(traceMessages({ request: { prompt: 'text completion prompt' } })[0].content, 'text completion prompt');
    const choices = [{ index: 0, message: { role: 'assistant', content: '正文', tool_calls: [{ id: 't1' }] } }, { index: 1, message: { content: '另一版', reasoning_content: '返回的思考' } }];
    const result = traceMessages({ responseBody: { choices } }, 'output');
    assert.deepEqual(result[0].tool_calls, [{ id: 't1' }]); assert.equal(result[1].choiceIndex, 1);
    assert.equal(result[1].reasoning_content, '返回的思考');
    assert.equal(traceMessages({ responseBody: { messages: [{ role: 'assistant', content: '流式正文', reasoning: '实际返回' }] } }, 'output')[0].reasoning, '实际返回');
    assert.equal(traceMessages({ responseRaw: 'invalid provider text' }, 'output')[0].content, 'invalid provider text');
    assert.equal(traceMessages({ request: { messages: [null, 'malformed input'] } })[1].content, 'malformed input');
    assert.equal(traceMessages({ responseBody: { choices: [null] } }, 'output')[0].content, null);
});

test('large collections are paged and stable selection ignores newly arriving records', () => {
    const entries = Array.from({ length: 5000 }, (_, i) => ({ title: `条目 ${i}`, content: '正文' }));
    assert.equal(valueChildren(entries).length, 30);
    assert.equal(valueChildren(entries, 30, 1000).length, 50);
    assert.equal(valueChildren(entries, 30)[0].label, '条目 30');
    const records = [{ id: 'a', source: '鱼忆', label: '选材', request: { prompt: '雨夜' } }, { id: 'b', label: '外部', responseRaw: '清晨' }];
    assert.equal(selectedTraceId(records, 'a'), 'a');
    assert.equal(selectedTraceId(records, 'gone'), 'b');
    assert.deepEqual(filterTraceRecords(records, '', '雨夜').map(record => record.id), ['a']);
    assert.deepEqual(filterTraceRecords(records, '来源未确认').map(record => record.id), ['b']);
    assert.deepEqual(filterTraceRecords(records).map(record => record.id), ['b', 'a']);
});

// Small DOM contract fixture: tests safety, lifecycle and interaction without a browser dependency.
class Node {
    constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {}; this.events = {}; this.attributes = {}; this.className = ''; this.scrollTop = 0; this.scrollLeft = 0; this._text = ''; this.classList = { add: name => { this.className += ` ${name}`; } }; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children.forEach(child => { child.parent = null; }); this.children = []; this._text = ''; this.append(...children); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, callback) { (this.events[name] ??= []).push(callback); }
    removeEventListener(name, callback) { this.events[name] = (this.events[name] ?? []).filter(item => item !== callback); }
    dispatch(name) { for (const callback of this.events[name] ?? []) callback({ target: this }); }
    click() { this.dispatch('click'); }
    focus() { this.ownerDocument.activeElement = this; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) { return walk(this).filter(node => selector === '[data-focus]' && node.dataset.focus); }
}
const walk = root => root.children.flatMap(child => [child, ...walk(child)]);
function fixture(records = []) {
    const listeners = new Set(); let reads = 0;
    const doc = { activeElement: null, createElement(tag) { return new Node(tag, this); } };
    const store = { records, snapshot() { reads++; return { records: this.records, totalChars: 50 }; }, subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); }, clear() { this.records = []; this.notify(); }, notify() { for (const fn of listeners) fn(); } };
    return { doc, store, listeners, reads: () => reads, viewer: createTraceViewer(doc, store) };
}
const findButton = (root, name) => walk(root).find(node => node.tagName === 'BUTTON' && node.textContent === name);

test('hidden viewer does no work; raw HTML is always literal and requests never take over selection', async () => {
    const f = fixture([{ id: 'first', label: '首次请求', request: { messages: [{ role: 'system', content: '<img src=x onerror=alert(1)>' }] }, status: 'completed' }]);
    f.store.notify(); assert.equal(f.reads(), 0);
    f.viewer.setActive(true);
    assert.match(f.viewer.element.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(walk(f.viewer.element).filter(node => ['IMG', 'SCRIPT', 'IFRAME'].includes(node.tagName)).length, 0);
    const reader = walk(f.viewer.element).find(node => node.tagName === 'ARTICLE');
    reader.scrollTop = 177;
    findButton(reader, '原文').focus(); findButton(reader, '原文').click();
    const original = reader.children[0];
    f.store.records.push({ id: 'second', label: '后来请求', request: { prompt: '新内容' } }); f.store.notify();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(reader.children[0], original, 'new request must not rebuild the selected reader');
    assert.equal(reader.scrollTop, 177);
    assert.equal(f.doc.activeElement.textContent, '原文');
    assert.match(reader.textContent, /首次请求/); assert.doesNotMatch(reader.textContent, /后来请求/);
    findButton(f.viewer.element, '清空记录').click(); assert.equal(f.store.records.length, 0);
    f.viewer.destroy(); assert.equal(f.listeners.size, 0);
});

test('message pagination avoids eagerly creating thousands of disclosures and is keyboard friendly', () => {
    const f = fixture([{ id: 'many', request: { messages: Array.from({ length: 2000 }, (_, i) => ({ role: 'user', content: `消息 ${i}` })) } }]);
    f.viewer.setActive(true);
    const reader = walk(f.viewer.element).find(node => node.tagName === 'ARTICLE');
    assert.equal(walk(reader).filter(node => node.tagName === 'DETAILS').length, 30);
    const more = walk(reader).find(node => node.tagName === 'BUTTON' && node.textContent.startsWith('显示后续消息'));
    assert.ok(more); more.click();
    assert.equal(walk(reader).filter(node => node.tagName === 'DETAILS').length, 60);
    assert.ok(walk(reader).filter(node => node.tagName === 'SUMMARY').every(node => node.dataset.focus));
    f.viewer.destroy();
});

test('fifth tab works before initialization and trace updates do not redraw other tabs', async () => {
    const f = fixture([{ id: 'external', label: '外部调用', request: { messages: [{ role: 'user', content: '未初始化也可查看' }] } }]);
    f.viewer.destroy();
    const container = f.doc.createElement('main'); let viewReads = 0;
    const controller = { traces: f.store, view() { viewReads++; return { save: null, settings: { enabled: false }, status: '未初始化' }; }, subscribe() { return () => {}; } };
    const panel = mountPanel(container, controller);
    const initialRoot = container.children[0];
    f.store.notify(); await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(container.children[0], initialRoot); assert.equal(viewReads, 1); assert.equal(f.reads(), 0);
    findButton(container, '收发').click();
    assert.match(container.textContent, /未初始化也可查看/);
    assert.equal(walk(container).filter(node => node.attributes.role === 'tab').length, 5);
    const readCount = viewReads; f.store.records.push({ id: 'next', request: { prompt: '新请求' } }); f.store.notify();
    await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(viewReads, readCount);
    panel.destroy(); assert.equal(f.listeners.size, 0);
});

test('boundary records explain their capture scope and successful transport cannot hide processing failure', () => {
    const f = fixture([{ id: 'boundary', label: '辅助任务', transport: 'agent-boundary', status: 'completed',
        request: { messages: [{ role: 'user', content: '输入' }] }, responseRaw: 'invalid JSON',
        captureNote: '辅助接口记录，未捕获网络包。', processingError: '模型未返回有效 JSON' }]);
    f.viewer.setActive(true);
    const reader = walk(f.viewer.element).find(node => node.tagName === 'ARTICLE');
    assert.match(reader.textContent, /辅助接口记录，未捕获网络包/);
    assert.match(reader.textContent, /已接收 · 处理失败/);
    assert.match(reader.textContent, /返回内容处理失败：模型未返回有效 JSON/);
    assert.ok(walk(reader).some(node => node.attributes.role === 'alert'));
    findButton(reader, '原文').click();
    assert.match(reader.textContent, /不是网络原始包/);
    assert.doesNotMatch(reader.textContent, /请求正文原文/);
    f.viewer.destroy();
    const simulated = fixture([{ id: 'test', transport: 'test', request: { prompt: '合成' } }]); simulated.viewer.setActive(true);
    assert.match(simulated.viewer.element.textContent, /辅助接口的提交与返回记录，不代表网络原始收发/); simulated.viewer.destroy();
});

test('mixed narration and generic paired JSON tags are split losslessly; invalid or partial tags stay literal', () => {
    const text = '夜雨停了。\n<Choices>["去码头","留下"]</Choices>\n<scene.update>{"location":"旧港"}</scene.update>\n你听见钟声。';
    const parts = splitStructuredText(text);
    assert.equal(parts.map(part => part.raw).join(''), text);
    assert.deepEqual(parts.filter(part => part.kind === 'json').map(part => [part.title, part.value]), [['Choices', ['去码头', '留下']], ['scene.update', { location: '旧港' }]]);
    for (const raw of ['<Choices>[bad]</Choices>', '<Update>{"a":1}', '<script>alert(1)</script>', '<A>{"a":1}</B>']) assert.deepEqual(splitStructuredText(raw), [{ kind: 'text', raw }]);
    assert.equal(splitStructuredText('<A>null</A>')[0].value, null);
});

test('reading folds JSON tag payloads without HTML execution and hides empty reasoning/tool rows; raw stays unchanged', () => {
    const content = '夜雨停了。\n<Choices>["去码头","留下"]</Choices>\n<Update>{"name":"旧港","content":"<img src=x onerror=alert(1)>"}</Update>';
    const response = { messages: [{ role: 'assistant', content, reasoning: '', reasoning_content: '  ', tool_calls: [] }] };
    const raw = JSON.stringify(response);
    const f = fixture([{ id: 'mixed', responseBody: response, responseRaw: raw }]); f.viewer.setActive(true);
    const reader = walk(f.viewer.element).find(node => node.tagName === 'ARTICLE'); findButton(reader, '输出').click();
    assert.match(reader.textContent, /夜雨停了。/);
    const sections = walk(reader).filter(node => node.tagName === 'DETAILS');
    const choices = sections.find(node => node.children[0]?.textContent.startsWith('Choices'));
    const update = sections.find(node => node.children[0]?.textContent.startsWith('Update'));
    assert.ok(choices); assert.equal(choices.open, false); assert.ok(update); assert.equal(update.open, false);
    assert.doesNotMatch(reader.textContent, /模型返回的思考文本|工具调用/);
    choices.open = true; choices.dispatch('toggle'); assert.match(choices.textContent, /去码头/);
    update.open = true; update.dispatch('toggle'); assert.match(update.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(walk(reader).filter(node => ['IMG', 'SCRIPT'].includes(node.tagName)).length, 0);
    findButton(reader, '原文').click();
    assert.equal(walk(reader).find(node => node.tagName === 'PRE').textContent, raw);
    assert.equal(f.store.records[0].responseBody.messages[0].content, content); f.viewer.destroy();
});

test('entry reading puts prose first and folds technical fields plus duplicate titles without losing data', () => {
    const encodedId = 'source:%E7%95%8C%E9%80%94:'.repeat(20);
    const entry = { id: encodedId, key: 'raw-key', title: '旧港灯塔', expectedVersion: 14, unknownDetail: '未知字段仍保留', intro: '海雾中的灯塔', content: '守灯人昨夜已经离开。' };
    const input = JSON.stringify({ entries: [entry] });
    const f = fixture([{ id: 'entry', request: { messages: [{ role: 'user', content: input }] } }]); f.viewer.setActive(true);
    const reader = walk(f.viewer.element).find(node => node.tagName === 'ARTICLE');
    const box = walk(reader).find(node => node.tagName === 'DETAILS' && node.children[0]?.textContent.startsWith('旧港灯塔'));
    assert.ok(box); box.open = true; box.dispatch('toggle');
    const attributes = walk(box).find(node => node.tagName === 'DETAILS' && node.children[0]?.textContent.startsWith('标识与属性'));
    assert.ok(attributes); assert.equal(attributes.open, false);
    const body = box.children[1];
    assert.equal(body.children[0].children[0].textContent, '内容');
    assert.match(body.textContent, /守灯人昨夜已经离开。/); assert.match(body.textContent, /未知字段仍保留/);
    assert.doesNotMatch(body.textContent, /source:|raw-key|expectedVersion|旧港灯塔/);
    attributes.open = true; attributes.dispatch('toggle');
    assert.match(attributes.textContent, /source:%E7/); assert.match(attributes.textContent, /raw-key/);
    assert.match(attributes.textContent, /expectedVersion/); assert.match(attributes.textContent, /14/); assert.match(attributes.textContent, /旧港灯塔/);
    findButton(reader, '原文').click();
    const raw = JSON.parse(walk(reader).find(node => node.tagName === 'PRE').textContent);
    assert.equal(raw.messages[0].content, input); assert.deepEqual(JSON.parse(input).entries[0], entry);
    f.viewer.destroy();
});
