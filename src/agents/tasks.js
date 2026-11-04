import { decodeMaintenanceEvidence } from './evidence-codec.js';
import { compactPlans, decodeCompactResult } from './compact-plan.js';
import { selectionCatalog, decodeSelectionIds } from './selection-codec.js';
import { classificationPieces, joinClassifications } from './classification-pieces.js';
import { invariant, plainText } from '../core/util.js';
import { createEntry, entryText, splitSourceText, GLOBAL_SCOPE } from '../core/state.js';
import { initializeRequest, requestBatches, strategyRequest, maintainRequest, selectRequest, compactRequest } from './requests.js';
import { sourceSegments } from './source-segments.js';
import { restoreProtectedReferences } from '../core/views.js';
import { SOURCE_MERGE } from './prompts.js';
import { DEFERRED } from './prescan.js';

// The controller keeps the trace open until task validation finishes. Simple
// standalone clients can still execute the same task without diagnostics.
async function completeTask(client, request, accept) {
    const validate = result => {
        try { return accept(result); }
        catch (error) {
            // Only these pure task-result checks are eligible for one format
            // correction. Cancellation, stale-state and persistence checks live
            // outside this boundary and must never initiate another model call.
            if (error.dwmResponseInvalid !== false) error.dwmResponseInvalid = true;
            throw error;
        }
    };
    return typeof client.completeValidated === 'function'
        ? client.completeValidated(request, validate) : validate(await client.complete(request));
}

export async function classifyEntries(client, entries, naturalLanguage = '', signal, { batchChars = 18000 } = {}) {
    const work = classificationPieces(entries, batchChars);
    if (work.length === entries.length && work.every((e,i)=>e===entries[i])) return classifyBatch(client,entries,naturalLanguage,signal);
    const classified=[], strategies=[];
    for(const group of requestBatches(work,batchChars,entryText,24)) {
        const result=await classifyBatch(client,group,naturalLanguage,signal);classified.push(...result.entries);strategies.push(result.strategy);
    }
    return {entries:joinClassifications(entries,classified),strategy:strategies.find(Boolean)??''};
}
async function classifyBatch(client, entries, naturalLanguage = '', signal) {
    return completeTask(client, { ...initializeRequest(entries, naturalLanguage), signal }, result => {
        invariant(Array.isArray(result.entries) && result.entries.length === entries.length, '初始化没有完整覆盖本批条目');
        invariant(result.entries.every(item => item && typeof item.id === 'string'), '初始化条目身份无效');
        const outputs = new Map(result.entries.map(e => [e.id, e]));
        invariant(outputs.size === entries.length, '初始化返回了重复条目');
        return {
            strategy: plainText(result.strategy ?? '', '记忆策略', 10000),
            entries: entries.map(source => {
                const item = outputs.get(source.id);
                invariant(item, `初始化漏掉了条目 ${source.title}`);
                const rebuilt = sourceSegments(entryText(source), item.segments);
                const next = createEntry({ ...source, kind: item.kind, intro: item.intro, retrieveWhen: item.retrieveWhen,
                    important: item.important, needsReview: item.needsReview || rebuilt.needsReview, segments: rebuilt.segments, scanBlocked: false });
                invariant(entryText(next) === entryText(source), '初始化分类不得改写原文');
                return next;
            }),
        };
    });
}
/** How many times one book scan may halve a refused batch. Each halving sends
 * two sub-requests, so a scan adds at most 32 requests beyond its original
 * batches, and a provider that refuses everything costs a bounded number of calls. */
export const SCAN_REFUSAL_BUDGET = 16;
export const scanBudget = (batchChars = 18000) => ({ refusals: SCAN_REFUSAL_BUDGET, batchChars });
/** Left for the host to send as the original book does (see prescan). */
export function blockedEntry(source) {
    return createEntry({ ...source, kind: 'fact', intro: '', retrieveWhen: '', important: false, needsReview: false, enabled: false,
        segments: source.segments.map(segment => ({ ...segment, writable: false })), status: DEFERRED, scanBlocked: true });
}
/** Book entries are independent, so a batch the provider's content review
 * refused is halved and resent; entries refused on their own stay unscanned
 * instead of failing the whole scan. Any other error still fails it. */
