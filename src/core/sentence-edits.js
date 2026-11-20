export const MAX_EDIT_SPAN_CHARS = 256;
export const MAX_EDIT_COVERAGE = 0.6;
export const SHORT_SINGLE_ENTRY_CHARS = 64;
const lineBreak = /[\r\n\v\f\u0085\u2028\u2029]/u;
function lengthUpTo(text,limit){let n=0;for(const _ of text)if(++n>limit)return n;return n;}
// Count significant characters only, capped once the largest allowed edit
// cannot cover 60%. Avoid scanning/allocating an array for a huge worldbook.
function bodySize(entry){
    let n=0;const stop=Math.floor(MAX_EDIT_SPAN_CHARS/MAX_EDIT_COVERAGE)+1;
    for(const segment of entry.segments){const nonspace=/\S/gu;while(nonspace.exec(segment.text))if(++n>=stop)return n;}
    return n;
}
function shortSingleEntry(entry){
    if(entry.segments.length!==1)return false;
    const text=entry.segments[0].text.trim();
    if(!text||text.length>SHORT_SINGLE_ENTRY_CHARS*2||lengthUpTo(text,SHORT_SINGLE_ENTRY_CHARS)>SHORT_SINGLE_ENTRY_CHARS||lineBreak.test(text))return false;
    // Conservative exception, not a language parser: don't treat a short
    // paragraph, list or structured record as a single editable sentence.
    const inner=text.replace(/[.!?。！？]+["'”’」』）)]*$/u,'');
    return !/[.!?。！？,，、;；|{}[\]<>]/u.test(inner) && (text.match(/[:：]/gu)??[]).length<=1;
}

/** Resolve against the original version, never against earlier replacements.
 * No trimming, regex interpretation or approximate matching is permitted. */
export function applySentenceEdits(entry, edits) {
    const rejected=[], plans=[], segments=new Map(entry.segments.map(s=>[s.id,s]));
    let rangeContext;
    const reject=(index,segmentId,code)=>rejected.push({editIndex:index,segmentId,code});
    for(const [index,edit] of edits.entries()){
        const segment=segments.get(edit?.segmentId);
        if(!segment){reject(index,edit?.segmentId,'patch-segment-missing');continue;}
        if(!segment.writable){reject(index,segment.id,'patch-protected');continue;}
        if(edit.outsideInput===true){reject(index,segment.id,'patch-not-found');continue;}
        const append=Object.hasOwn(edit,'append');
        if(append){
            if(typeof edit.append!=='string'||Object.hasOwn(edit,'oldText')||Object.hasOwn(edit,'newText')){reject(index,segment.id,'patch-invalid');continue;}
            if(edit.append)plans.push({index,id:segment.id,start:segment.text.length,end:segment.text.length,text:edit.append,append:true});
            continue;
        }
        if(typeof edit.oldText!=='string'||!edit.oldText.length||typeof edit.newText!=='string') {reject(index,segment.id,'patch-invalid');continue;}
        const start=segment.text.indexOf(edit.oldText);
        if(start<0){reject(index,segment.id,'patch-not-found');continue;}
        if(segment.text.indexOf(edit.oldText,start+1)>=0){reject(index,segment.id,'patch-ambiguous');continue;}
        const cutsPair=at=>at>0&&at<segment.text.length&&/[\uD800-\uDBFF]/.test(segment.text[at-1])&&/[\uDC00-\uDFFF]/.test(segment.text[at]);
        if(cutsPair(start)||cutsPair(start+edit.oldText.length)){reject(index,segment.id,'patch-invalid');continue;}
        if(edit.oldText===edit.newText)continue;
        if(lengthUpTo(edit.oldText,MAX_EDIT_SPAN_CHARS)>MAX_EDIT_SPAN_CHARS){reject(index,segment.id,'patch-span-too-long');continue;}
        if(lineBreak.test(edit.oldText.trim())){reject(index,segment.id,'patch-span-multiline');continue;}
        rangeContext??={size:bodySize(entry),short:shortSingleEntry(entry)};
        const selected=[...edit.oldText.matchAll(/\S/gu)].length;
        if(!rangeContext.short && (!rangeContext.size || selected/rangeContext.size>MAX_EDIT_COVERAGE)){
            reject(index,segment.id,'patch-span-too-wide');continue;
        }
        plans.push({index,id:segment.id,start,end:start+edit.oldText.length,text:edit.newText});
    }
    const conflicts=new Set();
    for(let i=0;i<plans.length;i++)for(let j=i+1;j<plans.length;j++){
        const a=plans[i],b=plans[j];
        if(a.id===b.id&&!a.append&&!b.append&&a.start<b.end&&b.start<a.end){conflicts.add(a.index);conflicts.add(b.index);}
    }
    const next=entry.segments.map(s=>({...s}));let applied=0;
    for(const s of next){
        const work=plans.filter(p=>p.id===s.id);
        for(const p of work.filter(p=>conflicts.has(p.index)))reject(p.index,p.id,'patch-overlap');
        const valid=work.filter(p=>!conflicts.has(p.index));
        let text=s.text;
        // Same-position appends are applied in reverse order to retain wire order.
        for(const p of valid.sort((a,b)=>b.start-a.start||b.index-a.index))text=text.slice(0,p.start)+p.text+text.slice(p.end);
        if(text.split('[受保护资料]').length>s.text.split('[受保护资料]').length){
            for(const p of valid)reject(p.index,p.id,'patch-protected-reference');continue;
        }
        s.text=text;applied+=valid.length;
    }
    return {segments:next,applied,rejected:rejected.sort((a,b)=>a.editIndex-b.editIndex)};
}
