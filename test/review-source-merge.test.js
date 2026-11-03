import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeSourceUpdates, SOURCE_MERGE_INPUT_CHARS} from '../src/agents/tasks.js';
import {makeSourceEntry, entryText} from '../src/core/state.js';
const item=(oldSource,current,newSource)=>({id:'source:b:1',title:'合成条目',oldSource,current,next:{...makeSourceEntry('b',{uid:1,comment:'合成条目',content:newSource}),segments:[{id:'body',text:newSource,writable:true}]}});
const never={complete:async()=>assert.fail('No model call expected')};
test('long source independent edits merge exactly without sending the full source',async()=>{
 const old='😀正文'.repeat(30000), story='剧情'+old.slice(2), source=old+'原书追加';
 const [result]=await mergeSourceUpdates(never,[item(old,story,source)]);
 assert.equal(result.segments.map(s=>s.text).join(''),story+'原书追加');assert.ok(result.segments.every(s=>s.text.length<=100000));
 assert.equal(entryText({...item(old,story,source).next,segments:result.segments}),story+'原书追加');
});
test('a localized long-source conflict sends only bounded context and preserves both tails',async()=>{
 const old='前'.repeat(20000)+'旧'+ '后'.repeat(20000), current=old.replace('旧','剧情'), authored=old.replace('旧','原书');let calls=0;
 const client={complete:async r=>{calls++;assert.ok(JSON.stringify(r.input).length<=SOURCE_MERGE_INPUT_CHARS);const e=r.input.entries[0];return {entries:[{id:e.id,segments:e.newSource.map(s=>({...s,text:s.text.replace('原书','合并')}))}]}}};
 const [result]=await mergeSourceUpdates(client,[item(old,current,authored)]);
 assert.equal(calls,1);assert.equal(result.segments.map(s=>s.text).join(''),old.replace('旧','合并'));
});
test('unbounded conflicts and protected long sources retain old data instead of guessing',async()=>{
 const old='旧'.repeat(20000), current='剧情'.repeat(20000), authored='原书'.repeat(20000);
 assert.equal((await mergeSourceUpdates(never,[item(old,current,authored)]))[0].held,true);
 const protectedItem=item(old,current,authored);protectedItem.used={segments:[{text:'保护',writable:false}]};
 assert.equal((await mergeSourceUpdates(never,[protectedItem]))[0].held,true);
 protectedItem.next.segments[0].writable=false;
 assert.equal((await mergeSourceUpdates(never,[protectedItem]))[0].held,true);
});
test('source merge caps each request across multiple items and validates 100k segment output',async()=>{
 const entries=Array.from({length:3},(_,i)=>({...item('旧'.repeat(2500),'剧情'.repeat(1250),'原书'.repeat(1250)),id:`e${i}`}));let calls=0;
 const client={complete:async r=>{calls++;assert.ok(JSON.stringify(r.input).length<=SOURCE_MERGE_INPUT_CHARS);return {entries:r.input.entries.map(e=>({id:e.id,segments:e.newSource}))}}};
 assert.equal((await mergeSourceUpdates(client,entries)).length,3);assert.equal(calls,3);
 await assert.rejects(mergeSourceUpdates({complete:async()=>({entries:[{id:'source:b:1',segments:[{id:'body',text:'x'.repeat(100001)}]}]})},[item('a','b','c')]),/合并片段/);
});