export async function classifyOrDefer(client, entries, naturalLanguage = '', signal, budget = scanBudget()) {
    try {
        const result = await classifyEntries(client, entries, naturalLanguage, signal, {batchChars:budget.batchChars});
        return { ...result, blocked: [] };
    } catch (error) {
        if (!error?.dwmBlocked) throw error;
        if (entries.length === 1 || budget.refusals <= 0) return { entries: entries.map(blockedEntry), strategy: '', blocked: entries.map(entry => entry.id) };
        budget.refusals--;
        // The checkpoint keeps one strategy per original batch; halves of one
        // batch read the same book, so the first one stands for both.
        const middle = Math.ceil(entries.length / 2), out = { entries: [], strategy: '', blocked: [] };
        for (const part of [entries.slice(0, middle), entries.slice(middle)]) {
            const result = await classifyOrDefer(client, part, naturalLanguage, signal, budget);
            out.entries.push(...result.entries); out.blocked.push(...result.blocked); out.strategy ||= result.strategy;
        }
        return out;
    }
}
export async function alignStrategy(client, strategies, entries, naturalLanguage, signal) {
    const distinct = [...new Set(strategies.filter(Boolean))];
    if (distinct.length <= 1) return plainText(distinct[0] ?? '', '记忆策略', 10000);
    return completeTask(client, { ...strategyRequest(strategies, entries, naturalLanguage), signal },
        result => plainText(result.strategy, '统一记忆策略', 10000));
}

