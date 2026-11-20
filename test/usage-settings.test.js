import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsageSettings,updateUsageSettings,ECONOMY_BUNDLE} from '../src/core/usage-settings.js';
import {Controller} from '../src/runtime/controller.js';
import {selectionMessages} from '../src/agents/requests.js';
import {maintenanceSchedule} from '../src/runtime/maintenance-policy.js';

test('economy bundle stores opt-in and restores the exact preceding custom settings',()=>{
 const base=normalizeUsageSettings({maintenanceEvery:7,selectionLimit:9,recentTurns:20});
 const on=updateUsageSettings(base,{economyMode:true});assert.equal(on.change,'enabled');
 for(const [k,v] of Object.entries(ECONOMY_BUNDLE))assert.equal(on.settings[k],v);
 assert.equal(on.settings.recentTurns,20);assert.equal(on.settings.maintenanceKeepRecent,1);
 const reloaded=normalizeUsageSettings(on.settings),off=updateUsageSettings(reloaded,{economyMode:false});
 assert.equal(off.settings.maintenanceEvery,7);assert.equal(off.settings.selectionLimit,9);assert.equal(off.settings.selectionRecentTurns,20);
});
test('manual bundle edit disables mode, keeps the edited bundle, and does not infer opt-in from values',()=>{
 const on=updateUsageSettings(normalizeUsageSettings(),{economyMode:true}).settings;
 const edit=updateUsageSettings(on,{selectionRecentTurns:6});assert.equal(edit.change,'manual-override');assert.equal(edit.settings.economyMode,false);
 assert.equal(edit.settings.maintenanceEvery,5);assert.equal(edit.settings.selectionRecentTurns,6);assert.equal(edit.settings.economyRestore,undefined);
 assert.equal(normalizeUsageSettings({...ECONOMY_BUNDLE,economyMode:false}).economyMode,false);
 assert.equal(updateUsageSettings(on,{maintenanceKeepRecent:2}).settings.economyMode,true);
 assert.equal(updateUsageSettings(on,{selectionRecentTurns:4}).change,null);
});
test('an enabled saved bundle gains newly added fields while preserving their pre-upgrade values',()=>{
 const old=updateUsageSettings(normalizeUsageSettings({futureLimit:17}),{economyMode:true}).settings;
 const upgraded=normalizeUsageSettings(old,{...ECONOMY_BUNDLE,futureLimit:9});
 assert.equal(upgraded.economyMode,true);assert.equal(upgraded.futureLimit,9);assert.equal(upgraded.economyRestore.futureLimit,17);
 assert.equal(updateUsageSettings(upgraded,{economyMode:false},{...ECONOMY_BUNDLE,futureLimit:9}).settings.futureLimit,17);
 const oldDev=normalizeUsageSettings({economyMode:true,economyEvery:99,economyKeepRecent:20});
 assert.equal(oldDev.maintenanceKeepRecent,1);assert.equal(oldDev.maintenanceEvery,5);assert.equal('economyEvery' in oldDev,false);
});
test('missing restore values use standard defaults when explicitly disabling',()=>{
 const off=updateUsageSettings({...normalizeUsageSettings(),...ECONOMY_BUNDLE,economyMode:true},{economyMode:false});
 assert.equal(off.settings.maintenanceEvery,3);assert.equal(off.settings.selectionRecentTurns,12);
});
test('controller persists bundle transitions in lazy mode and reports manual override after save',async()=>{
 const writes=[];const c=new Controller({snapshot:()=>({messages:[]})},{settings:{lazyMode:true},persistSettings:async s=>writes.push(structuredClone(s)),model:{complete:async()=>({})}});
 await c.setEconomyMode(true);assert.equal(c.settings.economyMode,true);assert.equal(writes.at(-1).economyMode,true);
 const changed=await c.updateSettings({selectionLimit:8});assert.equal(changed.economyModeChange,'manual-override');assert.equal(c.settings.selectionLimit,8);assert.equal(c.settings.maintenanceEvery,5);
 assert.equal(writes.at(-1).economyMode,false);
});
test('selection reference turns are independent of narration retention and retain unread backlog',()=>{
 const messages=Array.from({length:20},(_,i)=>({key:`m${i}`,role:i%2?'assistant':'user',content:'正文'}));
 const save={processed:messages.slice(0,4).map(m=>m.key)};
 const recent=selectionMessages({messages,userInput:''},save,4);
 assert.deepEqual(recent.map(m=>m.key),messages.slice(4).map(m=>m.key));
 const settings=normalizeUsageSettings({maintenanceEvery:3});
 const schedule=maintenanceSchedule(messages,[],settings);
 assert.equal(schedule.retainedReplies,1);assert.equal(schedule.eligibleReplies,9);assert.equal(schedule.eligiblePendingCount,18);assert.equal(schedule.retainedPendingCount,2);
});

