import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/runtime/controller.js';
import { DEFAULT_SETTINGS, MAINTENANCE_EVERY_MAX } from '../src/core/state.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled() { for (let i = 0; i < 12; i++) await tick(); }
function fixture({ settings = {}, handler } = {}) {
    const state = { chatId: 'cadence', bookName: 'main', templateEnabled: true, messages: [], userInput: '' };
    const calls = [], saves = new Map(), windows = [], settingsWrites = [];
    const host = {
        snapshot: () => structuredClone(state), loadWorldbook: async () => [],
        storage: { read: async id => structuredClone(saves.get(id) ?? null), write: async (id, save) => saves.set(id, structuredClone(save)) },
        clearPlan() {}, setPlan() {}, eligible: () => true, applyWindow: async actions => windows.push(...actions),
    };
    const options = { settings, persistSettings: async value => { settingsWrites.push(structuredClone(value)); options.settings = structuredClone(value); },
        model: { complete: async request => { calls.push(request); return await handler?.(request) ?? (request.purpose === 'select' ? { ids: [] } : { operations: [] }); } } };
    let controller = new Controller(host, options);
    const start = async () => { await controller.start(); await controller.initialize(); };
    const reply = async (number, content = '合成回复') => {
        state.messages.push({ key: `u${number}`, role: 'user', content: '合成输入' }, { key: `a${number}`, role: 'assistant', content });
        controller.messageReceived(); await settled();
    };
    return { get controller() { return controller; }, state, calls, windows, settingsWrites, start, reply,
        reload: async () => { controller = new Controller(host, options); await controller.start(); } };
}


test('reply interval is respected even when one reply exceeds the batch size',async()=>{
 const f=fixture({settings:{maintenanceEvery:3,maintenanceKeepRecent:0}});await f.start();
 await f.reply(1,'长'.repeat(20000));await f.reply(2,'长'.repeat(20000));
 assert.equal(f.calls.filter(r=>r.purpose==='maintain').length,0);
 await f.reply(3,'长'.repeat(20000));
 const requests=f.calls.filter(r=>r.purpose==='maintain');
 assert.equal(requests.length,3);
 assert.ok(requests.every(r=>r.input.messages.some(m=>m.role==='player')&&r.input.messages.some(m=>m.role==='character')));
 assert.equal(f.controller.store.state.processed.length,6);
});
for(const lazyMode of [false,true]) test(`economy keeps latest reply out of automatic memory, lazy=${lazyMode}`,async()=>{
 const f=fixture({settings:{economyMode:true,lazyMode,maintenanceEvery:5,maintenanceKeepRecent:1}});await f.start();
 for(let i=1;i<=5;i++)await f.reply(i);
 assert.equal(f.calls.filter(r=>r.purpose==='maintain').length,0);
 await f.reply(6);for(let i=0;i<50;i++)await tick();
 assert.deepEqual(f.controller.store.state.processed, f.state.messages.slice(0,10).map(m=>m.key));
 assert.ok(!f.calls.filter(r=>r.purpose==='maintain').some(r=>r.input.messages.some(m=>m.key==='a6'||m.key==='u6')));
 assert.equal(f.controller.view().maintenance.retainedReplies,1);
 assert.equal(f.controller.view().maintenance.every,5);
 const count=f.calls.length;f.state.messages.at(-1).key='a6-alt';f.controller.messageSwiped();
 for(let i=0;i<50;i++)await tick();
 assert.equal(f.calls.length,count,'rerolling the deferred reply does not cause maintenance');
});
test('manual maintenance flushes deferred latest replies and mode settings persist',async()=>{
 const f=fixture();await f.start();await f.controller.updateSettings({economyMode:true,maintenanceEvery:5,maintenanceKeepRecent:2});
 await f.reply(1);assert.equal(f.calls.length,0);await f.reload();
 assert.equal(f.controller.settings.maintenanceKeepRecent,2);
 await f.controller.maintain();assert.deepEqual(f.controller.store.state.processed,['u1','a1']);
 await f.controller.updateSettings({economyMode:false});assert.equal(f.controller.settings.maintenanceEvery,3);
 await assert.rejects(f.controller.updateSettings({maintenanceKeepRecent:-1}));
 await assert.rejects(f.controller.updateSettings({maintenanceEvery:0}));
});

test('economy window hides remembered older story but keeps the deferred latest turn',async()=>{
 const f=fixture({settings:{economyMode:true,recentTurns:1},handler:r=>r.purpose==='maintain'?{operations:[{type:'appendSummary',text:'前五轮已经归档。'}]}:undefined});
 await f.start();for(let i=1;i<=6;i++)await f.reply(i);
 assert.ok(f.windows.some(w=>w.hidden&&w.key==='a1'));
 assert.equal(f.windows.some(w=>w.hidden&&['u6','a6'].includes(w.key)),false);
 assert.equal(f.controller.store.state.rememberedKeys.includes('a6'),false);
 await f.reload();assert.equal(f.controller.view().maintenance.retainedReplies,1);
 assert.deepEqual(f.controller.store.state.processed,f.state.messages.slice(0,10).map(m=>m.key));
});

test('ordinary mode also defaults to retaining the latest reply',async()=>{
 const f=fixture();await f.start();for(let i=1;i<=3;i++)await f.reply(i);
 assert.equal(f.calls.filter(r=>r.purpose==='maintain').length,0);
 await f.reply(4);assert.deepEqual(f.controller.store.state.processed,f.state.messages.slice(0,6).map(m=>m.key));
 assert.equal(f.controller.view().maintenance.retainedReplies,1);
 const status=f.controller.uiStatus();assert.equal(status.pendingCount,2);assert.equal(status.eligiblePendingCount,0);assert.equal(status.retainedPendingCount,2);
 const committed=await f.controller.whenCommitted();assert.equal(committed.retainedPendingCount,2);
});