export async function maintain(client, save, messages, signal, scopeId = GLOBAL_SCOPE, observedState = null, validate = () => {}, { focus = null, followUp = false } = {}) {
    const request = maintainRequest(save, messages, scopeId, observedState, { focus, followUp });
    const full = new Set(request.input.memory.entries.map(entry => entry.id));
    const listed = new Set((request.input.memory.catalog ?? []).map(entry => entry.id));
    return completeTask(client, { ...request, signal }, result => {
        invariant(Array.isArray(result.operations), '后置维护须返回 operations 操作列表；无变化时返回空数组');
        // Catalog entries were not supplied in full: an edit to one becomes a
        // request for its text, answered by a separate follow-up pass.
        const needed = new Set(followUp ? [] : (Array.isArray(result.needEntries) ? result.needEntries : []).filter(id => listed.has(id)));
        const { needEntries: _needEntries, ...rest } = result;
        const kept = { ...rest, operations: result.operations.filter(op => {
            if (op?.type !== 'update' || !listed.has(op.id)) return true;
            if (!followUp) needed.add(op.id);
            return false;
        }) };
        const decoded = decodeMaintenanceEvidence(request.input, kept, op => !(save.worldbookOnly || followUp)
            || op.type === 'update' && (!followUp || full.has(op.id)));
        const restored = restoreProtectedReferences(decoded, request.input.memory);
        // Worldbook-only saves never keep narrative memory; ignore such operations
        // instead of failing the batch (the history window does not trim here).
        if (save.worldbookOnly || followUp) restored.operations = restored.operations.filter(op => op?.type === 'update' && (!followUp || full.has(op.id)));
        validate(restored);
        if (needed.size) restored.needEntries = [...needed].slice(0, 12);
        return restored;
    });
}
export async function select(client, save, messages, { eligible = () => true, selectionLimit = 16, selectionChars = 24000, observedState = null, forced = [], authorGuidance = '', messageCount = null, signal } = {}) {
    const request = selectRequest(save, messages, { eligible, selectionLimit, selectionChars, observedState, forced, authorGuidance, messageCount });
    const catalog = selectionCatalog(request.input);
    return completeTask(client, { ...request, signal }, result => {
        invariant(Array.isArray(result.ids), '前置选材格式无效，ids 须为列表');
        const allowed = new Map(catalog.map(e => [e.id, e]));
        invariant(result.ids.every(id => typeof id === 'string' && allowed.has(id)), '前置选择了目录中不允许的资料，请仅使用本批目录原 id');
        const ids = [...new Set(result.ids)];
        invariant(ids.filter(id => !allowed.get(id).constant).length <= selectionLimit, '前置选材数量超过按需名额，请保留本轮最相关的资料');
        return decodeSelectionIds(request.input, ids);
    });
}
export async function compact(client, save, signal, scopeId = GLOBAL_SCOPE, { summaryOnly = false } = {}) {
    const request = compactRequest(save, scopeId, { summaryOnly }), memory=request.input.memory;
    const plans=compactPlans(request), operations=[], summaries=[], fragments=new Map();
    let summaryChanged=false;
    for(const plan of plans){
        if(signal?.aborted)throw signal.reason;
        const input=plan.request.input.memory,ids=new Set(input.entries.map(e=>e.id));
        const result=await completeTask(client,{...plan.request,signal},raw=>{
            const decoded=decodeCompactResult(raw,plan);
            invariant(decoded.operations.every(op=>op&&['summary','update','mergeEvents','mergeEntries'].includes(op.type)),'整理只能更新脉络与给出的历史事件');
            invariant(decoded.operations.every(op=>op.type==='summary'?plan.summaryIndex!==undefined
                : ['mergeEvents','mergeEntries'].includes(op.type)?!plan.fragment&&Array.isArray(op.sources)&&op.sources.every(s=>ids.has(s.id)):ids.has(op.id)),'整理不得修改本批之外的资料');
            if(plan.fragment)invariant(decoded.operations.length<=1&&decoded.operations.every(op=>op.type==='update'&&op.segments?.every(s=>s.id===plan.fragment.segmentId)),'分段整理只能精简本片段');
            restoreProtectedReferences(decoded,plan.request.input.memory);
            return decoded;
        });
        if(plan.summaryIndex!==undefined){
            invariant(result.operations.length<=1,'脉络批次只能返回一个替换');
            summaries[plan.summaryIndex]=result.operations[0]?.text??plan.original;summaryChanged ||=result.operations.length>0;
        }else if(plan.fragment){
            const f=plan.fragment,entry=memory.entries.find(e=>e.id===f.entryId);
            if(!fragments.has(f.entryId))fragments.set(f.entryId,{entry,parts:new Map(),changed:false,evidence:new Set()});
            const merged=fragments.get(f.entryId),op=result.operations[0];
            if(!merged.parts.has(f.segmentId))merged.parts.set(f.segmentId,[]);
            merged.parts.get(f.segmentId)[f.index]=op?.segments?.[0]?.text??f.original;
            merged.changed ||=Boolean(op);for(const key of op?.evidence??[])merged.evidence.add(key);
        }else operations.push(...result.operations);
    }
    if(summaryChanged)operations.unshift({type:'summary',text:summaries.join('')});
    for(const {entry,parts,changed,evidence} of fragments.values())if(changed)operations.push({type:'update',id:entry.id,expectedVersion:entry.version,
        segments:entry.segments.map(segment=>({id:segment.id,text:parts.has(segment.id)?parts.get(segment.id).join(''):segment.text})),evidence:[...evidence]});
    return restoreProtectedReferences({operations},memory);
}

/** Author changed source entries that this save had already rewritten from the
 * story. The model merges each one; protected segments stay the new source. */
export const SOURCE_MERGE_INPUT_CHARS = 18000;
const mergeInput = items => ({ entries: items.map(({ id, title, oldSource, next, current }) => ({ id, title, oldSource, current,
    newSource: next.segments.filter(segment => segment.writable).map(segment => ({ id: segment.id, writable: true, text: segment.text })) })) });

function editSpan(before, after) {
    let start=0, tail=0;
    while(start<before.length && start<after.length && before[start]===after[start]) start++;
    if(start>0 && /[\uD800-\uDBFF]/.test(before[start-1])) start--;
    while(tail<before.length-start && tail<after.length-start && before[before.length-1-tail]===after[after.length-1-tail]) tail++;
    if(tail>0 && /[\uDC00-\uDFFF]/.test(before[before.length-tail])) tail--;
    return {start,end:before.length-tail,text:after.slice(start,after.length-tail)};
}
const mapBoundary = (position, edit, beforeLength, afterLength) => position===0 ? 0 : position===beforeLength ? afterLength
    : position<=edit.start ? position : position>=edit.end ? position+edit.text.length-(edit.end-edit.start) : null;

/** Long three-way merges send only the changed overlap. Independent edits are
 * merged exactly without a model; an unbounded/ambiguous overlap is held. */
