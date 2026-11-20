import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core/store.js';
import { createEntry, makeSourceEntry } from '../src/core/state.js';
import { entryUndoState } from '../src/core/entry-changes.js';
import { encodeSave, decodeSave } from '../src/core/storage-codec.js';
import { maintainRequest } from '../src/agents/requests.js';
async function fixture(){
    let disk,fail=false;const storage={read:async()=>structuredClone(disk),write:async(_,v)=>{if(fail)throw Error('write failed');disk=structuredClone(v)}};
    const store=new MemoryStore(storage);await store.load('c','b');
    await store.initialize([makeSourceEntry('b',{uid:1,content:'原书'}),createEntry({id:'a',title:'林舟',kind:'npc',text:'剧情人物'}),
        createEntry({id:'import',title:'旧总结',origin:'import',segments:[{id:'body',text:'只读旧总结',writable:false}]})],'');
    return {store,disk:()=>disk,fail:()=>{fail=true},storage};
}
const action=(store,patch)=>({confirmed:true,expectedSaveId:store.state.id,expectedRevision:store.state.revision,...patch});
test('single and bulk deletion exclude source entries and can undo only the latest operation after reload',async()=>{
    const {store}=await fixture();const before=store.snapshot();
    await assert.rejects(store.changeEntries(action(store,{type:'delete-entries',ids:['source:b:1','a']})),e=>e.dwmEntryChangeIssue==='source');assert.deepEqual(store.state,before);
    await store.changeEntries(action(store,{type:'delete-entries',ids:['a']}));const first=entryUndoState(store.state);
    await store.changeEntries(action(store,{type:'delete-entries',ids:['import']}));const last=entryUndoState(store.state);
    await store.load('c','b');assert.equal(entryUndoState(store.state).id,last.id);
    assert.deepEqual(store.state.audit.filter(row=>row.reason==='entry-delete').map(row=>[row.title,row.kind]),
        [['林舟','npc'],['旧总结','fact']]);
    await assert.rejects(store.changeEntries(action(store,{type:'entry-change-undo',undoId:first.id})),e=>e.dwmEntryChangeIssue==='undo-changed');
    await store.changeEntries(action(store,{type:'entry-change-undo',undoId:last.id}));
    assert.ok(store.state.data.entries.import);assert.equal(store.state.data.entries.a,undefined);assert.equal(entryUndoState(store.state),null);
});
test('deletion survives reroll and blocks model recreation under a new id',async()=>{
    const {store}=await fixture();await store.commit({operations:[]},{expectedRevision:store.state.revision,sourceKeys:['m1','m2']});
    await store.changeEntries(action(store,{type:'delete-entries',ids:['a','import']}),['m1','m2']);
    assert.equal(store.project(['m1','replacement']).data.entries.a,undefined);
    await store.reconcile(['m1','replacement']);assert.equal(store.state.data.entries.import,undefined);
    assert.equal(entryUndoState(store.state).canUndo,false);
    assert.deepEqual(maintainRequest(store.state,[]).input.memory.removedEntries.map(e=>e.title),['林舟','旧总结']);
    await store.commit({operations:[{type:'create',kind:'npc',title:' 林舟 ',text:'再次出现',evidence:['m1']}]},{expectedRevision:store.state.revision,sourceKeys:['m1','replacement']});
    assert.equal(Object.values(store.state.data.entries).some(e=>e.title.trim()==='林舟'),false);
    assert.ok(store.state.data.entries['source:b:1']);
});
test('stale confirmation and storage failure do not partially delete or publish an undo',async()=>{
    const f=await fixture(),before=f.store.snapshot();
    await assert.rejects(f.store.changeEntries({...action(f.store,{type:'delete-entries',ids:['a']}),expectedRevision:-1}),e=>e.dwmEntryChangeIssue==='changed');
    await assert.rejects(f.store.changeEntries({...action(f.store,{type:'delete-entries',ids:['a']}),confirmed:false}),e=>e.dwmEntryChangeIssue==='confirmation');
    f.fail();await assert.rejects(f.store.changeEntries(action(f.store,{type:'delete-entries',ids:['a','import']})),/write failed/);
    assert.deepEqual(f.store.state,before);assert.deepEqual(f.disk(),before);
});

test('old audit rows stay untouched when new named deletions are saved using the same codec',async()=>{
    const { store } = await fixture();
    const legacy = store.snapshot();
    const oldRow = { id: 'old', entryId: 'unknown', scopeId: 'global', reason: 'entry-delete',
        at: '2026-10-01T00:00:00.000Z', before: '旧资料', after: '', evidence: [] };
    legacy.audit.push(oldRow);
    const oldDisk = encodeSave(legacy);
    await store.load('c','b',decodeSave(oldDisk));
    await store.changeEntries(action(store,{type:'delete-entries',ids:['a']}));
    const newDisk = encodeSave(store.state);
    assert.equal(newDisk.encoding, oldDisk.encoding);
    assert.equal(newDisk.schema, oldDisk.schema);
    const [older, newer] = decodeSave(newDisk).audit;
    assert.deepEqual(older, oldRow);
    assert.deepEqual([newer.title,newer.kind], ['林舟','npc']);
});
