import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/runtime/controller.js';
import {LazyAutomation} from '../src/runtime/lazy-mode.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const until=async p=>{for(let i=0;i<1000;i++){if(p())return;await new Promise(r=>setTimeout(r,1))}assert.fail('stage not reached')};
async function fixture(){
 let disk,plan,handler=null;const calls=[];
 const live={chatId:'c',bookName:'b',templateEnabled:true,generating:false,messages:[{key:'m1',role:'user',content:'合成开场'},{key:'m2',role:'assistant',content:'合成回复'}]};
 const host={snapshot:()=>structuredClone(live),generationSnapshot:()=>structuredClone(live),loadWorldbook:async()=>[{uid:1,comment:'人物',content:'合成人物资料'}],storage:{read:async()=>structuredClone(disk),write:async(_,v)=>{disk=structuredClone(v)}},clearPlan(){plan=null},setPlan:p=>{plan=p},applyWindow:async()=>{}};
 const model={complete:async r=>{calls.push(r);if(handler){const result=await handler(r);if(result!==undefined)return result}if(r.purpose==='initialize')return {strategy:'s',entries:r.input.entries.map(e=>({id:e.id,kind:'npc',intro:'i',retrieveWhen:'w',segments:[{id:'body',writable:true}]}))};if(r.purpose==='select')return {ids:r.input.catalog.map(e=>e.id)};return {operations:[]}}};
 const make=(lazyMode=false)=>new Controller(host,{model,settings:{lazyMode,enabled:true,maintenanceEvery:1},lazyClock:{setTimer:()=>1,clearTimer(){}}});
 const c=make();await c.start();await c.initialize();return {c,host,live,calls,make,plan:()=>plan,handle:fn=>{handler=fn}};
}
test('enabling lazy mode returns after settings are saved without waiting for a model task',async()=>{
 const f=await fixture(),gate=deferred();f.live.messages.push({key:'m3',role:'assistant',content:'新增剧情'});f.handle(r=>r.purpose==='maintain'?gate.promise:undefined);
 let returned=false;const enabling=f.c.setLazyMode(true).then(()=>{returned=true});
 try{await until(()=>returned);assert.equal(f.c.settings.lazyMode,true);await until(()=>f.c.view().activity?.kind==='maintain');}
 finally{gate.resolve({operations:[]});await enabling;await f.c.readinessChanged();await f.c.setLazyMode(false)}
});
test('capacity reminders do not withdraw usable dynamic memory or bypass selection',async()=>{
 const f=await fixture();await f.c.store.updatePreferences({lazy:{attention:{reason:'capacity',task:'compact'},failures:{compact:{reason:'capacity',attempts:1}}}});
 const c=f.make(true);await c.start();await c.generationBefore({type:'normal'});
 assert.ok(f.plan()?.selectedIds.includes('source:b:1'));assert.ok(f.calls.some(r=>r.purpose==='select'));await c.setLazyMode(false);
});
test('ordinary background maintenance lets selection use committed memory and waits to commit',async()=>{
 const f=await fixture(),maintenance=deferred(),selection=deferred();await f.c.setLazyMode(true);await f.c.readinessChanged();
 f.live.messages.push({key:'m3',role:'assistant',content:'新增剧情'});
 f.handle(r=>r.purpose==='maintain'?maintenance.promise:r.purpose==='select'?selection.promise:undefined);
 f.c.messageReceived({type:'normal'});await until(()=>f.c.view().activity?.kind==='maintain');
 const sending=f.c.generationBefore({type:'normal'});
 try{await until(()=>f.calls.some(r=>r.purpose==='select'));const revision=f.c.store.state.revision;maintenance.resolve({operations:[]});await new Promise(r=>setTimeout(r,10));assert.equal(f.c.store.state.revision,revision);selection.resolve({ids:['source:b:1']});await sending;assert.ok(f.plan()?.selectedIds.includes('source:b:1'));}
 finally{maintenance.resolve({operations:[]});selection.resolve({ids:[]});await sending;await f.c.readinessChanged();await f.c.setLazyMode(false)}
});
for(const reason of ['connection','output'])test(`status exposes ${reason} while waiting and actively retrying`,async()=>{
 const f=await fixture(),gate=deferred();f.live.messages.push({key:'m3',role:'assistant',content:'新增剧情'});
 await f.c.store.updatePreferences({lazy:{failures:{maintain:{reason,attempts:1,nextRetryAt:Date.now()+60000,floors:{from:3,to:3,keys:['m3']}}}}});
 const c=f.make(true);await c.start();await c.readinessChanged();assert.equal(c.view().lazy.status.retryReason,reason);
 f.handle(r=>r.purpose==='maintain'?gate.promise:undefined);const retry=c.lazyRetry();await until(()=>c.view().lazy.status.state==='retrying');assert.equal(c.view().lazy.status.retryReason,reason);
 gate.resolve({operations:[]});await retry;assert.equal(c.view().lazy.status.retryReason,null);assert.equal(c.view().lazy.recent.filter(r=>r.type==='retry'&&r.ok).length,1);assert.equal(c.view().lazy.recent.filter(r=>r.type==='maintain').length,0);await c.setLazyMode(false);
});
for(const reason of ['connection','output','moderation'])test(`only moderation exposes ignore (${reason})`,async()=>{
 const error=Object.assign(new Error('synthetic'),{...(reason==='moderation'?{dwmBlocked:true}:reason==='output'?{dwmResponseInvalid:true}:{httpStatus:504}),dwmFloors:{from:1,to:2,keys:['a','b']}});
 let now=0;const runner=new LazyAutomation({identity:()=>1,saved:()=>({}),enabled:()=>true,idle:()=>true,plan:async()=>[{task:'maintain'}],run:async()=>{throw error},save:async()=>{},notify(){},errorText:()=>reason,capacity:()=>0,diagnostic:e=>{throw e}},{now:()=>now,delays:[1,5,30],setTimer:()=>1,clearTimer(){}});
 for(let i=0;i<5;i++){now+=100;await runner.kick({event:true})}assert.equal(runner.state.attention.canIgnore===true,reason==='moderation');runner.stop();
});

test('automatic completion records cannot change the revision during a newly started selection',async()=>{
 const f=await fixture(),maintenance=deferred(),selection=deferred();await f.c.setLazyMode(true);await f.c.readinessChanged();
 f.live.messages.push({key:'m3',role:'assistant',content:'新增剧情'});f.handle(r=>r.purpose==='maintain'?maintenance.promise:r.purpose==='select'?selection.promise:undefined);
 let sending;const unsubscribe=f.c.subscribe(view=>{if(!sending&&!view.activity&&view.status==='补记已完成'&&view.save?.processedCount===3){sending=true;sending=f.c.generationBefore({type:'normal'});}});
 f.c.messageReceived({type:'normal'});await until(()=>f.c.view().activity?.kind==='maintain');maintenance.resolve({operations:[]});
 try{await until(()=>f.calls.some(r=>r.purpose==='select'));const revision=f.c.store.state.revision;await new Promise(r=>setTimeout(r,10));assert.equal(f.c.store.state.revision,revision);selection.resolve({ids:['source:b:1']});await sending;assert.ok(f.plan()?.selectedIds.includes('source:b:1'));}
 finally{unsubscribe();selection.resolve({ids:[]});await sending;await f.c.readinessChanged();await f.c.setLazyMode(false)}
});
