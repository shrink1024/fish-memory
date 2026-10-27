import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { mountPanel } from '../src/ui/panel.js';
import { DEFAULT_SETTINGS } from '../src/core/state.js';

const host = () => ({ snapshot: () => ({ chatId: null, messages: [] }), rawGenerate: async () => '{}' });
const memoryStore = () => {
    const data = { current: null, profiles: null };
    return { data, load: () => structuredClone(data.current), save: value => { data.current = structuredClone(value); },
        loadProfiles: () => structuredClone(data.profiles), saveProfiles: list => { data.profiles = structuredClone(list); } };
};

test('FM-025: named connections are saved with their keys, switched and deleted', async () => {
    const store = memoryStore(), c = new Controller(host(), { connectionStore: store });
    await assert.rejects(c.saveConnectionProfile('甲'), /单独的兼容接口/, 'the ST connection is not a profile');
    await c.updateConnection({ mode: 'compatible', endpoint: 'https://a.example/v1', model: 'cheap', apiKey: 'key-a', maxOutputTokens: 8192 });
    await c.saveConnectionProfile(' 便宜档 ');
    await c.updateConnection({ mode: 'compatible', endpoint: 'https://b.example/v1', model: 'smart', apiKey: 'key-b' });
    await c.saveConnectionProfile('聪明档');
    await assert.rejects(c.saveConnectionProfile('  '), /配置名称/);
    assert.deepEqual(store.data.profiles.map(p => [p.name, p.apiKey]), [['便宜档', 'key-a'], ['聪明档', 'key-b']]);
    assert.deepEqual(c.view().connectionProfiles.map(p => [p.name, p.active, p.hasApiKey]), [['便宜档', false, true], ['聪明档', true, true]]);
    assert.doesNotMatch(JSON.stringify(c.view()), /key-[ab]/, 'keys never reach the view');

    await c.useConnectionProfile('便宜档');
    assert.deepEqual(c.view().connection, { mode: 'compatible', endpoint: 'https://a.example/v1', model: 'cheap', maxOutputTokens: 8192, hasApiKey: true });
    assert.equal(store.data.current.apiKey, 'key-a', 'the switched connection is what reloads next time');
    assert.deepEqual(c.view().connectionProfiles.map(p => p.active), [true, false]);

    await c.updateConnection({ mode: 'compatible', endpoint: 'https://a.example/v1', model: 'cheap-2' });
    await c.saveConnectionProfile('便宜档');
    assert.equal(store.data.profiles.length, 2, 'the same name overwrites');
    assert.equal(store.data.profiles[0].model, 'cheap-2');
    assert.equal(store.data.profiles[0].apiKey, 'key-a', 'a blank key on the same endpoint keeps the saved one');

    await c.deleteConnectionProfile('便宜档');
    assert.deepEqual(store.data.profiles.map(p => p.name), ['聪明档']);
    assert.equal(c.view().connection.model, 'cheap-2', 'deleting a profile leaves the live connection alone');
    await assert.rejects(c.useConnectionProfile('便宜档'), /没有找到/);

    const reloaded = new Controller(host(), { connectionStore: store });
    assert.deepEqual(reloaded.view().connectionProfiles.map(p => p.name), ['聪明档']);
});

test('FM-025: broken stored profiles are dropped, not fatal, and switching waits for running tasks', async () => {
    const store = memoryStore();
    store.data.profiles = [{ name: 'ok', endpoint: 'https://a.example/v1', model: 'm', apiKey: 'k', maxOutputTokens: -5 }, { name: 'ok', endpoint: 'x', model: 'y' },
        { name: '', endpoint: 'https://a', model: 'm' }, null, { name: 'no-model', endpoint: 'https://a' }];
    const c = new Controller(host(), { connectionStore: store });
    assert.deepEqual(c.view().connectionProfiles, [{ name: 'ok', endpoint: 'https://a.example/v1', model: 'm', maxOutputTokens: undefined, hasApiKey: true, active: false }]);
    store.loadProfiles = () => { throw new SyntaxError('bad json'); };
    assert.deepEqual(new Controller(host(), { connectionStore: store }).view().connectionProfiles, []);
    const view = c.view.bind(c);
    c.view = () => ({ ...view(), activity: { kind: 'maintain' } });
    await assert.rejects(c.useConnectionProfile('ok'), /当前任务/);
});

