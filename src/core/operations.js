import { clone, invariant, plainText, uid, limitText } from './util.js';
import { isRemovedEntry, titleKey, identityNames } from './entry-changes.js';
import { applySentenceEdits } from './sentence-edits.js';
import { assertNoPendingProtectedReferences } from './views.js';
import { createEntry, assertOriginalPreserved, entryText, entryScope, normalizeScopeId, scopeSummary, normalizeInventoryItems, canCompactEntry, entryTier, GLOBAL_SCOPE } from './state.js';

// Navigation sources, not a claim that every retained fact is supported by every
// source. Keep both the early origin and recent changes without endless growth.
function retainEvidence(entry, current, inherited = []) {
    const all = [...new Set([...(entry.evidence ?? []), ...inherited, ...current])];
    entry.lastEvidence = current;
    entry.evidenceTrimmed = Boolean(entry.evidenceTrimmed || all.length > 256);
    entry.evidence = all.length > 256 ? [...all.slice(0, 32), ...all.slice(-224)] : all;
}

export function applyMaintenance(data, result, { allowedEvidence = [], maxChars = {}, idFactory = uid, scopeId = GLOBAL_SCOPE, removals = [], requireEdits = false, allowAutomaticMerge = false } = {}) {
    invariant(result && Array.isArray(result.operations) && result.operations.length <= 100, '后置结果必须包含有效 operations');
    scopeId = normalizeScopeId(scopeId);
    const next = clone(data);
    const touched = new Set();
    const rejected = [];
    const merges = [];
    const participants=new Map();
    if(allowAutomaticMerge)for(const op of result.operations){
        const ids=op?.type==='update'?[op.id]:['mergeEntries','mergeEvents','mergeIntoSource'].includes(op?.type)
            ? [...(Array.isArray(op.sources)?op.sources.slice(0,100).map(s=>s?.id):[]),...(op.targetId?[op.targetId]:[])]:[];
        for(const id of new Set(ids))participants.set(id,(participants.get(id)??0)+1);
    }
    const updateCounts=new Map();
    if(requireEdits)for(const op of result.operations)if(op?.type==='update')updateCounts.set(op.id,(updateCounts.get(op.id)??0)+1);
    const evidence = value => {
        invariant(Array.isArray(value) && value.every(k => allowedEvidence.includes(k)), '修改依据必须来自本批输入正文');
        return [...new Set(value)];
    };
    for (const op of result.operations) {
        invariant(op && typeof op === 'object', '无效维护操作');
        assertNoPendingProtectedReferences(op);
        invariant(op.scopeId === undefined || op.scopeId === scopeId, '后置不得改变本批资料归属');
        if (op.type === 'summary') {
            // A rewrite can contain the entire previous summary. Leave room for
            // a new batch when custom compaction thresholds exceed 20k.
            const rewriteLimit = Math.max(20000, scopeSummary(data, scopeId).length + 8000);
            const text = plainText(op.text, '常驻脉络', maxChars.summary ?? rewriteLimit);
            if (scopeId === GLOBAL_SCOPE) next.summary = text;
            else (next.scopeSummaries ??= {})[scopeId] = text;
            touched.add('$summary');
        } else if (op.type === 'appendSummary') {
            // Maintenance adds to the running summary; compaction rewrites it.
            const text = plainText(op.text, '新增脉络', 8000).trim();
            if (text) {
                const current = scopeSummary(next, scopeId);
                const joined = current ? `${current}\n${text}` : text;
                if (scopeId === GLOBAL_SCOPE) next.summary = joined;
                else (next.scopeSummaries ??= {})[scopeId] = joined;
                touched.add('$summary');
            }
        } else if (op.type === 'inventory') {
            invariant(next.inventoryEnabled, '物品清单已关闭，禁止继续维护');
            const items = normalizeInventoryItems(op.items);
            if (scopeId === GLOBAL_SCOPE) next.inventory = items;
            else (next.scopeInventories ??= {})[scopeId] = items;
            touched.add('$inventory');
        } else if (op.type === 'create') {
            invariant(['fact', 'npc', 'npc_pool', 'event'].includes(op.kind), '后置不能创建规则或其他专用条目');
            invariant(op.evidence?.length > 0, '新建资料需要剧情依据');
            const title=plainText(op.title,'条目名称',500);
            const duplicate=['npc','npc_pool'].includes(op.kind) && Object.values(next.entries).find(entry=>entryScope(entry)===scopeId&&identityNames([entry]).some(name=>titleKey(name)===titleKey(title)));
            if(duplicate){
                rejected.push({code:'duplicate-character',entryId:duplicate.id,title,kind:op.kind,scopeId,evidence:evidence(op.evidence)});
                continue;
            }
            const entry = createEntry({ id: idFactory('entry'), scopeId, title: op.title, kind: op.kind,
                text: op.text, intro: op.intro, retrieveWhen: op.retrieveWhen,
                important: Boolean(op.important && op.kind === 'npc'), importanceIndependent: true, evidence: evidence(op.evidence) });
            if (isRemovedEntry(entry, removals)) continue;
            next.entries[entry.id] = entry;
            touched.add(entry.id);
        } else if (op.type === 'update') {
            const e = next.entries[op.id];
            invariant(e && entryScope(e) === scopeId, '后置不能跨范围修改资料');
            invariant(e?.enabled && e.segments.some(s => s.writable), '后置不能读写锁定或禁用条目');
            invariant(op.evidence?.length > 0, '更新事实需要剧情依据');
            const cited=evidence(op.evidence);
            if(allowAutomaticMerge&&participants.get(e.id)>1){rejected.push({code:'merge-overlap',entryId:e.id,title:e.title,kind:e.kind,scopeId,evidence:cited});continue;}
            if(requireEdits&&updateCounts.get(op.id)>1){
                rejected.push({code:'patch-duplicate-update',entryId:e.id,scopeId,title:e.title,kind:e.kind,evidence:cited});continue;
            }
            invariant(op.expectedVersion === e.version, '条目已变化，请重新维护');
            if(requireEdits||op.edits!==undefined){
                if(!Array.isArray(op.edits)){
                    rejected.push({code:'patch-rewrite-rejected',entryId:e.id,scopeId,title:e.title,kind:e.kind,evidence:cited});continue;
                }
                invariant(op.edits.length<=1000,'局部修改数量无效');
                const patch=applySentenceEdits(e,op.edits);
                rejected.push(...patch.rejected.map(item=>({...item,entryId:e.id,scopeId,title:e.title,kind:e.kind,evidence:cited})));
                if(!patch.applied)continue;
                for(const s of patch.segments)if(s.text!==e.segments.find(p=>p.id===s.id).text)plainText(s.text,'动态正文',maxChars[e.id]??100000);
                e.segments=patch.segments;
                // A rejected text edit must not be reported as a new fact in its directory.
                if(!patch.rejected.length){
                    if(op.intro!==undefined)e.intro=plainText(op.intro,'简介',2000);
                    if(op.retrieveWhen!==undefined)e.retrieveWhen=plainText(op.retrieveWhen,'提取指导',4000);
                }
                retainEvidence(e,cited);e.version++;touched.add(e.id);continue;
            }
            invariant(Array.isArray(op.segments) && op.segments.length > 0, '更新必须指定可写片段');
            for (const change of op.segments) {
                const segment = e.segments.find(s => s.id === change.id);
                invariant(segment?.writable, '禁止覆盖受保护片段');
                // An unchanged legacy segment may already exceed today's rule.
                // Only newly written text must satisfy the current length limit.
                if (change.text !== segment.text) segment.text = plainText(change.text, '动态正文', maxChars[e.id] ?? 100000);
            }
            if (op.intro !== undefined) e.intro = plainText(op.intro, '简介', 2000);
            if (op.retrieveWhen !== undefined) e.retrieveWhen = plainText(op.retrieveWhen, '提取指导', 4000);
            retainEvidence(e, evidence(op.evidence));
            e.version++;
            touched.add(e.id);
        } else if (op.type === 'promote') {
            const e = next.entries[op.id];
            invariant(e && entryScope(e) === scopeId, '后置不能跨范围修改资料');
            invariant(e?.kind === 'npc' && e.enabled && e.segments.some(s => s.writable), '仅可晋升可维护 NPC');
            invariant(op.evidence?.length > 0, '晋升需要持续关系或独立维护价值的依据');
            if (!e.important) e.importanceIndependent = true;
            e.important = true;
            retainEvidence(e, evidence(op.evidence));
            e.version++;
            touched.add(e.id);
        } else if (['mergeEvents', 'mergeEntries','mergeIntoSource'].includes(op.type)) {
            if(requireEdits&&!allowAutomaticMerge){
                const e=next.entries[op.sources?.[0]?.id];
                invariant(e&&entryScope(e)===scopeId,'事件整合不能跨资料范围');
                rejected.push({code:'patch-merge-needs-confirmation',entryId:e.id,scopeId,title:e.title,kind:e.kind,evidence:[]});
                continue;
            }
            const intoSource=op.type==='mergeIntoSource';
            invariant(Array.isArray(op.sources) && op.sources.length >= (intoSource?1:2) && op.sources.length <= 100,
                '事件整合至少需要两个已有条目');
            const ids = op.sources.map(source => source?.id);
            invariant(ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length,
                '事件整合来源不能重复');
            if(allowAutomaticMerge&&[...ids,op.targetId].some(id=>id&&participants.get(id)>1)){
                const e=next.entries[ids[0]];invariant(e,'整合来源不存在');
                rejected.push({code:'merge-overlap',entryId:e.id,title:e.title,kind:e.kind,scopeId,evidence:[]});continue;
            }
            invariant(intoSource || op.targetId === undefined || ids.includes(op.targetId), '整合目标必须属于来源事件');
            const sources = op.sources.map(source => {
                const current = next.entries[source.id];
                invariant(current && entryScope(current) === scopeId, '事件整合不能跨资料范围');
                invariant(canCompactEntry(current) && (op.type !== 'mergeEvents' || current.kind === 'event'), '只能整合未受保护的鱼忆新增条目');
                invariant(source.expectedVersion === current.version, '事件版本已变化，请重新整理');
                return current;
            });
            if(allowAutomaticMerge&&(op.sameIdentity!==true||typeof op.identityReason!=='string'||!op.identityReason.trim())){
                const e=sources[0];rejected.push({code:'merge-identity-unconfirmed',entryId:e.id,title:e.title,kind:e.kind,scopeId,evidence:[]});continue;
            }
            const identityReason=allowAutomaticMerge?plainText(op.identityReason,'合并依据',1000):'';
            if(intoSource){
                const target=next.entries[op.targetId];
                invariant(allowAutomaticMerge&&target?.source&&entryScope(target)===scopeId&&!ids.includes(target.id),'合并的原书目标无效');
                invariant(target.version===op.expectedTargetVersion,'原书目标已变化，请重新整理');
                if(!target.enabled||target.kind==='rule'||!target.segments.some(s=>s.writable)){
                    rejected.push({code:'merge-target-protected',entryId:target.id,title:target.title,kind:target.kind,scopeId,evidence:[]});continue;
                }
                const text=plainText(op.text,'追加资料',100000);invariant(text.trim(),'追加资料不能为空');
                const cited=evidence(op.evidence);invariant(cited.length>0,'事件整合需要依据');
                const merged=createEntry({...target,segments:[...target.segments,{id:idFactory('segment'),text:(entryText(target)?'\n':'')+text,writable:true}],
                    version:target.version+1,identityNames:identityNames([target,...sources]),lineage:[...new Set([...(target.lineage??[]),...sources.flatMap(e=>[e.id,...(e.lineage??[])])])]});
                retainEvidence(merged,cited,sources.flatMap(e=>e.evidence));next.entries[target.id]=merged;touched.add(target.id);
                for(const source of sources){delete next.entries[source.id];touched.add(source.id);}
                merges.push({targetId:target.id,sourceIds:ids,identityReason,intoSource:true,appended:limitText(text,4000),appendChars:text.length});continue;
            }
            if (op.type === 'mergeEntries') invariant(sources.every(e => e.kind === sources[0].kind), '合并条目须属于同一类型');
            invariant(Array.isArray(op.evidence) && op.evidence.length > 0, '事件整合需要依据');
            const cited = evidence(op.evidence);
            const title = plainText(op.title, '整合事件名称', 500);
            const intro = plainText(op.intro, '整合事件简介', 2000);
            const retrieveWhen = plainText(op.retrieveWhen ?? '', '整合事件提取指导', 4000);
            const text = plainText(op.text, '整合事件正文', 100000);
            invariant(title.trim() && intro.trim() && text.trim(), '整合事件须有名称、简介和正文');
            const sourceLimits = sources.map(source => maxChars[source.id]).filter(Number.isFinite);
            if (sourceLimits.length) invariant(text.length <= Math.min(...sourceLimits), '整合事件超出作者长度约束');
            const inheritedEvidence = sources.flatMap(source => source.evidence);
            const lineage = [...new Set(sources.flatMap(source => [...(source.lineage ?? []), source.id]))];
            const mergedEvidence = [...new Set([...inheritedEvidence, ...cited])];
            const target = op.targetId ? next.entries[op.targetId] : null;
            const id = target?.id ?? idFactory('entry');
            invariant(target || !next.entries[id], '新事件身份重复');
            const merged = createEntry({
                id, scopeId, title, kind: op.type === 'mergeEntries' ? sources[0].kind : 'event', intro, retrieveWhen, text,
                ...(op.type === 'mergeEntries' ? {
                    important: sources.some(e => e.important), constant: sources.some(e => e.constant),
                    importanceIndependent: !sources.some(e=>e.important && !e.importanceIndependent && !e.tier && !e.constant),
                    ...(sources.some(e => e.tier) ? {tier:sources.some(e => entryTier(e) === 'constant')?'constant':'onDemand'} : {}),
                } : {}),
                evidence: mergedEvidence, lineage,
                identityNames:identityNames(sources),
                version: target ? target.version + 1 : 1,
                enabled: true,
            });
            merged.evidenceTrimmed = sources.some(source => source.evidenceTrimmed);
            retainEvidence(merged, cited);
            for (const source of sources) { delete next.entries[source.id]; touched.add(source.id); }
            next.entries[id] = merged; touched.add(id);
            merges.push({targetId:id,sourceIds:ids,identityReason,intoSource:false});
        } else {
            throw new Error(`不支持的维护操作：${op.type}`);
        }
    }
    for (const [id, max] of Object.entries(maxChars)) {
        if (next.entries[id] && (!data.entries[id] || entryText(next.entries[id]) !== entryText(data.entries[id]))) {
            invariant(entryText(next.entries[id]).length <= max, `条目 ${id} 超出作者长度约束`);
        }
    }
    assertOriginalPreserved(data, next);
    return { next, touched: [...touched], rejected, merges };
}

