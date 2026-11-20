import test from 'node:test';
import assert from 'node:assert/strict';
import {createSave,createEntry} from '../src/core/state.js';
import {maintainRequest} from '../src/agents/requests.js';
import {serializeAgentInput} from '../src/agents/client.js';
import {applyMaintenance} from '../src/core/operations.js';

for(const locked of [false,true])test(`300-entry known-name supplement stays within 4000 characters (locked=${locked})`,()=>{
 const save=createSave('budget-test','b');
 for(let i=0;i<300;i++)save.data.entries[`source:long-worldbook-title:${i}`]=createEntry({id:`source:long-worldbook-title:${i}`,title:`第${i}号人物设定`,kind:'fact',segments:[{id:'body',text:'测试资料',writable:!locked}]});
 const memory=maintainRequest(save,[{key:'m1',role:'assistant',content:'第299号人物设定登场。'}],'global',null,{focus:new Set()}).input.memory;
 const extra=JSON.stringify(Object.fromEntries(Object.entries(memory).filter(([key])=>/known/i.test(key))));
 assert.ok(extra.length<=4000,`known-name supplement: ${extra.length}`);
 if(!locked)assert.ok(!extra.includes('第299号人物设定'),'catalog names should not be repeated');
});

test('long protected names stay bounded after wire escaping; omitted names are still rejected by the program',()=>{
 const save=createSave('budget-test','b');
 for(let i=0;i<300;i++)save.data.entries['n'+i]=createEntry({id:'n'+i,title:`人物${i}-`+'{{char}}'.repeat(20),kind:'fact',segments:[{id:'body',text:'受保护正文',writable:false}]});
 const title=save.data.entries.n299.title;
 const memory=maintainRequest(save,[{key:'m1',role:'assistant',content:title+'登场。'}]).input.memory;
 const supplement=Object.fromEntries(Object.entries(memory).filter(([key])=>key.startsWith('known')));
 assert.ok(serializeAgentInput(supplement).length<=4000);assert.equal(memory.knownNames[0],title);assert.equal(memory.knownNamesTruncated,true);
 const omitted=Object.values(save.data.entries).find(e=>!memory.knownNames.includes(e.title));
 const out=applyMaintenance(save.data,{operations:[{type:'create',kind:'npc',title:omitted.title,text:'重复',evidence:['m1']}]},{allowedEvidence:['m1']});
 assert.equal(out.rejected[0].code,'duplicate-character');assert.equal(Object.keys(out.next.entries).length,300);
});

test('names already present in full entries and follow-up-only requests add no supplement',()=>{
 const save=createSave('budget-test','b');save.data.entries.a=createEntry({id:'a',title:'Ｌｉｎａ',text:'可写正文',identityNames:['Lina']});
 assert.equal(maintainRequest(save,[]).input.memory.knownNames,undefined);
 save.data.entries.b=createEntry({id:'b',title:'保护人物',segments:[{id:'body',text:'保护正文',writable:false}]});
 const follow=maintainRequest(save,[],'global',null,{followUp:true,focus:new Set(['a'])}).input.memory;
 assert.equal(follow.knownNames,undefined);assert.equal(follow.knownCharacters,undefined);
});