test('R2: switching restores the saved key exactly, an empty one included', async () => {
    const store = memoryStore(), c = new Controller(host(), { connectionStore: store });
    const endpoint = 'https://same.example/v1';
    await c.updateConnection({ mode: 'compatible', endpoint, model: 'free', apiKey: '' });
    await c.saveConnectionProfile('匿名');
    await c.updateConnection({ mode: 'compatible', endpoint, model: 'paid', apiKey: 'key-paid' });
    await c.saveConnectionProfile('付费');
    await c.updateConnection({ mode: 'compatible', endpoint, model: 'paid', apiKey: 'key-other' });
    await c.saveConnectionProfile('另一账户');
    await c.useConnectionProfile('匿名');
    assert.equal(store.data.current.apiKey, '', 'the previous key is not carried into a keyless profile');
    assert.equal(c.view().connection.hasApiKey, false);
    assert.deepEqual(c.view().connectionProfiles.filter(p => p.active).map(p => p.name), ['匿名']);
    await c.useConnectionProfile('付费');
    assert.equal(store.data.current.apiKey, 'key-paid');
    await c.useConnectionProfile('另一账户');
    assert.equal(store.data.current.apiKey, 'key-other', 'same endpoint and model, different account');
    await c.useConnectionProfile('匿名');
    const reloaded = new Controller(host(), { connectionStore: store });
    assert.equal(reloaded.view().connection.hasApiKey, false, 'the keyless switch is what reloads');
    assert.deepEqual(reloaded.view().connectionProfiles.filter(p => p.active).map(p => p.name), ['匿名']);
    await reloaded.updateConnection({ mode: 'compatible', endpoint: 'https://other.example/v1', model: 'm', apiKey: 'k2' });
    await reloaded.useConnectionProfile('付费');
    assert.equal(store.data.current.apiKey, 'key-paid', 'switching across endpoints uses the profile key, not the live one');
});

// Minimal DOM contract fixture, as in model-list.test.js.
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

test('FM-025: the connection card lists profiles and switches with one click', async t => {
    const doc = { createElement(tag) { return new Node(tag, this); }, defaultView: {} };
    const root = new Node('main', doc), used = [], saved = [];
    const view = { chatId: 'c', enabled: true, status: '', settings: { ...DEFAULT_SETTINGS }, save: { id: 's', initialized: false, processedCount: 0 },
        sourceBook: 'main', readiness: { chat: true, book: true, template: true, single: true }, diagnostics: { pendingCount: 0 },
        presetApplication: { entries: [] }, connectionMode: 'compatible', modelList: null,
        connection: { mode: 'compatible', endpoint: 'https://a.example/v1', model: 'cheap', hasApiKey: true },
        connectionProfiles: [{ name: '便宜档', model: 'cheap', active: true }, { name: '聪明档', model: 'smart', active: false }] };
    const controller = { view: () => view, subscribe: () => () => {},
        useConnectionProfile: async name => { used.push(name); view.connection = { mode: 'compatible', endpoint: 'https://b.example/v1', model: 'smart', hasApiKey: true }; return { executed: true, message: 'ok' }; },
        saveConnectionProfile: async name => { saved.push(name); return { executed: true, message: 'ok' }; } };
    const panel = mountPanel(root, controller); t.after(() => panel.destroy());
    const find = predicate => walk(root).find(predicate);
    find(node => node.tagName === 'BUTTON' && node.textContent === '设置').click();
    assert.equal(find(node => node.dataset.focus === 'profile-use-便宜档').disabled, true, 'the live profile cannot be re-applied');
    find(node => node.dataset.focus === 'profile-use-聪明档').click(); await tick();
    assert.deepEqual(used, ['聪明档']);
    const endpoint = find(node => node.tagName === 'LABEL' && node.textContent.startsWith('接口基础地址')).children.find(node => node.tagName === 'INPUT');
    assert.equal(endpoint.value, 'https://b.example/v1', 'the form shows the switched connection, not the old draft');
    const name = find(node => node.tagName === 'LABEL' && node.textContent.startsWith('配置名称')).children.find(node => node.tagName === 'INPUT');
    name.value = '新档'; name.dispatch('input');
    find(node => node.tagName === 'BUTTON' && node.textContent === '保存当前生效的连接').click(); await tick();
    assert.deepEqual(saved, ['新档']);
});
