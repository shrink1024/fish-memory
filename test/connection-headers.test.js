import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHeaders } from '../src/agents/connection-headers.js';
import { compatibleConnection, listModels } from '../src/agents/client.js';
import { Controller } from '../src/runtime/controller.js';
import { createTraceStore } from '../src/diagnostics/trace-store.js';
const secret='synthetic-opencode-token-1622';
const host={snapshot:()=>({chatId:null,messages:[]}),rawGenerate:async()=> '{}'};
test('header validation rejects duplicates, browser-owned names, injection and missing retained values without echoing values',()=>{
    for(const rows of [[{name:'x-test',value:secret},{name:'X-Test',value:'other'}],[{name:'Cookie',value:secret}],
        [{name:'x-test',value:secret+'\r\nextra: yes'}],[{name:'x-test',keep:true}],Array.from({length:21},(_,i)=>({name:`x-${i}`,value:secret}))]){
        assert.throws(()=>resolveHeaders(rows),e=>Boolean(e.dwmHeaderIssue)&&!e.message.includes(secret));
    }
    assert.deepEqual(resolveHeaders([{name:'X-Test',value:''}],[{name:'x-test',value:secret}]),[{name:'X-Test',value:secret}]);
    assert.equal(resolveHeaders([{name:'X-Test',value:` ${secret} `}])[0].value,secret);
});
test('opencode-style headers are present on both models and chat, including a deliberate auth override',async()=>{
    const seen=[],headers=[{name:'x-api-key',value:secret},{name:'authorization',value:'Basic synthetic'}];
    const fetchImpl=async(url,options)=>{seen.push(options);return new Response(JSON.stringify(url.endsWith('/models')?{data:[{id:'model'}]}:{choices:[{message:{content:'{}'},finish_reason:'stop'}]}))};
    await listModels({endpoint:'https://opencode.example/v1',apiKey:'other',headers,fetchImpl});
    await compatibleConnection({endpoint:'https://opencode.example/v1',model:'model',apiKey:'other',headers,fetchImpl})({system:'s',input:'i'});
    for(const request of seen){assert.equal(request.headers['x-api-key'],secret);assert.equal(request.headers.authorization,'Basic synthetic');assert.equal(request.headers.Authorization,undefined);}
});
test('headers persist locally without view or trace disclosure; endpoint changes and profile switching use exact credentials',async t=>{
    let current,profiles=[];const connectionStore={load:()=>current,save:v=>{current=structuredClone(v)},loadProfiles:()=>profiles,saveProfiles:v=>{profiles=structuredClone(v)}};
    const c=new Controller(host,{connectionStore});
    await c.updateConnection({mode:'compatible',endpoint:'https://opencode.example/v1',model:'m',headers:[{name:'x-api-key',value:secret}]});
    await c.saveConnectionProfile('custom');
    assert.deepEqual(c.view().connection.headers,[{name:'x-api-key'}]);assert.ok(!JSON.stringify(c.view()).includes(secret));
    const loaded=new Controller(host,{connectionStore});assert.deepEqual(loaded.view().connection.headers,[{name:'x-api-key'}]);
    await loaded.updateConnection({mode:'compatible',endpoint:'https://opencode.example/v1',model:'m',headers:[{name:'x-api-key',value:''}]});
    assert.equal(current.headers[0].value,secret);
    const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
    let sent;globalThis.fetch=async(_,options)=>{sent=options.headers;return new Response('{"data":[{"id":"m"}]}')};
    await loaded.fetchModels({endpoint:'https://opencode.example/v1'});assert.equal(sent['x-api-key'],secret);
    await loaded.updateConnection({mode:'compatible',endpoint:'https://other.example/v1',model:'m'});assert.deepEqual(current.headers,[]);
    await loaded.useConnectionProfile('custom');assert.equal(current.headers[0].value,secret);
    const trace=createTraceStore();const id=trace.start({request:{headers:{'x-api-key':secret}},responseRaw:`provider echoed ${secret}`});trace.finish(id);
    assert.ok(!JSON.stringify(trace.exportData()).includes(secret));assert.match(trace.snapshot().records[0].responseRaw,/REDACTED/);
    await loaded.updateConnection({mode:'compatible',endpoint:'https://opencode.example/v1',model:'m',headers:[]});assert.deepEqual(current.headers,[]);
});
