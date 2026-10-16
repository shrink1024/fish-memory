import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels } from '../src/agents/client.js';
import { Controller } from '../src/runtime/controller.js';
import { mountPanel } from '../src/ui/panel.js';
import { DEFAULT_SETTINGS } from '../src/core/state.js';

const reply = (body, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('model lists are read from OpenAI-style, plain and named payloads, deduplicated and sorted', async () => {
    const seen = [];
    const fetchImpl = async (url, options) => { seen.push([url, options.headers]); return new Response(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }, { id: '' }] })); };
    assert.deepEqual(await listModels({ endpoint: 'https://aux.example/v1/', apiKey: 'k', fetchImpl }), ['a-model', 'b-model']);
    assert.deepEqual(seen, [['https://aux.example/v1/models', { Authorization: 'Bearer k' }]]);
    assert.deepEqual(await listModels({ endpoint: 'https://aux.example/v1', fetchImpl: reply({ models: [{ name: 'x' }] }) }), ['x']);
    assert.deepEqual(await listModels({ endpoint: 'https://aux.example/v1', fetchImpl: reply(['y', 'z']) }), ['y', 'z']);
});

test('model list failures explain the fallback and never block manual entry', async () => {
    await assert.rejects(listModels({ endpoint: 'https://aux.example/v1', fetchImpl: reply('<html>', 404) }), /没有提供模型列表（HTTP 404）.*手动填写/);
    await assert.rejects(listModels({ endpoint: 'https://aux.example/v1', fetchImpl: reply({ data: [] }) }), /为空/);
    await assert.rejects(listModels({ endpoint: 'https://aux.example/v1', fetchImpl: reply({ error: 'x' }, 401) }), /鉴权失败/);
    await assert.rejects(listModels({ endpoint: 'https://aux.example/v1', fetchImpl: async () => { throw new TypeError('Load failed'); } }), /不允许网页直接访问/);
    await assert.rejects(listModels({ endpoint: 'http://remote.example/v1', fetchImpl: reply({ data: [] }) }), /HTTPS/);
});

test('fetching models reuses the saved key only for the same endpoint', async t => {
    const original = globalThis.fetch, headers = [];
    globalThis.fetch = async (url, options) => { headers.push([url, options.headers.Authorization ?? null]); return new Response(JSON.stringify({ data: [{ id: 'm' }] })); };
    t.after(() => { globalThis.fetch = original; });
    const host = { snapshot: () => ({ chatId: null, messages: [] }), rawGenerate: async () => '{}' };
    const c = new Controller(host);
    await c.updateConnection({ mode: 'compatible', endpoint: 'https://aux.example/v1', model: 'm', apiKey: 'sk-secret-123' });
    const result = await c.fetchModels({ endpoint: 'https://aux.example/v1/', apiKey: '' });
    assert.match(result.message, /1 个模型/);
    assert.deepEqual(c.view().modelList, { endpoint: 'https://aux.example/v1', models: ['m'] });
    await c.fetchModels({ endpoint: 'https://other.example/v1', apiKey: '' });
    assert.deepEqual(headers, [['https://aux.example/v1/models', 'Bearer sk-secret-123'], ['https://other.example/v1/models', null]], 'a saved key never goes to another server');
    await assert.rejects(c.fetchModels({ endpoint: ' ' }), /接口基础地址/);
    assert.doesNotMatch(JSON.stringify(c.view()), /sk-secret-123/);
});

// Minimal DOM contract fixture, as in initialization-panel.test.js.
class Node {
    constructor(tag, doc) {
        this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {};
        this.events = {}; this.attributes = {}; this._text = ''; this.className = ''; this.value = '';
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
    dispatch(type) { for (const callback of this.events[type] ?? []) callback({ target: this, currentTarget: this }); }
    click() { if (!this.disabled) this.dispatch('click'); }
    focus() { this.ownerDocument.activeElement = this; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the connection card fetches models and fills the model name from the list', async t => {
    const doc = { createElement(tag) { return new Node(tag, this); }, defaultView: {} };
    const root = new Node('main', doc), listeners = new Set(), requests = [];
    const view = { chatId: 'c', enabled: true, status: '', settings: { ...DEFAULT_SETTINGS }, save: { id: 's', initialized: false, processedCount: 0 },
        sourceBook: 'main', readiness: { chat: true, book: true, template: true, single: true }, diagnostics: { pendingCount: 0 },
        presetApplication: { entries: [] }, connectionMode: 'compatible',
        connection: { mode: 'compatible', endpoint: 'https://aux.example/v1', model: '', hasApiKey: true }, modelList: null };
    const controller = { view: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        fetchModels: async input => { requests.push(input); view.modelList = { endpoint: 'https://aux.example/v1', models: ['alpha', 'beta'] }; return { executed: true, message: '已获取 2 个模型' }; } };
    const panel = mountPanel(root, controller); t.after(() => panel.destroy());
    const find = predicate => walk(root).find(predicate);
    find(node => node.tagName === 'BUTTON' && node.textContent === '设置').click();
    find(node => node.tagName === 'BUTTON' && node.textContent === '获取模型列表').click(); await tick();
    assert.deepEqual(requests, [{ endpoint: 'https://aux.example/v1', apiKey: '' }]);
    const list = find(node => node.tagName === 'SELECT' && node.dataset.focus === 'model-list');
    assert.ok(list, 'the fetched list is offered');
    assert.deepEqual(list.children.map(option => option.value), ['', 'alpha', 'beta']);
    list.value = 'beta'; list.dispatch('change');
    const label = find(node => node.tagName === 'LABEL' && node.textContent.startsWith('模型名称'));
    assert.equal(label.children.find(node => node.tagName === 'INPUT').value, 'beta');
});
