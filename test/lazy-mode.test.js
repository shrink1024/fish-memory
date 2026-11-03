import test from 'node:test';
import assert from 'node:assert/strict';
import {LazyAutomation} from '../src/runtime/lazy-mode.js';
import {initialSettings} from '../src/adapters/settings.js';
import {Controller} from '../src/runtime/controller.js';
const tick=()=>new Promise(r=>setTimeout(r,1));
const until=async p=>{for(let i=0;i<1000;i++){if(p())return;await tick()}assert.fail('stage not reached')};
test('only installations without a Fish settings subtree opt into lazy mode',()=>{
 assert.equal(initialSettings({}).lazyMode,true);assert.equal(initialSettings({dwm:{}}).lazyMode,false);
 assert.equal(initialSettings({dwm:{enabled:true}}).lazyMode,false);assert.equal(initialSettings({dwm:{lazyMode:true}}).lazyMode,true);
});
for(const reason of ['connection','output','quota','moderation','cancelled'])test(`lazy ${reason} failure has bounded retries across repeated events and reload`,async()=>{
 let now=0,calls=0,saved={},enabled=true,identity='a';const errors={connection:Object.assign(Error('network offline'),{httpStatus:504}),output:Object.assign(Error('invalid'),{dwmResponseInvalid:true}),quota:Object.assign(Error('quota'),{kind:'quota'}),moderation:Object.assign(Error('blocked'),{dwmBlocked:true,dwmFloors:{from:1,to:2,keys:['a','b']}}),cancelled:Object.assign(Error('stop'),{name:'AbortError'})};
 const driver={identity:()=>identity,saved:()=>saved,enabled:()=>enabled,idle:()=>true,plan:async()=>[{task:'init'}],run:async()=>{calls++;throw errors[reason]},save:async s=>{saved=structuredClone(s)},notify(){},errorText:()=>reason,capacity:()=>91,diagnostic:e=>{throw e}};
 const clock={now:()=>now,setTimer:()=>({unref(){}}),clearTimer(){},delays:[1,5,30]};let runner=new LazyAutomation(driver,clock);
 await runner.kick();for(let i=0;i<20;i++){now+=100;await runner.kick({event:true})}
 const expected=['connection','output'].includes(reason)?5:1;assert.equal(calls,expected);
 runner.stop();runner=new LazyAutomation(driver,clock);for(let i=0;i<5;i++)await runner.kick({event:true});assert.equal(calls,expected);
 if(reason!=='cancelled')assert.equal(runner.state.attention.reason,reason);assert.ok(saved.recent.length<=5);
 enabled=false;await runner.kick({force:true});assert.equal(calls,expected);runner.stop();
});
test('lazy timers are called unbound, as browser setTimeout requires',async()=>{
 const strict=function(){if(this!==undefined&&this!==globalThis)throw new TypeError('Illegal invocation');return {unref(){}}};
 const driver={identity:()=>'a',saved:()=>({}),enabled:()=>true,idle:()=>true,plan:async()=>[],run:async()=>({}),save:async()=>{},notify(){},errorText:()=>'',capacity:()=>0,diagnostic:e=>{throw e}};
 const runner=new LazyAutomation(driver,{setTimer:strict,clearTimer:strict});await runner.kick();assert.ok(runner.timer);runner.stop();assert.equal(runner.timer,null);
});
async function fixture({lazyMode=true,messages=3,blocked=false}={}){
 let saved,block=blocked;const requests=[];const live={chatId:'c',bookName:'b',templateEnabled:true,generating:false,messages:Array.from({length:messages},(_,i)=>({key:`m${i}`,role:i%2?'assistant':'user',content:`合成剧情 ${i}`,hidden:false}))};
 const book=[{uid:1,comment:'设定',content:'合成资料'}];
 const host={snapshot:()=>structuredClone(live),generationSnapshot:()=>structuredClone(live),loadWorldbook:async()=>structuredClone(book),storage:{read:async()=>structuredClone(saved),write:async(_,v)=>{saved=structuredClone(v)}},clearPlan(){},setPlan(){},applyWindow:async()=>{}};
 const model={complete:async r=>{requests.push(r);if(r.purpose==='initialize')return {strategy:'s',entries:r.input.entries.map(e=>({id:e.id,kind:'fact',intro:'i',retrieveWhen:'w',segments:[{id:'body',writable:true}]}))};if(r.purpose==='maintain'&&block)throw Object.assign(Error('blocked'),{dwmBlocked:true});if(r.purpose==='select')return {ids:[]};return {operations:[]}}};
 const c=new Controller(host,{model,settings:{lazyMode,enabled:true,maintenanceEvery:1},lazyClock:{setTimer:()=>({unref(){}}),clearTimer(){}}});await c.start();
 return {c,live,requests,book,unblock:()=>{block=false},saved:()=>saved,host};
}
test('old players keep manual initialization; lazy mode initializes existing 312-floor histories',async()=>{
 const old=await fixture({lazyMode:false});await old.c.readinessChanged();assert.equal(old.c.store.state.initialized,false);assert.equal(old.requests.length,0);
 const f=await fixture({messages:312});await f.c.readinessChanged();await until(()=>f.c.store.state.initialized);await f.c.readinessChanged();
 assert.equal(f.c.store.state.processed.length,312);assert.equal(f.c.view().lazy.enabled,true);assert.equal(f.c.view().lazy.recent[0].type,'init');
 const calls=f.requests.length;await f.c.readinessChanged();assert.equal(f.requests.length,calls);await f.c.setLazyMode(false);
});
test('ignored moderated floors advance progress without certifying memory and later floors still work',async()=>{
 const f=await fixture({blocked:true});await f.c.readinessChanged();await until(()=>f.c.view().lazy.attention?.reason==='moderation');
 assert.deepEqual(f.c.view().lazy.attention.floors,{from:1,to:3});await f.c.lazyIgnore();await until(()=>f.c.store.state.initialized);
 assert.equal(f.c.store.state.processed.length,3);assert.deepEqual(f.c.store.state.rememberedKeys,[]);
 f.unblock();f.live.messages.push({key:'m3',role:'assistant',content:'后续剧情',hidden:false});f.c.messageReceived({type:'normal'});await f.c.readinessChanged();await until(()=>f.c.store.state.processed.length===4);
 assert.deepEqual(f.c.store.state.rememberedKeys,['m3']);assert.deepEqual(f.requests.filter(r=>r.purpose==='maintain').at(-1).input.messages.map(m=>m.key),['m3']);
 await f.c.store.reconcile(['m0','replacement']);assert.ok(!f.c.store.state.rememberedKeys.includes('m0'));await f.c.setLazyMode(false);
});

