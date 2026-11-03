import test from 'node:test';
import assert from 'node:assert/strict';
import {generateAuxiliary} from '../src/adapters/auxiliary-transport.js';
import {LazyAutomation, lazyFailure} from '../src/runtime/lazy-mode.js';
import {Controller} from '../src/runtime/controller.js';
import {modelApiError} from '../src/agents/client.js';

const until=async p=>{for(let i=0;i<500;i++){if(p())return;await new Promise(r=>setTimeout(r,1))}assert.fail('stage not reached')};
const native = (body, stream) => generateAuxiliary({params:{purpose:'maintain',system:'s',input:{},stream},
 context:{mainApi:'openai',chatCompletionSettings:{}},script:{extractMessageFromData:p=>p.choices[0].message.content},
 openai:{getChatCompletionModel:()=> 'synthetic',createGenerationParameters:async()=>({generate_data:{}})},fetchImpl:async()=>Response.json(body)});
test('TT custom upstream 402 wrapped as HTTP 502 stays non-retryable quota',()=>{
 const error=modelApiError({error:{message:'Custom OpenAI endpoint failed with status 402: Payment Required'}},502);
 assert.equal(lazyFailure(error),'quota');assert.equal(error.httpStatus,402);assert.equal(error.transportStatus,502);
});
for(const stream of [false,true]) for(const [message,extra,reason] of [
 ['Gateway Timeout',{},'connection'], ['Payment Required',{},'quota'], ['Too Many Requests',{quota_error:true},'quota'],
])test(`native HTTP 200 error ${message}, stream=${stream}, enters ${reason} recovery`,async()=>{
 await assert.rejects(native({error:{message},quota_error:false,...extra},stream),e=>lazyFailure(e)===reason);
});

test('failure to persist the automation ledger is storage attention, never a model connection failure',async()=>{
 const runner=new LazyAutomation({identity:()=>1,saved:()=>({}),enabled:()=>true,idle:()=>true,plan:async()=>[],
  run:async()=>{},save:async()=>{throw new Error('Chat integrity check rejected save')},notify(){},errorText:()=>'',capacity:()=>0,diagnostic(){}},
  {setTimer:()=>1,clearTimer(){}});
 runner.bind();assert.equal(await runner.save({updatedAt:'synthetic'}),false);
 assert.equal(runner.state.attention.reason,'storage');runner.stop();
});

async function fixture(){
 let disk,handle=()=>undefined,failSave=false;const calls=[];
 const live={chatId:'recovery',bookName:'b',templateEnabled:true,generating:false,messages:[{key:'m0',role:'user',content:'合成开场'},{key:'m1',role:'assistant',content:'合成回复'}]};
 const book=[{uid:1,content:'合成资料'}];
 const host={snapshot:()=>structuredClone(live),generationSnapshot:()=>structuredClone(live),loadWorldbook:async()=>structuredClone(book),
  storage:{read:async()=>structuredClone(disk),write:async(_,v)=>{if(failSave)throw Object.assign(new Error('HTTP 403'),{httpStatus:403});disk=structuredClone(v)}},clearPlan(){},setPlan(){},applyWindow:async()=>{}};
 const model={complete:async r=>{calls.push(r);const value=await handle(r);if(value!==undefined)return value;
  if(r.purpose==='initialize')return {strategy:'s',entries:r.input.entries.map(e=>({id:e.id,kind:'fact',intro:'i',segments:[{id:'body',writable:true}]}))};
  return {operations:[]};}};
 const make=()=>new Controller(host,{model,settings:{lazyMode:true,maintenanceEvery:1},lazyClock:{setTimer:()=>1,clearTimer(){}}});
 return {live,host,book,calls,make,handle:fn=>{handle=fn},failSave:value=>{failSave=value}};
}
test('stopping initialization remains explicitly stopped across reload and resumes only on manual retry',async()=>{
 const f=await fixture();let entered=false;
 f.handle(r=>{if(r.purpose==='initialize'){entered=true;return new Promise((_,reject)=>r.signal.addEventListener('abort',()=>reject(r.signal.reason),{once:true}))}});
 const c=f.make();await c.start();await until(()=>entered);await c.requestStop();await c.readinessChanged();
 assert.equal(c.view().lazy.status.state,'stopped');assert.equal(c.view().lazy.status.stoppedTask,'init');
 const count=f.calls.length;await c.readinessChanged();assert.equal(f.calls.length,count);await c.setLazyMode(false);
 const next=f.make();await next.start();await next.readinessChanged();assert.equal(next.view().lazy.status.state,'stopped');assert.equal(f.calls.length,count);
 f.handle(()=>undefined);await next.lazyRetry();assert.equal(next.store.state.initialized,true);assert.equal(next.view().lazy.status.state,'ready');await next.setLazyMode(false);
});
test('ignoring blocked new floors never reports those floors as recorded',async()=>{
 const f=await fixture(),c=f.make();await c.start();await c.readinessChanged();
 f.live.messages.push({key:'m2',role:'user',content:'被拒合成剧情'},{key:'m3',role:'assistant',content:'被拒合成回复'});
 f.handle(r=>{if(r.purpose==='maintain')throw Object.assign(new Error('synthetic moderation'),{dwmBlocked:true})});
 await c.readinessChanged();assert.equal(c.view().lazy.attention.reason,'moderation');await c.lazyIgnore();await c.readinessChanged();
 assert.equal(c.store.state.processed.length,4);assert.deepEqual(c.store.state.rememberedKeys,['m0','m1']);
 assert.equal(c.view().lazy.status.ignoredFloors,2);
 assert.ok(c.view().lazy.recent.some(r=>r.type==='ignored'&&r.from===3&&r.to===4));
 assert.ok(!c.view().lazy.recent.some(r=>r.type==='maintain'&&r.from<=4&&r.to>=3));
 await c.setLazyMode(false);
});

