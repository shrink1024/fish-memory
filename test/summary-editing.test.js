import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/runtime/controller.js';
import {scopeSummary, createEntry} from '../src/core/state.js';
import {encodeSave, decodeSave} from '../src/core/storage-codec.js';

async function fixture(settings={}) {
    let disk, plan, fail=false;
    const chat={chatId:'summary-test',bookName:'book',templateEnabled:true,messages:[],userInput:''};
    const storage={read:async()=>disk && decodeSave(disk),write:async(_,s)=>{if(fail)throw Error('disk full');disk=encodeSave(s)}};
    const calls=[];
    let respond = r=>r.purpose==='select'?{ids:[]}:{operations:[]};
    const controller=new Controller({storage,snapshot:()=>structuredClone(chat),loadWorldbook:async()=>[],
        clearPlan(){plan=null},setPlan:value=>{plan=value},applyWindow:async()=>{}},{
        settings:{maintenanceEvery:1000,...settings},model:{complete:async r=>{calls.push(r);return respond(r)}}
    });
    await controller.start();
    await controller.store.initialize([createEntry({id:'one',title:'条目',kind:'fact',text:'可写资料'})],'');
    const keys=()=>chat.messages.map(m=>m.key);
    function floor(){const key='m'+(chat.messages.length+1);chat.messages.push({key,role:'assistant',content:'本轮新剧情'+key});return key}
    const store=controller.store;
    const commit=(ops,scopeId='global',sourceKeys=keys())=>store.commit({operations:ops},{sourceKeys,scopeId,expectedRevision:store.state.revision});
    async function edit(text,scopeId='global',draft=controller.summaryEditState(scopeId)) {
        return controller.manual({type:'summary-edit',scopeId,text,expectedSaveId:draft.saveId,expectedRevision:draft.revision});
    }
    function undo(){const u=controller.view().entryUndo;return controller.manual({type:'entry-change-undo',undoId:u.id,confirmed:true,expectedSaveId:u.saveId,expectedRevision:u.revision})}
    return {controller,store,chat,keys,floor,commit,edit,undo,calls,setResponse:f=>{respond=f},plan:()=>plan,fail:v=>{fail=v}};
}

for (const mode of ['append','rewrite']) test('manual summary is the next sent and maintained basis in '+mode,async()=>{
    const f=await fixture({summaryMode:mode});f.floor();
    await f.commit([{type:'summary',text:'已经归还钥匙。旧约定失效。'}]);
    await f.edit('玩家确认的新约定。');
    await f.controller.generationBefore({type:'normal'});assert.equal(f.plan().summary,'玩家确认的新约定。');
    f.floor();let observed;
    f.setResponse(r=>{observed=r;return {operations:[{type:mode==='append'?'appendSummary':'summary',text:mode==='append'?'到了新港。':'玩家确认的新约定，随后到了新港。'}]}});
    await f.controller.maintain();assert.equal(observed.input.memory.summary,'玩家确认的新约定。');
    assert.match(f.store.state.data.summary,/新约定.*新港/s);
    assert.doesNotMatch(JSON.stringify(observed.input),/旧约定失效/);
    const before=f.store.state.data.summary;f.floor();f.setResponse(()=>({operations:[{type:'summary',text:'又出现了旧约定失效。'}]}));
    await f.controller.maintain();assert.equal(f.store.state.data.summary,before);
    assert.equal(f.store.state.audit.at(-1).reason,'summary-edited-content');
    assert.ok(!f.store.state.rememberedKeys.includes(f.keys().at(-1)));
});

test('a stale summary draft cannot overwrite a finished maintenance, and a stale maintenance cannot overwrite a saved draft',async()=>{
    const f=await fixture();f.floor();await f.commit([{type:'summary',text:'初稿。'}]);const draft=f.controller.summaryEditState();
    f.floor();await f.commit([{type:'appendSummary',text:'刚刚更新。'}]);
    await assert.rejects(f.edit('过期修改','global',draft),/changed/);assert.match(f.store.state.data.summary,/刚刚更新/);
    f.floor();let release,enter;const gate=new Promise(r=>{release=r}),began=new Promise(r=>{enter=r});
    f.setResponse(async()=>{enter();await gate;return {operations:[{type:'summary',text:'迟到的结果'}]}});
    const running=f.controller.maintain();await began;await f.edit('保存中的玩家新稿');release();
    await assert.rejects(running,/存档已更新/);assert.equal(f.store.state.data.summary,'保存中的玩家新稿');
});

