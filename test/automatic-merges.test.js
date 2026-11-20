import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../src/core/store.js';
import {Controller} from '../src/runtime/controller.js';
import {createEntry,entryText,makeSourceEntry} from '../src/core/state.js';
import {entryUndoState} from '../src/core/entry-changes.js';
import {frontCatalog,maintenanceView} from '../src/core/views.js';
import {compactRequest} from '../src/agents/requests.js';
import {compactPlans,COMPACT_INPUT_CHARS} from '../src/agents/compact-plan.js';
const item=(id,kind='npc',extra={})=>createEntry({id,kind,title:id==='a'?'林舟':'阿舟',text:id==='a'?'林舟又叫阿舟。':'阿舟就是林舟，住山城。',evidence:['m1'],...extra});
async function fixture(entries=[item('a'),item('b')]){
 let disk,fail=false;const storage={read:async()=>structuredClone(disk),write:async(_,v)=>{if(fail)throw Error('disk full');disk=structuredClone(v)}};
 const store=new MemoryStore(storage);await store.load('c','book');await store.initialize(entries,'');
 await store.commit({operations:[{type:'summary',text:'已有概况'}]},{expectedRevision:store.state.revision,sourceKeys:['m1']});
 return {store,storage,fail:()=>{fail=true}};
}
const merge=(store,extra={})=>({type:'mergeEntries',sources:['a','b'].map(id=>({id,expectedVersion:store.state.data.entries[id].version})),
 targetId:'a',title:'林舟',intro:'人物',text:'林舟又叫阿舟，住山城。',evidence:['m1'],sameIdentity:true,identityReason:'两条明确说明林舟和阿舟是同一人。',...extra});
