import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEntries } from '../src/agents/tasks.js';
import { createEntry, makeSourceEntry, entryTier, gatedTier } from '../src/core/state.js';
import { applyMaintenance } from '../src/core/operations.js';
import { MemoryStore } from '../src/core/store.js';

const model={complete:async ({input})=>({strategy:'',entries:input.entries.map(e=>({id:e.id,kind:'npc',important:true,segments:[{id:'body',writable:true}]}))})};
for(const [title,constant,text] of [['green',false,'人物'],['blue',true,'人物'],['long',false,'人物'.repeat(55000)]])test(`new ${title} classification keeps importance independent of tier`,async()=>{
    const {entries:[entry]}=await classifyEntries(model,[makeSourceEntry('b',{uid:1,constant,content:text})]);
    assert.equal(entry.important,true);assert.equal(entryTier(entry),constant?'constant':'onDemand');
});
test('generated important NPC and later promotion stay on demand',()=>{
    const data={entries:{},summary:'',inventoryEnabled:false};
    const created=applyMaintenance(data,{operations:[{type:'create',kind:'npc',title:'林舟',text:'人物',important:true,evidence:['m']}]},{allowedEvidence:['m'],idFactory:()=> 'npc'}).next;
    assert.equal(entryTier(created.entries.npc),'onDemand');
    const oldUnimportant=createEntry({id:'npc',kind:'npc',text:'人物'});
    const promoted=applyMaintenance({...data,entries:{npc:oldUnimportant}},{operations:[{type:'promote',id:'npc',evidence:['m']}]},{allowedEvidence:['m']}).next;
    assert.equal(entryTier(promoted.entries.npc),'onDemand');assert.equal(promoted.entries.npc.important,true);
});
test('legacy important entries retain their old tier without mutation',()=>{
    const old=createEntry({id:'npc',kind:'npc',important:true,text:'旧重要人物'}),before=structuredClone(old);
    assert.equal(entryTier(old),'constant');assert.deepEqual(old,before);
    for(const tier of ['off','onDemand','constant'])assert.equal(entryTier(createEntry({...old,importanceIndependent:true,tier})),tier);
    assert.equal(gatedTier(createEntry({...old,importanceIndependent:true})),'onDemand');
    assert.equal(gatedTier(createEntry({...old,importanceIndependent:true,constant:true})),'constant');
});
test('manual promotion keeps a player tier and does not make an unimportant NPC constant',async()=>{
    let disk;const store=new MemoryStore({read:async()=>disk,write:async(_,value)=>{disk=structuredClone(value)}});
    await store.load('c','b');await store.initialize([createEntry({id:'npc',kind:'npc',text:'人物'}),createEntry({id:'chosen',kind:'npc',text:'玩家已选',tier:'off',enabled:false})],'');
    await store.manual({type:'promote',id:'npc'},[]);await store.manual({type:'promote',id:'chosen'},[]);
    assert.equal(entryTier(store.state.data.entries.npc),'onDemand');assert.equal(entryTier(store.state.data.entries.chosen),'off');
    await store.load('c','b');assert.equal(entryTier(store.state.data.entries.npc),'onDemand');
});