test('scope-specific edits, shared undo and atomic storage survive reload',async()=>{
    const f=await fixture();f.floor();await f.commit([{type:'summary',text:'全局'}]);await f.edit('异世界','world-B');
    assert.equal(f.store.state.data.summary,'全局');assert.equal(scopeSummary(f.store.state.data,'world-B'),'异世界');
    f.fail(true);await assert.rejects(f.edit('失败的写入','world-B'),/disk full/);f.fail(false);
    await f.store.load(f.chat.chatId,'book');assert.equal(f.controller.view().entryUndo.scopeId,'world-B');
    await f.undo();assert.equal(scopeSummary(f.store.state.data,'world-B'),'');assert.equal(f.store.state.audit.at(-1).reason,'summary-edit-undo');
    await f.edit('新正文');const s=f.store.state;await f.controller.manual({type:'delete-entries',confirmed:true,ids:['one'],expectedSaveId:s.id,expectedRevision:s.revision});
    assert.equal(f.controller.view().entryUndo.kind,'delete');await f.edit('再编辑');assert.equal(f.controller.view().entryUndo.kind,'summary');
    await f.undo();assert.equal(f.store.state.data.summary,'新正文');assert.equal(f.controller.view().entryUndo,null);
});

test('rollback keeps an earlier player edit and reports crossing a later edit even with lagging maintenance anchors',async()=>{
    const f=await fixture();f.floor();await f.commit([{type:'summary',text:'最早。'}]);
    await f.edit('保留的手动改动。');f.floor();f.floor();await f.edit('第三楼手动写入。');
    await f.commit([{type:'appendSummary',text:'补第二楼。'}],'global',f.keys().slice(0,2));
    f.floor();await f.commit([{type:'appendSummary',text:'第四楼。'}]);f.chat.messages.pop();
    await f.store.reconcile(f.keys());
    assert.match(f.store.state.data.summary,/第三楼手动写入/);assert.equal(f.store.lastRollback.revertedSummaryEdits,undefined);
    f.chat.messages.pop();await f.store.reconcile(f.keys());
    assert.equal(f.store.state.data.summary,'保留的手动改动。');
    assert.deepEqual(f.store.lastRollback.revertedSummaryEdits.map(e=>e.action),['edit']);
    assert.deepEqual(f.store.state.audit.filter(r=>r.reason==='summary-edit').map(r=>r.after),['保留的手动改动。']);
    assert.ok(!f.store.state.rememberedKeys.includes('m2'));
});

test('summary editing and shared summary undo are unavailable in worldbook-only and lazy modes',async()=>{
    const f=await fixture();await f.edit('原文');const u=f.controller.view().entryUndo;
    for(const patch of [{memoryMode:'worldbook'},{memoryMode:'full',lazyMode:true}]){
        await f.controller.updateSettings(patch);assert.equal(f.controller.view().summaryEditing,null);
        assert.equal(f.controller.view().entryUndo.canUndo,false);
        await assert.rejects(f.controller.manual({type:'entry-change-undo',undoId:u.id,confirmed:true,expectedSaveId:u.saveId,expectedRevision:u.revision}),/unavailable/);
        assert.equal(f.store.state.data.summary,'原文');
    }
});