async function mergeLongSource(client, item, signal) {
    const {id,oldSource,current,next}=item;
    if(!next.segments.every(s=>s.writable) || item.used?.segments.some(s=>!s.writable)) return {id,held:true,note:'长条目权限边界无法安全合并，旧资料保留'};
    const authored=entryText(next), story=editSpan(oldSource,current), author=editSpan(oldSource,authored);
    const finish=text=>({id,segments:splitSourceText(text).map(s=>({...s,writable:true})),note:''});
    if(current===oldSource)return finish(authored);
    if(authored===oldSource||authored===current)return finish(current);
    if(story.end<author.start||author.end<story.start){
        let merged=oldSource;
        for(const edit of [story,author].sort((a,b)=>b.start-a.start)) merged=merged.slice(0,edit.start)+edit.text+merged.slice(edit.end);
        return finish(merged);
    }
    let start=Math.max(0,Math.min(story.start,author.start)-512),end=Math.min(oldSource.length,Math.max(story.end,author.end)+512);
    if(start>0&&/[\uDC00-\uDFFF]/.test(oldSource[start]))start--;
    if(end<oldSource.length&&/[\uDC00-\uDFFF]/.test(oldSource[end]))end++;
    const aStart=mapBoundary(start,author,oldSource.length,authored.length),aEnd=mapBoundary(end,author,oldSource.length,authored.length);
    const sStart=mapBoundary(start,story,oldSource.length,current.length),sEnd=mapBoundary(end,story,oldSource.length,current.length);
    if([aStart,aEnd,sStart,sEnd].some(v=>v===null))return {id,held:true,note:'长条目改动无法定位，旧资料保留'};
    const fragment={...item,oldSource:oldSource.slice(start,end),current:current.slice(sStart,sEnd),
        next:{...next,segments:[{id:'fragment',text:authored.slice(aStart,aEnd),writable:true}]}};
    if(JSON.stringify(mergeInput([fragment])).length>SOURCE_MERGE_INPUT_CHARS)return {id,held:true,note:'长条目冲突范围超过单次合并预算，旧资料保留'};
    const [result]=await mergeSourceBatch(client,[fragment],signal);
    return finish(authored.slice(0,aStart)+result.segments[0].text+authored.slice(aEnd));
}
export async function mergeSourceUpdates(client, items, signal) {
    if(JSON.stringify(mergeInput(items)).length<=SOURCE_MERGE_INPUT_CHARS)return mergeSourceBatch(client,items,signal);
    const result=[];
    for(const item of items){
        if(signal?.aborted)throw signal.reason;
        if(JSON.stringify(mergeInput([item])).length<=SOURCE_MERGE_INPUT_CHARS)result.push(...await mergeSourceBatch(client,[item],signal));
        else result.push(await mergeLongSource(client,item,signal));
    }
    return result;
}
async function mergeSourceBatch(client, items, signal) {
    const input=mergeInput(items);
    invariant(JSON.stringify(input).length<=SOURCE_MERGE_INPUT_CHARS,'来源合并请求超过单次处理预算');
    return completeTask(client, { purpose: 'sourceMerge', system: SOURCE_MERGE, input, signal }, result => {
        invariant(Array.isArray(result.entries) && result.entries.length === items.length, '原书合并没有覆盖全部条目');
        const outputs = new Map(result.entries.map(item => [item?.id, item]));
        return items.map(({ id, next }) => {
            const item = outputs.get(id);
            invariant(item && Array.isArray(item.segments), `原书合并漏掉了条目 ${id}`);
            const writable = next.segments.filter(segment => segment.writable).map(segment => segment.id);
            const texts = new Map(item.segments.map(segment => [segment?.id, segment?.text]));
            invariant(texts.size === writable.length && writable.every(segmentId => typeof texts.get(segmentId) === 'string'),
                '原书合并须返回该条目全部可写片段，且不得包含受保护片段');
            const segments = next.segments.map(segment => segment.writable ? { ...segment, text: plainText(texts.get(segment.id), '合并片段', 100000) } : segment);
            return { id, segments, note: typeof item.note === 'string' ? item.note.slice(0, 500) : '' };
        });
    });
}
