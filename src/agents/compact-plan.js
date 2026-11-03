import { invariant } from '../core/util.js';
import { projectProtectedReferences } from '../core/views.js';

export const COMPACT_INPUT_CHARS = 24000;
/** Split at Unicode and protected-reference boundaries; never expose a partial token. */
function pieces(text, limit) {
    const result=[];
    for(let start=0;start<text.length;){
        let end=Math.min(text.length,start+limit);
        if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
        const open=text.lastIndexOf('⟦鱼忆引用:',end-1),close=text.indexOf('⟧',open);
        if(open>=start&&close>=end)end=open>start?open:close+1;
        invariant(end>start,'整理分段边界无效');result.push(text.slice(start,end));start=end;
    }
    return result.length?result:[''];
}
/** Full source keys remain local; only a reversible short-key map goes on wire. */
function envelope(request, entries, summary) {
    const references=new Map(),reverse=new Map();
    const alias=key=>{if(!reverse.has(key)){const id=`k${reverse.size+1}`;reverse.set(key,id);references.set(id,key);}return reverse.get(key)};
    const projected=entries.map(({lastEvidence,evidenceTrimmed,lineage,...entry})=>({...entry,evidence:[...new Set(entry.evidence??[])].map(alias)}));
    const {inventory,catalog,...memory}=request.input.memory;
    const projection={...memory,summary,entries:projected};
    projectProtectedReferences(request.input.memory,projection);
    return {request:{...request,input:{...request.input,memory:projection}},references};
}
export function compactPlans(request, limit=COMPACT_INPUT_CHARS) {
    const plans=[],fits=plan=>JSON.stringify(plan.request.input).length<=limit;
    const summary=request.input.memory.summary??'';
    let size=Math.max(256,Math.floor(limit/4));
    if(summary){
        let chunks=fits(envelope(request,[],summary))?[summary]:pieces(summary,size);
        while(!chunks.every(chunk=>fits(envelope(request,[],chunk)))){size=Math.floor(size/2);invariant(size>=32,'整理指导过长，无法在预算内请求');chunks=pieces(summary,size);}
        for(const [index,chunk] of chunks.entries())plans.push({...envelope(request,[],chunk),summaryIndex:index,original:chunk});
    }
    const groups=new Map();for(const entry of request.input.memory.entries){const kind=entry.kind;groups.set(kind,[...(groups.get(kind)??[]),entry]);}
    for(const entries of groups.values()){
        let batch=[];
        const flush=()=>{if(batch.length){plans.push(envelope(request,batch,''));batch=[];}};
        for(const entry of entries){
            if(fits(envelope(request,[...batch,entry],''))){batch.push(entry);continue;}
            flush();if(fits(envelope(request,[entry],''))){batch=[entry];continue;}
            // One oversized generated entry is condensed by writable fragment.
            // It cannot merge with another identity until these pieces rejoin.
            for(const segment of entry.segments){
                let width=Math.max(256,Math.floor(limit/4)),chunks=pieces(segment.text,width);
                const part=text=>envelope(request,[{...entry,mergeable:false,segments:[{...segment,text}]}],'');
                while(!chunks.every(text=>fits(part(text)))){width=Math.floor(width/2);invariant(width>=32,'整理条目目录过长，无法在预算内请求');chunks=pieces(segment.text,width);}
                for(const [index,text] of chunks.entries())plans.push({...part(text),fragment:{entryId:entry.id,segmentId:segment.id,index,total:chunks.length,original:text}});
            }
        }
        flush();
    }
    const summaryCount=plans.filter(plan=>plan.summaryIndex!==undefined).length;
    for(const plan of plans)plan.request.system += plan.fragment?'\n本批只包含同一条目的一个正文分段。仅精简给出的这段，保留本段事实，不补齐其他片段，不合并身份。':summaryCount>1&&plan.summaryIndex!==undefined?'\n本批是长脉络的一段。只精简这一段，不重复补写其他段，尽量压缩到本段长度的六成以内。':'';
    return plans.sort((a,b)=>Number(a.summaryIndex!==undefined)-Number(b.summaryIndex!==undefined));
}
export function decodeCompactResult(result, plan) {
    invariant(Array.isArray(result.operations),'整理结果需要 operations 列表');
    return {operations:result.operations.map(operation=>{
        const op=structuredClone(operation);
        if(op.evidence)op.evidence=op.evidence.map(key=>{invariant(plan.references.has(key),'整理引用了未提供的来源编号');return plan.references.get(key)});
        return op;
    })};
}
