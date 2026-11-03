import test from 'node:test';
import assert from 'node:assert/strict';
import {compatibleConnection,AgentClient} from '../src/agents/client.js';
import {readStreamResponse} from '../src/agents/stream-response.js';
const event=v=>`data: ${JSON.stringify(v)}\r\n\r\n`;
const response=(finish='stop',done=true)=>{
 const source=event({choices:[{index:0,delta:{content:'{"text":"中文"}'}}]})+event({choices:[{index:0,delta:{},finish_reason:finish}]})+(done?'data: [DONE]\r\n\r\n':'');
 const bytes=new TextEncoder().encode(source);
 return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close()}}),{headers:{'content-type':'text/event-stream'}});
};
test('global stream option reaches the wire and chunked unicode JSON is accepted only on completion',async()=>{
 let wire;const transport=compatibleConnection({endpoint:'https://example.invalid/v1',model:'synthetic',fetchImpl:async(u,o)=>{wire=JSON.parse(o.body);return response()}});
 const client=new AgentClient(transport,{getTimeouts:()=>({auxiliaryStream:true,timeoutMs:1000})});
 assert.deepEqual(await client.complete({purpose:'select',system:'s',input:{}}),{text:'中文'});assert.equal(wire.stream,true);
});
test('missing end marker and length termination cannot be accepted',async()=>{
 await assert.rejects(readStreamResponse(response('stop',false)),/未完整结束/);
 const transport=compatibleConnection({endpoint:'https://example.invalid/v1',model:'synthetic',fetchImpl:async()=>response('length')});
 await assert.rejects(transport({stream:true,system:'',input:''}),/截断/);
});
test('aborting a stalled stream cancels the reader and rejects',async()=>{
 const abort=new AbortController();let cancelled=false;
 const r=new Response(new ReadableStream({cancel(){cancelled=true}}));
 const pending=readStreamResponse(r,{signal:abort.signal});abort.abort(new DOMException('stop','AbortError'));
 await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,true);
});


test('native host streams accept explicit Gemini and Anthropic endings without exposing reasoning',async()=>{
 const responseOf=events=>new Response(events.map(event).join(''),{headers:{'content-type':'text/event-stream'}});
 const gemini=await readStreamResponse(responseOf([{candidates:[{content:{parts:[{thought:true,text:'private'},{text:'{"ids":[]}' } ]}}]},{candidates:[{finishReason:'STOP'}]}]));
 assert.equal(gemini.choices[0].message.content,'{"ids":[]}');
 const claude=await readStreamResponse(responseOf([{type:'content_block_delta',delta:{type:'text_delta',text:'{"ids":[]}'}},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}]));
 assert.equal(claude.choices[0].message.content,'{"ids":[]}');
 await assert.rejects(readStreamResponse(responseOf([{type:'content_block_delta',delta:{type:'text_delta',text:'{"ids":[]}'}}])),/未完整结束/);
});

test('non-success Gemini endings reject even when accumulated text is valid JSON',async()=>{
 for(const finishReason of ['RECITATION','OTHER']){
  const r=new Response(event({candidates:[{content:{parts:[{text:'{"ids":[]}'}]},finishReason}]}));
  await assert.rejects(readStreamResponse(r),/未完整结束/);
 }
});
