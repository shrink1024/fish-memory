import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/runtime/controller.js';
import {createEntry} from '../src/core/state.js';

const LOST='DELETED_STORY_SENTINEL';
async function fixture({lazyMode=false,maintenanceKeepRecent=0}={}){
 let disk,plan,failWrites=false;const state={chatId:'delete-fixture',bookName:'b',templateEnabled:true,userInput:'继续',messages:[]};
 const host={snapshot:()=>structuredClone(state),storage:{read:async()=>structuredClone(disk),write:async(_,v)=>{if(failWrites)throw Error('synthetic rollback storage failure');disk=structuredClone(v)}},loadWorldbook:async()=>[],clearPlan(){plan=null},setPlan:p=>{plan=p},applyWindow:async()=>{}};
 const c=new Controller(host,{settings:{lazyMode,maintenanceKeepRecent,maintenanceEvery:1000},lazyClock:{setTimer:()=>1,clearTimer(){}},model:{complete:async r=>r.purpose==='select'?{ids:Object.keys(c.store.state.data.entries)}:{operations:[]}}});
 await c.start();await c.store.initialize([createEntry({id:'person',kind:'npc',title:'林舟',text:'现住旧港。'})],'');
 state.messages=[{key:'m1',role:'user',content:'见面'},{key:'m2',role:'assistant',content:'开场'},{key:'m3',role:'user',content:'之后呢'},{key:'m4',role:'assistant',content:LOST}];
 await c.store.commit({operations:[{type:'summary',text:'开场。'}]},{expectedRevision:c.store.state.revision,sourceKeys:['m1','m2']});
 await c.store.commit({operations:[{type:'summary',text:LOST},{type:'update',id:'person',expectedVersion:1,edits:[{segmentId:'body',oldText:'现住旧港。',newText:LOST}],evidence:['m4']},
 {type:'create',kind:'event',title:LOST,text:LOST,evidence:['m4']},{type:'inventory',items:[{name:LOST,description:LOST}]}]},{expectedRevision:c.store.state.revision,sourceKeys:['m1','m2','m3','m4']});
 return {c,state,plan:()=>plan,failWrites:value=>{failWrites=value}};
}
for(const lazyMode of [false,true])for(const maintenanceKeepRecent of [0,1])for(const count of [1,2])test(`delete ${count} floors then immediately generate, lazy=${lazyMode}, deferred=${maintenanceKeepRecent}`,async()=>{
 const f=await fixture({lazyMode,maintenanceKeepRecent});f.state.messages.splice(-count);f.c.messageDeleted();
 await f.c.generationBefore({type:'normal'});await f.c.whenIdle();
 assert.doesNotMatch(JSON.stringify(f.c.store.state.data),new RegExp(LOST));
 assert.doesNotMatch(JSON.stringify(f.plan()),new RegExp(LOST));
 const rollback=f.c.view().rollback;assert.deepEqual(rollback.discardedRanges,[{from:5-count,to:4}]);
 assert.equal(rollback.summaryChanged,true);assert.equal(rollback.inventoryChanged,true);
 assert.ok(rollback.affectedEntries.some(e=>e.id==='person'&&e.action==='restored'));
 assert.ok(rollback.affectedEntries.some(e=>e.action==='removed'));
 assert.equal(f.c.store.state.lastRollback,undefined,'player notification is not model input or saved story');
 f.c.cancel();
});

test('a failed rollback is visible and cannot inject the removed story on the next send',async()=>{
 const f=await fixture();f.failWrites(true);f.state.messages.pop();f.c.messageDeleted();await f.c.whenIdle();
 assert.match(f.c.view().error??'',/rollback storage failure/,'a failed asynchronous rollback must not be silently swallowed');
 assert.equal(f.c.view().errorInfo.action,'rollback');
 assert.equal(f.c.view().rollback,null,'no successful rollback notification before durable save');
 await f.c.generationBefore({type:'normal'});assert.equal(f.plan(),null,'failed rollback cannot inject stale memory');
 f.failWrites(false);await f.c.generationBefore({type:'normal'});assert.doesNotMatch(JSON.stringify(f.plan()),new RegExp(LOST));assert.ok(f.c.view().rollback);
});

for(const lazyMode of [false,true])test(`deletion rejects a late maintenance result containing removed facts, lazy=${lazyMode}`,async()=>{
 const f=await fixture({lazyMode});await f.c.store.reconcile(['m1','m2']);let release,entered;
 const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
 f.c.client={complete:async r=>{if(r.purpose==='select')return {ids:[]};if(!r.input.messages.some(m=>m.content===LOST))return {operations:[]};entered();await gate;
  return {operations:[{type:'appendSummary',text:LOST},{type:'create',kind:'event',title:LOST,text:LOST,evidence:[r.input.messages.at(-1).key]},{type:'inventory',items:[{name:LOST,description:LOST}]}]};}};
 const running=f.c.maintain();running.catch(()=>{});await started;
 f.state.messages.pop();f.c.messageDeleted();release();await assert.rejects(running);await f.c.whenIdle();
 assert.doesNotMatch(JSON.stringify(f.c.store.state.data),new RegExp(LOST));f.c.cancel();
});

for(const deleteAgain of [false,true])test(`a delayed native deletion event ${deleteAgain?'still cancels a newly changed path':'does not cancel selection already reading the reduced history'}`,async()=>{
 const f=await fixture(),write=f.c.store.storage.write;let release,entered;
 const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});let first=true;
 f.c.store.storage.write=async(...args)=>{if(first){first=false;entered();await gate}return write(...args)};
 f.state.messages.pop();const sending=f.c.generationBefore({type:'normal'});await started;
 if(deleteAgain)f.state.messages.pop();
 f.c.messageDeleted();release();const result=await sending;await f.c.whenIdle();
 assert.equal(result?.cancel===true,deleteAgain);
 assert.doesNotMatch(JSON.stringify(f.c.store.state.data),new RegExp(LOST));
 if(!deleteAgain)assert.ok(f.plan(),'the current generation can send safely after durable rollback');
});

test('rollback removal keeps the archived name across reloads and later deletions',async()=>{
    const {c}=await fixture();
    const store=c.store;
    const id=Object.values(store.state.data.entries).find(entry=>entry.kind==='event').id;
    const previousAudit=structuredClone(store.state.audit);
    store.project(['m1','m2','m3']);
    assert.deepEqual(store.state.audit,previousAudit);
    await store.reconcile(['m1','m2','m3']);
    await store.load('delete-fixture','b');
    await store.reconcile(['m1']);
    const removals=store.state.audit.filter(row=>row.reason==='rollback-remove'&&row.entryId===id);
    assert.equal(removals.length,1);
    const [row]=removals;
    assert.deepEqual([row.title,row.kind,row.before,row.after,row.evidence],[LOST,'event','','',[]]);
    assert.equal(store.state.data.entries[id],undefined);
});
