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

test('a stalled model-list request times out without publishing its late result', async t => {
    const deadline = new AbortController(), originalTimeout = AbortSignal.timeout, originalFetch = globalThis.fetch;
    t.after(() => { AbortSignal.timeout = originalTimeout; globalThis.fetch = originalFetch; });
    AbortSignal.timeout = ms => { assert.equal(ms,15000); return deadline.signal; };
    let release, sentSignal;
    globalThis.fetch = (_url, options) => { sentSignal=options.signal; return new Promise(resolve=>{release=resolve;}); };
    const c = new Controller({snapshot:()=>({chatId:null,messages:[]}),rawGenerate:async()=>'{}'});
    const pending = c.fetchModels({endpoint:'https://openrouter.ai/api/v1'});
    const rejected = assert.rejects(pending, /15 秒.*手动填写/);
    assert.equal(sentSignal,deadline.signal);
    deadline.abort(new DOMException('expired','TimeoutError')); await rejected;
    release(new Response('{"data":[{"id":"late/model"}]}')); await tick();
    assert.equal(c.view().modelList,null);
});

test('provider discovery reuses credentials only for the saved endpoint and publishes a model-scoped list', async t => {
    const original = globalThis.fetch, sent = [], endpoint = 'https://openrouter.ai/api/v1';
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (url, options) => {
        sent.push({url,headers:options.headers});
        return new Response(JSON.stringify({data:{endpoints:[{tag:'openai',provider_name:'OpenAI'}]}}));
    };
    const c = new Controller({snapshot:()=>({chatId:null,messages:[]}),rawGenerate:async()=>'{}'});
    await c.updateConnection({mode:'compatible',endpoint,model:'openai/gpt-4o-mini',apiKey:'saved-key',headers:[{name:'X-Test',value:'saved-header'}]});
    const result = await c.fetchProviders({endpoint:`${endpoint}/`,model:' openai/gpt-4o-mini ',apiKey:''});
    assert.match(result.message,/1 个服务提供商/);
    assert.deepEqual(c.view().providerList,{endpoint,model:'openai/gpt-4o-mini',providers:[{id:'openai',name:'OpenAI'}]});
    await c.fetchProviders({endpoint:`${endpoint}?route=other`,model:'openai/gpt-4o-mini'});
    assert.deepEqual(sent,[
        {url:`${endpoint}/models/openai/gpt-4o-mini/endpoints`,headers:{Authorization:'Bearer saved-key','X-Test':'saved-header'}},
        {url:`${endpoint}/models/openai/gpt-4o-mini/endpoints?route=other`,headers:{}}
    ]);
    await assert.rejects(c.fetchProviders({endpoint:'https://other.example/v1',model:'openai/gpt-4o-mini'}),/OpenRouter/);
    await assert.rejects(c.fetchProviders({endpoint,model:''}),/选择模型/);
    assert.equal(sent.length,2);
    assert.doesNotMatch(JSON.stringify(c.view()),/saved-key|saved-header/);
});

test('a late provider discovery cannot replace the latest model list', async t => {
    const original=globalThis.fetch, release=[], endpoint='https://openrouter.ai/api/v1';
    t.after(()=>{globalThis.fetch=original;});
    globalThis.fetch=()=>new Promise(resolve=>release.push(resolve));
    const c=new Controller({snapshot:()=>({chatId:null,messages:[]}),rawGenerate:async()=>'{}'});
    const first=c.fetchProviders({endpoint,model:'vendor/old'}), second=c.fetchProviders({endpoint,model:'vendor/new'});
    release[1](new Response('{"data":{"endpoints":[{"tag":"new-provider"}]}}')); await second;
    release[0](new Response('{"data":{"endpoints":[{"tag":"old-provider"}]}}'));
    assert.equal((await first).executed,false);
    assert.deepEqual(c.view().providerList,{endpoint,model:'vendor/new',providers:[{id:'new-provider',name:'new-provider'}]});
});