test('lazy scan yields between paid batches, persists accepted work, and resumes after failure without reclassifying',async()=>{
 let disk,release,failSecond=true;const calls=[];
 const live={chatId:'yield',bookName:'b',templateEnabled:true,generating:false,messages:[{key:'m',role:'user',content:'旧剧情'}]};
 const book=Array.from({length:3},(_,i)=>({uid:i,comment:`条目${i}`,content:'设定'.repeat(20)}));
 const host={snapshot:()=>structuredClone(live),generationSnapshot:()=>structuredClone(live),loadWorldbook:async()=>book,storage:{read:async()=>structuredClone(disk),write:async(_,v)=>{disk=structuredClone(v)}},clearPlan(){},applyWindow:async()=>{}};
 const c=new Controller(host,{settings:{lazyMode:true,batchChars:50},lazyClock:{setTimer:()=>1,clearTimer(){}},model:{complete:async r=>{
  if(r.purpose!=='initialize')return {operations:[]};calls.push(r.input.entries[0].id);
  if(calls.length===1)await new Promise(resolve=>{release=resolve});
  if(calls.length===2&&failSecond)throw Object.assign(Error('504'),{httpStatus:504});
  return {strategy:'s',entries:r.input.entries.map(e=>({id:e.id,kind:'fact',intro:'i',segments:[{id:'body',writable:true}]}))};
 }}});await c.start();await until(()=>release);
 live.generating=true;await c.generationBefore({type:'normal'});release();await until(()=>c.store.initializationCheckpoint()?.classifiedBatches===1);
 assert.equal(calls.length,1);assert.equal(c.view().lazy.status.deferredTurn,true);
 live.generating=false;await c.generationEnded();await until(()=>c.view().lazy.status.state==='waiting-retry');
 assert.equal(c.store.initializationCheckpoint().classifiedBatches,1,'retry ledger must not discard paid checkpoints');
 failSecond=false;await c.lazyRetry();await until(()=>c.store.state.initialized);
 assert.equal(calls.filter(id=>id===calls[0]).length,1);assert.equal(c.store.state.processed.length,1);await c.setLazyMode(false);
});

