import test from 'node:test';
import assert from 'node:assert/strict';
import {createSave, makeSourceEntry} from '../src/core/state.js';
import {frontCatalog} from '../src/core/views.js';
import {selectRequest,maintainRequest} from '../src/agents/requests.js';
import {select} from '../src/agents/tasks.js';
import {selectionCatalog,decodeSelectionIds} from '../src/agents/selection-codec.js';
import {AgentClient,serializeAgentInput} from '../src/agents/client.js';
import {decodeResponse} from '../src/diagnostics/capture.js';

function fixture(){
 const save=createSave('codec','合成世界书——仅限程序测试');
 for(let i=0;i<12;i++){
  const e=makeSourceEntry(save.bookName,{uid:i,comment:`人物 ${i}`,content:`不可更改的原文 ${i} {{user}}`,constant:i===0});
  e.intro=`人物简介 ${i}`;e.retrieveWhen=`遇到人物 ${i} 时`;e.evidence=['m0'];save.data.entries[e.id]=e;
 }
 save.data.strategy='记录已发生的事实';save.data.summary='昨日抵达北城。';
 return {save,messages:[{key:'m0',role:'user',content:'去见人物 1。'}]};
}
test('compact selection catalog expands to every original field and never mutates a save',()=>{
 const {save,messages}=fixture(),before=structuredClone(save);
 const input=selectRequest(save,messages,{messageCount:13,authorGuidance:'作者要求',observedState:{fields:[]}}).input;
 const expanded=selectionCatalog(input).map(e=>({...e,id:decodeSelectionIds(input,[e.id])[0]}));
 assert.deepEqual(expanded,frontCatalog(save,()=>true,save.data.scopeContext,['m0']));
 assert.deepEqual(save,before);assert.equal(input.messages[0].content,messages[0].content);
 assert.equal(input.summary,save.data.summary);assert.equal(input.authorGuidance,'作者要求');assert.deepEqual(input.progress,{messageCount:13});
 assert.ok(input.catalog.every(e=>e.id.length<8));assert.ok(!JSON.stringify(input).includes('source:%'));
 assert.deepEqual(JSON.parse(serializeAgentInput(input)),input);
});
test('summary, progress and recent evidence updates do not change the stable directory prefix',()=>{
 const {save,messages}=fixture(),first=selectRequest(save,messages,{messageCount:13}).input;
 save.data.summary+='今天到了河边。';Object.values(save.data.entries)[0].evidence=[];
 const second=selectRequest(save,messages,{messageCount:14}).input;
 assert.equal(serializeAgentInput(first).split(',"summary":')[0],serializeAgentInput(second).split(',"summary":')[0]);
 assert.notDeepEqual(first.catalogState,second.catalogState);
 const hidden=selectRequest(save,messages,{eligible:e=>e!==Object.values(save.data.entries)[0]}).input;
 assert.equal(first.catalog[1].id,hidden.catalog[0].id,'short ids do not shift when a candidate becomes ineligible');
});
test('wire short ids decode before task validation/persistence, including correcting unknown ids',async()=>{
 const {save,messages}=fixture();let calls=0;
 const client=new AgentClient(async request=>{
  const input=JSON.parse(request.input);calls++;
  return JSON.stringify({ids:calls===1?['not-in-this-request']:[input.catalog[1].id]});
 });
 const result=await select(client,save,messages);assert.equal(calls,2);assert.deepEqual(result,[Object.keys(save.data.entries)[1]]);
});
test('constant defaults, forced entries and limits survive catalog packing',async()=>{
 const {save,messages}=fixture(),ids=Object.keys(save.data.entries);
 const choose={complete:async({input})=>({ids:input.catalog.slice(0,3).map(e=>e.id)})};
 await assert.rejects(select(choose,save,messages,{selectionLimit:1}),/数量超过/);
 assert.deepEqual(await select(choose,save,messages,{selectionLimit:1,forced:[ids[1]]}),ids.slice(0,3));
 const request=selectRequest(save,messages,{eligible:e=>e.id!==ids[1]});
 assert.throws(()=>decodeSelectionIds(request.input,[ids[1]]),/不允许/);
 assert.throws(()=>decodeSelectionIds(structuredClone(request.input),[request.input.catalog[0].id]),/不允许/);
});
test('alias collisions with real short ids cannot select the wrong entry',async()=>{
 const {save,messages}=fixture();const e={...structuredClone(Object.values(save.data.entries)[1]),id:'e0'};save.data.entries.e0=e;
 const request=selectRequest(save,messages);assert.equal(request.input.catalog[0].id,'_e0');
 assert.deepEqual(decodeSelectionIds(request.input,['_e0','e0']),[Object.keys(save.data.entries)[0],'e0']);
});
test('stream trace decoding retains actual provider usage and never invents cache hits',()=>{
 const usage={prompt_tokens:120,prompt_cache_hit_tokens:100,prompt_cache_miss_tokens:20,completion_tokens:8,total_tokens:128};
 const frame=v=>'data: '+JSON.stringify(v)+'\n\n';
 const body=frame({choices:[{delta:{content:'{}'},finish_reason:'stop'}],usage:null})+frame({choices:[],usage})+'data: [DONE]\n\n';
 assert.deepEqual(decodeResponse(body).usage,usage);assert.equal(decodeResponse(frame({choices:[]})).usage,undefined);
});
test('summary-only updates retain the preceding maintenance entries byte-for-byte',()=>{
 const {save,messages}=fixture(),before=maintainRequest(save,messages).input;
 save.data.summary+='随后去了市场。';const after=maintainRequest(save,messages).input;
 assert.deepEqual(before.memory.entries,after.memory.entries);
 assert.equal(serializeAgentInput(before).split(',"summary":')[0],serializeAgentInput(after).split(',"summary":')[0]);
 assert.equal(after.memory.summary,save.data.summary);assert.deepEqual(before.messages,after.messages);
});
