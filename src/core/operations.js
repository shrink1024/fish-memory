import { clone, invariant, plainText, uid, limitText } from './util.js';
import { assertNoPendingProtectedReferences } from './views.js';
import { createEntry, assertOriginalPreserved, entryText, entryScope, normalizeScopeId, GLOBAL_SCOPE } from './state.js';

// Navigation sources, not a claim that every retained fact is supported by every
// source. Keep both the early origin and recent changes without endless growth.
function retainEvidence(entry, current, inherited = []) {
    const all = [...new Set([...(entry.evidence ?? []), ...inherited, ...current])];
    entry.lastEvidence = current;
    entry.evidenceTrimmed = Boolean(entry.evidenceTrimmed || all.length > 256);
    entry.evidence = all.length > 256 ? [...all.slice(0, 32), ...all.slice(-224)] : all;
}

export function applyMaintenance(data, result, { allowedEvidence = [], maxChars = {}, idFactory = uid, scopeId = GLOBAL_SCOPE } = {}) {
    invariant(result && Array.isArray(result.operations) && result.operations.length <= 100, '后置结果必须包含有效 operations');
    scopeId = normalizeScopeId(scopeId);
    const next = clone(data);
    const touched = new Set();
    const evidence = value => {
        invariant(Array.isArray(value) && value.every(k => allowedEvidence.includes(k)), '修改依据必须来自本批输入正文');
        return [...new Set(value)];
    };
    for (const op of result.operations) {
        invariant(op && typeof op === 'object', '无效维护操作');
        assertNoPendingProtectedReferences(op);
        invariant(op.scopeId === undefined || op.scopeId === scopeId, '后置不得改变本批资料归属');
        if (op.type === 'summary') {
            const text = plainText(op.text, '常驻脉络', maxChars.summary ?? 20000);
            if (scopeId === GLOBAL_SCOPE) next.summary = text;
            else (next.scopeSummaries ??= {})[scopeId] = text;
            touched.add('$summary');
        } else if (op.type === 'inventory') {
            invariant(next.inventoryEnabled, '物品清单已关闭，禁止继续维护');
            invariant(Array.isArray(op.items) && op.items.length <= 200, '物品清单无效');
            const items = op.items.map(item => ({ name: plainText(item.name, '物品名称', 300), description: plainText(item.description, '物品简介', 3000) }));
            if (scopeId === GLOBAL_SCOPE) next.inventory = items;
            else (next.scopeInventories ??= {})[scopeId] = items;
            touched.add('$inventory');
        } else if (op.type === 'create') {
            invariant(['fact', 'npc', 'npc_pool', 'event'].includes(op.kind), '后置不能创建规则或其他专用条目');
            invariant(op.evidence?.length > 0, '新建资料需要剧情依据');
            const entry = createEntry({ id: idFactory('entry'), scopeId, title: op.title, kind: op.kind,
                text: op.text, intro: op.intro, retrieveWhen: op.retrieveWhen,
                important: Boolean(op.important && op.kind === 'npc'), evidence: evidence(op.evidence) });
            next.entries[entry.id] = entry;
            touched.add(entry.id);
        } else if (op.type === 'update') {
            const e = next.entries[op.id];
            invariant(e && entryScope(e) === scopeId, '后置不能跨范围修改资料');
            invariant(e?.enabled && e.segments.some(s => s.writable), '后置不能读写锁定或禁用条目');
            invariant(op.expectedVersion === e.version, '条目已变化，请重新维护');
            invariant(op.evidence?.length > 0, '更新事实需要剧情依据');
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
            e.important = true;
            retainEvidence(e, evidence(op.evidence));
            e.version++;
            touched.add(e.id);
        } else if (op.type === 'mergeEvents') {
            invariant(Array.isArray(op.sources) && op.sources.length >= 2 && op.sources.length <= 100,
                '事件整合至少需要两个已有条目');
            const ids = op.sources.map(source => source?.id);
            invariant(ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length,
                '事件整合来源不能重复');
            invariant(op.targetId === undefined || ids.includes(op.targetId), '整合目标必须属于来源事件');
            const sources = op.sources.map(source => {
                const current = next.entries[source.id];
                invariant(current && entryScope(current) === scopeId, '事件整合不能跨资料范围');
                invariant(current?.kind === 'event' && !current.source && current.enabled
                    && current.segments.every(segment => segment.writable), '只能整合可维护的自建事件');
                invariant(source.expectedVersion === current.version, '事件版本已变化，请重新整理');
                return current;
            });
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
                id, scopeId, title, kind: 'event', intro, retrieveWhen, text,
                evidence: mergedEvidence, lineage,
                version: target ? target.version + 1 : 1,
                enabled: true,
            });
            merged.evidenceTrimmed = sources.some(source => source.evidenceTrimmed);
            retainEvidence(merged, cited);
            for (const source of sources) { delete next.entries[source.id]; touched.add(source.id); }
            next.entries[id] = merged; touched.add(id);
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
    return { next, touched: [...touched] };
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
export function auditChanges(before, after, reason, at) {
    return Object.keys(diffData(before, after).entries).map(id => ({
        id: uid('audit'), entryId: id, scopeId: entryScope(after.entries[id] ?? before.entries[id]), at, reason,
        before: limitText(before.entries[id] ? entryText(before.entries[id]) : ''),
        after: limitText(after.entries[id] ? entryText(after.entries[id]) : ''),
        evidence: clone(after.entries[id]?.evidence ?? []),
    }));
}
