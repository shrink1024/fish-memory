import test from 'node:test';
import assert from 'node:assert/strict';
import {createEntry,createSave,makeSourceEntry,entryText} from '../src/core/state.js';
import {applyMaintenance} from '../src/core/operations.js';
import {MemoryStore} from '../src/core/store.js';
import {Controller} from '../src/runtime/controller.js';
import {AgentClient} from '../src/agents/client.js';
import {encodeSave,decodeSave} from '../src/core/storage-codec.js';
import {maintain,compact} from '../src/agents/tasks.js';
const original='性格：寡言。\r\n对白：“容我想想。”\n现住旧港。';
const entry=()=>createEntry({id:'npc',kind:'npc',title:'林舟',text:original});
const op=edits=>({type:'update',id:'npc',expectedVersion:1,edits,evidence:['m1']});
const apply=(edits,extra={})=>applyMaintenance({entries:{npc:entry()},summary:''},{operations:[{...op(edits),...extra}]},{allowedEvidence:['m1'],requireEdits:true});
test('replacement, deletion and append preserve every unmentioned byte including voice examples and CRLF',()=>{
 const out=apply([{segmentId:'body',oldText:'现住旧港。',newText:'现住山城。'},{segmentId:'body',oldText:'性格：寡言。',newText:''},{segmentId:'body',append:'\n已经归还钥匙。'}]);
 assert.equal(entryText(out.next.entries.npc),'\r\n对白：“容我想想。”\n现住山城。\n已经归还钥匙。');assert.equal(out.rejected.length,0);
});
test('missing and ambiguous anchors reject only their edit and do not publish misleading intro metadata',()=>{
 const out=apply([{segmentId:'body',oldText:'没有的句子',newText:'虚构'}, {segmentId:'body',oldText:'现住旧港。',newText:'现住山城。'}],{intro:'包含未执行的虚构改动'});
 assert.equal(out.rejected[0].code,'patch-not-found');assert.match(entryText(out.next.entries.npc),/现住山城/);assert.equal(out.next.entries.npc.intro,'');
 const e=entry();e.segments[0].text='同一句。同一句。';
 const repeated=applyMaintenance({entries:{npc:e}},{operations:[op([{segmentId:'body',oldText:'同一句。',newText:'删改'}])]},{allowedEvidence:['m1'],requireEdits:true});
 assert.equal(repeated.rejected[0].code,'patch-ambiguous');assert.deepEqual(repeated.next.entries.npc,e);
});
test('overlaps and protected segments are rejected while independent appends can proceed',()=>{
 const out=apply([{segmentId:'body',oldText:'现住旧港。',newText:'A'},{segmentId:'body',oldText:'旧港',newText:'B'},{segmentId:'body',append:'尾部'}]);
 assert.deepEqual(out.rejected.map(e=>e.code),['patch-overlap','patch-overlap']);assert.equal(entryText(out.next.entries.npc),original+'尾部');
 const e=entry();e.segments.unshift({id:'locked',text:'保护规则',writable:false});
 const blocked=applyMaintenance({entries:{npc:e}},{operations:[op([{segmentId:'locked',oldText:'保护规则',newText:'篡改'},{segmentId:'body',append:'\n新进展'}])]},{allowedEvidence:['m1'],requireEdits:true});
 assert.equal(blocked.rejected[0].code,'patch-protected');assert.equal(blocked.next.entries.npc.segments[0].text,'保护规则');
});
test('whole rewrites cannot bypass the automatic path, and brand new entries still accept a full body',async()=>{
 let disk;const store=new MemoryStore({read:async()=>disk,write:async(_,v)=>{disk=structuredClone(v)}});await store.load('c','b');await store.initialize([entry()],'');
 await store.commit({operations:[{type:'update',id:'npc',expectedVersion:1,segments:[{id:'body',text:'漏了对白'}],evidence:['m1']},
   {type:'create',kind:'event',title:'事件',text:'完整新事件',evidence:['m1']}]},{expectedRevision:store.state.revision,sourceKeys:['m1']});
 assert.equal(entryText(store.state.data.entries.npc),original);assert.equal(store.state.audit.find(e=>e.outcome==='rejected').reason,'patch-rewrite-rejected');
 assert.ok(Object.values(store.state.data.entries).some(e=>e.title==='事件'));
});
test('sentence changes replay along the chosen branch and a failed write does not publish rejection audit',async()=>{
 let fail=false;const store=new MemoryStore({read:async()=>null,write:async()=>{if(fail)throw Error('disk full')}});await store.load('c','b');await store.initialize([entry()],'');
 await store.commit({operations:[op([{segmentId:'body',oldText:'现住旧港。',newText:'现住山城。'}])]},{expectedRevision:store.state.revision,sourceKeys:['m1']});
 const before=store.snapshot();fail=true;await assert.rejects(store.commit({operations:[{...op([{segmentId:'body',oldText:'找不到',newText:'坏'}]),expectedVersion:2}]},{expectedRevision:store.state.revision,sourceKeys:['m1','m2']}),/disk full/);assert.deepEqual(store.state,before);
 fail=false;await store.reconcile(['replacement']);assert.equal(entryText(store.state.data.entries.npc),original);
});
test('a real AgentClient accepts a missing-anchor report once without a format retry',async()=>{
 const raw={uid:1,comment:'林舟',content:original},save=createSave('c','b');save.initialized=true;
 const e=createEntry({...makeSourceEntry('b',raw),kind:'npc',segments:[{id:'body',text:original,writable:true}]});save.data.entries[e.id]=e;save.base=structuredClone(save.data);
 let disk=save,calls=0;const model=new AgentClient(async request=>{calls++;const input=JSON.parse(request.input);return JSON.stringify({operations:[{...op([{segmentId:'body',oldText:'不存在',newText:'新'}]),id:e.id,evidence:[input.messages[0].key]}]})});
 const c=new Controller({snapshot:()=>({chatId:'c',bookName:'b',templateEnabled:true,messages:[{key:'m1',role:'assistant',content:'新剧情'}]}),loadWorldbook:async()=>[raw],
  storage:{read:async()=>structuredClone(disk),write:async(_,v)=>{disk=structuredClone(v)}},clearPlan(){},applyWindow:async()=>{}},{model});await c.start();await c.maintain();
 assert.equal(calls,1);assert.equal(c.store.state.audit.at(-1).reason,'patch-not-found');assert.equal(entryText(c.store.state.data.entries[e.id]),original);
 assert.deepEqual(c.store.state.processed,['m1']);assert.deepEqual(c.store.state.rememberedKeys,[],'rejected evidence must retain its original history');
});
test('protected references can locate and retain original text only within their own writable segment',async()=>{
 const save=createSave('c','b');save.data.entries.secret=createEntry({id:'secret',kind:'rule',text:'王都艾尔德兰'});
 save.data.entries.npc=createEntry({id:'npc',kind:'npc',text:'居住于王都艾尔德兰。'});
 const result=await maintain({complete:async r=>{assert.doesNotMatch(JSON.stringify(r.input),/王都艾尔德兰/);const text=r.input.memory.entries[0].segments[0].text;return {operations:[op([{segmentId:'body',oldText:text,newText:text+'随后离开。'}])]}}},save,[{key:'m1',role:'assistant',content:'离开了'}]);
 assert.equal(entryText(applyMaintenance(save.data,result,{allowedEvidence:['m1'],requireEdits:true}).next.entries.npc),'居住于王都艾尔德兰。随后离开。');
});
test('1.1.1 and dev.1 v1 storage round trips; dev.2 is refused with a machine-readable recovery reason',()=>{
 const save=createSave('compat','b');const encoded=encodeSave(save);assert.equal(encoded.encoding,'fish-memory-pool-v1');assert.deepEqual(decodeSave(encoded),save);assert.deepEqual(decodeSave(save),save);
 assert.throws(()=>decodeSave({...encoded,encoding:'fish-memory-pool-v2'}),e=>e.dwmStorageFormat==='reverted-dev2-source-layers');
});
test('raw dev.2 test snapshots fail before a storage write rather than silently showing only their changes',async()=>{
 const save=createSave('c','b');save.initialized=true;save.data.entries.npc={...entry(),sourceLayer:{version:1,settings:[],protected:false}};
 let writes=0;const store=new MemoryStore({read:async()=>structuredClone(save),write:async()=>{writes++}});
 await assert.rejects(store.load('c','b'),e=>e.dwmStorageFormat==='reverted-dev2-source-layers');assert.equal(writes,0);assert.equal(store.state,null);
});
test('automatic compaction uses edits, and repeated text across input fragments is still ambiguous in the actual entry',async()=>{
 const save=createSave('c','b');save.initialized=true;save.data.entries.event=createEntry({id:'event',kind:'event',title:'事件',text:'原句。'+('重复背景。'.repeat(7000)),evidence:['m0']});
 const result=await compact({complete:async r=>{const e=r.input.memory.entries[0];return {operations:[{type:'update',id:e.id,expectedVersion:e.version,
   edits:[{segmentId:e.segments[0].id,oldText:e.segments[0].text.includes('原句。')?'原句。':'重复背景。',newText:'短句。'}],evidence:e.evidence}]}}},save);
 const out=applyMaintenance(save.data,result,{allowedEvidence:['m0'],requireEdits:true});
 assert.ok(entryText(out.next.entries.event).startsWith('短句。'));assert.equal(entryText(out.next.entries.event).split('重复背景。').length,7001);
 assert.ok(out.rejected.some(e=>e.code==='patch-ambiguous'));
});
test('a rejected follow-up retracts history coverage even when the first pass already saved a summary',async()=>{
 const store=new MemoryStore({read:async()=>null,write:async()=>{}});await store.load('c','b');await store.initialize([entry()],'');
 await store.commit({operations:[{type:'summary',text:'已有概况'}]},{expectedRevision:store.state.revision,sourceKeys:['m1']});assert.deepEqual(store.state.rememberedKeys,['m1']);
 await store.commit({operations:[op([{segmentId:'body',oldText:'找不到',newText:'变化'}])]},{expectedRevision:store.state.revision,sourceKeys:['m1']});
 assert.deepEqual(store.state.processed,['m1']);assert.deepEqual(store.state.rememberedKeys,[]);assert.equal(store.state.data.summary,'已有概况');
});
test('a locator cannot split an emoji surrogate pair',()=>{
 const e=entry();e.segments[0].text='🐟保留';
 const out=applyMaintenance({entries:{npc:e}},{operations:[op([{segmentId:'body',oldText:'\ud83d',newText:''}])]},{allowedEvidence:['m1'],requireEdits:true});
 assert.equal(out.rejected[0].code,'patch-invalid');assert.equal(entryText(out.next.entries.npc),'🐟保留');
});
test('multiple updates to one entry cannot use guessed future versions to bypass original-text matching',()=>{
 const e=entry();e.segments[0].text='甲：同一句。乙：同一句。';
 const out=applyMaintenance({entries:{npc:e}},{operations:[op([{segmentId:'body',oldText:'甲：同一句。',newText:''}]),
  {...op([{segmentId:'body',oldText:'同一句。',newText:'偷改'}]),expectedVersion:2}]},{allowedEvidence:['m1'],requireEdits:true});
 assert.equal(entryText(out.next.entries.npc),e.segments[0].text);assert.equal(out.rejected.length,2);assert.ok(out.rejected.every(r=>r.code==='patch-duplicate-update'));
});
