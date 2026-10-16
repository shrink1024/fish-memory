import { clone } from '../core/util.js';
import { entryText, scopeSummary, readableScopes, GLOBAL_SCOPE } from '../core/state.js';
import { frontCatalog, maintenanceView, hasProtectedReferences } from '../core/views.js';
import { INITIALIZE, ALIGN_STRATEGY, MAINTAIN, MAINTAIN_REWRITE, SELECT, COMPACT } from './prompts.js';

export const INITIALIZATION_BATCH_ITEMS = 24;
export const isReadableMessage = message => !message.hidden || message.hiddenBy === 'dynamic-world-memory';

/** Story text entering an auxiliary task is archival material, not a live
 * turn addressed to the model. Marking the speaker keeps the projection's
 * provenance explicit so the material is read as a record to file. */
export function sourceRole(role) {
    if (role === 'user') return 'player';
    if (role === 'assistant') return 'character';
    return role === 'system' ? 'narration' : 'material';
}

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
/** Player chose "仅动态世界书": keep the worldbook current, nothing else. */
export const WORLDBOOK_ONLY_NOTE = '本存档使用“仅动态世界书”模式：只用 update 更新已有条目；不要新增条目或晋升人物，不要返回 create、promote、summary、inventory 或 mergeEvents。';
/** Second pass for entries the first pass listed in needEntries. */
export const FOLLOW_UP_NOTE = '补充更新：上一步已处理这批正文，并请求了 memory.entries 中这些条目的全文。本次只用 update 修改其中被本批正文改变的事实；不要返回 appendSummary、summary、create、promote、inventory、mergeEvents 或 needEntries。无需修改时返回空数组。';
export function maintainRequest(save, messages, scopeId = GLOBAL_SCOPE, observedState = null, { focus = null, followUp = false } = {}) {
    const memory = maintenanceView(save, scopeId, { includeProvenance: false, focus });
    const notes = [save.worldbookOnly ? WORLDBOOK_ONLY_NOTE : '', followUp ? FOLLOW_UP_NOTE : ''].filter(Boolean);
    // Keep this projection's private reference capability for task validation;
    // serialized requests and diagnostics contain only the masked plain data.
    return { purpose: 'maintain', system: [save.summaryRewrite ? MAINTAIN_REWRITE : MAINTAIN, ...notes].join('\n'),
        input: { memory, ...referenceInstructions(memory), ...(observedState ? { observedState: clone(observedState) } : {}),
            messages: messages.filter(isReadableMessage).map(({ key, role, content }) => ({ key, role: sourceRole(role), content, source: '存档正文', scopeId })) } };
}
export function selectRequest(save, messages, { eligible = () => true, selectionLimit = 16, selectionChars = 24000, observedState = null } = {}) {
    messages = messages.filter(isReadableMessage);
    const catalog = frontCatalog(save, eligible, save.data.scopeContext, messages.map(m => m.key));
    return clone({ purpose: 'select', system: SELECT,
        input: { strategy: save.data.strategy, summary: [...readableScopes(save.data.scopeContext)].map(scopeId => { const text = scopeSummary(save.data, scopeId); return text ? (scopeId === GLOBAL_SCOPE ? text : `【范围 ${scopeId}】\n${text}`) : ''; }).filter(Boolean).join('\n\n'),
            scopeContext: { activeScopeId: save.data.scopeContext?.activeScopeId ?? GLOBAL_SCOPE, requestedScopeIds: save.data.scopeContext?.requestedScopeIds ?? [] }, selectionLimit, selectionChars, catalog,
            ...(observedState ? { observedState } : {}),
            messages: messages.map(({ key, role, content }) => ({ key, role: sourceRole(role), content, source: '存档正文' })) } });
}
export function compactRequest(save, scopeId = GLOBAL_SCOPE, { summaryOnly = false } = {}) {
    const memory = maintenanceView(save, scopeId);
    delete memory.catalog;
    memory.entries = memory.entries.filter(e => !summaryOnly && e.kind === 'event').map(e => ({ ...e,
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
