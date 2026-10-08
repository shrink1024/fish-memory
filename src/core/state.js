import { clone, invariant, plainText, uid } from './util.js';

// Development format v2 stores one story path and compact journal anchors.
export const SCHEMA_VERSION = 2;
export const KINDS = ['fact', 'rule', 'npc', 'npc_pool', 'event', 'inventory'];
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    inventoryEnabled: true,
    windowEnabled: true,
    recentTurns: 12,
    batchChars: 18000,
    timeoutMs: 90000,
    auditLimit: 100,
    compactEvery: 20,
    selectionLimit: 16,
    selectionChars: 24000,
    compactChars: 48000,
    mvuEnabled: false,
    mvuFields: [],
    mvuBookName: null,
});

export const GLOBAL_SCOPE = 'global';
export function normalizeScopeId(value = GLOBAL_SCOPE) {
    invariant(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value)
        && !['constructor', 'prototype', '__proto__'].includes(value), '资料范围 scopeId 无效');
    return value;
}
export function entryScope(entry) { return normalizeScopeId(entry.scopeId); }
export function scopeSummary(data, scopeId = GLOBAL_SCOPE) {
    return scopeId === GLOBAL_SCOPE ? data.summary : (data.scopeSummaries?.[normalizeScopeId(scopeId)] ?? '');
}
export function scopeInventory(data, scopeId = GLOBAL_SCOPE) {
    return scopeId === GLOBAL_SCOPE ? data.inventory : (data.scopeInventories?.[normalizeScopeId(scopeId)] ?? []);
}
export function readableScopes(context) {
    return new Set([GLOBAL_SCOPE, normalizeScopeId(context?.activeScopeId), ...(context?.requestedScopeIds ?? []).map(normalizeScopeId)]);
}
export function sourceId(book, id) { return `source:${encodeURIComponent(book)}:${id}`; }
export function entryText(entry) { return entry.segments.map(s => s.text).join(''); }
export function createEntry(input) {
    invariant(input && typeof input === 'object', '条目不能为空');
    const entry = {
        id: input.id ?? uid('entry'),
        scopeId: normalizeScopeId(input.scopeId),
        title: plainText(input.title ?? '', '条目名称', 500),
        kind: input.kind ?? 'fact',
        intro: plainText(input.intro ?? '', '简介', 2000),
        retrieveWhen: plainText(input.retrieveWhen ?? '', '提取指导', 4000),
        constant: Boolean(input.constant),
        enabled: input.enabled !== false,
        important: Boolean(input.important),
        segments: clone(input.segments ?? [{ id: 'body', text: input.text ?? '', writable: input.kind !== 'rule' }]),
        source: input.source ? clone(input.source) : null,
        evidence: clone(input.evidence ?? []),
        lastEvidence: clone(input.lastEvidence ?? input.evidence ?? []),
        evidenceTrimmed: Boolean(input.evidenceTrimmed),
        lineage: clone(input.lineage ?? []),
        version: input.version ?? 1,
        status: input.status ?? 'confirmed',
        needsReview: Boolean(input.needsReview),
    };
    invariant(KINDS.includes(entry.kind), `未知条目类型：${entry.kind}`);
    invariant(typeof entry.id === 'string' && entry.id.length < 1000, '无效条目身份');
    invariant(Array.isArray(entry.segments) && entry.segments.length > 0 && entry.segments.length <= 100, '条目必须包含 1–100 个片段');
    invariant(Array.isArray(entry.lineage) && entry.lineage.length <= 10000
        && entry.lineage.every(id => typeof id === 'string' && id.length > 0 && id.length < 1000)
        && new Set(entry.lineage).size === entry.lineage.length, '事件来源链无效');
    const ids = new Set();
    for (const segment of entry.segments) {
        invariant(typeof segment.id === 'string' && !ids.has(segment.id), '片段身份缺失或重复');
        ids.add(segment.id);
        plainText(segment.text, '片段正文');
        invariant(typeof segment.writable === 'boolean', '片段须有明确写权限');
        if (entry.kind === 'rule') segment.writable = false;
    }
    return entry;
}

