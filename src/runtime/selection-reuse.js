import { clone } from '../core/util.js';
import { applyDataPatch } from '../core/operations.js';
import { sha256Fingerprint } from '../core/content-hash.js';

/** Native normal sends have a draft; regenerate sees the same player message
 * already stored. Normalize only that final player slot, anchored by all prior
 * selected message identities in this chat. Identical text in a later turn is
 * deliberately a different key. */
export function selectionFrame(snapshot, recent) {
    const path=snapshot.messages.map(m=>({key:m.key,role:m.role}));
    if(snapshot.userInput)path.push({key:'current-input',role:'user'});
    const tail=path.at(-1),playerKey=tail?.role==='user'?tail.key:null;
    if(playerKey!==null)tail.key=null;
    const messages=recent.map(({key,role,content})=>({key:playerKey!==null&&key===playerKey?null:key,role,content}));
    return {path,messages,playerKey};
}
export async function selectionReuseKeys(snapshot, recent, material, data, eligibleIds) {
    const frame=selectionFrame(snapshot,[...snapshot.messages,...(snapshot.userInput?[{key:'current-input',role:'user',content:snapshot.userInput}]:[])]);
    const readMessages=recent.map(({key,role,content})=>({key:frame.playerKey!==null&&key===frame.playerKey?null:key,role,content}));
    const stableKey=await sha256Fingerprint(JSON.stringify({chatId:snapshot.chatId,bookName:snapshot.bookName,path:frame.path,material}));
    const key=await sha256Fingerprint(JSON.stringify({stableKey,readMessages,data,eligibleIds}));
    return {key,stableKey,frame,readMessages};
}

/** A validated model result becomes reusable only after the host accepted its
 * plan. Staging does not let a cancelled/late request overwrite a good cache. */
export class SelectionReuse {
    #entry=null;
    #staged=new WeakMap();
    serial=0;
    forced=false;
    invalidate(keepCandidate=false){if(!keepCandidate)this.#entry=null;this.#staged=new WeakMap();}
    sameTurn(snapshot){return this.#entry?.chatId===snapshot.chatId&&JSON.stringify(this.#entry.path)===JSON.stringify(selectionFrame(snapshot,[]).path);}
    clear(){this.invalidate();this.forced=false;this.serial++;}
    force(value){this.forced=value;this.serial++;}
    get(key){return this.#entry?.key===key?[...this.#entry.ids]:null;}
    resolve(key,context,allowed) {
        const entry=this.#entry;
        if(!entry)return {reason:'no-cache'};
        if(!entry.ids.every(id=>allowed.has(id)))return {reason:'eligibility-changed'};
        if(entry.key===key)return {ids:[...entry.ids],readMessages:entry.readMessages,reason:'exact',
            ...(entry.inventoryDisabledAt===context.inventoryDisabledAt?{payload:entry.payload}:{})};
        if(JSON.stringify(entry.path)!==JSON.stringify(context.frame.path))return {reason:'turn-changed'};
        if(entry.stableKey!==context.stableKey)return {reason:'inputs-changed'};
        if(!entry.journalIds||entry.journalIds.some((id,i)=>context.journal[i]?.id!==id))return {reason:'memory-changed'};
        const suffix=context.journal.slice(entry.journalIds.length);
        if(!suffix.length&&JSON.stringify(entry.eligibleIds)!==JSON.stringify(context.eligibleIds))return {reason:'eligibility-changed'};
        for(const id of Object.keys(entry.memory.entries)) {
            if(context.memory.entries[id]&&entry.eligibleIds.includes(id)!==context.eligibleIds.includes(id))return {reason:'eligibility-changed'};
        }
        const read=new Map(entry.readMessages.map(m=>[m.key,m])),current=new Map(context.frame.messages.map(m=>[m.key,m]));
        if(context.readMessages.some(m=>JSON.stringify(read.get(m.key))!==JSON.stringify(m)))return {reason:'history-changed'};
        for(const [key,message] of read)if(JSON.stringify(message)!==JSON.stringify(current.get(key)))return {reason:'history-changed'};
        let expected=entry.memory;
        for(const commit of suffix){
            if(commit.automatic!==true||!['maintenance','compact'].includes(commit.reason))return {reason:'memory-changed'};
            if(commit.reason==='maintenance'&&(!Array.isArray(commit.readKeys)||!commit.readKeys.every(k=>read.has(k===context.frame.playerKey?null:k))))return {reason:'history-changed'};
            expected=applyDataPatch(expected,commit.patch);
        }
        if(JSON.stringify(expected)!==JSON.stringify(context.memory))return {reason:'memory-changed'};
        return {ids:[...entry.ids],readMessages:entry.readMessages,reason:'maintenance'};
    }
    stage(plan,key,ids,serial,context){
        const previous=this.#entry?.key===key?this.#entry:null;
        this.#staged.set(plan,{key,chatId:plan.chatId,ids:[...ids],serial,...(context?{stableKey:context.stableKey,memory:previous?.memory??clone(context.memory),
            inventoryDisabledAt:context.inventoryDisabledAt,payload:context.payload===previous?.payload?context.payload:clone(context.payload),
            path:clone(context.frame.path),journalIds:context.journal.map(c=>c.id),eligibleIds:[...context.eligibleIds],readMessages:clone(context.readMessages)}:{})});
    }
    commit(plan){
        const candidate=this.#staged.get(plan);if(!candidate)return;
        this.#staged.delete(plan);this.#entry=candidate;
        if(candidate.serial===this.serial)this.forced=false;
    }
}
