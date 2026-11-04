import test from 'node:test';
import assert from 'node:assert/strict';
import { maintain } from '../src/agents/tasks.js';
import { maintainRequest } from '../src/agents/requests.js';
import { AgentClient } from '../src/agents/client.js';
import { createSave, createEntry, entryText } from '../src/core/state.js';
import { applyMaintenance } from '../src/core/operations.js';
import { Controller } from '../src/runtime/controller.js';

const keys=['18a6d68f-875c-447a-820d-740d684cb194:swipe:0','16391c2a-cf87-4f0b-bfd8-736dead9cdc7:swipe:0'];
const messages=keys.map((key,i)=>({key,role:'assistant',content:`合成剧情 ${i}`}));
const create=evidence=>({type:'create',kind:'event',title:'合成事件',text:'钥匙交还。',intro:'钥匙交还',retrieveWhen:'钥匙归属',evidence});
test('maintenance sends short evidence keys and restores exact originals before validation',async()=>{
 const save=createSave('c','b'),before=structuredClone(messages);let wire;
 const result=await maintain({complete:async r=>{wire=r.input;return {operations:[create(r.input.messages.map(m=>m.key))]};}},save,messages,undefined,undefined,null,
  output=>{assert.deepEqual(output.operations[0].evidence,keys);applyMaintenance(save.data,output,{allowedEvidence:keys});});
 assert.deepEqual(wire.messages.map(m=>m.key),['m1','m2']);
 assert.ok(keys.every(key=>!JSON.stringify(wire).includes(key)));
 assert.deepEqual(result.operations[0].evidence,keys);assert.deepEqual(messages,before);
});
test('maintenance aliases avoid short key collisions and include only readable messages',()=>{
 const input=maintainRequest(createSave('c','b'),[messages[0],{key:'m1',role:'user',content:'short'}, {...messages[1],hidden:true}]).input;
 assert.equal(input.messages.length,2);assert.notEqual(input.messages[0].key,'m1');assert.equal(input.messages[1].key,'m1');
 assert.equal(new Set(input.messages.map(m=>m.key)).size,2);
});
test('unknown evidence causes at most one correction; valid second output restores ids',async()=>{
 let calls=0;const wire=[];const client=new AgentClient(async r=>{
  wire.push(JSON.parse(r.input));calls++;
  return JSON.stringify({operations:[create([calls===1?'m999':wire.at(-1).messages[0].key])]});
 });
 const output=await maintain(client,createSave('c','b'),messages);
 assert.equal(calls,2);assert.deepEqual(wire[0],wire[1]);assert.deepEqual(output.operations[0].evidence,[keys[0]]);
});
test('original or misspelled UUID cannot bypass the wire evidence allow-list',async()=>{
 for(const invalid of [keys[0],keys[0].replace('820d','840d'),'m0','m99',null]){
  await assert.rejects(maintain({complete:async()=>({operations:[create([invalid])]})},createSave('c','b'),messages),/修改依据必须来自本批输入正文/);
 }
});
test('overlapping asynchronous batches keep independent evidence maps and MVU references follow the wire key',async()=>{
 const results=await Promise.all(messages.map(async message=>{
  const observed={source:'MVU read-only observation',messageKey:message.key,fields:[]};
  return maintain({complete:async r=>{
   assert.equal(r.input.observedState.messageKey,r.input.messages[0].key);
   await new Promise(resolve=>setImmediate(resolve));return {operations:[create([r.input.messages[0].key])]};
  }},createSave('c','b'),[message],undefined,undefined,observed);
 }));
 assert.deepEqual(results.map(r=>r.operations[0].evidence[0]),keys);
});
test('controller initialization persists original evidence and original coverage keys',async()=>{
 const snapshot={chatId:'c',bookName:'b',templateEnabled:true,generating:false,messages};let stored;
 const host={snapshot:()=>structuredClone(snapshot),loadWorldbook:async()=>[{uid:1,comment:'rule',content:'<% let x=1; %>'}],
  storage:{read:async()=>stored,write:async(_,value)=>{stored=structuredClone(value)}},clearPlan(){},applyWindow:async()=>{}};
 const controller=new Controller(host,{model:{complete:async r=>{
  assert.equal(r.purpose,'maintain');assert.deepEqual(r.input.messages.map(m=>m.key),['m1','m2']);
  return {operations:[create(r.input.messages.map(m=>m.key))]};
 }}});
 await controller.start();await controller.initialize();
 const event=Object.values(stored.data.entries).find(e=>e.kind==='event');
 assert.deepEqual(event.evidence,keys);assert.deepEqual(event.lastEvidence,keys);
 assert.deepEqual(stored.processed,keys);assert.deepEqual(stored.rememberedKeys,keys);
});

for (const followUp of [false,true]) test(`evidence decoding preserves protected references in ${followUp?'follow-up':'regular'} updates`,async()=>{
 const save=createSave('c','b');
 save.data.entries.rule=createEntry({id:'rule',kind:'rule',title:'地名',text:'合成王都'});
 save.data.entries.npc=createEntry({id:'npc',kind:'npc',title:'甲',text:'甲住在合成王都。'});
 const result=await maintain({complete:async r=>{
  const npc=r.input.memory.entries.find(e=>e.id==='npc');
  assert.ok(npc.segments[0].text.includes('⟦鱼忆引用:'));
  return {operations:[{type:'update',id:'npc',expectedVersion:1,evidence:[r.input.messages[0].key],
   segments:[{id:'body',text:npc.segments[0].text+'已归还钥匙。'}]}]};
 }},save,messages,undefined,'global',null,output=>applyMaintenance(save.data,output,{allowedEvidence:keys}),{focus:new Set(['npc']),followUp});
 const {next}=applyMaintenance(save.data,result,{allowedEvidence:keys});
 assert.equal(entryText(next.entries.npc),'甲住在合成王都。已归还钥匙。');
 assert.deepEqual(next.entries.npc.lastEvidence,[keys[0]]);
});