for(const task of ['maintain','sync','compact'])test(`explicit resume restarts a stopped ${task} task`,async()=>{
 const f=await fixture(),c=f.make();await c.start();await c.readinessChanged();await c.setLazyMode(false);
 if(task==='maintain')f.live.messages.push({key:'m2',role:'assistant',content:'新增剧情'});
 if(task==='sync')f.book.push({uid:2,content:'新条目'});
 if(task==='compact'){
  await c.store.commit({operations:[{type:'create',kind:'event',title:'经历',intro:'i',retrieveWhen:'w',text:'合成事件',evidence:['m0']}]},{expectedRevision:c.store.state.revision,sourceKeys:f.live.messages.map(m=>m.key)});
  await c.updateSettings({compactEvery:1});
 }
 let entered=false;const purpose=task==='sync'?'initialize':task;
 f.handle(r=>{if(r.purpose===purpose){entered=true;return new Promise((_,reject)=>r.signal.addEventListener('abort',()=>reject(r.signal.reason),{once:true}))}});
 await c.setLazyMode(true);await until(()=>entered);await c.requestStop();await c.readinessChanged();
 assert.equal(c.view().lazy.status.stoppedTask,task);const calls=f.calls.length;
 await c.readinessChanged();assert.equal(f.calls.length,calls);
 f.handle(()=>undefined);await c.lazyRetry();assert.ok(f.calls.length>calls);assert.equal(c.view().lazy.status.stoppedTask,null);
 if(task==='maintain')assert.equal(c.store.state.processed.length,3);
 if(task==='sync')assert.ok(c.store.state.data.entries['source:b:2']);
 await c.setLazyMode(false);
});
test('a rejected memory write retains committed progress and exposes storage attention',async()=>{
 const f=await fixture(),c=f.make();await c.start();await c.readinessChanged();
 f.live.messages.push({key:'m2',role:'assistant',content:'新增剧情'});f.failSave(true);await c.readinessChanged();
 assert.equal(c.store.state.processed.length,2);assert.equal(c.view().lazy.attention.reason,'storage');
 const calls=f.calls.length;await c.readinessChanged();assert.equal(f.calls.length,calls);
 f.failSave(false);await c.lazyRetry();assert.equal(c.store.state.processed.length,3);assert.equal(c.view().lazy.attention,null);await c.setLazyMode(false);
});

test('mixed ignored and remembered floors produce separate truthful completion ranges',async()=>{
 const f=await fixture(),first=f.make();await first.start();await first.readinessChanged();await first.setLazyMode(false);
 for(let i=2;i<5;i++)f.live.messages.push({key:`m${i}`,role:'assistant',content:`新增合成剧情 ${i}`});
 await first.store.updatePreferences({lazy:{...first.store.state.preferences.lazy,ignored:['m3']}});
 const c=f.make();await c.start();await c.readinessChanged();
 const records=c.view().lazy.recent.filter(r=>r.type==='maintain');
 assert.deepEqual(records.map(r=>[r.from,r.to]),[[3,3],[5,5]]);
 assert.equal(c.view().lazy.status.ignoredFloors,1);assert.ok(!c.store.state.rememberedKeys.includes('m3'));await c.setLazyMode(false);
});
test('unknown failures remain visible and do not trigger automatic paid retries',async()=>{
 let calls=0,saved={};const runner=new LazyAutomation({identity:()=>1,saved:()=>saved,enabled:()=>true,idle:()=>true,
  plan:async()=>[{task:'maintain'}],run:async()=>{calls++;throw new Error('synthetic unknown')},save:async value=>{saved=value},
  notify(){},errorText:()=> 'synthetic',capacity:()=>0,diagnostic(){}},{setTimer:()=>1,clearTimer(){}});
 await runner.kick();for(let i=0;i<5;i++)await runner.kick({event:true});
 assert.equal(calls,1);assert.equal(runner.state.attention.reason,'paused');runner.stop();
});
test('failed ledger writes do not publish an uncommitted ignore or success record',async()=>{
 const runner=new LazyAutomation({identity:()=>1,saved:()=>({ignored:['old'],recent:[]}),enabled:()=>true,idle:()=>true,plan:async()=>[],
  save:async()=>{throw new Error('save rejected')},notify(){}},{setTimer:()=>1,clearTimer(){}});
 runner.bind();await runner.save({ignored:['old','new']},{type:'ignored',from:2,to:2});
 assert.deepEqual(runner.state.ignored,['old']);assert.deepEqual(runner.state.recent,[]);assert.equal(runner.state.attention.reason,'storage');runner.stop();
});
