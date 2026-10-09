import { clone, invariant, uid } from './util.js';
import { entryText, entryScope, scopeSummary, scopeInventory, readableScopes, normalizeScopeId, GLOBAL_SCOPE } from './state.js';

export const PROTECTED_TEXT_MARKER = '[受保护资料]';

// Reference dictionaries stay in this realm; neither model requests nor trace
// exports receive the originals. The exact projection object is the capability.
const protectedReferences = new WeakMap();
const restoredLiteralOperations = new WeakMap();
// Operations that only carry legacy markers already present in their own input.
const legacyMarkerOperations = new WeakMap();
const REFERENCE_PREFIX = '⟦鱼忆引用:';
const referencePattern = () => /⟦鱼忆引用:[^⟧]*(?:⟧|$)/gu;

export function hasProtectedReferences(memory) { return Boolean(protectedReferences.get(memory)?.size); }

function referenceSource(memory, source) {
    if (source[0] === 'summary' || source[0] === 'strategy') return memory[source[0]];
    if (source[0] === 'inventory') return memory.inventory?.[source[1]]?.[source[2]];
    const entry = memory.entries.find(entry => entry.id === source[1]);
    return source[2] === 'segment' ? entry?.segments.find(segment => segment.id === source[3])?.text : entry?.[source[2]];
}
function referenceAllowed(source, operation, path) {
    if (operation.type === 'summary') return path.length === 1 && path[0] === 'text' && source[0] === 'summary';
    if (operation.type === 'inventory') return path.length === 3 && path[0] === 'items' && source[0] === 'inventory'
        && path[1] === source[1] && path[2] === source[2];
    if (operation.type === 'update' && source[0] === 'entry' && operation.id === source[1]) {
        if (path.length === 1) return ['intro', 'retrieveWhen'].includes(path[0]) && source[2] === path[0];
        return path.length === 3 && path[0] === 'segments' && path[2] === 'text' && source[2] === 'segment'
            && operation.segments[path[1]]?.id === source[3];
    }
    if (operation.type === 'mergeEvents' && source[0] === 'entry' && operation.sources?.some(entry => entry.id === source[1])) {
        return path.length === 1 && (path[0] === 'text' ? source[2] === 'segment'
            : ['title', 'intro', 'retrieveWhen'].includes(path[0]) && path[0] === source[2]);
    }
    return false;
}

const markerCount = value => typeof value === 'string' ? value.split(PROTECTED_TEXT_MARKER).length - 1
    : Array.isArray(value) ? value.reduce((n, item) => n + markerCount(item), 0)
    : value && typeof value === 'object' ? Object.values(value).reduce((n, item) => n + markerCount(item), 0) : 0;

/** Earlier versions could save the generic marker. It cannot be decoded, but
 * it must not freeze every later maintenance. Each output field may only carry
 * markers its own input field already had: a summary from the summary, an
 * entry segment/intro/retrieveWhen from the same one, an inventory field from
 * a distinct input item's same field, a merged event from its sources' same
 * kind of field. Copies to other fields, new markers or extra markers fail.
 * Within one batch an entry field may be carried once; summary and inventory
 * operations replace their whole value, so a later one simply supersedes. */
function legacyMarkersAllowed(memory, operation, used) {
    const fields = [];
    const walk = (value, path) => {
        if (typeof value === 'string') { const count = markerCount(value); if (count) fields.push({ path, count }); }
        else if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, index]));
        else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
    };
    walk(operation, []);
    const entry = id => memory.entries.find(item => item.id === id);
    const consume = key => { if (used.has(key)) return false; used.add(key); return true; };
    const sameKind = (sources, path) => {
        const [field] = path;
        if (field === 'text') return sources.reduce((n, source) => n + markerCount(source.segments.map(segment => segment.text)), 0);
        return ['title', 'intro', 'retrieveWhen'].includes(field) ? sources.reduce((n, source) => n + markerCount(source[field]), 0) : 0;
    };
    if (operation.type === 'summary') return fields.every(({ path, count }) => path.length === 1 && path[0] === 'text' && count <= markerCount(memory.summary));
    if (operation.type === 'update') {
        const source = entry(operation.id);
        if (!source || used.has(`entry:${source.id}:merged`)) return false;
        return fields.every(({ path, count }) => {
            if (path.length === 1 && ['intro', 'retrieveWhen'].includes(path[0])) {
                return count <= markerCount(source[path[0]]) && consume(`entry:${source.id}:${path[0]}`);
            }
            if (path.length === 3 && path[0] === 'segments' && path[2] === 'text') {
                const segment = source.segments.find(item => item.id === operation.segments[path[1]]?.id);
                return Boolean(segment) && count <= markerCount(segment.text) && consume(`entry:${source.id}:segment:${segment.id}`);
            }
            return false;
        });
    }
    if (operation.type === 'inventory') {
        // Items may be reordered or removed. Match each marked output field to a
        // distinct input item's same field holding at least as many markers.
        const items = memory.inventory ?? [];
        return ['name', 'description'].every(kind => {
            const output = fields.filter(({ path }) => path[0] === 'items' && path[2] === kind).map(({ count }) => count).sort((a, b) => b - a);
            const input = items.map(item => markerCount(item?.[kind])).filter(Boolean).sort((a, b) => b - a);
            return output.every((count, index) => count <= (input[index] ?? 0));
        }) && fields.every(({ path }) => path.length === 3 && path[0] === 'items' && ['name', 'description'].includes(path[2]));
    }
    if (operation.type === 'mergeEvents') {
        const sources = (operation.sources ?? []).map(item => entry(item?.id)).filter(Boolean);
        if (!sources.length || !fields.every(({ path, count }) => path.length === 1 && count <= sameKind(sources, path))) return false;
        // Merged sources are removed; the same source must not also be carried
        // forward by another operation in this batch.
        return sources.every(source => consume(`entry:${source.id}:merged`) && !source.segments.some(segment => used.has(`entry:${source.id}:segment:${segment.id}`))
            && !['intro', 'retrieveWhen', 'title'].some(field => used.has(`entry:${source.id}:${field}`)));
    }
    return false;
}

