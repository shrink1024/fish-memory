import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/runtime/controller.js';
import {entryText} from '../src/core/state.js';
import {encodeSave,decodeSave} from '../src/core/storage-codec.js';
const original='设定'.repeat(10000);
async function fixture(){
 let disk,plan,fail=false,calls=0;const book=[{uid:1,comment:'长条目',content:original}];
 const state={chatId:'c',bookName:'b',templateEnabled:true,generating:false,messages:[{key:'m',role:'assistant',content:'合成剧情',hidden:false}]};
 const host={snapshot:()=>structuredClone(state),generationSnapshot:()=>structuredClone(state),loadWorldbook:async()=>structuredClone(book),clearPlan(){},setPlan:v=>{plan=v},applyWindow:async()=>{},
 storage:{read:async()=>disk?decodeSave(disk):null,write:async(_,v)=>{if(fail)throw Error('write failed');disk=encodeSave(v)}}};
 const model={complete:async r=>{calls++;if(r.purpose==='initialize')return {strategy:'s',entries:r.input.entries.map(e=>({id:e.id,kind:'fact',intro:'i',retrieveWhen:'w',segments:[{id:'body',writable:true}]}))};if(r.purpose==='select')return {ids:r.input.catalog.map(e=>e.id)};if(r.purpose==='sourceMerge')assert.fail('wide conflict must not reach model');return {operations:[]}}};
 const make=()=>new Controller(host,{model,settings:{enabled:true,maintenanceEvery:1000}}),c=make();await c.start();await c.initialize();
 await c.manual({type:'edit',id:'source:b:1',segments:[{id:'body',text:'剧情'+original+'剧情',writable:true}]});book[0].content=original.slice(0,10000)+'作者'+original.slice(10000);
 await c.syncSourceChanges();return {c,book,make,plan:()=>plan,calls:()=>calls,setFail:v=>{fail=v}};
}
for(const choice of ['adopt-source','keep-current'])test(`held source remains usable and ${choice} survives reload and branch replay`,async()=>{
 const f=await fixture(),id='source:b:1',current=entryText(f.c.store.state.data.entries[id]);
 assert.equal(f.c.sourceChanges.changed,false);assert.equal(f.c.sourceChanges.held[0].id,id);
 await f.c.generationBefore({type:'normal'});assert.ok(f.plan().selectedIds.includes(id));assert.equal(entryText(f.plan().entries.find(e=>e.id===id)),current);
 const calls=f.calls();await f.c.syncSourceChanges();assert.equal(f.calls(),calls,'retry must not rescan an identical held version');
 const reload=f.make();await reload.start();assert.equal(reload.sourceChanges.changed,false);assert.equal(reload.sourceChanges.held[0].id,id);
 await reload.manual({type:'source-held-resolve',id,choice,confirmed:true});
 assert.equal(entryText(reload.store.state.data.entries[id]),choice==='adopt-source'?f.book[0].content:current);
 assert.equal(reload.store.state.data.entries[id].source.original,f.book[0].content);assert.equal(reload.store.state.sourceHeld?.[id],undefined);assert.equal(reload.sourceChanges.changed,false);
 assert.ok(reload.store.state.audit.some(a=>a.entryId===id&&a.reason==='source-held-resolve'));
 const again=f.make();await again.start();await again.store.reconcile(['other']);
 assert.equal(entryText(again.store.state.data.entries[id]),choice==='adopt-source'?f.book[0].content:current);
 f.book[0].content+='再次变更';await again.generationBefore({type:'normal'});assert.equal(again.sourceChanges.changed,true);
});
test('held resolution rejects missing confirmation, changed source and failed persistence atomically',async()=>{
 const f=await fixture(),id='source:b:1',action={type:'source-held-resolve',id,choice:'adopt-source',confirmed:true};
 await assert.rejects(f.c.manual({...action,confirmed:false}),/确认/);
 const before=f.c.store.snapshot();f.setFail(true);await assert.rejects(f.c.manual(action),/write failed/);assert.deepEqual(f.c.store.state,before);f.setFail(false);
 f.book[0].content+='变更';await assert.rejects(f.c.manual(action),/原书.*变化|来源.*变化/);assert.deepEqual(f.c.store.state,before);
});
test('one held entry does not hide a different unresolved source change',async()=>{
 const f=await fixture();f.book.push({uid:2,comment:'新增资料',content:'另一条'});await f.c.generationBefore({type:'normal'});
 assert.equal(f.c.sourceChanges.changed,true);assert.ok(f.c.sourceChanges.added.includes('新增资料'));
});

test('resolving one held entry leaves other source changes pending and rejects stale entry versions',async()=>{
 const f=await fixture(),id='source:b:1',version=f.c.store.state.data.entries[id].version;
 await f.c.manual({type:'edit',id,title:'玩家再次修改'});
 await assert.rejects(f.c.manual({type:'source-held-resolve',id,choice:'keep-current',confirmed:true,expectedVersion:version}),/条目已更新/);
 f.book.push({uid:2,comment:'未同步的另一条',content:'新增设定'});
 await f.c.manual({type:'source-held-resolve',id,choice:'keep-current',confirmed:true});
 assert.equal(f.c.sourceChanges.changed,true);assert.deepEqual(f.c.sourceChanges.added,['未同步的另一条']);assert.equal(f.c.store.state.data.entries[id].title,'玩家再次修改');
});
test('corrupt held source baselines cannot be loaded as a pending resolution',async()=>{
 const f=await fixture();const {validateSave}=await import('../src/core/state.js');
 const invalid=f.c.store.snapshot();invalid.sourceHeld['source:b:1'].next.source.baselineSegments=[];
 assert.throws(()=>validateSave(invalid),/来源基线/);
});

test('a changed pending source cannot be adopted through an older confirmation',async()=>{
 const f=await fixture(),id='source:b:1',expectedResolutionId=f.c.sourceChanges.held[0].resolutionId;
 f.book[0].content+='第二次作者变更';await f.c.syncSourceChanges();assert.notEqual(f.c.sourceChanges.held[0].resolutionId,expectedResolutionId);
 await assert.rejects(f.c.manual({type:'source-held-resolve',id,choice:'adopt-source',confirmed:true,expectedResolutionId}),/原书版本已变化/);
});
