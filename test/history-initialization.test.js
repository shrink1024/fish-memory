import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptRegex } from '../src/adapters/prompt-regex.js';
import { createSillyTavernHost } from '../src/adapters/sillytavern.js';
import { Controller } from '../src/runtime/controller.js';

const rules = () => [
    {id:'window',promptOnly:true,placement:[1,2],minDepth:43,findRegex:'^[\\s\\S]*$',replaceString:''},
    {id:'cleanup',promptOnly:true,placement:[2],findRegex:'<status>[\\s\\S]*?</status>',replaceString:''},
    {id:'disabled',promptOnly:true,disabled:true,placement:[2],findRegex:'.*',replaceString:''},
    {id:'display',markdownOnly:true,placement:[2],findRegex:'.*',replaceString:''},
];
function engine(scripts=rules()) {
    const runRegexScript=(s,text)=>text.replace(new RegExp(s.findRegex,'g'),s.replaceString);
    return {getRegexScripts:()=>scripts,runRegexScript,
        getRegexedString(text,placement,{depth}) {
            for(const s of scripts) if(s.promptOnly&&!s.disabled&&s.placement.includes(placement)
                && (s.minDepth==null||depth>=s.minDepth)&&(s.maxDepth==null||depth<=s.maxDepth))text=runRegexScript(s,text);
            return text;
        }};
}
test('history cleans all floors independently of external hides and depth windows; send projection is unchanged',()=>{
    const read=createPromptRegex({engine:engine()});
    const chat=Array.from({length:291},(_,i)=>({mes:`<think>secret-${i}</think>story-${i}<status>noise</status>`,is_system:i<248}));
    const original=structuredClone(chat),before=read.project(chat);
    const history=read.projectHistory(chat);
    assert.deepEqual(history.map(m=>m.content),chat.map((_,i)=>`story-${i}`));
    assert.ok(history.every(m=>!m.regexSkipped));
    assert.deepEqual(read.project(chat),before);assert.deepEqual(chat,original);
    const visible=chat.map(m=>({...m,is_system:false}));
    assert.equal(read.project(visible).filter(m=>!m.regexSkipped).length,43);
    assert.equal(read.projectHistory(visible).filter(m=>!m.regexSkipped).length,291);
});
test('history strips complete, multiline and nested thinking but keeps an unclosed block, including without a host regex engine',()=>{
    const read=createPromptRegex();
    const input=['<think>hidden\nsecret</think>story','before<THINKING class="x">hidden</THINKING>after',
        'before<think>unfinished','<think>a<thinking>b</thinking>c</think>story','<think>only secret</think>','story'];
    assert.deepEqual(read.projectHistory(input.map(m=>({mes:m}))).map(m=>m.content),['story','beforeafter','before<think>unfinished','story','','story']);
    assert.equal(read.projectHistory([{mes:input[4]}])[0].regexSkipped,true);
    // An unclosed tag after closed blocks keeps only the unclosed remainder.
    assert.equal(read.projectHistory([{mes:'<think>a</think>他写下<think>两个字，又写了一段。'}])[0].content,'他写下<think>两个字，又写了一段。');
    assert.equal(read.projectHistory([{mes:'<think>a<thinking>b</thinking>c'}])[0].content,'<think>a<thinking>b</thinking>c');
});
test('history honors allowed rules, placements and disabling, and cleans thinking introduced by replacements',()=>{
    const scripts=[{id:'replace',promptOnly:true,placement:[2],findRegex:'draft',replaceString:'<think>new secret</think>story'}];
    const read=createPromptRegex({engine:engine(scripts)});
    assert.equal(read.projectHistory([{mes:'draft'}])[0].content,'story');
    assert.equal(read.projectHistory([{mes:'draft',is_user:true}])[0].content,'draft');
    scripts[0].replaceString='changed';assert.equal(read.projectHistory([{mes:'draft'}])[0].content,'changed');
    const disabled=createPromptRegex({engine:engine(),disabled:()=>true});
    assert.equal(disabled.projectHistory([{mes:'<think>secret</think>story<status>keep</status>'}])[0].content,'story<status>keep</status>');
});
test('initialization reads 291 cleaned messages through the real host adapter without changing outgoing hides',async()=>{
    const live={chatId:'synthetic',characterId:0,characters:[{avatar:'synthetic.png',data:{extensions:{world:'main'}}}],chatMetadata:{},
        chat:Array.from({length:291},(_,i)=>({mes:`<think>secret</think>story-${i}<status>noise</status>`,is_system:i<248,is_user:i%2===1}))};
    const native=await createSillyTavernHost({context:()=>live,extensions:{},worldInfo:{},script:{},save:async()=>{},regex:engine()});
    const sentBefore=native.snapshot(),before=structuredClone(live.chat),calls=[];let saved;
    const host={...native,snapshot:()=>({...native.snapshot(),templateEnabled:true}),
        initializationSnapshot:()=>({...native.initializationSnapshot(),templateEnabled:true}),
        loadWorldbook:async()=>[{uid:1,comment:'rule',content:'<% let x=1; %>'}],
        storage:{read:async()=>saved,write:async(_,v)=>{saved=structuredClone(v)}},clearPlan(){},applyWindow:async()=>{}};
    const c=new Controller(host,{settings:{enabled:true,historyBatchChars:18000},model:{complete:async r=>{
        calls.push(structuredClone(r));return {operations:[]};
    }}});
    await c.start();await c.initialize();
    const messages=calls.filter(r=>r.purpose==='maintain').flatMap(r=>r.input.messages);
    assert.equal(messages.length,291);assert.equal(new Set(messages.map(m=>m.key)).size,291);
    assert.ok(messages.every(m=>!m.content.includes('secret')));
    assert.equal(messages[0].content,'story-0');assert.equal(messages.at(-1).content,'story-290');
    assert.equal(c.store.state.rememberedKeys.length,291);
    assert.deepEqual(native.snapshot(),sentBefore);assert.deepEqual(live.chat,before);
    // Runtime maintenance remains on the ordinary outgoing projection.
    live.chat.push({mes:'hidden new floor',is_system:true});
    const count=calls.length;await c.maintain();assert.equal(calls.length,count);
});

test('depth-free cleaners may legitimately empty non-story rows; finite depth filters are excluded',()=>{
    const scripts=[
        {promptOnly:true,placement:[2],minDepth:0,maxDepth:-1,findRegex:'<status>[\\s\\S]*?</status>',replaceString:''},
        {promptOnly:true,placement:[2],maxDepth:0,findRegex:'.*',replaceString:'send-only'},
    ];
    const read=createPromptRegex({engine:engine(scripts)});
    assert.deepEqual(read.projectHistory([{mes:'<status>noise</status>'},{mes:'story'}]),[
        {content:'',regexSkipped:true},{content:'story',regexSkipped:false}]);
});
test('history cleanup failure stops instead of exposing the uncleaned story',()=>{
    const e=engine();e.runRegexScript=()=>{throw Error('cleaner failed');};
    assert.throws(()=>createPromptRegex({engine:e}).projectHistory([{mes:'<think>secret</think>story'}]),/cleaner failed/);
});