test('turning lazy mode off cancels scheduled retries without cancelling accepted work',async()=>{
 let enabled=true,time=0,ran=0,timers=new Map(),seq=0;const driver={identity:()=>1,saved:()=>({}),enabled:()=>enabled,idle:()=>true,plan:async()=>[{task:'init'}],run:async()=>{ran++;throw new TypeError('network')},save:async()=>{},notify(){},errorText:()=>'',capacity:()=>0,diagnostic:e=>{throw e}};
 const runner=new LazyAutomation(driver,{now:()=>time,setTimer:(fn,delay)=>{timers.set(++seq,{fn,delay});return seq},clearTimer:id=>timers.delete(id)});
 await runner.kick();assert.equal(ran,1);assert.equal(timers.size,1);enabled=false;await runner.kick();assert.equal(timers.size,0);time+=3600000;await runner.kick({event:true});assert.equal(ran,1);
});
test('lazy capacity recovery compacts once and requires explicit handling if still full',async()=>{
 let calls=0,saved={},now=0;const driver={identity:()=>1,saved:()=>saved,enabled:()=>true,idle:()=>true,plan:async()=>[{task:'compact'}],run:async()=>{calls++;throw Object.assign(Error('full'),{kind:'capacity'})},save:async s=>{saved=s},notify(){},errorText:()=>'',capacity:()=>95,diagnostic:e=>{throw e}};
 const runner=new LazyAutomation(driver,{now:()=>now,setTimer:()=>1,clearTimer(){}});await runner.kick();for(let i=0;i<10;i++){now+=3600000;await runner.kick({event:true})}
 assert.equal(calls,1);assert.equal(runner.state.attention.reason,'capacity');assert.equal(runner.state.attention.percent,95);runner.stop();
});

