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
export async function selectionReuseKey(snapshot, recent, material) {
    const {path,messages}=selectionFrame(snapshot,recent);
    return sha256Fingerprint(JSON.stringify({chatId:snapshot.chatId,bookName:snapshot.bookName,path,messages,material}));
}

/** A validated model result becomes reusable only after the host accepted its
 * plan. Staging does not let a cancelled/late request overwrite a good cache. */
export class SelectionReuse {
    #entry=null;
    #staged=new WeakMap();
    serial=0;
    forced=false;
    invalidate(){this.#entry=null;this.#staged=new WeakMap();}
    clear(){this.invalidate();this.forced=false;this.serial++;}
    force(value){this.forced=value;this.serial++;}
    get(key){return this.#entry?.key===key?[...this.#entry.ids]:null;}
    resolve(key,context,allowed) {
        const entry=this.#entry;
        if(!entry||!entry.ids.every(id=>allowed.has(id)))return null;
        if(entry.key===key)return {ids:[...entry.ids],readMessages:entry.readMessages};
        if(entry.stableKey!==context.stableKey||!entry.journalIds)return null;
        if(entry.journalIds.some((id,i)=>context.journal[i]?.id!==id))return null;
        const suffix=context.journal.slice(entry.journalIds.length);
        if(!suffix.length&&JSON.stringify(entry.eligibleIds)!==JSON.stringify(context.eligibleIds))return null;
        for(const id of Object.keys(entry.memory.entries)) {
            if(context.memory.entries[id]&&entry.eligibleIds.includes(id)!==context.eligibleIds.includes(id))return null;
        }
        const read=new Map(entry.readMessages.map(m=>[m.key,m])),current=new Map(context.frame.messages.map(m=>[m.key,m]));
        if(context.readMessages.some(m=>JSON.stringify(read.get(m.key))!==JSON.stringify(m)))return null;
        for(const [key,message] of read)if(JSON.stringify(message)!==JSON.stringify(current.get(key)))return null;
        let expected=entry.memory;
        for(const commit of suffix){
            if(commit.automatic!==true||!['maintenance','compact'].includes(commit.reason))return null;
            if(commit.reason==='maintenance'&&(!Array.isArray(commit.readKeys)||!commit.readKeys.every(k=>read.has(k===context.frame.playerKey?null:k))))return null;
            expected=applyDataPatch(expected,commit.patch);
        }
        if(JSON.stringify(expected)!==JSON.stringify(context.memory))return null;
        return {ids:[...entry.ids],readMessages:entry.readMessages};
    }
    stage(plan,key,ids,serial,context){
        this.#staged.set(plan,{key,ids:[...ids],serial,...(context?{stableKey:context.stableKey,memory:clone(context.memory),
            journalIds:context.journal.map(c=>c.id),eligibleIds:[...context.eligibleIds],readMessages:clone(context.readMessages)}:{})});
    }
    commit(plan){
        const candidate=this.#staged.get(plan);if(!candidate)return;
        this.#staged.delete(plan);this.#entry=candidate;
        if(candidate.serial===this.serial)this.forced=false;
    }
}
