import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntry, createSave } from '../src/core/state.js';
import { maintain } from '../src/agents/tasks.js';
import { maintenanceView, playerView } from '../src/core/views.js';
import { applyMaintenance } from '../src/core/operations.js';
import { MemoryStore } from '../src/core/store.js';
import { titleKey } from '../src/core/entry-changes.js';
const secret='完全受保护的人物正文，不应出现在整理请求';
const npc=(id,title,scopeId='global')=>createEntry({id,title,kind:'npc',scopeId,segments:[{id:'body',text:secret,writable:false}]});
test('known identities contain only three metadata fields and cannot enter the follow-up body path',async()=>{
    const save=createSave('c','b');save.initialized=true;save.data.entries.a=npc('a','林舟');save.data.entries.b=npc('b','另世界','world-B');
    const view=maintenanceView(save);assert.deepEqual(view.knownCharacters,[{id:'a',title:'林舟',kind:'npc'}]);assert.equal(view.entries.length,0);
    let calls=0;const result=await maintain({complete:async request=>{calls++;assert.doesNotMatch(JSON.stringify(request.input),new RegExp(secret));return {operations:[],needEntries:['a']};}},save,[{key:'m1',role:'assistant',content:'林舟来了。'}]);
    assert.equal(result.needEntries,undefined);assert.equal(calls,1);
});
test('same normalized NPC identity is rejected per operation, while distinct names, kinds and scopes remain separate',()=>{
    const save=createSave('c','b');save.data.entries.a=npc('a',' ÉLISE  LIN ');
    const op=(title,kind='npc')=>({type:'create',kind,title,text:'本次出场',evidence:['m1']});
    const out=applyMaintenance(save.data,{operations:[op('e\u0301lise lin'),op('Élise Lin（另一人）'),op('élise lin','event'),{type:'appendSummary',text:'本次出场记录'}]},
        {allowedEvidence:['m1']});
    assert.equal(out.rejected.length,1);assert.equal(out.rejected[0].entryId,'a');assert.equal(out.next.entries.a.segments[0].text,secret);
    assert.equal(Object.values(out.next.entries).length,3);assert.equal(out.next.summary,'本次出场记录');
    const other=applyMaintenance(save.data,{operations:[op('élise lin')]},{allowedEvidence:['m1'],scopeId:'world-B'});
    assert.equal(other.rejected.length,0);assert.equal(Object.values(other.next.entries).filter(e=>e.kind==='npc').length,2);
});
test('duplicate rejection is recorded atomically in the player audit without exposing protected body',async()=>{
    let disk,fail=false;const store=new MemoryStore({read:async()=>disk,write:async(_,s)=>{if(fail)throw Error('disk full');disk=structuredClone(s)}});
    await store.load('c','b');await store.initialize([npc('a','林舟')],'');
    const result={operations:[{type:'create',kind:'npc',title:'林舟',text:'重复的人物正文',evidence:['m1']}]};
    const before=store.snapshot();fail=true;await assert.rejects(store.commit(result,{expectedRevision:store.state.revision,sourceKeys:['m1']}),/disk full/);assert.deepEqual(store.state,before);
    fail=false;await store.commit(result,{expectedRevision:store.state.revision,sourceKeys:['m1']});
    assert.equal(Object.keys(store.state.data.entries).length,1);assert.equal(store.state.audit.at(-1).reason,'duplicate-character');
    assert.equal(store.state.audit.at(-1).outcome,'rejected');assert.doesNotMatch(JSON.stringify(store.state.audit),/完全受保护|重复的人物正文/);
    assert.equal(store.state.journal.at(-1).rejected.length,1);
});
test('a rejected duplicate does not falsely mark an unchanged original entry as edited',async()=>{
 const store=new MemoryStore({read:async()=>null,write:async()=>{}});await store.load('c','b');
 await store.initialize([createEntry({...npc('a','林舟'),source:{book:'b',uid:1,original:secret}})],'');
 await store.commit({operations:[{type:'create',kind:'npc',title:'林舟',text:'不采用',evidence:['m1']}]},{expectedRevision:store.state.revision,sourceKeys:['m1']});
 assert.equal(playerView(store.state).restoreChanges.a,false);assert.equal(store.state.audit.at(-1).outcome,'rejected');
});
for(const kind of ['fact','event','rule'])test(`a source classified as ${kind} still reserves its name for character creation`,async()=>{
 const save=createSave('c','b');save.initialized=true;
 save.data.entries.a=createEntry({...npc('a','林舟'),kind,enabled:false,source:{book:'b',uid:1,original:secret}});
 const memory=maintenanceView(save);assert.deepEqual(memory.knownCharacters,[{id:'a',title:'林舟',kind}]);
 assert.doesNotMatch(JSON.stringify(memory),new RegExp(secret));
 const result=applyMaintenance(save.data,{operations:[{type:'create',kind:'npc',title:'林舟',text:'重复的人物',evidence:['m1']},
  {type:'create',kind:'npc',title:'林舟（另一人）',text:'不同身份',evidence:['m1']}]},{allowedEvidence:['m1']});
 assert.equal(result.rejected.length,1);assert.equal(result.rejected[0].entryId,'a');
 assert.equal(Object.values(result.next.entries).filter(e=>e.kind==='npc').length,1);
 const out=await maintain({complete:async()=>({operations:[],needEntries:['a']})},save,[{key:'m1',role:'assistant',content:'人物出场'}]);
 assert.equal(out.needEntries,undefined,'metadata must not authorize fetching protected text');
});
test('name comparison folds width without rewriting stored names or collapsing unrelated compatibility characters',()=>{
 assert.equal(titleKey('Ｌｉｎａ'),titleKey('Lina'));assert.equal(titleKey('Ａ　Ｂ'),titleKey('a b'));
 assert.equal(titleKey('ｶﾞ'),titleKey('ガ'));assert.notEqual(titleKey('①'),titleKey('1'));
 const save=createSave('c','b');save.data.entries.a=createEntry({...npc('a','Ｌｉｎａ'),kind:'fact'});
 const out=applyMaintenance(save.data,{operations:[{type:'create',kind:'npc',title:'Lina',text:'重复',evidence:['m1']}]},{allowedEvidence:['m1']});
 assert.equal(out.rejected.length,1);assert.equal(out.next.entries.a.title,'Ｌｉｎａ');assert.equal(out.next.entries.a.segments[0].text,secret);
});
