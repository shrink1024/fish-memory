import { summaryThreshold } from '../core/summary-edits.js';
import { encodeMaintenanceEvidence } from './evidence-codec.js';
import { serializeAgentInput } from './client.js';
import { activeRemovals, titleKey } from '../core/entry-changes.js';
import { clone } from '../core/util.js';
import { encodeSelectionInput } from './selection-codec.js';
import { entryText, scopeSummary, readableScopes, canCompactEntry, GLOBAL_SCOPE } from '../core/state.js';
import { frontCatalog, maintenanceView, hasProtectedReferences } from '../core/views.js';
import { INITIALIZE, ALIGN_STRATEGY, MAINTAIN, MAINTAIN_REWRITE, SELECT, COMPACT } from './prompts.js';

export const INITIALIZATION_BATCH_ITEMS = 24;
export const isReadableMessage = message => !message.regexSkipped && (!message.hidden || message.hiddenBy === 'dynamic-world-memory');

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
/** The author's native timers, as a hint only: fish no longer runs them, the
 * initialization agent turns their intent into retrieveWhen. */
function nativeTiming(metadata) {
    const timing = Object.fromEntries(['sticky', 'cooldown', 'delay'].map(key => [key, Number(metadata?.[key])]).filter(([, value]) => Number.isFinite(value) && value > 0));
    return Object.keys(timing).length ? { nativeTiming: timing } : {};
}
export function initializeRequest(entries, naturalLanguage = '') {
    return clone({ purpose: 'initialize', system: INITIALIZE,
        input: { naturalLanguage, entries: entries.map(e => ({ id: e.id, title: e.title, content: entryText(e), constant: e.constant,
            keywordHints: { primary: e.source?.metadata?.key ?? [], secondary: e.source?.metadata?.keysecondary ?? [] },
            ...nativeTiming(e.source?.metadata) })) } });
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
export const KNOWN_NAMES_CHARS = 4000;
function compactKnownNames(memory,messages,needed){
    const known=memory.knownCharacters??[];delete memory.knownCharacters;
    if(!needed)return;
    const listed=new Set([...(memory.entries??[]),...(memory.catalog??[])].map(e=>titleKey(e.title)));
    const candidates=new Map();for(const {title} of known){const key=titleKey(title);if(key&&!listed.has(key)&&!candidates.has(key))candidates.set(key,title);}
    if(!candidates.size)return;
    const text=titleKey(messages.map(m=>m.content??'').join('\n'));
    const ordered=[...candidates].sort(([a],[b])=>Number(text.includes(b))-Number(text.includes(a)));
    const supplement={knownNames:[],knownNamesTruncated:true};let chars=JSON.stringify(supplement).length;
    for(const [,name] of ordered){const size=serializeAgentInput(name).length+(supplement.knownNames.length?1:0);if(chars+size>KNOWN_NAMES_CHARS)continue;supplement.knownNames.push(name);chars+=size;}
    if(supplement.knownNames.length===candidates.size)delete supplement.knownNamesTruncated;
    Object.assign(memory,supplement);
}
export function maintainRequest(save, messages, scopeId = GLOBAL_SCOPE, observedState = null, { focus = null, followUp = false } = {}) {
    const memory = maintenanceView(save, scopeId, { includeProvenance: false, focus });
    compactKnownNames(memory,messages.filter(isReadableMessage),!followUp&&!save.worldbookOnly);
    const removed = activeRemovals(save).filter(e=>e.scopeId===scopeId);
    if (removed.length) memory.removedEntries = removed.map(({id,title,kind})=>({id,title,kind}));
    const edited = save.journal?.some(commit => commit.summaryEdit?.scopeId === scopeId);
    const notes = [edited && !save.worldbookOnly && !followUp ? '当前范围的脉络经过玩家编辑。以当前正文为准。只加入本批确实新发生的事情，不从条目、旧引文或其他资料补回被删掉的旧经历。' : '', save.worldbookOnly ? WORLDBOOK_ONLY_NOTE : '', followUp ? FOLLOW_UP_NOTE : ''].filter(Boolean);
    // Keep this projection's private reference capability for task validation;
    // serialized requests and diagnostics contain only the masked plain data.
    return { purpose: 'maintain', system: [save.summaryRewrite ? MAINTAIN_REWRITE : MAINTAIN, ...notes].join('\n'),
        input: encodeMaintenanceEvidence({ memory, ...referenceInstructions(memory), ...(observedState ? { observedState: clone(observedState) } : {}),
            messages: messages.filter(isReadableMessage).map(({ key, role, content }) => ({ key, role: sourceRole(role), content, source: '存档正文', scopeId })) }) };
}
export function selectRequest(save, messages, { eligible = () => true, selectionLimit = 16, selectionChars = 24000, observedState = null, forced = [], authorGuidance = '', messageCount = null } = {}) {
    messages = messages.filter(isReadableMessage);
    // Entries the program already sends this turn (author triggers) count as constant.
    const catalog = frontCatalog(save, eligible, save.data.scopeContext, messages.map(m => m.key)).map(e => forced.includes(e.id) ? { ...e, constant: true } : e);
    return { purpose: 'select', system: SELECT,
        input: encodeSelectionInput({ strategy: save.data.strategy, summary: [...readableScopes(save.data.scopeContext)].map(scopeId => { const text = scopeSummary(save.data, scopeId); return text ? (scopeId === GLOBAL_SCOPE ? text : `【范围 ${scopeId}】\n${text}`) : ''; }).filter(Boolean).join('\n\n'),
            scopeContext: { activeScopeId: save.data.scopeContext?.activeScopeId ?? GLOBAL_SCOPE, requestedScopeIds: save.data.scopeContext?.requestedScopeIds ?? [] }, selectionLimit, selectionChars, catalog,
            ...(observedState ? { observedState } : {}), ...(authorGuidance ? { authorGuidance } : {}),
            ...(Number.isInteger(messageCount) ? { progress: { messageCount } } : {}),
            messages: messages.map(({ key, role, content }) => ({ key, role: sourceRole(role), content, source: '存档正文' })) }, Object.keys(save.data.entries)) };
}
export function compactRequest(save, scopeId = GLOBAL_SCOPE, { summaryOnly = false, summaryLength } = {}) {
    const memory = maintenanceView(save, scopeId);
    delete memory.catalog;
    delete memory.knownCharacters;
    memory.sourceTargets=summaryOnly?[]:memory.entries.filter(e=>save.data.entries[e.id].source&&e.kind!=='rule'
        && !/<%|@@/.test(save.data.entries[e.id].source.original??'')).map(e=>({id:e.id,title:save.data.entries[e.id].title,kind:e.kind,version:e.version,
            intro:e.intro.includes('⟦鱼忆引用:')?'':e.intro.slice(0,160),...(e.intro.length>160||e.intro.includes('⟦鱼忆引用:')?{introIncomplete:true}:{}),
            matchNames:[save.data.entries[e.id].title,...(save.data.entries[e.id].identityNames??[]),...(Array.isArray(save.data.entries[e.id].source.metadata?.key)?save.data.entries[e.id].source.metadata.key:[])].filter(v=>typeof v==='string'&&v.trim())}));
    memory.entries = memory.entries.filter(e => !summaryOnly && canCompactEntry(save.data.entries[e.id])).map(e => ({ ...e, mergeable: true }));
    const threshold = summaryThreshold(summaryLength);
    const summaryTarget = summaryLength && scopeSummary(save.data,scopeId).length >= threshold ? Math.floor(threshold * 0.6) : null;
    return { purpose: 'compact', ...(summaryTarget ? {summaryTarget} : {}), system: COMPACT, input: { memory, ...referenceInstructions(memory) } };
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
/** The reference window limits already-maintained history only. All readable
 * pending story remains in selection until committed, including long backlogs. */
export function selectionMessages(snapshot, save, recentTurns) {
    const starts = snapshot.messages.flatMap((m, i) => m.role === 'user' && isReadableMessage(m) ? [i] : []);
    const start = starts.length > recentTurns ? starts[starts.length - recentTurns] : 0;
    const recent = snapshot.messages.slice(Math.min(start, save.processed.length)).filter(isReadableMessage);
    if (snapshot.userInput) recent.push({ key: 'current-input', role: 'user', content: snapshot.userInput });
    return recent;
}
