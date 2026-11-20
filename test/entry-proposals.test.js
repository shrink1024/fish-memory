import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { MemoryStore } from '../src/core/store.js';
import { createEntry, createSave, entryTier, entryText } from '../src/core/state.js';
import { entryChangePlan, completeEntryProposal, applyEntryChange, enforceRemovals, activeRemovals } from '../src/core/entry-changes.js';
import { applyMaintenance } from '../src/core/operations.js';
const locked='不可发送给整理模型的完整保护设定';
async function fixture(){
    let disk,writes=0,run;
    const storage={read:async()=>structuredClone(disk),write:async(_,v)=>{disk=structuredClone(v);writes++}};
    const store=new MemoryStore(storage);await store.load('c','b');
    await store.initialize([createEntry({id:'a',kind:'npc',title:'人物甲',segments:[{id:'locked',text:locked,writable:false},{id:'body',text:'重复的剧情甲',writable:true}],evidence:['m1'],tier:'onDemand'}),
        createEntry({id:'b',kind:'npc',title:'人物乙',text:'剧情乙',evidence:['m2'],tier:'constant'}),
        createEntry({id:'protected',kind:'npc',title:'全保护',segments:[{id:'all',text:'受保护',writable:false}]})],'');
    await store.commit({operations:[]},{expectedRevision:store.state.revision,sourceKeys:['m1','m2']});
    const live={chatId:'c',bookName:'b',templateEnabled:true,messages:[{key:'m1',role:'user',content:'开始'},{key:'m2',role:'assistant',content:'随后'}]};
    const calls=[],c=new Controller({storage,snapshot:()=>structuredClone(live),loadWorldbook:async()=>[],clearPlan(){},applyWindow:async()=>{}},
        {model:{complete:async request=>{calls.push(request);if(run)return run(request);return {entries:request.input.targets.map(t=>({id:t.id,title:'整理结果',intro:'说明',segments:t.segments.map(id=>({id,text:'精简后的剧情'}))}))}}}});
    await c.start();return {c,calls,live,disk:()=>structuredClone(disk),writes:()=>writes,setRun:fn=>{run=fn}};
}
const confirm=(proposal,result=proposal.result)=>({type:'entry-change-apply',proposalId:proposal.id,result,confirmed:true});
test('merge proposes without writes, keeps protected text off the wire, preserves tier/evidence, and undoes once',async()=>{
    const f=await fixture(),before=f.disk(),writes=f.writes();
    const proposal=await f.c.proposeEntryChange({mode:'merge',ids:['a','b']});
    assert.equal(f.writes(),writes);assert.deepEqual(f.disk(),before);assert.equal(f.calls.length,1);
    assert.doesNotMatch(JSON.stringify(f.calls[0].input),new RegExp(locked));
    proposal.result[0].title='玩家调整的标题';
    await f.c.manual(confirm(proposal));
    const merged=Object.values(f.c.store.state.data.entries).find(e=>e.title==='玩家调整的标题');
    assert.ok(merged);assert.equal(entryTier(merged),'constant');assert.deepEqual(merged.evidence,['m1','m2']);
    assert.ok(merged.segments.some(s=>!s.writable&&s.text===locked));assert.equal(f.c.store.state.data.entries.a,undefined);
    assert.deepEqual(Object.fromEntries(f.disk().audit.filter(row=>row.reason==='entry-merge').map(row=>[row.entryId,[row.title,row.kind]])),
        {a:['人物甲','npc'],b:['人物乙','npc'],[merged.id]:['玩家调整的标题','npc']});
    const undo=f.c.view().entryUndo;
    await f.c.manual({type:'entry-change-undo',undoId:undo.id,expectedSaveId:undo.saveId,expectedRevision:undo.revision,confirmed:true});
    assert.deepEqual(f.c.store.state.data.entries,before.data.entries);assert.equal(f.c.view().entryUndo,null);
});
test('condense accepts edited writable text but rejects protected edits, full protection, and stale data',async()=>{
    const f=await fixture();await assert.rejects(f.c.proposeEntryChange({mode:'condense',ids:['protected']}),e=>e.dwmEntryChangeIssue==='protected');
    const proposal=await f.c.proposeEntryChange({mode:'condense',ids:['a']});
    const tampered=structuredClone(proposal.result);tampered[0].segments[0].text='改掉保护';
    await assert.rejects(f.c.manual(confirm(proposal,tampered)),e=>e.dwmEntryChangeIssue==='protected');
    proposal.result[0].segments.find(s=>s.writable).text='玩家修订后的正文';await f.c.manual(confirm(proposal));
    assert.equal(entryText(f.c.store.state.data.entries.a),locked+'玩家修订后的正文');
    const stale=await f.c.proposeEntryChange({mode:'condense',ids:['b']});
    await f.c.store.manual({type:'edit',id:'b',title:'之后已修改'},['m1','m2']);const before=f.disk();
    await assert.rejects(f.c.manual(confirm(stale)),e=>e.dwmEntryChangeIssue==='changed');assert.deepEqual(f.disk(),before);
});
test('a pending story replacement invalidates a proposal even before the host emits its change event',async()=>{
    const f=await fixture(),proposal=await f.c.proposeEntryChange({mode:'condense',ids:['b']}),before=f.disk();
    f.live.messages[1].key='replacement';await assert.rejects(f.c.manual(confirm(proposal)),e=>e.dwmEntryChangeIssue==='changed');assert.deepEqual(f.disk(),before);
});
test('cancellation discards late model proposals without a save',async()=>{
    const f=await fixture();let entered,resolve;const began=new Promise(r=>{entered=r});
    f.setRun(request=>{entered();return new Promise(r=>{resolve=()=>r({entries:request.input.targets.map(t=>({id:t.id,segments:t.segments.map(id=>({id,text:'迟到'}))}))})})});
    const before=f.disk(),promise=f.c.proposeEntryChange({mode:'condense',ids:['b']});const checked=assert.rejects(promise);
    await began;f.c.cancel();resolve();await checked;assert.deepEqual(f.disk(),before);
});
test('merged entries survive replay only when their sources still match; removed source identities stay suppressed',async()=>{
    const f=await fixture(),proposal=await f.c.proposeEntryChange({mode:'merge',ids:['a','b']});await f.c.manual(confirm(proposal));
    const target=proposal.result[0].id;
    await f.c.store.reconcile(['m1','other']);
    assert.ok(f.c.store.state.data.entries[target]);assert.equal(f.c.store.state.data.entries.a,undefined);
    await f.c.store.commit({operations:[{type:'create',kind:'npc',title:'人物甲',text:'不要恢复',evidence:['m1']}]},
        {expectedRevision:f.c.store.state.revision,sourceKeys:['m1','other']});
    assert.equal(Object.values(f.c.store.state.data.entries).filter(e=>e.title==='人物甲').length,0);
});
test('deleting a merged result keeps its former source identities removed and undo restores the merged result only',async()=>{
    const f=await fixture(),proposal=await f.c.proposeEntryChange({mode:'merge',ids:['a','b']});await f.c.manual(confirm(proposal));
    const target=proposal.result[0].id,version=f.c.view().entryEditing;
    await f.c.manual({type:'delete-entries',ids:[target],confirmed:true,expectedSaveId:version.saveId,expectedRevision:version.revision});
    await f.c.store.commit({operations:[{type:'create',kind:'npc',title:'人物乙',text:'不要恢复',evidence:['m1']}]},{expectedRevision:f.c.store.state.revision,sourceKeys:['m1','m2']});
    assert.equal(Object.values(f.c.store.state.data.entries).filter(e=>e.title==='人物乙').length,0);
    const undo=f.c.view().entryUndo;await f.c.manual({type:'entry-change-undo',undoId:undo.id,confirmed:true,expectedSaveId:undo.saveId,expectedRevision:undo.revision});
    assert.ok(f.c.store.state.data.entries[target]);assert.equal(f.c.store.state.data.entries.a,undefined);
});
test('automatic compaction descendants keep the manual merge identity exclusions without deleting the descendant',()=>{
    const save=createSave('c','b');save.initialized=true;
    for(const id of ['a','b','c'])save.data.entries[id]=createEntry({id,title:id,kind:'event',text:id,evidence:['m1']});
    const {templates}=entryChangePlan([save.data.entries.a,save.data.entries.b],'merge');
    const entries=completeEntryProposal(templates,[{id:templates[0].id,title:'合并事件',segments:[{id:'body',text:'合并正文'}]}]);
    const {next}=applyEntryChange(save,{type:'entry-change-apply',mode:'merge',ids:['a','b'],entries,confirmed:true,expectedSaveId:save.id,expectedRevision:save.revision},[]);
    next.data=applyMaintenance(next.data,{operations:[{type:'mergeEntries',sources:[{id:entries[0].id,expectedVersion:entries[0].version},{id:'c',expectedVersion:1}],
        title:'再次整理',intro:'说明',text:'完整合并',evidence:['m1']}]},{allowedEvidence:['m1'],idFactory:()=> 'descendant'}).next;
    enforceRemovals(next);assert.ok(next.data.entries.descendant);assert.equal(activeRemovals(next).length,2);
    const suppressed=applyMaintenance(next.data,{operations:[{type:'create',kind:'event',title:'a',text:'重复',evidence:['m1']}]},
        {allowedEvidence:['m1'],idFactory:()=> 'recreated',removals:activeRemovals(next)}).next;
    assert.equal(suppressed.entries.recreated,undefined);
});