const commit=(store,operation)=>store.commit({operations:[operation]},{reason:'compact',automatic:true,expectedRevision:store.state.revision,sourceKeys:['m1']});
const undo=store=>{const u=entryUndoState(store.state);return store.changeEntries({type:'entry-change-undo',undoId:u.id,confirmed:true,expectedSaveId:u.saveId,expectedRevision:u.revision},store.state.storyKeys)};
for(const kind of ['npc','event'])test(`automatic ${kind} merge preserves identity/provenance, is audited and can be undone after reload`,async()=>{
 const f=await fixture([item('a',kind),item('b',kind)]),before=f.store.snapshot();await commit(f.store,merge(f.store));
 assert.equal(Object.keys(f.store.state.data.entries).length,1);assert.deepEqual(f.store.state.data.entries.a.identityNames,['林舟','阿舟']);
 assert.ok(f.store.state.audit.some(r=>r.reason==='automatic-merge'));assert.equal(entryUndoState(f.store.state).automatic,true);
 const removed=f.store.state.audit.find(row=>row.reason==='automatic-merge'&&row.entryId==='b');
 assert.equal(removed.title,'阿舟');assert.equal(removed.kind,kind);
 assert.ok(frontCatalog(f.store.state).find(e=>e.id==='a').aliases.includes('阿舟'));
 await f.store.load('c','book');await undo(f.store);assert.deepEqual(f.store.state.data.entries,before.data.entries);
});
test('adopted merge names stop an alias from being recreated in the following maintenance',async()=>{
 const f=await fixture();await commit(f.store,merge(f.store));
 await f.store.commit({operations:[{type:'create',kind:'npc',title:'阿舟',text:'不能重复建立',evidence:['m2']}]},{expectedRevision:f.store.state.revision,sourceKeys:['m1','m2']});
 assert.equal(Object.keys(f.store.state.data.entries).length,1);assert.equal(f.store.state.audit.at(-1).reason,'duplicate-character');
});
test('overlapping automatic merges cannot consume the same source twice',async()=>{
 const f=await fixture([item('a'),item('b'),item('c')]),before=f.store.snapshot(),first=merge(f.store);
 await f.store.commit({operations:[first,{...first,sources:[{id:'b',expectedVersion:1},{id:'c',expectedVersion:1}],targetId:'b'}]},
  {reason:'compact',automatic:true,expectedRevision:f.store.state.revision,sourceKeys:['m1']});
 assert.deepEqual(f.store.state.data,before.data);assert.equal(f.store.state.audit.at(-1).reason,'merge-overlap');
});
test('without a clear same-identity decision different people remain independent',async()=>{
 const f=await fixture([item('a','npc',{text:'林舟是船工。'}),item('b','npc',{title:'许宁',text:'许宁是医生，和林舟是不同的人。'})]),before=f.store.snapshot();
 await commit(f.store,merge(f.store,{sameIdentity:false,identityReason:'这是不同的人'}));assert.deepEqual(f.store.state.data.entries,before.data.entries);
 assert.equal(f.store.state.audit.at(-1).reason,'merge-identity-unconfirmed');assert.equal(entryUndoState(f.store.state),null);
});
test('duplicates append into a source while preserving every existing segment and the source baseline',async()=>{
 const raw={uid:1,comment:'林舟',content:'对白样例。现住旧港。'};
 const source=createEntry({...makeSourceEntry('book',raw),id:'source:book:1',kind:'fact',segments:[{id:'locked',text:'对白样例。',writable:false},{id:'body',text:'现住旧港。',writable:true}]});
 const f=await fixture([source,item('a')]),before=f.store.snapshot();
 await commit(f.store,{type:'mergeIntoSource',sources:[{id:'a',expectedVersion:1}],targetId:source.id,expectedTargetVersion:1,text:'现已搬到山城。',evidence:['m1'],sameIdentity:true,identityReason:'新条目与来源同为林舟。'});
 const target=f.store.state.data.entries[source.id];assert.deepEqual(target.segments.slice(0,2),before.data.entries[source.id].segments);
 assert.deepEqual(target.source,before.data.entries[source.id].source);assert.equal(entryText(target),raw.content+'\n现已搬到山城。');assert.equal(f.store.state.data.entries.a,undefined);
 const absorbed=f.store.state.audit.find(row=>row.reason==='automatic-merge'&&row.entryId==='a');
 assert.equal(absorbed.title,'林舟');assert.equal(absorbed.kind,'npc');
 const audit=f.store.state.audit.find(r=>r.reason==='automatic-merge'&&r.entryId===source.id);assert.equal(audit.merge.appended,'现已搬到山城。');assert.equal(audit.merge.appendChars,'现已搬到山城。'.length);
 await undo(f.store);assert.deepEqual(f.store.state.data.entries,before.data.entries);
});
test('undo survives reroll of a later unprocessed reply and never resurrects discarded facts',async()=>{
 const f=await fixture(),before=f.store.snapshot();await commit(f.store,merge(f.store));
 const u=entryUndoState(f.store.state);await f.store.changeEntries({type:'entry-change-undo',undoId:u.id,confirmed:true,expectedSaveId:u.saveId,expectedRevision:u.revision},['m1','pending']);
 await f.store.reconcile(['m1','replacement']);assert.deepEqual(f.store.state.data.entries,before.data.entries);
 await f.store.reconcile(['m1','replacement-2']);assert.deepEqual(f.store.state.data.entries,before.data.entries);
});
test('failed writes do not remove inputs or replace the previous undo slot',async()=>{
 const f=await fixture(),before=f.store.snapshot();f.fail();await assert.rejects(commit(f.store,merge(f.store)),/disk full/);assert.deepEqual(f.store.state,before);
});
test('closed or protected sources and modified merge results cannot be silently overwritten',async()=>{
 const source=createEntry({...makeSourceEntry('book',{uid:1,comment:'林舟',content:'保护正文'}),kind:'npc'}),f=await fixture([source,item('a')]);
 const result={type:'mergeIntoSource',sources:[{id:'a',expectedVersion:1}],targetId:source.id,expectedTargetVersion:1,text:'新增',evidence:['m1'],sameIdentity:true,identityReason:'同一人物'};
 await commit(f.store,result);assert.ok(f.store.state.data.entries.a);assert.equal(f.store.state.audit.at(-1).reason,'merge-target-protected');
 const g=await fixture();await commit(g.store,merge(g.store));await g.store.manual({type:'edit',id:'a',intro:'后来又有修改'},['m1']);assert.equal(entryUndoState(g.store.state).canUndo,false);
});
test('the source candidate list stays bounded and excludes protected bodies',()=>{
 const entries=Array.from({length:300},(_,i)=>createEntry({...makeSourceEntry('book',{uid:i,comment:i===0?'林舟':`其他${i}`,content:'原书全文不能泄露'}),intro:'简短简介',segments:[{id:'body',text:'原书全文不能泄露',writable:true}]}));
 const f={data:{entries:Object.fromEntries([...entries,item('a')].map(e=>[e.id,e])),summary:'',strategy:'',inventoryEnabled:false},journal:[]};
 const plans=compactPlans(compactRequest(f));assert.ok(plans.every(p=>JSON.stringify(p.request.input).length<=COMPACT_INPUT_CHARS));
 assert.equal(plans[0].request.input.memory.sourceTargets.length,1);assert.doesNotMatch(JSON.stringify(plans[0].request.input),/原书全文不能泄露/);
});
test('Controller sends only source candidates and commits an append-only source merge',async()=>{
 const raw={uid:1,comment:'林舟',content:'原书对白保留。'},source=createEntry({...makeSourceEntry('book',raw),segments:[{id:'body',text:raw.content,writable:true}]}),f=await fixture([source,item('a')]);let calls=0;
 const host={storage:f.storage,snapshot:()=>({chatId:'c',bookName:'book',templateEnabled:true,messages:[{key:'m1',role:'assistant',content:'已有剧情'}]}),loadWorldbook:async()=>[raw],clearPlan(){},applyWindow:async()=>{}};
 const c=new Controller(host,{model:{complete:async r=>{calls++;if(!r.input.memory.entries.length)return {operations:[]};const e=r.input.memory.entries[0],t=r.input.memory.sourceTargets[0];return {operations:[{type:'mergeIntoSource',sources:[{id:e.id,expectedVersion:e.version}],targetId:t.id,expectedTargetVersion:t.version,text:'新增经历。',evidence:e.evidence,sameIdentity:true,identityReason:'原名同为林舟'}]}}}});
 await c.start();const result=await c.compact({automatic:true});assert.equal(result.merged,1);assert.equal(result.condensed,0);
 assert.equal(entryText(c.store.state.data.entries[source.id]),raw.content+'\n新增经历。');assert.equal(c.store.state.data.entries.a,undefined);assert.ok(calls>0);
 const u=c.view().entryUndo;await c.manual({type:'entry-change-undo',undoId:u.id,expectedSaveId:u.saveId,expectedRevision:u.revision,confirmed:true});const count=calls;
 await c.readinessChanged();assert.equal(calls,count,'undo must not immediately rerun the same compaction');
 assert.ok(maintenanceView(c.store.state).knownCharacters.some(e=>e.title==='林舟'));
});
for(const undoFirst of [false,true])test(`source merge ${undoFirst?'with undo ':''}rolls back with its story without reviving discarded people`,async()=>{
 const source=createEntry({...makeSourceEntry('book',{uid:1,comment:'林舟',content:'原设定。'}),segments:[{id:'body',text:'原设定。',writable:true}]}),f=await fixture([source]);
 for(const [key,title] of [['m2','阿舟'],['m3','舟哥']])await f.store.commit({operations:[{type:'create',kind:'npc',title,text:`${title}就是林舟。`,evidence:[key]}]},
  {expectedRevision:f.store.state.revision,sourceKeys:key==='m2'?['m1','m2']:['m1','m2','m3']});
 const sources=Object.values(f.store.state.data.entries).filter(e=>!e.source);
 await f.store.commit({operations:[{type:'mergeIntoSource',sources:sources.map(e=>({id:e.id,expectedVersion:e.version})),targetId:source.id,expectedTargetVersion:1,
  text:'合并后的新事。',evidence:['m2','m3'],sameIdentity:true,identityReason:'称呼相同对象。'}]},
  {reason:'compact',automatic:true,expectedRevision:f.store.state.revision,sourceKeys:['m1','m2','m3']});
 if(undoFirst)await undo(f.store);
 await f.store.reconcile(['m1','m2','new']);assert.equal(entryText(f.store.state.data.entries[source.id]),'原设定。');
 assert.ok(Object.values(f.store.state.data.entries).some(e=>e.title==='阿舟'));assert.ok(!Object.values(f.store.state.data.entries).some(e=>e.title==='舟哥'));
});
test('a source locked while the model is running cannot be written or consume its generated duplicate',async()=>{
 const raw={uid:1,comment:'林舟',content:'原文。'},source=createEntry({...makeSourceEntry('book',raw),segments:[{id:'body',text:raw.content,writable:true}]}),f=await fixture([source,item('a')]);const book=[raw];
 const c=new Controller({storage:f.storage,snapshot:()=>({chatId:'c',bookName:'book',templateEnabled:true,messages:[{key:'m1',role:'assistant',content:'已有剧情'}]}),loadWorldbook:async()=>structuredClone(book),clearPlan(){},applyWindow:async()=>{}},
  {model:{complete:async r=>{
   if(!r.input.memory.entries.length)return {operations:[]};
   book.push({uid:2,comment:'[DWM Rules]',content:JSON.stringify({format:'dwm-rules',version:1,naturalLanguage:'',script:'when title == "林舟" => lock;'})});
   const e=r.input.memory.entries[0],t=r.input.memory.sourceTargets[0];return {operations:[{type:'mergeIntoSource',sources:[{id:e.id,expectedVersion:e.version}],targetId:t.id,expectedTargetVersion:t.version,text:'不能写入',evidence:e.evidence,sameIdentity:true,identityReason:'同人'}]};
  }}});await c.start();const before=c.store.snapshot();await assert.rejects(c.compact(),/锁定|禁用/);assert.deepEqual(c.store.state.data,before.data);
});
