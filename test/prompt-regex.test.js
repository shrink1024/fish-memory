import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptRegex } from '../src/adapters/prompt-regex.js';
import { createSave } from '../src/core/state.js';
import { selectRequest, maintainRequest } from '../src/agents/requests.js';

test('prompt projection uses host permissions/placements/depth without mutating stored messages', () => {
    let allowed = true, calls = [];
    const engine = { getRegexScripts: () => allowed ? [{promptOnly:true,findRegex:'think',minDepth:1}] : [],
        getRegexedString(text, placement, options) { calls.push({placement,...options}); return allowed && options.depth >= 1 ? text.replace(/<think>.*?<\/think>/g,'') : text; } };
    const read = createPromptRegex({engine});
    const chat=[{mes:'<think>draft</think>story'},{mes:'hidden',is_system:true},{mes:'player',is_user:true}];
    const before=structuredClone(chat), result=read.project(chat);
    assert.equal(result[0].content,'story');assert.deepEqual(calls,[{placement:2,isPrompt:true,depth:1},{placement:1,isPrompt:true,depth:0}]);
    assert.deepEqual(chat,before);allowed=false;assert.equal(read.project(chat)[0].content,before[0].mes);
    const count=calls.length;assert.equal(read.project(chat,{type:'continue'})[2].content,'player');assert.equal(calls.length,count);
    allowed=true;read.project(chat,{type:'continue'});assert.equal(calls.at(-1).depth,-1);
});
test('empty regex results stay in the story path but never enter auxiliary requests', () => {
    const read=createPromptRegex({engine:{getRegexedString:t=>t.replace(/<think>.*?<\/think>/g,''),getRegexScripts:()=>[{promptOnly:true}]}});
    const projected=read.project([{mes:'<think>draft</think>'},{mes:'story'}]);
    const messages=projected.map((m,i)=>({...m,key:String(i),role:'assistant',hidden:false}));
    assert.equal(messages.length,2);assert.equal(messages[0].regexSkipped,true);
    const save=createSave('c','b');
    assert.deepEqual(selectRequest(save,messages,{}).input.messages.map(m=>m.key),['1']);
    assert.deepEqual(maintainRequest(save,messages).input.messages.map(m=>m.key),['1']);
});
test('missing engine falls back explicitly and regex changes invalidate memoized output', () => {
    const warnings=[];const read=createPromptRegex({warn:(...args)=>warnings.push(args)});
    assert.equal(read.project([{mes:'raw'}])[0].content,'raw');assert.equal(warnings[0][0],'prompt-regex-unavailable');
    let replacement='first';const engine={getRegexScripts:()=>[{promptOnly:true,replaceString:replacement}],getRegexedString:()=>replacement};
    const live=createPromptRegex({engine});assert.equal(live.project([{mes:'raw'}])[0].content,'first');replacement='second';assert.equal(live.project([{mes:'raw'}])[0].content,'second');
});


test('regex-only empty history advances initialization progress with no maintenance call',async()=>{
 const {Controller}=await import('../src/runtime/controller.js');
 let saved;const calls=[];const state={chatId:'c',bookName:'b',templateEnabled:true,generating:false,messages:[{key:'empty',role:'assistant',content:'',regexSkipped:true,hidden:false}]};
 const host={snapshot:()=>structuredClone(state),promptRegexSignature:()=> 'rules-a',loadWorldbook:async()=>[{uid:1,comment:'规则',content:'<% let x=1; %>'}],storage:{read:async()=>saved,write:async(_,v)=>{saved=structuredClone(v)}},clearPlan(){},applyWindow:async()=>{}};
 const c=new Controller(host,{model:{complete:async r=>{calls.push(r.purpose);return {operations:[]}}}});await c.start();await c.initialize();
 assert.deepEqual(c.store.state.processed,['empty']);assert.ok(!calls.includes('maintain'));await c.maintain();assert.ok(!calls.includes('maintain'));
});

test('absent prompt-only rules do not invoke the engine',()=>{
 const read=createPromptRegex({engine:{getRegexScripts:()=>[{markdownOnly:true}],getRegexedString:()=>assert.fail('display-only regex must not run')}});
 assert.equal(read.project([{mes:'raw'}])[0].content,'raw');
});
test('append invalidates only rows crossing applicable depth bands',()=>{
 let calls=0;const engine={getRegexScripts:()=>[{promptOnly:true,minDepth:2}],getRegexedString:(t,p,o)=>{calls++;return o.depth>=2?`filtered:${t}`:t}};
 const read=createPromptRegex({engine}),chat=Array.from({length:3000},(_,i)=>({mes:`${i}`}));
 read.project(chat);assert.equal(calls,3000);read.project(chat);assert.equal(calls,3000);
 chat.push({mes:'new'});const result=read.project(chat);assert.equal(calls,3002);assert.equal(result[2998].content,'filtered:2998');
 const continued=read.project(chat,{type:'continue'});assert.equal(calls,3002);assert.equal(continued[2998].content,'2998');
});
test('common name macros cache with context, invalidate on rename, and volatile macros never cache',()=>{
 let calls=0,name='甲',macro='char';const engine={getRegexScripts:()=>[{promptOnly:true,replaceString:`{{${macro}}}`}],getRegexedString:()=>`${name}:${++calls}`};
 const read=createPromptRegex({engine,macroContext:()=>({char:name,user:'玩家'})}),chat=[{mes:'raw'}];
 assert.equal(read.project(chat)[0].content,'甲:1');assert.equal(read.project(chat)[0].content,'甲:1');
 name='乙';assert.equal(read.project(chat)[0].content,'乙:2');macro='time';read.project(chat);read.project(chat);assert.equal(calls,4);
 const noContext=createPromptRegex({engine});macro='char';noContext.project(chat);noContext.project(chat);assert.equal(calls,6);
});

test('host generation projects volatile rules once and status snapshots stay read-only',async()=>{
 const {createSillyTavernHost}=await import('../src/adapters/sillytavern.js');let calls=0;
 const live={chatId:'synthetic',characterId:0,characters:[{avatar:'synthetic.png',data:{extensions:{world:'main'}}}],chatMetadata:{},chat:[{mes:'玩家',is_user:true},{mes:'正文',is_user:false}]};
 const host=await createSillyTavernHost({context:()=>live,extensions:{},worldInfo:{},script:{},save:async()=>{},
 regex:{getRegexScripts:()=>[{promptOnly:true,replaceString:'{{time}}'}],getRegexedString:t=>{calls++;return t+'投影'}}});
 const before=structuredClone(live.chat);assert.equal(host.statusSnapshot().messages[0].content,'玩家');assert.deepEqual(live.chat,before);assert.equal(calls,0);
 assert.equal(host.generationSnapshot().messages[1].content,'正文投影');assert.equal(calls,2);
 host.statusSnapshot();assert.equal(calls,2);
});