test('enabling lazy mode resolves existing source conflicts without rescanning or losing story text',async()=>{
 const f=await fixture();await f.c.readinessChanged();await f.c.setLazyMode(false);
 const id='source:b:1',old='资料'.repeat(12000);f.book[0].content=old;await f.c.syncSourceChanges();
 await f.c.manual({type:'edit',id,segments:[{id:'body',text:'剧情'+old+'剧情',writable:true}]});
 f.book[0].content=old.slice(0,10000)+'作者新版'+old.slice(10000);await f.c.syncSourceChanges();
 assert.equal(f.c.sourceChanges.held.length,1);const calls=f.requests.length;
 await f.c.setLazyMode(true);await f.c.readinessChanged();await until(()=>!Object.keys(f.c.store.state.sourceHeld??{}).length);
 assert.equal(f.requests.length,calls);assert.equal(f.c.store.state.data.entries[id].segments[0].text,'剧情'+old+'剧情');
 assert.equal(f.c.store.state.data.entries[id].source.original,f.book[0].content);assert.ok(f.c.view().lazy.recent.some(r=>r.type==='held-kept'));
 await f.c.readinessChanged();assert.equal(f.requests.length,calls);await f.c.setLazyMode(false);
});
test('unchanged generated memory is automatically compacted at most once',async()=>{
 const f=await fixture();await f.c.readinessChanged();
 await f.c.updateSettings({compactEvery:1});
 await f.c.store.commit({operations:[{type:'create',kind:'event',title:'经历',intro:'i',retrieveWhen:'w',text:'合成事件',evidence:['m0']}]},{expectedRevision:f.c.store.state.revision,sourceKeys:f.live.messages.map(m=>m.key)});
 await f.c.readinessChanged();const n=f.requests.filter(r=>r.purpose==='compact').length;assert.ok(n>0);
 for(let i=0;i<4;i++)await f.c.readinessChanged();assert.equal(f.requests.filter(r=>r.purpose==='compact').length,n);await f.c.setLazyMode(false);
});

test('controller network failures never exceed the scheduled plus one-event model-call budget',async()=>{
 let now=0,calls=0,disk;const live={chatId:'bounded',bookName:'b',templateEnabled:true,messages:[{key:'m',role:'user',content:'已有剧情'}]};
 const c=new Controller({snapshot:()=>structuredClone(live),loadWorldbook:async()=>[{uid:1,content:'资料'}],storage:{read:async()=>disk,write:async(_,v)=>{disk=structuredClone(v)}},clearPlan(){},applyWindow:async()=>{}},{settings:{lazyMode:true},lazyClock:{now:()=>now,delays:[1,5,30],setTimer:()=>1,clearTimer(){}},model:{complete:async()=>{calls++;throw new TypeError('network offline')}}});
 await c.start();await c.readinessChanged();for(let i=0;i<10;i++){now+=100;await c.readinessChanged()}
 assert.equal(calls,4);assert.equal(c.view().lazy.attention,null);
 c.messageReceived({type:'normal'});await c.readinessChanged();assert.equal(calls,5);assert.equal(c.view().lazy.attention.reason,'connection');
 for(let i=0;i<10;i++){live.messages.push({key:`n${i}`,role:'assistant',content:'继续'});c.messageReceived({type:'normal'});await c.readinessChanged()}
 assert.equal(calls,5);await c.setLazyMode(false);
});

test('advanced mode retains a persisted capacity notice and clears it after the player reduces memory',async()=>{
 const f=await fixture();await f.c.readinessChanged();await f.c.setLazyMode(false);
 await f.c.store.updatePreferences({lazy:{attention:{reason:'capacity',task:'compact',percent:95},failures:{compact:{reason:'capacity',attempts:1}}}});
 const advanced=new Controller(f.host,{settings:{lazyMode:false},model:{complete:async()=>assert.fail('advanced mode must not start automatically')}});await advanced.start();
 assert.equal(advanced.view().lazy.attention.reason,'capacity');
 await advanced.manual({type:'edit',id:'source:b:1',segments:[{id:'body',text:'短',writable:true}]});
 assert.equal(advanced.view().lazy.attention,null);
});

test('a host chat switch before its load event cannot run work against the previous store',async()=>{
 const f=await fixture();await f.c.readinessChanged();const calls=f.requests.length,previous=f.c.store.snapshot();
 f.live.chatId='new-chat';f.live.messages=[{key:'other',role:'user',content:'另一个聊天'}];
 await f.c.readinessChanged();assert.equal(f.requests.length,calls);assert.deepEqual(f.c.store.state,previous);
 await f.c.chatChanged();await f.c.readinessChanged();assert.equal(f.c.store.state.chatId,'new-chat');assert.equal(f.requests.filter(r=>r.purpose==='initialize').length,1,'inherited complete memory is never reinitialized');await f.c.setLazyMode(false);
});
