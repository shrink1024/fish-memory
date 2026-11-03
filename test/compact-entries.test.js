import test from 'node:test';
import assert from 'node:assert/strict';
import {createEntry,createSave} from '../src/core/state.js';
import {compactRequest} from '../src/agents/requests.js';
import {applyMaintenance} from '../src/core/operations.js';

test('compaction includes writable generated facts and NPCs but never source/import/protected entries',()=>{
 const save=createSave('c','main');save.initialized=true;
 for(const [id,extra] of Object.entries({npc:{kind:'npc'},fact:{kind:'fact'},source:{source:{book:'main',uid:1}},imported:{origin:'import'},protected:{segments:[{id:'body',text:'locked',writable:false}]}})) save.data.entries[id]=createEntry({id,title:id,text:'合成资料',kind:'fact',...extra});
 assert.deepEqual(compactRequest(save).input.memory.entries.map(e=>e.id),['npc','fact']);
});
test('merging generated NPCs preserves highest tier, provenance and rejects protected/source inputs',()=>{
 const save=createSave('c','main');for(const id of ['a','b']) save.data.entries[id]=createEntry({id,title:id,kind:'npc',text:id,evidence:['m'],tier:id==='a'?'constant':'onDemand'});
 const op={type:'mergeEntries',sources:[{id:'a',expectedVersion:1},{id:'b',expectedVersion:1}],targetId:'a',title:'同一人物',intro:'i',retrieveWhen:'w',text:'合并资料',evidence:['m']};
 const out=applyMaintenance(save.data,{operations:[op]},{allowedEvidence:['m']}).next;
 assert.equal(out.entries.a.kind,'npc');assert.equal(out.entries.a.tier,'constant');assert.equal(out.entries.b,undefined);assert.ok(out.entries.a.lineage.includes('b'));
 save.data.entries.b.source={book:'extra',uid:1};assert.throws(()=>applyMaintenance(save.data,{operations:[op]},{allowedEvidence:['m']}),/只能整合/);
});

test('automatic merged NPC importance remains gated and future promotion is effective',()=>{
 for(const important of [false,true]){
  const save=createSave('c','main');for(const id of ['a','b'])save.data.entries[id]=createEntry({id,title:id,kind:'npc',text:id,important});
  const operation={type:'mergeEntries',sources:[{id:'a',expectedVersion:1},{id:'b',expectedVersion:1}],targetId:'a',title:'人物',text:'合并',intro:'i',retrieveWhen:'w',evidence:['m']};
  const merged=applyMaintenance(save.data,{operations:[operation]},{allowedEvidence:['m']}).next;
  assert.equal(merged.entries.a.tier,undefined);assert.equal(merged.entries.a.important,important);
  assert.equal(gatedTier(merged.entries.a),'onDemand');
  const promoted=applyMaintenance(merged,{operations:[{type:'promote',id:'a',evidence:['m']}]},{allowedEvidence:['m']}).next;
  assert.equal(entryTier(promoted.entries.a),'constant');assert.equal(gatedTier(promoted.entries.a),'onDemand');
 }
});
import {entryTier,gatedTier} from '../src/core/state.js';
