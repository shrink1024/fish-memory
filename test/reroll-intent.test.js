import assert from 'node:assert/strict';
import test from 'node:test';
import { trackRerollIntent } from '../src/adapters/reroll-intent.js';

function fixture() {
    const listeners = new Map(), chat = [{swipe_id:0, swipes:['现有回复']}];
    let id = 'chat', generating = false;
    const tracker = trackRerollIntent({
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: (type, fn) => { assert.equal(listeners.get(type),fn); listeners.delete(type); },
    }, () => chat, () => id, () => generating);
    const target = selector => ({closest: query => query === selector});
    const emit = (type, event) => listeners.get(type)?.(event);
    return {tracker, chat, target, emit, listeners, changeChat: () => {id = 'new';}, busy: () => {generating = true;}};
}
test('only a player activation on the same tail identifies a native reroll, once',()=>{
    const f=fixture(), click={target:f.target('#option_regenerate'),isTrusted:true};
    f.emit('click',{...click,isTrusted:false});assert.equal(f.tracker.consume('regenerate'),false);
    f.emit('click',click);assert.equal(f.tracker.consume('regenerate',{automatic_trigger:true}),false);
    f.emit('click',click);assert.equal(f.tracker.consume('regenerate'),true);assert.equal(f.tracker.consume('regenerate'),false);
    f.emit('click',click);f.chat.push({});assert.equal(f.tracker.consume('regenerate'),false);
    f.emit('click',click);f.changeChat();assert.equal(f.tracker.consume('regenerate'),false);
    f.busy();f.emit('click',click);assert.equal(f.tracker.consume('regenerate'),false);
    f.tracker.dispose();assert.equal(f.listeners.size,0);
});
test('existing candidate navigation and an automatic swipe do not create a player question',()=>{
    const f=fixture(), target=f.target('.last_mes .swipe_right');
    f.chat[0].swipes.push('另一已有回复');
    f.emit('click',{target,isTrusted:true});assert.equal(f.tracker.consume('swipe'),false);
    f.chat[0].swipe_id=1;f.emit('click',{target,isTrusted:true});assert.equal(f.tracker.consume('swipe'),true);
    assert.equal(f.tracker.consume('swipe'),false);
});
test('a touch swipe needs the matching native touchend for a new candidate',()=>{
    const f=fixture(), target=f.target('#sheld');
    f.emit('swiped-left',{target});assert.equal(f.tracker.consume('swipe'),false);
    f.emit('touchend',{target,isTrusted:true});f.emit('swiped-left',{target});assert.equal(f.tracker.consume('swipe'),true);
});