export function restoreProtectedReferences(result, memory) {
    const references = protectedReferences.get(memory);
    const restored = clone(result);
    const usedLegacyFields = new Set();
    for (const operation of restored.operations ?? []) {
        const visit = (value, path = []) => {
            if (typeof value === 'string') return value.replace(referencePattern(), token => {
                const reference = references?.get(token);
                invariant(reference, '结果含未知或过期的受保护引用，请仅保留本次输入中的引用编号');
                invariant(referenceSource(memory, reference.source)?.includes(token), '结果使用了本批未提供来源的受保护引用');
                invariant(referenceAllowed(reference.source, operation, path), '受保护引用不能移到其他字段或未提供的来源范围');
                return reference.text;
            });
            if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, index]));
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]));
            return value;
        };
        const decoded = visit(operation);
        Object.assign(operation, decoded);
        // A story may literally contain our reserved syntax. It was itself
        // escaped before generation, so only this exact validated operation may
        // persist the restored literal; arbitrary unexpanded references fail.
        if (JSON.stringify(operation).includes(REFERENCE_PREFIX)) restoredLiteralOperations.set(operation, JSON.stringify(operation));
        const markers = markerCount(operation);
        if (markers && legacyMarkersAllowed(memory, operation, usedLegacyFields)) legacyMarkerOperations.set(operation, JSON.stringify(operation));
    }
    return restored;
}

export function assertNoPendingProtectedReferences(operation) {
    const serialized = JSON.stringify(operation);
    if (serialized.includes(PROTECTED_TEXT_MARKER) && legacyMarkerOperations.get(operation) !== serialized) throw Object.assign(new Error(
        '结果含旧版受保护资料占位符，无法确定原文；请先手动纠正对应记忆，原记忆保留'), { dwmResponseInvalid: false });
    invariant(!serialized.includes(REFERENCE_PREFIX) || restoredLiteralOperations.get(operation) === serialized,
        '结果含未还原的受保护引用，原记忆保留');
}

