import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSave, makeSourceEntry } from '../src/core/state.js';
import { sourceBookChanges, sourceMatches, nativeSwitchOverlay } from '../src/core/source-book.js';
import { Controller } from '../src/runtime/controller.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/tavernhelper-4.11.2-worldbook-roundtrip.json',import.meta.url)));
function save() {
    const value=createSave('g6','book');value.initialized=true;
    value.base.entries=Object.fromEntries(fixture.before.map(raw=>{const e=makeSourceEntry('book',raw);return [e.id,e]}));
    value.data=structuredClone(value.base);return value;
}
test('actual TavernHelper 4.11.2 roundtrip output is not an authored source update',()=>{
    assert.equal(sourceBookChanges(save(),fixture.normalized).changed,false);
    assert.equal(sourceBookChanges(save(),fixture.switches).changed,false);
    const overlay=nativeSwitchOverlay(save(),fixture.switches);
    assert.equal(overlay.data.entries['source:book:1'].enabled,false);
    assert.equal(overlay.data.entries['source:book:1'].constant,true);
});
test('real text, keywords, activation and unknown metadata changes remain visible',()=>{
    for(const raw of [fixture.body,fixture.keywords])assert.deepEqual(sourceBookChanges(save(),raw).updated,['林舟']);
    for(const patch of [{order:200},{position:4},{scanDepth:1},{probability:50,useProbability:true},{sticky:3},
        {characterFilter:{names:['另一个角色'],tags:[],isExclude:false}},{extra:{authorRule:'new'}}]){
        assert.equal(sourceMatches(makeSourceEntry('book',fixture.normalized[0]).source,{...fixture.normalized[0],...patch}),false,JSON.stringify(patch));
    }
    const baseline={...fixture.normalized[0],keysecondary:['港口'],selective:true};
    assert.equal(sourceMatches(makeSourceEntry('book',baseline).source,{...baseline,selective:false}),false);
    assert.equal(sourceMatches(makeSourceEntry('book',baseline).source,{...baseline,content:baseline.content+' '}),false,'do not trim authored text');
    assert.equal(sourceMatches(makeSourceEntry('book',{...baseline,key:['/port/ui']}).source,{...baseline,key:['/port/iu']}),true,'helper normalizes regex flag ordering');
    assert.equal(sourceMatches(makeSourceEntry('book',{...baseline,key:['/port/u']}).source,{...baseline,key:['/port/iu']}),false,'actual regex flag changes still count');
});
test('an existing false-positive archive recovers without rescanning or rewriting its source baseline',async()=>{
    let disk=save(),calls=[];const before=structuredClone(disk);
    const c=new Controller({snapshot:()=>({chatId:'g6',bookName:'book',messages:[],templateEnabled:true}),loadWorldbook:async()=>structuredClone(fixture.normalized),
        storage:{read:async()=>structuredClone(disk),write:async(_,v)=>{disk=structuredClone(v)}},clearPlan(){},setPlan(){},applyWindow:async()=>{}},
        {settings:{lazyMode:false},model:{complete:async r=>{calls.push(r.purpose);return {ids:[]}}}});
    await c.start();assert.equal(c.view().sourceChanges.changed,false);
    await c.generationBefore({type:'normal'});
    assert.deepEqual(calls,['select']);assert.deepEqual(disk,before);
});
