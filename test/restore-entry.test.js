import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../src/core/store.js';
import {makeSourceEntry} from '../src/core/state.js';

test('manual tiers retain replay history without audit; restore is atomic and clears only that entry',async()=>{
 let disk;const storage={read:async()=>structuredClone(disk),write:async(_,v)=>{disk=structuredClone(v)}};
 const store=new MemoryStore(storage);await store.load('c','b');
 const a=makeSourceEntry('b',{uid:1,comment:'甲',content:'初始正文'}),b=makeSourceEntry('b',{uid:2,comment:'乙',content:'乙正文'});
 await store.initialize([a,b],'');
 await store.manual({type:'edit',id:a.id,segments:[{id:'body',text:'修改正文',writable:true}]},['m']);
 await store.manual({type:'edit',id:b.id,title:'乙修改'},['m']);
 const n=store.state.audit.length;
 await store.manual({type:'tier',id:a.id,tier:'constant'},['m']);assert.equal(store.state.audit.length,n);
 await store.manual({type:'restore-entry',id:a.id,confirmed:true,withTier:true},['m']);
 assert.equal(store.state.data.entries[a.id].segments[0].text,'初始正文');assert.equal(store.state.data.entries[a.id].tier,undefined);
 assert.ok(!store.state.audit.some(r=>r.entryId===a.id));assert.ok(store.state.audit.some(r=>r.entryId===b.id));
 const reloaded=new MemoryStore(storage);await reloaded.load('c','b');await reloaded.reconcile(['other']);
 assert.equal(reloaded.state.data.entries[a.id].segments[0].text,'初始正文');assert.ok(!reloaded.state.audit.some(r=>r.entryId===a.id));
});
test('clearing audit for a generated entry leaves the data and replay journal intact',async()=>{
 let disk;const store=new MemoryStore({read:async()=>disk,write:async(_,v)=>{disk=structuredClone(v)}});await store.load('c','b');await store.initialize([], '');
 await store.manual({type:'import-memory',entries:[{title:'旧总结',content:'合成资料'}]},[]);
 const id=Object.keys(store.state.data.entries)[0],before=structuredClone(store.state);
 await store.manual({type:'audit-clear',id,confirmed:true},[]);
 assert.deepEqual(store.state.data,before.data);assert.deepEqual(store.state.journal,before.journal);assert.equal(store.state.audit.length,0);
});

test('restore clears title, kind, protection and review changes while optional tier stays player-controlled',async()=>{
 const store=new MemoryStore({read:async()=>null,write:async()=>{}});await store.load('c','b');
 const e=makeSourceEntry('b',{uid:1,comment:'初始标题',content:'保护原文'});await store.initialize([e],'');
 await store.manual({type:'edit',id:e.id,title:'临时标题',intro:'临时简介',retrieveWhen:'临时条件',segments:[{id:'body',text:'临时正文',writable:true}]},['m']);
 await store.manual({type:'classify',id:e.id,kind:'npc'},['m']);
 await store.manual({type:'tier',id:e.id,tier:'constant'},['m']);
 await store.manual({type:'restore-entry',id:e.id,confirmed:true},['m']);
 const out=store.state.data.entries[e.id];assert.equal(out.title,e.title);assert.equal(out.kind,e.kind);assert.deepEqual(out.segments,e.segments);assert.equal(out.intro,e.intro);assert.equal(out.retrieveWhen,e.retrieveWhen);assert.equal(out.needsReview,e.needsReview);assert.equal(out.tier,'constant');assert.equal(store.state.audit.length,0);
 await store.manual({type:'restore-entry',id:e.id,confirmed:true,withTier:true},['m']);assert.equal(store.state.data.entries[e.id].tier,undefined);
});

test('restore intent survives source-sync rollback and storage failures keep data and audit together',async()=>{
 let disk,fail=false;const storage={read:async()=>structuredClone(disk),write:async(_,v)=>{if(fail)throw Error('write failed');disk=structuredClone(v)}};
 const store=new MemoryStore(storage);await store.load('c','b');const old=makeSourceEntry('b',{uid:1,comment:'旧标题',content:'旧资料'});await store.initialize([old],'');
 const next=makeSourceEntry('b',{uid:1,comment:'新标题',content:'新资料'});
 await store.commit({operations:[]},{expectedRevision:store.state.revision,sourceKeys:['m']});
 await store.manual({type:'edit',id:old.id,title:'玩家标题',segments:[{id:'body',text:'剧情变化',writable:true}]},['m']);
 await store.syncSource({base:{[next.id]:next},data:{[next.id]:{...next,segments:[{id:'body',text:'合并剧情',writable:true}]}},removed:[]},{expectedRevision:store.state.revision});
 const before=store.snapshot();fail=true;
 await assert.rejects(store.manual({type:'restore-entry',id:next.id,confirmed:true},['m']),/write failed/);assert.deepEqual(store.state,before);
 fail=false;await store.manual({type:'restore-entry',id:next.id,confirmed:true},['m']);
 const reload=new MemoryStore(storage);await reload.load('c','b');await reload.reconcile(['other']);
 assert.equal(reload.state.data.entries[next.id].title,'新标题');assert.equal(reload.state.data.entries[next.id].segments[0].text,'新资料');assert.equal(reload.state.audit.length,0);
});

test('restore availability compares title and kind without audit and caches only unchanged revisions',async()=>{
 const {playerView}=await import('../src/core/views.js');const {createSave}=await import('../src/core/state.js');
 const save=createSave('c','b'),e=makeSourceEntry('b',{uid:1,comment:'甲',content:'原文'});save.data.entries[e.id]=structuredClone(e);save.base.entries[e.id]=structuredClone(e);
 assert.equal(playerView(save).restoreChanges[e.id],false);
 save.data.entries[e.id].title='乙';save.revision++;assert.equal(playerView(save).restoreChanges[e.id],true);
 save.data.entries[e.id].title='甲';save.data.entries[e.id].kind='npc';save.revision++;assert.equal(playerView(save).restoreChanges[e.id],true);
 let serialized=0;const stringify=JSON.stringify;JSON.stringify=(value,...args)=>{if(value===save.data.entries[e.id].segments)serialized++;return stringify(value,...args)};
 try{save.revision++;const first=playerView(save);assert.equal(serialized,0,'title/type difference short circuits');save.data.entries[e.id].kind=e.kind;save.revision++;playerView(save);assert.equal(serialized,1);first.restoreChanges[e.id]=false;playerView(save);assert.equal(serialized,1);}finally{JSON.stringify=stringify;}
});
