import test from 'node:test';
import assert from 'node:assert/strict';
import {createEntry,entryText} from '../src/core/state.js';
import {applyMaintenance} from '../src/core/operations.js';
import {MemoryStore} from '../src/core/store.js';
import {applySentenceEdits} from '../src/core/sentence-edits.js';
import {createSave} from '../src/core/state.js';
import {maintain} from '../src/agents/tasks.js';
const entry=text=>createEntry({id:'n',title:'人物',kind:'npc',text});
const replace=(oldText,newText='现住山城。')=>({segmentId:'body',oldText,newText});
function rejected(text,oldText,code){const before=entry(text),out=applySentenceEdits(before,[replace(oldText)]);assert.equal(entryText({segments:out.segments}),text);assert.equal(out.rejected[0].code,code);assert.equal(out.applied,0);}
test('whole multi-sentence bodies and multi-line selections cannot become rewrite operations',()=>{
 const text='性格寡言。对白示例：容我想想。现住旧港。';
 rejected(text,text,'patch-span-too-wide');
 rejected('性格寡言，口癖是容我想想，现住旧港','性格寡言，口癖是容我想想，现住旧港','patch-span-too-wide');
 rejected('旧港\n身体健康\n对白保留。','旧港\n身体健康','patch-span-multiline');
 for(const separator of ['\r\n','\u2028','\u2029'])rejected(`甲${separator}乙\n其它保留`, `甲${separator}乙`,'patch-span-multiline');
});
test('a bounded single edit cannot cover most of the body or exceed the absolute span limit',()=>{
 const lead='旧事实'.repeat(25)+'。',text=lead+'对白保留。';rejected(text,lead,'patch-span-too-wide');
 const large='甲'.repeat(257),long=large+'乙'.repeat(2000);rejected(long,large,'patch-span-too-long');
 // Whitespace must not inflate the denominator and hide near-total coverage.
 rejected(' '.repeat(2000)+lead+'短句。',lead,'patch-span-too-wide');
});
test('small sentence replacement, deletion and append remain available including short one-sentence entries',()=>{
 const text='性格寡言。对白示例：“容我想想。”现住旧港。';
 const out=applySentenceEdits(entry(text),[replace('现住旧港。'),replace('性格寡言。',''),{segmentId:'body',append:'\n已经归还钥匙。'}]);
 assert.equal(out.rejected.length,0);assert.equal(entryText({segments:out.segments}),'对白示例：“容我想想。”现住山城。\n已经归还钥匙。');
 for(const sentence of ['现住旧港。','住港口','Lives in the port.']){
  const short=applySentenceEdits(entry(sentence),[replace(sentence)]);assert.equal(short.rejected.length,0);assert.equal(short.segments[0].text,'现住山城。');
 }
});
test('another independent edit can succeed while an overbroad edit is rejected and audited atomically',async()=>{
 const lead='旧事实'.repeat(25)+'。',text=lead+'对白保留。';
 let disk;const store=new MemoryStore({read:async()=>disk,write:async(_,v)=>{disk=structuredClone(v)}});await store.load('c','b');await store.initialize([entry(text)],'');
 await store.commit({operations:[{type:'update',id:'n',expectedVersion:1,edits:[replace(lead),{segmentId:'body',append:'新情况。'}],evidence:['m1']}]},{expectedRevision:store.state.revision,sourceKeys:['m1']});
 assert.equal(entryText(store.state.data.entries.n),text+'新情况。');assert.equal(store.state.audit.at(-1).reason,'patch-span-too-wide');assert.deepEqual(store.state.rememberedKeys,[]);
});
test('name width normalization does not weaken exact body matching',()=>{
 const e=entry('姓名为Ｌｉｎａ，其他文字保留。');
 const out=applyMaintenance({entries:{n:e}},{operations:[{type:'update',id:'n',expectedVersion:1,edits:[replace('Lina','Nina')],evidence:['m1']}]},{allowedEvidence:['m1'],requireEdits:true});
 assert.equal(out.rejected[0].code,'patch-not-found');assert.equal(entryText(out.next.entries.n),entryText(e));
});
test('a short protected-reference token cannot hide a large original span from the limit',async()=>{
 const secret='保护'.repeat(300),save=createSave('c','b');save.data.entries.rule=createEntry({id:'rule',kind:'rule',title:'规则',text:secret});
 save.data.entries.n=entry('引用'+secret+'。其余资料保留。');
 const result=await maintain({complete:async request=>{
  assert.doesNotMatch(JSON.stringify(request.input),new RegExp(secret));
  const token=request.input.memory.entries[0].segments[0].text.match(/⟦鱼忆引用:[^⟧]+⟧/u)[0];
  return {operations:[{type:'update',id:'n',expectedVersion:1,edits:[replace(token,'缩短')],evidence:['m1']}]};
 }},save,[{key:'m1',role:'assistant',content:'合成新剧情'}]);
 const out=applyMaintenance(save.data,result,{allowedEvidence:['m1'],requireEdits:true});assert.equal(out.rejected[0].code,'patch-span-too-long');assert.equal(entryText(out.next.entries.n),entryText(save.data.entries.n));
});