// Explicit projections: never pass the save envelope or journal to an agent.
export function frontCatalog(save, eligible = () => true, context = save.data.scopeContext, recentKeys = []) {
    const scopes = readableScopes(context);
    const recent = new Set(recentKeys);
    return Object.values(save.data.entries).filter(e => e.enabled && scopes.has(entryScope(e)) && eligible(e)).map(e => ({
        id: e.id, scopeId: entryScope(e), title: e.title, kind: e.kind, intro: e.intro,
        retrieveWhen: e.retrieveWhen, constant: e.constant || e.important,
        contentChars: entryText(e).length,
        recentEvidenceCount: (e.evidence ?? []).filter(key => recent.has(key)).length,
    }));
}
export function frontRead(save, ids, eligible = () => true, context = save.data.scopeContext) {
    const scopes = readableScopes(context);
    return [...new Set(ids)].map(id => {
        const e = save.data.entries[id];
        invariant(e?.enabled && scopes.has(entryScope(e)) && eligible(e), `本轮不可读取条目：${id}`);
        return { id, scopeId: entryScope(e), title: e.title, kind: e.kind, content: entryText(e) };
    });
}
export function maintenanceView(save, scopeId = GLOBAL_SCOPE, { includeProvenance = true } = {}) {
    scopeId = normalizeScopeId(scopeId);
    const protectedBodies = Object.values(save.data.entries)
        .flatMap(e => e.segments.filter(s => !e.enabled || !s.writable).map(s => s.text))
        // A separator or one-character stub is not a distinctive quotation.
        // Replacing it everywhere corrupts otherwise unrelated narrative text.
        .filter(body => typeof body === 'string' && (body.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 4)
        .sort((a, b) => b.length - a.length);
    const view = {
        scopeId, strategy: save.data.strategy, summary: scopeSummary(save.data, scopeId),
        entries: Object.values(save.data.entries)
            .filter(e => e.enabled && entryScope(e) === scopeId && e.segments.some(s => s.writable))
            .map(e => ({ id: e.id, scopeId: entryScope(e), title: e.title, kind: e.kind,
                // A mixed entry's introduction may quote a protected segment.
                intro: e.segments.every(s => s.writable) ? e.intro : '',
                retrieveWhen: e.segments.every(s => s.writable) ? e.retrieveWhen : '',
                version: e.version, important: e.important,
                segments: e.segments.filter(s => s.writable).map(s => ({ id: s.id, text: s.text })),
                ...(includeProvenance ? { evidence: clone(e.evidence), lastEvidence: clone(e.lastEvidence ?? e.evidence),
                    evidenceTrimmed: Boolean(e.evidenceTrimmed), lineage: clone(e.lineage ?? []) } : {}) })),
        ...(save.data.inventoryEnabled ? { inventory: clone(scopeInventory(save.data, scopeId)) } : {}),
    };
    // Keep references reversible only for text already present in this writable
    // projection. Never include a protected segment's body in the dictionary on
    // the wire, and never make a later replacement rescan an inserted marker.
    const references = new Map(), original = JSON.stringify(view);
    let namespace = uid('r');
    while (original.includes(`${REFERENCE_PREFIX}${namespace}:`)) namespace += '-new';
    const bodies = [...new Set(protectedBodies)];
    const scrub = (text, source) => {
        let cursor = 0, output = '';
        const literals = referencePattern();
        while (cursor < text.length) {
            literals.lastIndex = cursor;
            const literal = literals.exec(text);
            let at = literal?.index ?? -1, found = literal?.[0] ?? '';
            // Do not compile entire large worldbooks into one enormous RegExp.
            // Find the earliest match, preferring the longest at the same point.
            for (const body of bodies) {
                const index = text.indexOf(body, cursor);
                if (index >= 0 && (at < 0 || index < at || (index === at && body.length > found.length))) {
                    at = index; found = body;
                }
            }
            if (at < 0) break;
            const token = `${REFERENCE_PREFIX}${namespace}:${references.size + 1}⟧`;
            references.set(token, { text: found, source });
            output += text.slice(cursor, at) + token;
            cursor = at + found.length;
        }
        return output + text.slice(cursor);
    };
    view.strategy = scrub(view.strategy, ['strategy']); view.summary = scrub(view.summary, ['summary']);
    for (const entry of view.entries) {
        for (const key of ['title', 'intro', 'retrieveWhen']) entry[key] = scrub(entry[key], ['entry', entry.id, key]);
        for (const segment of entry.segments) segment.text = scrub(segment.text, ['entry', entry.id, 'segment', segment.id]);
    }
    if (view.inventory) view.inventory = view.inventory.map((item, index) => ({
        name: scrub(item.name, ['inventory', index, 'name']), description: scrub(item.description, ['inventory', index, 'description']) }));
    protectedReferences.set(view, references);
    return view;
}

export function memoryMetrics(save) {
    if (!save) return { entryChars: 0, catalogChars: 0, eventChars: 0, summaryChars: 0 };
    const entries = Object.values(save.data.entries);
    return { entryChars: entries.reduce((sum, e) => sum + entryText(e).length, 0),
        catalogChars: JSON.stringify(frontCatalog(save)).length,
        eventChars: entries.filter(e => e.enabled && e.kind === 'event').reduce((sum, e) => sum + entryText(e).length, 0),
        summaryChars: save.data.summary.length + Object.values(save.data.scopeSummaries ?? {}).reduce((sum, text) => sum + text.length, 0) };
}
export function playerView(save) {
    return clone({ id: save.id, revision: save.revision, initialized: save.initialized,
        bookName: save.bookName, preferences: save.preferences ?? {}, data: save.data, processedCount: save.processed.length,
        inventoryNeedsCatchUp: save.inventoryDisabledAt !== null, audit: save.audit });
}

// Card-facing projection intentionally has no source baselines, audit, journal or rules.
export function scopeRead(save, scopeId) {
    const view = maintenanceView(save, normalizeScopeId(scopeId));
    const result = { scopeId: view.scopeId, summary: view.summary, entries: view.entries,
        ...(view.inventory && save.inventoryDisabledAt === null ? { inventory: view.inventory } : {}) };
    return result;
}