test('future boolean and enum bundle members retain their original settings across reload',()=>{
 const bundle={...ECONOMY_BUNDLE,futureFlag:false,futurePolicy:'lean'};
 const base=normalizeUsageSettings({futureFlag:true,futurePolicy:'full'});
 const on=updateUsageSettings(base,{economyMode:true},bundle).settings;
 const reload=normalizeUsageSettings(on,bundle),off=updateUsageSettings(reload,{economyMode:false},bundle).settings;
 assert.equal(off.futureFlag,true);assert.equal(off.futurePolicy,'full');
});

test('legacy enabled mode with no restore record falls back to standard defaults, not its saved active values',()=>{
 const loaded=normalizeUsageSettings({economyMode:true,maintenanceEvery:7,selectionRecentTurns:6});
 const off=updateUsageSettings(loaded,{economyMode:false}).settings;
 assert.equal(off.maintenanceEvery,3);assert.equal(off.selectionRecentTurns,12);
});
test('failed persistence does not announce or apply an automatic mode shutdown',async()=>{
 let fail=false;const c=new Controller({snapshot:()=>({chatId:null,bookName:null,messages:[]})},{model:{complete:async()=>({})},persistSettings:async()=>{if(fail)throw Error('save failed')}});
 await c.setEconomyMode(true);fail=true;
 await assert.rejects(c.updateSettings({maintenanceEvery:9}),/save failed/);
 assert.equal(c.settings.economyMode,true);assert.equal(c.settings.maintenanceEvery,5);
});

test('shorter selection reference window never drops unremembered text inside narration retention',()=>{
 const messages=Array.from({length:12},(_,i)=>({key:`k${i}`,role:i%2?'assistant':'user',content:i%2?'文'.repeat(50000):'输入'}));
 const result=selectionMessages({messages,userInput:''},{processed:[]},2);
 assert.deepEqual(result.map(m=>m.key),messages.map(m=>m.key));
 const remembered=selectionMessages({messages,userInput:''},{processed:messages.map(m=>m.key)},2);
 assert.deepEqual(remembered.map(m=>m.key),messages.slice(-4).map(m=>m.key));
});

test('economy bundle preserves the existing source scan budget',()=>{
 const current=normalizeUsageSettings({batchChars:12000});assert.equal(current.sourceBatchChars,12000);
 const on=updateUsageSettings(current,{economyMode:true}).settings;assert.equal(on.batchChars,40000);assert.equal(on.sourceBatchChars,12000);
 const reloaded=normalizeUsageSettings(on);assert.equal(reloaded.sourceBatchChars,12000);
});

test('enabling economy does not change first worldbook scan partitioning',async()=>{
 let saved;const calls=[];
 const host={snapshot:()=>({chatId:'c',bookName:'b',messages:[],templateEnabled:true}),loadWorldbook:async()=>[1,2].map(uid=>({uid,content:'字'.repeat(10000)})),
  storage:{read:async()=>saved,write:async(_,v)=>{saved=structuredClone(v)}},clearPlan(){},applyWindow:async()=>{}};
 const c=new Controller(host,{settings:{batchChars:12000},model:{complete:async r=>{calls.push(r);return {strategy:'s',entries:r.input.entries.map(e=>({id:e.id,kind:'fact',intro:'合成',segments:[{id:'body',writable:true}]}))};}}});
 await c.start();await c.setEconomyMode(true);await c.initialize();
 assert.equal(c.settings.batchChars,40000);assert.equal(c.settings.sourceBatchChars,12000);
 assert.equal(calls.filter(r=>r.purpose==='initialize').length,2);
});
