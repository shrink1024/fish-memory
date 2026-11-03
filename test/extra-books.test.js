import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/runtime/controller.js';
const classify=input=>({strategy:'s',entries:input.entries.map(e=>({id:e.id,kind:'fact',intro:'i',retrieveWhen:'w',segments:[{id:'body',writable:true}]}))});
async function fixture(){
 const books={main:[{uid:1,comment:'主书条目',content:'主书原文'}],extra:[{uid:1,comment:'外部人物',content:'外部原文'},{uid:2,comment:'关闭条目',content:'关闭原文',disable:true},{uid:3,comment:'脚本',content:'<% let x=1; %>'}]};
 const state={chatId:'c',bookName:'main',templateEnabled:true,generating:false,messages:[{key:'m',role:'assistant',content:'合成开场',hidden:false}]};let disk,plan;
 const host={snapshot:()=>structuredClone(state),generationSnapshot:()=>structuredClone(state),listWorldbooks:()=>Object.keys(books).map(name=>({name,primary:name==='main'})),
 loadWorldbook:async(name='main')=>{if(!books[name])throw Error('missing');return structuredClone(books[name]);},
 storage:{read:async()=>structuredClone(disk??null),write:async(_,v)=>{disk=structuredClone(v)}},clearPlan(){},setPlan:p=>{plan=p},applyWindow:async()=>{}};
 const model={complete:async r=>r.purpose==='initialize'?classify(r.input):r.purpose==='select'?{ids:r.input.catalog.filter(e=>e.title==='外部人物').map(e=>e.id)}:{operations:[]}};
 const c=new Controller(host,{model,settings:{enabled:true,maintenanceEvery:1000}});await c.start();await c.initialize();return {c,books,state,plan:()=>plan,host};
}
test('external selection keeps identities, disabled tier, native book and reroll persistence',async()=>{
 const f=await fixture(),preview=await f.c.extraBookPreview('extra');
 assert.equal(preview.entries.find(e=>e.uid===3).flag,'script');
 await f.c.addFromBook('extra',['1','2'],preview.snapshot);
 const a=f.c.store.state.data.entries['source:extra:1'],b=f.c.store.state.data.entries['source:extra:2'];
 assert.equal(a.source.external,true);assert.equal(b.enabled,false);assert.equal(b.status,'confirmed');assert.equal(f.books.extra[1].disable,true);
 assert.ok(f.c.store.state.data.entries['source:main:1']);
 assert.equal((await f.c.extraBookPreview('extra')).entries[0].flag,'added');
 await f.c.store.reconcile(['other']);assert.ok(f.c.store.state.data.entries[a.id]);
 f.state.messages=[{key:'other',role:'assistant',content:'另一候选',hidden:false}];
 await f.c.generationBefore({type:'normal'});assert.match(f.plan().details,/外部原文/);
});
test('external source sync does not import unselected additions or mistake an unavailable book for deletion',async()=>{
 const f=await fixture();await f.c.addFromBook('extra',[1]);
 await f.c.initialize();assert.ok(f.c.store.state.data.entries['source:extra:1'],'reinitialization keeps selected external sources');
 f.books.extra[0].content='更新后原文';f.books.extra.push({uid:4,comment:'未选择的新增',content:'新内容'});
 await f.c.syncSourceChanges();assert.equal(f.c.store.state.data.entries['source:extra:1'].source.original,'更新后原文');assert.equal(f.c.store.state.data.entries['source:extra:4'],undefined);
 delete f.books.extra;const skipped=await f.c.syncSourceChanges();assert.match(skipped.message,/来源世界书不可用.*跳过/);
 assert.equal(f.c.sourceChanges.changed,false);
 assert.ok(f.c.store.state.data.entries['source:extra:1']);
});


test('stopping a later external scan preserves the committed first batch across reload',async()=>{
 const f=await fixture();f.books.extra=Array.from({length:25},(_,uid)=>({uid,comment:`条目${uid}`,content:'独立资料'}));
 const complete=f.c.client.completeValidated;let count=0;
 f.c.client.completeValidated=async(...args)=>{if(args[0].purpose==='initialize' && ++count===2){f.c.cancel();throw Error('合成停止')}return complete(...args)};
 await assert.rejects(f.c.addFromBook('extra',f.books.extra.map(e=>e.uid)),/合成停止|取消/);
 assert.equal(Object.values(f.c.store.state.data.entries).filter(e=>e.source?.book==='extra').length,24);
 await f.c.store.load('c','main');assert.equal(Object.values(f.c.store.state.data.entries).filter(e=>e.source?.book==='extra').length,24);
});

test('a freshly added external entry has nothing to restore',async()=>{
 const f=await fixture();await f.c.addFromBook('extra',['1']);
 assert.equal(f.c.view().save.restoreChanges['source:extra:1'],false);
});

test('missing external book never blocks use, maintenance, compaction, restore or rebuilding, and later sync recovers',async()=>{
 const f=await fixture();await f.c.addFromBook('extra',[1]);const id='source:extra:1',original=structuredClone(f.books.extra);
 await f.c.manual({type:'edit',id,title:'临时标题'});delete f.books.extra;
 await f.c.syncSourceChanges();assert.equal(f.c.sourceChanges.changed,false);
 await f.c.manual({type:'restore-entry',id,confirmed:true});assert.equal(f.c.store.state.data.entries[id].title,'外部人物');
 await f.c.generationBefore({type:'normal'});assert.match(f.plan().details,/外部原文/);
 f.state.messages.push({key:'new',role:'assistant',content:'新增合成剧情',hidden:false});
 const maintenance=await f.c.maintain();assert.notEqual(maintenance?.executed,false);
 await f.c.store.commit({operations:[{type:'summary',text:'已有合成脉络'}]},{expectedRevision:f.c.store.state.revision,sourceKeys:f.state.messages.map(m=>m.key)});
 assert.equal((await f.c.compact()).executed,true);
 await f.c.initialize();assert.ok(f.c.store.state.data.entries[id]);assert.equal(f.c.store.state.data.entries[id].source.external,true);
 f.books.extra=original;f.books.extra[0].content='来源恢复后的新资料';
 await f.c.syncSourceChanges();assert.equal(f.c.store.state.data.entries[id].source.original,'来源恢复后的新资料');
});
test('removed external row retains its edited copy and restore baseline through sync and reinitialization',async()=>{
 const f=await fixture();await f.c.addFromBook('extra',[1]);const id='source:extra:1';
 await f.c.manual({type:'edit',id,segments:[{id:'body',text:'已经积累的剧情',writable:true}]});f.books.extra.shift();
 await f.c.syncSourceChanges();assert.equal(f.c.sourceChanges.changed,false);
 await f.c.initialize();assert.equal(f.c.store.state.data.entries[id].segments[0].text,'已经积累的剧情');
 await f.c.manual({type:'restore-entry',id,confirmed:true});assert.equal(f.c.store.state.data.entries[id].segments[0].text,'外部原文');
});
test('panel-only refreshes do not project regex history',async()=>{
 const f=await fixture();let calls=0;const snapshot=f.host.snapshot;
 f.host.statusSnapshot=snapshot;f.host.snapshot=()=>{calls++;return snapshot()};
 for(let i=0;i<20;i++)f.c.view();assert.equal(calls,0);
});
