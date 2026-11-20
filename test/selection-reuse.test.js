import test from 'node:test';
import assert from 'node:assert/strict';
import {createEntry} from '../src/core/state.js';
import {Controller} from '../src/runtime/controller.js';
const clone=structuredClone;
function fixture(settings={}){
 let saved, signature='native-model-a';const calls=[],plans=[];
 const state={chatId:'c',bookName:'b',templateEnabled:true,generating:false,messages:[],userInput:'相同请求'};
 const host={snapshot:()=>clone(state),generationSnapshot:()=>clone(state),selectionContextSignature:()=>signature,
  loadWorldbook:async()=>[],storage:{read:async()=>saved,write:async(_,v)=>{saved=clone(v)}},clearPlan(){},setPlan:p=>plans.push(p),applyWindow:async()=>{}};
 let fail=false,gate,selected=[],maintenance={operations:[]};
 const controller=new Controller(host,{settings,model:{complete:async r=>{
  calls.push(r);if(r.purpose==='select'){if(gate)await gate;if(fail)throw Error('synthetic failure');return {ids:[...selected]};}return structuredClone(maintenance);
 }}});
 return {controller,state,calls,plans,host,signature:v=>{signature=v},ids:v=>{selected=v},maintenance:v=>{maintenance=v},fail:v=>{fail=v},gate:p=>{gate=p},start:async()=>{await controller.start();await controller.initialize();calls.length=0;}};
}
const selects=f=>f.calls.filter(r=>r.purpose==='select').length;
test('same turn reuses selection; forcing refresh is one-shot and never generates narration',async()=>{
 const f=fixture();await f.start();await f.controller.generationBefore({type:'normal'});await f.controller.generationBefore({type:'regenerate'});
 assert.equal(selects(f),1);assert.equal(f.plans.at(-1).selectionSource,'reused');
 f.controller.setNextSelectionRefresh(true);await f.controller.generationBefore({type:'regenerate'});
 assert.equal(selects(f),2);assert.equal(f.controller.view().selectionReuse.forceNext,false);
 await f.controller.generationBefore({type:'regenerate'});assert.equal(selects(f),2);
 await f.controller.updateSettings({rerollSelection:'refresh'});await f.controller.generationBefore({type:'regenerate'});await f.controller.generationBefore({type:'regenerate'});
 assert.equal(selects(f),4);
});
test('draft-to-stored player message normalizes only the same turn, not a later identical turn',async()=>{
 const f=fixture();await f.start();await f.controller.generationBefore({type:'normal'});
 f.state.messages.push({key:'stored-user-1',role:'user',content:f.state.userInput});f.state.userInput='';
 await f.controller.generationBefore({type:'regenerate'});assert.equal(selects(f),1);
 f.state.messages.push({key:'reply-1',role:'assistant',content:'已回复'});f.state.userInput='相同请求';
 await f.controller.generationBefore({type:'normal'});assert.equal(selects(f),2);
});
test('input, effective memory, native model and settings invalidate selection reuse',async()=>{
 const f=fixture();await f.start();await f.controller.generationBefore({type:'normal'});
 f.state.userInput='改过的输入';await f.controller.generationBefore({type:'normal'});assert.equal(selects(f),2);
 f.controller.store.state.data.summary='新的事实';await f.controller.generationBefore({type:'normal'});assert.equal(selects(f),3);
 f.signature('native-model-b');await f.controller.generationBefore({type:'normal'});assert.equal(selects(f),4);
 await f.controller.updateSettings({selectionLimit:8});await f.controller.generationBefore({type:'normal'});assert.equal(selects(f),5);
});
test('failed forced refresh and preview do not consume the one-shot option',async()=>{
 const f=fixture();await f.start();await f.controller.generationBefore({type:'normal'});
 f.controller.setNextSelectionRefresh(true);await f.controller.previewPlan();assert.equal(f.controller.view().selectionReuse.forceNext,true);
 f.fail(true);await f.controller.generationBefore({type:'regenerate'});assert.equal(f.controller.view().selectionReuse.forceNext,true);
 f.fail(false);await f.controller.generationBefore({type:'regenerate'});assert.equal(f.controller.view().selectionReuse.forceNext,false);assert.equal(f.plans.at(-1).selectionSource,'fresh');
});
test('a late cancelled selection cannot populate the cache',async()=>{
 const f=fixture();await f.start();let release;f.gate(new Promise(r=>{release=r}));
 const running=f.controller.generationBefore({type:'normal'});
 for(let i=0;i<30&&!selects(f);i++)await new Promise(r=>setImmediate(r));
 f.controller.cancel();release();await running;f.gate(null);
 await f.controller.generationBefore({type:'normal'});assert.equal(selects(f),2);assert.equal(f.plans.at(-1).selectionSource,'fresh');
});

test('one-shot refresh can replace a bad but valid previous selection',async()=>{
 const f=fixture();await f.start();
 for(const id of ['a','b'])f.controller.store.state.data.entries[id]=createEntry({id,kind:'fact',title:id,text:'合成资料'+id});
 f.ids(['a']);await f.controller.generationBefore({type:'normal'});assert.deepEqual(f.plans.at(-1).selectedIds,['a']);
 f.ids(['b']);await f.controller.generationBefore({type:'regenerate'});assert.deepEqual(f.plans.at(-1).selectedIds,['a']);
 f.controller.setNextSelectionRefresh(true);await f.controller.generationBefore({type:'regenerate'});assert.deepEqual(f.plans.at(-1).selectedIds,['b']);
 await f.controller.generationBefore({type:'regenerate'});assert.deepEqual(f.plans.at(-1).selectedIds,['b']);assert.equal(selects(f),2);
});

