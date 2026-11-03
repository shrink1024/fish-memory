import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/runtime/controller.js';
import {encodeSave,decodeSave,expandedChars} from '../src/core/storage-codec.js';
import {assertRebuildCapacity} from '../src/core/capacity.js';
function fixture(size){
 let disk,calls=0;const book=[{uid:1,comment:'合成长条目',content:'长'.repeat(size),disable:true}];
 const state={chatId:'c',bookName:'b',templateEnabled:true,generating:false,messages:[]};
 const host={snapshot:()=>structuredClone(state),loadWorldbook:async()=>structuredClone(book),clearPlan(){},applyWindow:async()=>{},
 storage:{read:async()=>disk?decodeSave(disk):null,write:async(_,v)=>{disk=encodeSave(v);decodeSave(disk)}}};
 const c=new Controller(host,{model:{complete:async()=>{calls++;throw Error('unexpected model call')}},settings:{enabled:true}});
 return {c,book,calls:()=>calls,disk:()=>disk};
}
test('capacity counts repeated pooled strings as expanded data',()=>{
 const shared={text:'x'.repeat(1000)};assert.equal(expandedChars([shared,shared]),JSON.stringify([shared,shared]).length);
});
test('oversized admission fails before calls or writes and keeps existing save intact',async()=>{
 const f=fixture(9000000);await f.c.start();const revision=f.c.store.state.revision;
 await assert.rejects(f.c.initialize(),e=>e.kind==='capacity'&&/需为重新扫描预留空间/.test(e.message));
 assert.equal(f.calls(),0);assert.equal(f.c.store.state.revision,revision);assert.equal(f.c.store.state.initialized,false);assert.equal(f.disk(),undefined);
});
test('admitted large sources retain edit and rebuild headroom with the real codec',async()=>{
 const f=fixture(4000000);await f.c.start();await f.c.initialize();const id='source:b:1';
 for(let i=0;i<2;i++)await f.c.store.manual({type:'edit',id,segments:f.c.store.state.data.entries[id].segments.map((s,n)=>n===0?{...s,text:`改${i}`+s.text.slice(2)}:s)},[]);
 assertRebuildCapacity(f.c.store.state);await f.c.initialize();assert.equal(f.c.store.state.data.entries[id].source.original.length,4000000);
 assert.equal(decodeSave(f.disk()).data.entries[id].source.original.length,4000000);
});

test('source sync checks its enlarged material before a model call and preserves old memory',async()=>{
 const f=fixture(10);await f.c.start();await f.c.initialize();const before=f.c.store.snapshot();
 f.book[0].disable=false;f.book[0].content='长'.repeat(9000000);
 await assert.rejects(f.c.syncSourceChanges(),e=>e.kind==='capacity');assert.equal(f.calls(),0);assert.deepEqual(f.c.store.state,before);
});

test('legacy saves beyond rebuild reserve still accept tier changes and reductions below the actual codec limit',async()=>{
 const {MemoryStore}=await import('../src/core/store.js');const {createSave,makeSourceEntry}=await import('../src/core/state.js');
 const legacy=createSave('legacy','b'),entry=makeSourceEntry('b',{uid:1,comment:'已有长资料',content:'旧'.repeat(9000000)});
 entry.source.baselineSegments=structuredClone(entry.segments);legacy.data.entries[entry.id]=entry;legacy.base=structuredClone(legacy.data);legacy.initialized=true;
 assert.throws(()=>assertRebuildCapacity(legacy),e=>e.kind==='capacity');
 let disk=encodeSave(legacy),writes=0;const store=new MemoryStore({read:async()=>decodeSave(disk),write:async(_,v)=>{disk=encodeSave(v);writes++}});await store.load('legacy','b');
 await store.manual({type:'tier',id:entry.id,tier:'off'},[]);assert.equal(writes,1);
 await store.manual({type:'edit',id:entry.id,segments:[{id:'body',text:'缩短后',writable:false}]},[]);assert.equal(writes,2);
 assert.equal(decodeSave(disk).data.entries[entry.id].segments[0].text,'缩短后');
 const before=store.snapshot();await assert.rejects(store.manual({type:'tier',id:entry.id,tier:'constant'},[]),e=>e.kind==='capacity');assert.deepEqual(store.state,before,'actual codec cap still rejects atomically');
});
