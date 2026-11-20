import { requestBatches } from '../agents/requests.js';

/** A cadence decides when to work; a batch target decides how much one call reads. */
export function maintenanceSchedule(messages, processed, settings) {
    let covered=0;
    while(covered<processed.length&&messages[covered]?.key===processed[covered])covered++;
    const reply = m => m.role==='assistant' && (m.rawHasContent ?? Boolean(String(m.content??'').trim()));
    const every=settings.maintenanceEvery;
    const keep=settings.maintenanceKeepRecent ?? 1;
    const replies=messages.flatMap((m,i)=>reply(m)?[i]:[]);
    let end=messages.length;
    if(keep&&replies.length){
        end=replies[Math.max(0,replies.length-keep)];
        // Defer the player's corresponding input as well, so it cannot be
        // recorded alone before the selected response is ready to keep.
        for(let i=end-1;i>=0;i--){
            if(messages[i].role==='assistant')break;
            if(messages[i].role==='user')end=i;
        }
    }
    end=Math.max(covered,end);
    const pending=messages.slice(covered),eligible=messages.slice(covered,end);
    const pendingReplies=pending.filter(reply).length,eligibleReplies=eligible.filter(reply).length;
    return {every,pendingReplies,eligibleReplies,retainedReplies:pendingReplies-eligibleReplies,
        eligibleEnd:end,covered,eligiblePendingCount:Math.max(0,end-covered),retainedPendingCount:Math.max(0,messages.length-end),waiting:pending.length>0&&eligibleReplies<every,
        trigger:eligibleReplies>=every?'interval':pending.length?'waiting':'none'};
}

/** Keep a short player input with its oversized reply. A single oversized
 * message was already permitted; only a bounded small prefix is added to it. */
export function maintenanceBatches(messages, limit) {
    const units=[];
    for(const message of messages){
        if(!units.length||message.role==='user')units.push([message]);
        else units.at(-1).push(message);
    }
    const size=unit=>unit.reduce((n,m)=>n+String(m.content??'').length,0);
    const groups=[];let batch=[],used=0;
    const flush=()=>{if(batch.length)groups.push(batch);batch=[];used=0;};
    for(const unit of units){
        const length=size(unit);
        if(length>limit){
            flush();
            const prefix=unit.slice(0,-1),tail=unit.at(-1);
            const smallPrefix=prefix.length&&prefix[0].role==='user'&&prefix.every(m=>m.role!=='assistant')
                &&size(prefix)<=Math.min(2000,Math.floor(limit/10));
            if(smallPrefix&&tail.role==='assistant'&&String(tail.content??'').length>limit)groups.push(unit);
            else groups.push(...requestBatches(unit,limit));
        }else{
            if(used+length>limit)flush();batch.push(...unit);used+=length;
        }
    }
    flush();return groups;
}
