import { clone } from '../core/util.js';
import { entryText, scopeSummary, readableScopes, GLOBAL_SCOPE } from '../core/state.js';
import { frontCatalog, maintenanceView, hasProtectedReferences } from '../core/views.js';
import { INITIALIZE, ALIGN_STRATEGY, MAINTAIN, SELECT, COMPACT } from './prompts.js';

export const INITIALIZATION_BATCH_ITEMS = 24;
export const isReadableMessage = message => !message.hidden || message.hiddenBy === 'dynamic-world-memory';

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
function referenceInstructions(memory) {
    return hasProtectedReferences(memory) ? { protectedReferences: '⟦鱼忆引用:…⟧ 是当前字段中已有文字的保留引用。继续使用该文字时原样保留编号；不要猜测内容、新造编号或移到其他字段。事件合并仅能在对应字段中沿用列明来源事件的引用。程序会在校验前还原。' } : {};
}
export function maintainRequest(save, messages, scopeId = GLOBAL_SCOPE, observedState = null) {
    const memory = maintenanceView(save, scopeId, { includeProvenance: false });
    // Keep this projection's private reference capability for task validation;
    // serialized requests and diagnostics contain only the masked plain data.
    return { purpose: 'maintain', system: MAINTAIN,
        input: { memory, ...referenceInstructions(memory), ...(observedState ? { observedState: clone(observedState) } : {}),
            messages: messages.filter(isReadableMessage).map(({ key, role, content }) => ({ key, role, content, scopeId })) } };
}
export function selectRequest(save, messages, { eligible = () => true, selectionLimit = 16, selectionChars = 24000, observedState = null } = {}) {
    messages = messages.filter(isReadableMessage);
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
    return { purpose: 'compact', system: COMPACT, input: { memory, ...referenceInstructions(memory) } };
}
export function requestBatches(items, maxChars, text = item => item.content, maxItems = Infinity) {
    const result = []; let current = [], size = 0;
    for (const item of items) {
        const length = text(item).length;
        if (current.length && (size + length > maxChars || current.length >= maxItems)) { result.push(current); current = []; size = 0; }
        current.push(item); size += length;
    }
    if (current.length) result.push(current);
    return result;
}
export function selectionMessages(snapshot, save, recentTurns) {
    const starts = snapshot.messages.flatMap((m, i) => m.role === 'user' && isReadableMessage(m) ? [i] : []);
    const start = starts.length > recentTurns ? starts[starts.length - recentTurns] : 0;
    const recent = snapshot.messages.slice(Math.min(start, save.processed.length)).filter(isReadableMessage);
    if (snapshot.userInput) recent.push({ key: 'current-input', role: 'user', content: snapshot.userInput });
    return recent;
}