export function createSave(chatId, bookName) {
    const data = { entries: {}, summary: '', strategy: '', inventory: [], inventoryEnabled: true,
        scopeSummaries: {}, scopeInventories: {}, scopeContext: null, messageScopes: {} };
    return {
        schema: SCHEMA_VERSION, id: uid('save'), chatId, bookName,
        revision: 0, initialized: false, preferences: { enabled: true }, base: clone(data), data,
        processed: [], storyKeys: [], journal: [], audit: [], inventoryDisabledAt: null,
        parentId: null, createdAt: new Date().toISOString(),
    };
}

export function validateSave(save) {
    invariant(save?.schema === SCHEMA_VERSION, '不支持的存档格式，请勿覆盖现有数据');
    invariant(typeof save.id === 'string' && Number.isInteger(save.revision), '存档身份无效');
    invariant(Array.isArray(save.processed) && Array.isArray(save.storyKeys) && Array.isArray(save.journal) && Array.isArray(save.audit), '存档进度无效');
    invariant(save.processed.length <= save.storyKeys.length && save.processed.every((key, i) => key === save.storyKeys[i]), '已处理进度与剧情路径不符');
    for (const commit of save.journal) {
        invariant(Number.isInteger(commit.anchorLength) && commit.anchorLength >= 0 && commit.anchorLength <= save.storyKeys.length, '提交锚点无效');
        invariant(commit.endKey === (commit.anchorLength ? save.storyKeys[commit.anchorLength - 1] : null), '提交末端与剧情路径不符');
        invariant(commit.inventoryDisabledAt === null || Number.isInteger(commit.inventoryDisabledAt), '物品停用进度无效');
    }
    for (const [scopeId, summary] of Object.entries(save.data.scopeSummaries ?? {})) { normalizeScopeId(scopeId); plainText(summary, '范围脉络'); }
    for (const [scopeId, items] of Object.entries(save.data.scopeInventories ?? {})) { normalizeScopeId(scopeId); invariant(Array.isArray(items), '范围物品无效'); }
    for (const scopeId of Object.values(save.data.messageScopes ?? {})) normalizeScopeId(scopeId);
    if (save.data.scopeContext) {
        normalizeScopeId(save.data.scopeContext.activeScopeId);
        invariant(typeof save.data.scopeContext.owner === 'string' && Array.isArray(save.data.scopeContext.requestedScopeIds), '范围上下文无效');
        save.data.scopeContext.requestedScopeIds.forEach(normalizeScopeId);
    }
    for (const entry of Object.values(save.data.entries)) {
        createEntry(entry);
        invariant(entry.kind !== 'rule' || entry.segments.every(segment => segment.writable === false), '规则条目不可写');
        if (entry.source?.baselineSegments) {
            invariant(Array.isArray(entry.source.baselineSegments)
                && entry.source.baselineSegments.every(segment => typeof segment.text === 'string' && typeof segment.writable === 'boolean')
                && entry.source.baselineSegments.map(segment => segment.text).join('') === entry.source.original,
            '原书分类基准无效');
        }
    }
    return save;
}

export function makeSourceEntry(book, raw) {
    return createEntry({
        id: sourceId(book, raw.uid), title: raw.comment || `条目 ${raw.uid}`,
        text: raw.content ?? '', enabled: !raw.disable, constant: raw.constant,
        source: { book, uid: raw.uid, original: raw.content ?? '', metadata: clone(raw) },
        // Initialization must classify before this entry can be maintained.
        segments: [{ id: 'body', text: raw.content ?? '', writable: false }],
        needsReview: true,
    });
}

export function assertOriginalPreserved(before, after) {
    for (const [id, entry] of Object.entries(before.entries)) {
        if (entry.source) invariant(JSON.stringify(entry.source) === JSON.stringify(after.entries[id]?.source), '维护不能修改原书基准');
    }
}
