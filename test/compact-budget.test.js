import test from 'node:test';
import assert from 'node:assert/strict';
import {compact} from '../src/agents/tasks.js';
import {COMPACT_INPUT_CHARS,compactPlans} from '../src/agents/compact-plan.js';
import {compactRequest} from '../src/agents/requests.js';
import {createSave,createEntry,entryText} from '../src/core/state.js';
import {applyMaintenance} from '../src/core/operations.js';
function saveWith(text='正文'){
 const save=createSave('c','b');save.initialized=true;save.data.entries.e=createEntry({id:'e',title:'合成事件',kind:'event',text,evidence:['m-'+ 'a'.repeat(100)]});return save;
}
test('compact sends bounded batches, short evidence and no inventory, and restores original keys',async()=>{
 const save=saveWith();save.data.summary='脉络';save.data.inventory=[{name:'无关物品',description:'无关'}];
 for(let i=0;i<6;i++)save.data.entries[`e${i}`]=createEntry({id:`e${i}`,title:'事件',kind:'event',text:'正'.repeat(12000),evidence:['m-'+String(i).repeat(100)]});
 const calls=[];const result=await compact({complete:async r=>{calls.push(r);assert.ok(JSON.stringify(r.input).length<=COMPACT_INPUT_CHARS);assert.equal(r.input.memory.inventory,undefined);return {operations:r.input.memory.entries.map(e=>({type:'update',id:e.id,expectedVersion:e.version,segments:e.segments,evidence:e.evidence}))}}},save);
 assert.ok(calls.length>1);assert.ok(!JSON.stringify(calls).includes('m-'));assert.equal(result.operations.find(op=>op.id==='e').evidence[0],save.data.entries.e.evidence[0]);
});
test('oversized writable entry condenses all fragments without truncating emoji or losing source evidence',async()=>{
 const text='😀剧情'.repeat(24000),save=saveWith(text);let calls=0;
 const result=await compact({complete:async r=>{calls++;const e=r.input.memory.entries[0];assert.equal(e.mergeable,false);return {operations:[{type:'update',id:e.id,expectedVersion:e.version,segments:e.segments,evidence:e.evidence}]}}},save);
 const next=applyMaintenance(save.data,result,{allowedEvidence:save.data.entries.e.evidence}).next;
 assert.ok(calls>1);assert.equal(entryText(next.entries.e),text);assert.deepEqual(next.entries.e.evidence,save.data.entries.e.evidence);
});
test('compaction rejects forged short evidence and cross-batch operations before accepting results',async()=>{
 const save=saveWith();await assert.rejects(compact({complete:async()=>({operations:[{type:'update',id:'e',expectedVersion:1,evidence:['k999'],segments:[]}]})},save),/未提供/);
 save.data.summary='摘要';await assert.rejects(compact({complete:async()=>({operations:[{type:'summary',text:'越界修改摘要'}]})},save),/本批之外/);
});
test('empty compaction performs no model call; large summaries are covered exactly',async()=>{
 const save=createSave('c','b');assert.deepEqual(await compact({complete:async()=>assert.fail('empty')},save),{operations:[]});
 save.data.summary='摘要😀'.repeat(20000);const plans=compactPlans(compactRequest(save));assert.equal(plans.map(p=>p.original).join(''),save.data.summary);
 const result=await compact({complete:async r=>({operations:[{type:'summary',text:r.input.memory.summary}]})},save);assert.equal(result.operations[0].text,save.data.summary);
});