for(const [tier,threshold] of [['short',4000],['standard',8000],['long',16000]])test('compaction threshold, target and retention at '+tier,async()=>{
    const f=await fixture(tier==='standard'?{}:{summaryLength:tier});f.floor();
    await f.commit([{type:'summary',text:'甲'.repeat(threshold-1)}]);await f.controller.maintain();
    assert.ok(!f.calls.some(r=>r.purpose==='compact'));
    await f.commit([{type:'summary',text:'甲'.repeat(threshold)}]);
    let text='长'.repeat(Math.floor(threshold*.6)+1);
    f.setResponse(()=>({operations:[{type:'summary',text}]}));
    await f.controller.maintain();assert.equal(f.store.state.data.summary,'甲'.repeat(threshold));assert.ok(f.calls.at(-1).system.includes(String(Math.floor(threshold*.6))));
    text='精简后仍有效的事实。';await f.controller.maintain();assert.equal(f.store.state.data.summary,text);
});
test('changing length under economy mode uses the shorter target on next explicit compaction',async()=>{
    const f=await fixture({summaryLength:'long'});f.floor();await f.commit([{type:'summary',text:'甲'.repeat(7000)}]);await f.controller.setEconomyMode(true);
    const prior=f.controller.settings.selectionChars;await f.controller.updateSettings({summaryLength:'short'});
    assert.equal(f.controller.settings.economyMode,true);assert.equal(f.controller.settings.selectionChars,prior);
    f.setResponse(r=>({operations:r.input.memory.entries.length?[]:[{type:'summary',text:'压缩稿'}]}));
    await f.controller.compact();assert.equal(f.store.state.data.summary,'压缩稿');
    await assert.rejects(f.controller.updateSettings({summaryLength:'other'}),/summary-length/);
});

test('summary compaction cannot restore an excised phrase, but a later explicit player edit can restore it',async()=>{
    const f=await fixture();f.floor();await f.commit([{type:'summary',text:'她带着红钥匙巡逻。'}]);await f.edit('她巡逻。');
    f.setResponse(r=>({operations:r.input.memory.summary?[{type:'summary',text:'她用红钥匙巡逻。她带着红钥匙巡逻。'}]:[]}));
    await f.controller.compact();assert.equal(f.store.state.data.summary,'她巡逻。');
    await f.edit('她带着红钥匙巡逻。');await f.controller.compact();assert.match(f.store.state.data.summary,/红钥匙/);
});

test('transport failures and malformed or empty compacted summaries preserve the complete source',async()=>{
    const f=await fixture({summaryLength:'short'});f.floor();const original='甲'.repeat(4500);await f.commit([{type:'summary',text:original}]);
    for (const answer of [null,42,'']) {
        f.setResponse(()=>{if(answer===null)throw Error('synthetic offline');return {operations:[{type:'summary',text:answer}]}});
        await assert.rejects(f.controller.compact());
        assert.equal(f.store.state.data.summary,original);
    }
});

test('numeric length validates integer bounds and restores all three legacy settings',async()=>{
    const f=await fixture();assert.equal(f.controller.settings.summaryLength,8000);
    for(const [name,value] of Object.entries({short:4000,standard:8000,long:16000})){
        const loaded=await fixture({summaryLength:name});assert.equal(loaded.controller.settings.summaryLength,value);
        await f.controller.updateSettings({summaryLength:2347});await f.controller.updateSettings({summaryLength:name});
        assert.equal(f.controller.settings.summaryLength,value);
    }
    for(const value of [2000,50000,17321]) {
        await f.controller.updateSettings({summaryLength:value});
        assert.equal(f.controller.settings.summaryLength,value);
    }
    for(const value of [1999,50001,3200.5,'3200',true,null,undefined,NaN,Infinity]) {
        await assert.rejects(f.controller.updateSettings({summaryLength:value}),/summary-length:invalid/);
        assert.equal(f.controller.settings.summaryLength,17321);
    }
    assert.equal((await fixture({summaryLength:-1})).controller.settings.summaryLength,8000);
});

test('50k numeric threshold permits a 30k full compacted summary, then a smaller arbitrary setting compresses without slicing',async()=>{
    const f=await fixture({summaryLength:50000});f.floor();
    await f.edit('甲'.repeat(49999));await f.controller.maintain();assert.ok(!f.calls.some(r=>r.purpose==='compact'));
    await f.edit('甲'.repeat(50000));
    const respond=length=>r=>({operations:r.input.memory.summary?[{type:'summary',text:'新'.repeat(Math.round(length*r.input.memory.summary.length/50000))}]:[]});
    f.setResponse(respond(30000));await f.controller.maintain();assert.equal(f.store.state.data.summary.length,30000);
    await f.controller.updateSettings({summaryLength:2347});
    f.setResponse(r=>({operations:r.input.memory.summary?[{type:'summary',text:'完整精简稿。'}]:[]}));
    await f.controller.maintain();assert.match(f.store.state.data.summary,/^([完]整精简稿。)+$/);
});
