import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/runtime/controller.js';
import {makeSourceEntry,entryText,splitSourceText} from '../src/core/state.js';
const long='正文😀'.repeat(25001);
const classify=input=>({strategy:'s',entries:input.entries.map(e=>({id:e.id,kind:'fact',intro:'i',retrieveWhen:'w',segments:[{id:'body',writable:true}]}))});
function fixture({disabled=false, failAt=0, failHistory=false}={}){
 let disk,calls=0,historyCalls=0;
 const requests=[],state={chatId:'c',bookName:'b',templateEnabled:true,generating:false,messages:[{key:'m',role:'assistant',content:'合成开场',hidden:false}]};
 const storage={read:async()=>structuredClone(disk??null),write:async(_,v)=>{disk=structuredClone(v)}};
 const host={snapshot:()=>structuredClone(state),loadWorldbook:async()=>[{uid:1,comment:'超长条目',content:long,disable:disabled}],storage,clearPlan(){},applyWindow:async()=>{}};
 const model={complete:async r=>{
  if(r.purpose==='initialize'){calls++;requests.push(r.input);if(calls===failAt)throw Error('合成故障');return classify(r.input)}
  if(r.purpose==='maintain' && failHistory && !historyCalls++)throw Error('合成历史失败');
  return {operations:[]};
 }};
 const c=new Controller(host,{model,settings:{enabled:true,scanConcurrency:1,batchChars:18000}});
 return {c,requests,host,model,count:()=>calls};
}
test('long source scanning preserves all text and uses bounded work units; disabled long entries need no calls',async()=>{
 const f=fixture();await f.c.start();await f.c.initialize();
 assert.ok(f.count()>1);assert.ok(f.requests.every(r=>r.entries.every(e=>e.content.length<=18000)));
 assert.equal(Object.keys(f.c.store.state.data.entries).length,1);const entry=Object.values(f.c.store.state.data.entries)[0];assert.equal(entryText(entry),long);assert.equal(entry.source.original,long);assert.equal(entry.scanPiece,undefined);
 assert.equal(splitSourceText('😀'.repeat(100001)).map(e=>e.text).join(''),'😀'.repeat(100001));
 const closed=fixture({disabled:true});await closed.c.start();await closed.c.initialize();assert.equal(closed.count(),0);assert.equal(entryText(Object.values(closed.c.store.state.data.entries)[0]),long);
});
test('long classification checkpoints resume completed chunks instead of rescanning them',async()=>{
 const f=fixture({failAt:3});await f.c.start();await assert.rejects(f.c.initialize(),/合成故障/);
 const first=f.requests[0].entries[0].id;await f.c.initialize();
 assert.equal(f.requests.filter(r=>r.entries[0].id===first).length,1);
 assert.equal(entryText(Object.values(f.c.store.state.data.entries)[0]),long);
});
test('a history checkpoint retains the joined long source without reclassifying work units',async()=>{
 const f=fixture({failHistory:true});await f.c.start();await assert.rejects(f.c.initialize(),/合成历史失败/);const before=f.count();
 await f.c.initialize();assert.equal(f.count(),before);assert.equal(f.c.store.state.initialized,true);
});

test('unmergeable long source sync keeps both prior memory and baseline pending',async()=>{
 const f=fixture();await f.c.start();await f.c.initialize();const id='source:b:1';
 await f.c.store.manual({type:'edit',id,segments:[{id:'body',text:'剧情'.repeat(40000),writable:true}]},['m']);
 const before=structuredClone(f.c.store.state);f.host.loadWorldbook=async()=>[{uid:1,comment:'超长条目',content:'新版'.repeat(50002)}];
 const result=await f.c.syncSourceChanges();assert.match(result.message,/长资料无法安全分段合并/);
 assert.deepEqual(f.c.store.state.data.entries[id],before.data.entries[id]);assert.deepEqual(f.c.store.state.base.entries[id],before.base.entries[id]);
 assert.equal(f.c.sourceChanges.changed,false);assert.deepEqual(f.c.sourceSync.held,[id]);assert.equal(f.c.sourceChanges.held[0].id,id);
});
