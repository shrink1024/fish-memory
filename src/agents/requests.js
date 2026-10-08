import { clone } from '../core/util.js';
import { entryText, scopeSummary, readableScopes, GLOBAL_SCOPE } from '../core/state.js';
import { frontCatalog, maintenanceView } from '../core/views.js';
import { INITIALIZE, ALIGN_STRATEGY, MAINTAIN, SELECT, COMPACT } from './prompts.js';

// Both the executing tasks and read-only previews use these projections. Nothing
// in a save envelope (audit, journal, source baselines) is passed wholesale.
export function initializeRequest(entries, naturalLanguage = '') {
    return clone({ purpose: 'initialize', system: INITIALIZE,
        input: { naturalLanguage, entries: entries.map(e => ({ id: e.id, title: e.title, content: entryText(e), constant: e.constant,
            keywordHints: { primary: e.source?.metadata?.key ?? [], secondary: e.source?.metadata?.keysecondary ?? [] } })) } });
}
export function strategyRequest(strategies, entries, naturalLanguage) {
    const distinct = [...new Set(strategies.filter(Boolean))];
    if (distinct.length <= 1) return null;
    return clone({ purpose: 'strategy', system: ALIGN_STRATEGY,
        input: { naturalLanguage, strategies: distinct, catalog: entries.map(({ id, title, kind, intro }) => ({ id, title, kind, intro })) } });
}
export function maintainRequest(save, messages, scopeId = GLOBAL_SCOPE, observedState = null) {
    return clone({ purpose: 'maintain', system: MAINTAIN,
        input: { memory: maintenanceView(save, scopeId), ...(observedState ? { observedState } : {}),
            messages: messages.map(({ key, role, content }) => ({ key, role, content, scopeId })) } });
}
export function selectRequest(save, messages, { eligible = () => true, selectionLimit = 16, selectionChars = 24000, observedState = null } = {}) {
    const catalog = frontCatalog(save, eligible, save.data.scopeContext, messages.map(m => m.key));
    return clone({ purpose: 'select', system: SELECT,
        input: { strategy: save.data.strategy, summary: [...readableScopes(save.data.scopeContext)].map(scopeId => { const text = scopeSummary(save.data, scopeId); return text ? (scopeId === GLOBAL_SCOPE ? text : `【范围 ${scopeId}】\n${text}`) : ''; }).filter(Boolean).join('\n\n'),
            scopeContext: { activeScopeId: save.data.scopeContext?.activeScopeId ?? GLOBAL_SCOPE, requestedScopeIds: save.data.scopeContext?.requestedScopeIds ?? [] }, selectionLimit, selectionChars, catalog,
            ...(observedState ? { observedState } : {}),
            messages: messages.map(({ key, role, content }) => ({ key, role, content })) } });
}
export function compactRequest(save, scopeId = GLOBAL_SCOPE) {
    const memory = maintenanceView(save, scopeId);
    memory.entries = memory.entries.filter(e => e.kind === 'event').map(e => ({ ...e,
        mergeable: !save.data.entries[e.id].source && save.data.entries[e.id].segments.every(s => s.writable) }));
    return clone({ purpose: 'compact', system: COMPACT, input: { memory } });
}
export function requestBatches(items, maxChars, text = item => item.content) {
    const result = []; let current = [], size = 0;
    for (const item of items) {
        const length = text(item).length;
        if (current.length && size + length > maxChars) { result.push(current); current = []; size = 0; }
        current.push(item); size += length;
    }
    if (current.length) result.push(current);
    return result;
}
export function selectionMessages(snapshot, save, recentTurns) {
    const starts = snapshot.messages.flatMap((m, i) => m.role === 'user' ? [i] : []);
    const start = starts.length > recentTurns ? starts[starts.length - recentTurns] : 0;
    const recent = snapshot.messages.slice(Math.min(start, save.processed.length));
    if (snapshot.userInput) recent.push({ key: 'current-input', role: 'user', content: snapshot.userInput });
    return recent;
}
