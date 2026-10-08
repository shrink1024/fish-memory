import { clone, invariant } from './util.js';
import { entryText, entryScope, scopeSummary, scopeInventory, readableScopes, normalizeScopeId, GLOBAL_SCOPE } from './state.js';

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
export function maintenanceView(save, scopeId = GLOBAL_SCOPE) {
    scopeId = normalizeScopeId(scopeId);
    const protectedBodies = Object.values(save.data.entries)
        .flatMap(e => e.segments.filter(s => !s.writable).map(s => s.text))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    let strategy = save.data.strategy;
    for (const body of protectedBodies) strategy = strategy.replaceAll(body, '[受保护资料]');
    const view = {
        scopeId, strategy, summary: scopeSummary(save.data, scopeId),
        entries: Object.values(save.data.entries)
            .filter(e => e.enabled && entryScope(e) === scopeId && e.segments.some(s => s.writable))
            .map(e => ({ id: e.id, scopeId: entryScope(e), title: e.title, kind: e.kind,
                // A mixed entry's introduction may quote a protected segment.
                intro: e.segments.every(s => s.writable) ? e.intro : '',
                retrieveWhen: e.segments.every(s => s.writable) ? e.retrieveWhen : '',
                version: e.version, important: e.important,
                segments: e.segments.filter(s => s.writable).map(s => ({ id: s.id, text: s.text })),
                evidence: clone(e.evidence), lastEvidence: clone(e.lastEvidence ?? e.evidence),
                evidenceTrimmed: Boolean(e.evidenceTrimmed), lineage: clone(e.lineage ?? []) })),
        ...(save.data.inventoryEnabled ? { inventory: clone(scopeInventory(save.data, scopeId)) } : {}),
    };
    // A previous summary or writable entry can contain verbatim protected text.
    // Scrub the whole projection, not only the strategy or mixed introduction.
    const scrub = text => protectedBodies.reduce((value, body) => value.replaceAll(body, '[受保护资料]'), text);
    view.strategy = scrub(view.strategy); view.summary = scrub(view.summary);
    for (const entry of view.entries) {
        for (const key of ['title', 'intro', 'retrieveWhen']) entry[key] = scrub(entry[key]);
        for (const segment of entry.segments) segment.text = scrub(segment.text);
    }
    if (view.inventory) view.inventory = view.inventory.map(item => ({ name: scrub(item.name), description: scrub(item.description) }));
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