test('a stalled provider discovery times out without accepting a late result', async t => {
    const originalFetch=globalThis.fetch, originalTimeout=AbortSignal.timeout, deadline=new AbortController(); let release;
    t.after(()=>{globalThis.fetch=originalFetch;AbortSignal.timeout=originalTimeout;});
    AbortSignal.timeout=ms=>{assert.equal(ms,15000);return deadline.signal;};
    globalThis.fetch=(_url,options)=>{assert.equal(options.signal,deadline.signal);return new Promise(resolve=>{release=resolve;});};
    const c=new Controller({snapshot:()=>({chatId:null,messages:[]}),rawGenerate:async()=>'{}'});
    const pending=c.fetchProviders({endpoint:'https://openrouter.ai/api/v1',model:'vendor/model'});
    const rejected=assert.rejects(pending,/15 秒.*手动填写/);
    deadline.abort(new DOMException('expired','TimeoutError')); await rejected;
    release(new Response('{"data":{"endpoints":[{"tag":"late-provider"}]}}')); await tick();
    assert.equal(c.view().providerList,null);
});

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
    find(node => node.tagName === 'BUTTON' && node.textContent === '辅助模型').click();
    assert.equal(find(node => node.dataset.focus === 'model-list').disabled, true, 'the model picker is visible before connecting');
    find(node => node.tagName === 'BUTTON' && node.textContent === '连接并获取模型').click(); await tick();
    assert.deepEqual(requests, [{ endpoint: 'https://aux.example/v1', apiKey: '', headers: [] }]);
    const list = find(node => node.tagName === 'SELECT' && node.dataset.focus === 'model-list');
    assert.ok(list, 'the fetched list is offered');
    assert.equal(list.disabled, false, 'connecting enables selection without a model ID first');
    assert.deepEqual(list.children.map(option => option.value), ['', 'alpha', 'beta']);
    list.value = 'beta'; list.dispatch('change');
    const label = find(node => node.tagName === 'LABEL' && node.textContent.startsWith('模型 ID'));
    assert.equal(label.children.find(node => node.tagName === 'INPUT').value, 'beta');
    const address = find(node => node.dataset.focus === '接口地址');
    address.value = 'https://other.example/v1'; address.dispatch('input');
    assert.equal(find(node => node.dataset.focus === 'model-list').disabled, true, 'a changed endpoint cannot offer the old provider model list');
});

test('OpenRouter preset starts clean, fetches model IDs and saves through the compatible connection', async t => {
    const doc = { createElement(tag) { return new Node(tag, this); }, defaultView: {} };
    const root = new Node('main', doc), fetched = [], applied = [], saved = [], providerRequests = [];
    const endpoint = 'https://openrouter.ai/api/v1';
    const view = { chatId:'c', enabled:true, status:'', settings:{...DEFAULT_SETTINGS}, save:{id:'s',initialized:false,processedCount:0},
        sourceBook:'main', readiness:{chat:true,book:true,template:true,single:true}, diagnostics:{pendingCount:0}, presetApplication:{entries:[]},
        connectionMode:'compatible', connection:{endpoint:'https://other.example/v1',model:'old',hasApiKey:true,headers:[{name:'X-Api-Key'}]} };
    const controller = {view:()=>view, subscribe:()=>()=>{},
        fetchModels:async input=>{ fetched.push(input); view.modelList={endpoint,models:['vendor/test-model']}; },
        fetchProviders:async input=>{providerRequests.push(input);view.providerList={endpoint,model:'vendor/test-model',providers:[{id:'deepinfra/fp4',name:'DeepInfra'}]};},
        updateConnection:async input=>{applied.push(input);}, saveConnectionProfile:async name=>{saved.push(name);} };
    const panel = mountPanel(root, controller); t.after(()=>panel.destroy());
    const find = predicate=>walk(root).find(predicate), focused = key=>find(node=>node.dataset.focus===key);
    const button = label=>find(node=>node.tagName==='BUTTON'&&node.textContent===label);
    const input = (key,value)=>{ const node=focused(key); node.value=value; node.dispatch('input'); };
    button('设置').click(); button('辅助模型').click();
    input('密钥','another-provider-draft-key');
    focused('connection-choice').value='openrouter'; focused('connection-choice').dispatch('change');
    assert.equal(focused('接口地址').value,endpoint); assert.equal(focused('密钥').value,''); assert.equal(focused('model-name').value,'');
    assert.equal(applied.length,0,'choosing a preset does not change the active connection');
    input('密钥','fake-openrouter-key'); input('profile-name','Router test');
    button('连接并获取模型').click(); await tick();
    assert.deepEqual(fetched,[{endpoint,apiKey:'fake-openrouter-key',headers:[]}]);
    const models=focused('model-list'); assert.equal(models.disabled,false);
    models.value='vendor/test-model'; models.dispatch('change');
    assert.equal(focused('密钥').value,'fake-openrouter-key','model selection preserves the entered key');
    assert.equal(focused('provider-list').value,'','new connections start with automatic routing');
    focused('fetch-providers').click(); await tick();
    assert.deepEqual(providerRequests,[{endpoint,model:'vendor/test-model',apiKey:'fake-openrouter-key',headers:[]}]);
    assert.deepEqual(focused('provider-list').children.map(option=>option.value),['','deepinfra/fp4']);
    focused('provider-list').value='deepinfra/fp4'; focused('provider-list').dispatch('change');
    button('保存并使用').click(); await tick();
    assert.deepEqual(applied,[{mode:'compatible',endpoint,model:'vendor/test-model',apiKey:'fake-openrouter-key',maxOutputTokens:'',headers:[],openrouterProvider:'deepinfra/fp4'}]);
    assert.deepEqual(saved,['Router test']);
});