export function diffData(before, after) {
    const entries = {};
    for (const id of new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])) {
        if (JSON.stringify(before.entries[id]) !== JSON.stringify(after.entries[id])) entries[id] = clone(after.entries[id] ?? null);
    }
    const patch = { entries };
    // The card's live control context is not a story fact and must not rewind
    // with a deleted/replaced reply. MemoryStore preserves it independently.
    for (const key of ['summary', 'strategy', 'inventory', 'inventoryEnabled']) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = clone(after[key]);
    }
    for (const key of ['scopeSummaries', 'scopeInventories', 'messageScopes']) {
        const changes = {};
        for (const id of new Set([...Object.keys(before[key] ?? {}), ...Object.keys(after[key] ?? {})])) {
            if (JSON.stringify(before[key]?.[id]) !== JSON.stringify(after[key]?.[id])) changes[id] = clone(after[key]?.[id] ?? null);
        }
        if (Object.keys(changes).length) (patch.scopeChanges ??= {})[key] = changes;
    }
    return patch;
}
export function compactionMeasure(state,scopeId=GLOBAL_SCOPE){
    const commits=state.journal.filter(j=>j.reason==='maintenance');
    const related=j=>scopeId===GLOBAL_SCOPE&&Object.hasOwn(j.patch,'summary')||Object.hasOwn(j.patch.scopeChanges?.scopeSummaries??{},scopeId)
        ||Object.values(j.patch.entries).some(entry=>entry&&entryScope(entry)===scopeId&&canCompactEntry(entry));
    return {count:commits.filter(related).length,cycles:commits.length,commitId:commits.at(-1)?.id??null,summaryChars:scopeSummary(state.data,scopeId).length,
        size:scopeSummary(state.data,scopeId).length+Object.values(state.data.entries).filter(e=>entryScope(e)===scopeId&&canCompactEntry(e)).reduce((n,e)=>n+entryText(e).length,0)};
}
export function applyDataPatch(data, patch) {
    const next = clone(data);
    for (const [id, value] of Object.entries(patch.entries)) {
        if (value === null) delete next.entries[id]; else next.entries[id] = clone(value);
    }
    for (const key of ['summary', 'strategy', 'inventory', 'inventoryEnabled', 'scopeContext']) if (key in patch) next[key] = clone(patch[key]);
    for (const [key, changes] of Object.entries(patch.scopeChanges ?? {})) {
        invariant(['scopeSummaries', 'scopeInventories', 'messageScopes'].includes(key), '无效范围补丁');
        next[key] ??= {};
        for (const [id, value] of Object.entries(changes)) {
            if (value === null) delete next[key][id]; else next[key][id] = clone(value);
        }
    }
    return next;
}
/** Snapshot the identity while the entry still exists. Only the player sees this record. */
export function entryAuditRecord(entry, reason, at) {
    return {
        id: uid('audit'), entryId: entry.id, scopeId: entryScope(entry), title: entry.title, kind: entry.kind,
        at, reason, before: '', after: '', evidence: [],
    };
}

export function auditChanges(before, after, reason, at) {
    return Object.keys(diffData(before, after).entries).map(id => {
        const previous = before.entries[id];
        const current = after.entries[id];
        return {
            ...entryAuditRecord(current ?? previous, reason, at),
            before: previous ? limitText(entryText(previous)) : '',
            after: current ? limitText(entryText(current)) : '',
            evidence: clone(current?.evidence ?? []),
        };
    });
}
