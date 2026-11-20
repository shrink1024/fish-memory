import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../src/core/store.js';
import {scopeInventory} from '../src/core/state.js';
async function setup(){let saved;const storage={read:async()=>structuredClone(saved),write:async(_,v)=>{saved=structuredClone(v)}};
 const store=new MemoryStore(storage);await store.load('c','b');await store.initialize([],'s');return {store,storage};}
const item=(name,description='合成说明')=>({name,description});
const edit=(store,items,scopeId='global',keys=store.state.storyKeys)=>store.manual({type:'inventory-edit',scopeId,items,expectedSaveId:store.state.id,expectedRevision:store.state.revision},keys);
test('manual inventory supports add, rename, delete, scopes and undo without advancing coverage',async()=>{
 const {store}=await setup();await edit(store,[item('钥匙')]);await edit(store,[item('铜钥匙','新说明'),item('信')]);
 const change=store.inventoryEditState('global').undoCommitId;
 await edit(store,[item('当地金币')],'world-a');assert.deepEqual(scopeInventory(store.state.data,'global'),[item('铜钥匙','新说明'),item('信')]);
 await store.manual({type:'inventory-edit-undo',scopeId:'global',commitId:change,expectedSaveId:store.state.id,expectedRevision:store.state.revision});
 assert.deepEqual(store.state.data.inventory,[item('钥匙')]);assert.deepEqual(scopeInventory(store.state.data,'world-a'),[item('当地金币')]);
 await edit(store,[]);assert.deepEqual(store.state.data.inventory,[]);assert.deepEqual(store.state.processed,[]);
});
test('manual inventory survives candidate rollback, reload and can then be undone',async()=>{
 const {store,storage}=await setup();await store.commit({operations:[{type:'inventory',items:[item('临时物品')]}]},{expectedRevision:store.state.revision,sourceKeys:['u','a-old']});
 await edit(store,[item('玩家确认的物品')]);await store.reconcile(['u','a-new']);
 assert.deepEqual(store.state.data.inventory,[item('玩家确认的物品')]);
 const restored=new MemoryStore(storage);await restored.load('c','b');await restored.reconcile(['u','a-newer']);
 assert.deepEqual(restored.state.data.inventory,[item('玩家确认的物品')]);
 await restored.manual({type:'inventory-edit-undo',scopeId:'global',commitId:restored.inventoryEditState().undoCommitId,expectedSaveId:restored.state.id,expectedRevision:restored.state.revision},['u','a-newer']);
 assert.deepEqual(restored.state.data.inventory,[],'undo uses the rebased branch before the player edit, not discarded narrative');
});
test('disabled, catch-up, malformed and stale inventory edits are rejected atomically',async()=>{
 const {store}=await setup();const original=store.snapshot();
 for(const items of [[item('a'.repeat(301))],Array.from({length:201},()=>item('x')),null])await assert.rejects(edit(store,items));
 assert.deepEqual(store.state,original);
 await assert.rejects(store.manual({type:'inventory-edit',items:[],expectedSaveId:store.state.id,expectedRevision:0}),/更新|变化|版本/);
 await store.manual({type:'inventory-toggle',enabled:false});await assert.rejects(edit(store,[]),e=>e.dwmInventoryEdit==='disabled');
 await store.manual({type:'inventory-toggle',enabled:true});await assert.rejects(edit(store,[]),e=>e.dwmInventoryEdit==='catch-up');
});
test('automatic maintenance starts from manual inventory; stale undo cannot erase newer model changes',async()=>{
 const {store}=await setup();await edit(store,[item('玩家物品')]);const id=store.inventoryEditState().undoCommitId;
 await store.commit({operations:[{type:'inventory',items:[...store.state.data.inventory,item('新剧情物品')]}]},{expectedRevision:store.state.revision,sourceKeys:['u','a']});
 await assert.rejects(store.manual({type:'inventory-edit-undo',commitId:id,expectedSaveId:store.state.id,expectedRevision:store.state.revision},['u','a']),e=>e.dwmInventoryEdit==='changed');
 assert.equal(store.state.data.inventory.length,2);
});

test('scope inventory edits and consecutive undo remain valid across repeated rollback',async()=>{
 const {store}=await setup();await store.commit({operations:[]},{expectedRevision:store.state.revision,sourceKeys:['u','a']});
 await edit(store,[item('甲')],'world');await edit(store,[item('乙')],'world');
 await store.reconcile(['u','b']);assert.deepEqual(scopeInventory(store.state.data,'world'),[item('乙')]);
 for(let i=0;i<2;i++)await store.manual({type:'inventory-edit-undo',scopeId:'world',commitId:store.inventoryEditState('world').undoCommitId,expectedSaveId:store.state.id,expectedRevision:store.state.revision},['u','b']);
 assert.deepEqual(scopeInventory(store.state.data,'world'),[]);
 await store.reconcile(['u','c']);assert.deepEqual(scopeInventory(store.state.data,'world'),[]);
});

test('inventory forms cannot save into another save with the same revision',async()=>{
 const {store}=await setup();await assert.rejects(store.manual({type:'inventory-edit',items:[item('外来物品')],expectedSaveId:'other-save',expectedRevision:store.state.revision}),/存档已切换/);
 assert.deepEqual(store.state.data.inventory,[]);
});

test('controller permits editing with an ordinary deferred tail and exposes the saved undo state',async()=>{
 const {Controller}=await import('../src/runtime/controller.js');let saved;
 const state={chatId:'c',bookName:'b',templateEnabled:true,messages:[],userInput:''};
 const host={snapshot:()=>structuredClone(state),loadWorldbook:async()=>[],clearPlan(){},setPlan(){},applyWindow:async()=>{},storage:{read:async()=>saved,write:async(_,v)=>{saved=structuredClone(v)}}};
 const c=new Controller(host,{model:{complete:async r=>r.purpose==='select'?{ids:[]}:{operations:[]}}});
 await c.start();await c.initialize();state.messages.push({key:'u',role:'user',content:'输入'},{key:'a',role:'assistant',content:'暂缓的回复'});
 const form=c.inventoryEditState();assert.equal(form.canEdit,true);assert.equal(c.uiStatus().retainedPendingCount,2);
 await c.manual({type:'inventory-edit',items:[item('手动清单')],expectedSaveId:form.saveId,expectedRevision:form.revision});
 assert.equal(c.view().inventoryEditing.canUndo,true);assert.equal(c.store.state.processed.length,0);
 c.store.state.inventoryDisabledAt=0;
 await assert.rejects(c.manual({type:'inventory-edit',items:[],expectedSaveId:form.saveId,expectedRevision:c.store.state.revision}),e=>e.dwmInventoryEdit==='catch-up');
});