test('provider controls preserve unlisted pins, allow manual fallback, and clear stale choices on target changes', async t => {
    const doc={createElement(tag){return new Node(tag,this);},defaultView:{}}, root=new Node('main',doc), applied=[];
    const endpoint='https://openrouter.ai/api/v1', model='vendor/model';
    const view={chatId:'c',enabled:true,status:'',settings:{...DEFAULT_SETTINGS},save:{id:'s',initialized:false,processedCount:0},
        sourceBook:'main',readiness:{chat:true,book:true,template:true,single:true},diagnostics:{pendingCount:0},presetApplication:{entries:[]},
        connectionMode:'compatible',connection:{endpoint,model,hasApiKey:true,openrouterProvider:'saved/region'},
        providerList:{endpoint,model:'vendor/other',providers:[{id:'other-provider',name:'Other'}]}};
    const controller={view:()=>view,subscribe:()=>()=>{},fetchProviders:async()=>{throw Error('服务商列表暂不可用');},updateConnection:async input=>{applied.push(input);}};
    const panel=mountPanel(root,controller);t.after(()=>panel.destroy());
    const focused=key=>walk(root).find(node=>node.dataset.focus===key);
    const button=label=>walk(root).find(node=>node.tagName==='BUTTON'&&node.textContent===label);
    const input=(key,value)=>{const node=focused(key);node.value=value;node.dispatch('input');};
    button('设置').click();button('辅助模型').click();
    assert.equal(focused('provider-list').value,'saved/region');
    assert.deepEqual(focused('provider-list').children.map(option=>option.value),['','saved/region'],'a different model list cannot replace the saved pin');
    focused('fetch-providers').click();await tick();
    assert.equal(focused('provider-list').disabled,false,'a failed refresh still allows clearing the saved pin');
    focused('provider-list').value='';focused('provider-list').dispatch('change');
    button('应用连接').click();await tick();assert.equal(applied.at(-1).openrouterProvider,'');
    input('provider-id','manual/variant');
    assert.equal(focused('provider-list').value,'manual/variant');
    const applyButton=button('应用连接');focused('provider-id').dispatch('change');
    assert.equal(button('应用连接'),applyButton,'blurring the manual field must not replace the button about to receive a click');
    applyButton.click();await tick();assert.equal(applied.at(-1).openrouterProvider,'manual/variant');
    input('model-name','vendor/unknown');
    assert.equal(focused('provider-list').value,'');assert.equal(focused('provider-id').value,'');assert.equal(focused('provider-list').disabled,true);
    input('model-name','vendor/other');
    assert.equal(focused('provider-list').disabled,false);
    assert.deepEqual(focused('provider-list').children.map(option=>option.value),['','other-provider'],'typing a cached model rebuilds its options immediately');
    focused('provider-list').value='other-provider';focused('provider-list').dispatch('change');
    input('接口地址','https://other.example/v1');
    assert.equal(focused('provider-id').value,'');assert.equal(focused('provider-list').disabled,true);
    assert.equal(focused('provider-list').parent.parent.hidden,true);
    button('应用连接').click();await tick();assert.equal('openrouterProvider' in applied.at(-1),false);
});
