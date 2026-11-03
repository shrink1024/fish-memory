import test from 'node:test';
import assert from 'node:assert/strict';
import {generateAuxiliary} from '../src/adapters/auxiliary-transport.js';
import {lazyFailure} from '../src/runtime/lazy-mode.js';
const sse='data: '+JSON.stringify({choices:[{index:0,delta:{content:'{"ids":[]}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
const generate=response=>generateAuxiliary({params:{purpose:'select',system:'s',input:{},stream:true},context:{mainApi:'openai',chatCompletionSettings:{}},script:{extractMessageFromData:p=>p.choices[0].message.content},openai:{getChatCompletionModel:()=> 'synthetic',createGenerationParameters:async()=>({generate_data:{}})},fetchImpl:async()=>response});
for(const mime of [null,'text/plain','application/octet-stream'])test(`native host forwards SSE without event-stream MIME (${mime})`,async()=>{
 const response=new Response(new TextEncoder().encode(sse),{headers:mime?{'content-type':mime}:{}});
 assert.equal(await generate(response),'{"ids":[]}');
});
test('SSE API errors retain their failure category instead of becoming incomplete output',async()=>{
 const response=new Response('data: '+JSON.stringify({error:{message:'Gateway Timeout',status:504}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 await assert.rejects(generate(response),e=>lazyFailure(e)==='connection');
});
test('TT synthetic API-error content is classified only on the TT native transport',async()=>{
 const previous=globalThis.__TAURITAVERN__;
 const response=()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'[API 错误]\nCustom OpenAI endpoint failed with status 402: Payment Required'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 try{
  globalThis.__TAURITAVERN__={abiVersion:2};await assert.rejects(generate(response()),e=>lazyFailure(e)==='quota');
  delete globalThis.__TAURITAVERN__;assert.match(await generate(response()),/^\[API 错误\]/);
 }finally{if(previous===undefined)delete globalThis.__TAURITAVERN__;else globalThis.__TAURITAVERN__=previous;}
});
test('native stream still accepts an explicit JSON response and classifies non-stream errors',async()=>{
 assert.equal(await generate(Response.json({choices:[{message:{content:'{"ids":[]}'}}]})),'{"ids":[]}');
 await assert.rejects(generate(new Response(JSON.stringify({error:{message:'synthetic timeout'}}),{status:504})),e=>e.kind==='timeout');
 await assert.rejects(generate(new Response(new TextEncoder().encode(sse.replace('data: [DONE]\n\n','')))),/未完整结束/);
});
test('native forwarding of a JSON reply without MIME preserves moderation, errors and valid text',async()=>{
 const forwarded=body=>new Response(new TextEncoder().encode(JSON.stringify(body)));
 await assert.rejects(generate(forwarded({choices:[{message:{content:''},finish_reason:'content_filter'}]})),e=>e.dwmBlocked===true);
 await assert.rejects(generate(forwarded({error:{message:'Gateway Timeout'},quota_error:false})),e=>e.kind==='timeout');
 await assert.rejects(generate(forwarded({error:{message:'Payment Required'},quota_error:false})),e=>e.kind==='quota');
 assert.equal(await generate(forwarded({choices:[{message:{content:'{"ids":[]}'},finish_reason:'stop'}]})),'{"ids":[]}');
});