test('automatic maintenance of already-read history preserves the selected turn, manual inventory edits invalidate it',async()=>{
 const f=fixture({maintenanceEvery:2,maintenanceKeepRecent:1});await f.start();
 f.state.messages=Array.from({length:6},(_,i)=>({key:`old-${i}`,role:i%2?'assistant':'user',content:`合成剧情${i}`}));
 await f.controller.generationBefore({type:'normal'});
 f.maintenance({operations:[{type:'appendSummary',text:'旧剧情已整理。'}]});
 await f.controller.maintain({automatic:true});assert.equal(f.controller.store.state.processed.length,4);
 assert.equal(f.controller.store.state.journal.at(-1).automatic,true);
 await f.controller.generationBefore({type:'regenerate'});assert.equal(selects(f),1);assert.equal(f.plans.at(-1).selectionSource,'reused');
 await f.controller.manual({type:'inventory-edit',scopeId:'global',items:[{name:'手动钥匙',description:'玩家确认'}],expectedSaveId:f.controller.store.state.id,expectedRevision:f.controller.store.state.revision});
 await f.controller.generationBefore({type:'regenerate'});assert.equal(selects(f),2);
});
test('automatic maintenance of newly exposed history cannot reuse a selection that never read it',async()=>{
 const f=fixture({selectionRecentTurns:2,recentTurns:2,maintenanceEvery:2,maintenanceKeepRecent:1});await f.start();
 f.state.messages=Array.from({length:12},(_,i)=>({key:`long-${i}`,role:i%2?'assistant':'user',content:i%2?'文'.repeat(20000):'输入'}));
 f.state.messages[0].hidden=true;
 await f.controller.generationBefore({type:'normal'});
 const seen=new Set(f.calls.find(r=>r.purpose==='select').input.messages.map(m=>m.key));assert.equal(seen.has('long-0'),false);
 f.state.messages[0].hidden=false;
 await f.controller.maintain({automatic:true});
 await f.controller.generationBefore({type:'regenerate'});assert.equal(selects(f),2);
});

test('switching an existing candidate invalidates reuse even if a later projection has the same prefix',async()=>{
 const f=fixture();await f.start();await f.controller.generationBefore({type:'normal'});
 f.controller.messageSwiped();await f.controller.whenIdle();
 await f.controller.generationBefore({type:'regenerate'});assert.equal(selects(f),2);
});

const reroll = (f,type='regenerate',other={}) => f.controller.generationBefore({type,playerReroll:true,...other});
async function askFixture() {
    const f=fixture({rerollSelection:'ask'});await f.start();
    f.controller.store.state.data.entries.a=createEntry({id:'a',kind:'npc',title:'阿舟',text:'资料'});
    f.ids(['a']);await f.controller.generationBefore({type:'normal'});
    return f;
}
for(const type of ['regenerate','swipe'])for(const answer of ['reuse','refresh',undefined]){
 test('ask waits for '+type+' and resolves '+String(answer),async()=>{
    const f=await askFixture(),initial=f.plans.length;let answerDialog,show;
    const opened=new Promise(resolve=>{show=resolve});
    f.controller.registerRerollChoiceHandler(payload=>{show(payload);return new Promise(resolve=>{answerDialog=resolve})});
    const running=reroll(f,type),payload=await opened;
    assert.deepEqual(payload.entries,[{id:'a',title:'阿舟'}]);assert.equal(payload.count,1);assert.equal(payload.type,type);
    assert.equal(f.plans.length,initial);assert.equal(selects(f),1);
    answerDialog(answer);await running;
    assert.equal(f.plans.length,initial+1);assert.equal(selects(f),answer==='refresh'?2:1);
    assert.equal(f.plans.at(-1).selectionSource,answer==='refresh'?'fresh':'reused');
 });
}
test('ask skips noninteractive, forced, stale, first-send, preview and lazy paths',async()=>{
    const f=fixture({rerollSelection:'ask'});await f.start();let asked=0;
    f.controller.registerRerollChoiceHandler(()=>{asked++;return 'refresh'});
    await reroll(f);await f.controller.generationBefore({type:'normal'});
    await f.controller.generationBefore({type:'regenerate'});await reroll(f,'swipe',{options:{automatic_trigger:true}});
    await f.controller.previewPlan();await reroll(f,'continue');
    f.state.userInput='改动输入';await reroll(f);const previous=selects(f);
    f.controller.setNextSelectionRefresh(true);await reroll(f);assert.equal(selects(f),previous+1);
    await f.controller.updateSettings({lazyMode:true});await reroll(f);
    assert.equal(f.plans.at(-1).selectionSource,'reused');assert.equal(asked,0);
});
for(const action of ['stop','switch','unmount','settings','force','native-input'])test('pending ask handles '+action,async()=>{
    const f=await askFixture();let show,reply;const opened=new Promise(resolve=>{show=resolve});
    const dispose=f.controller.registerRerollChoiceHandler(p=>{show(p);return new Promise(resolve=>{reply=resolve})});
    const count=f.plans.length,r=reroll(f);const p=await opened;
    if(action==='stop')f.controller.generationStopped();
    if(action==='switch'){f.state.chatId='another';await f.controller.chatChanged();}
    if(action==='unmount')dispose();
    if(action==='settings'){await f.controller.updateSettings({selectionLimit:6});reply('reuse');}
    if(action==='native-input'){f.state.userInput='更新后的输入';reply('reuse');}
    if(action==='force')f.controller.setNextSelectionRefresh(true);
    const result=await r;reply('refresh');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(p.signal.aborted,true);
    const cancelled=['stop','switch'].includes(action);
    assert.equal(Boolean(result?.cancel),cancelled);
    assert.equal(f.plans.length,count+(cancelled?0:1));
    assert.equal(selects(f),['settings','force','native-input'].includes(action)?2:1);
});
