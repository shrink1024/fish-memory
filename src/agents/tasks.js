import { invariant, plainText } from '../core/util.js';
import { createEntry, entryText, GLOBAL_SCOPE } from '../core/state.js';
import { initializeRequest, strategyRequest, maintainRequest, selectRequest, compactRequest } from './requests.js';
import { sourceSegments } from './source-segments.js';
import { restoreProtectedReferences } from '../core/views.js';
import { SOURCE_MERGE } from './prompts.js';

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

export async function classifyEntries(client, entries, naturalLanguage = '', signal) {
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
                    important: item.important, needsReview: item.needsReview || rebuilt.needsReview, segments: rebuilt.segments });
                invariant(entryText(next) === entryText(source), '初始化分类不得改写原文');
                return next;
            }),
        };
    });
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
        const restored = restoreProtectedReferences(kept, request.input.memory);
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
    const catalog = request.input.catalog;
    return completeTask(client, { ...request, signal }, result => {
        invariant(Array.isArray(result.ids), '前置选材格式无效，ids 须为列表');
        const allowed = new Map(catalog.map(e => [e.id, e]));
        invariant(result.ids.every(id => typeof id === 'string' && allowed.has(id)), '前置选择了目录中不允许的资料，请仅使用本批目录原 id');
        const ids = [...new Set(result.ids)];
        invariant(ids.filter(id => !allowed.get(id).constant).length <= selectionLimit, '前置选材数量超过按需名额，请保留本轮最相关的资料');
        return ids;
    });
}
export async function compact(client, save, signal, scopeId = GLOBAL_SCOPE, { summaryOnly = false } = {}) {
    const request = compactRequest(save, scopeId, { summaryOnly });
    const memory = request.input.memory;
    return completeTask(client, { ...request, signal }, result => {
        invariant(Array.isArray(result.operations) && result.operations.every(op => op && ['summary', 'update', 'mergeEvents'].includes(op.type)), '整理只能更新脉络与给出的历史事件');
        const ids = new Set(memory.entries.map(e => e.id));
        invariant(result.operations.every(op => op.type === 'summary' || (op.type === 'mergeEvents' ? Array.isArray(op.sources) && op.sources.every(source => ids.has(source.id)) : ids.has(op.id))), '整理不得修改当前事实或未提供的条目');
        return restoreProtectedReferences(result, memory);
    });
}

/** Author changed source entries that this save had already rewritten from the
 * story. The model merges each one; protected segments stay the new source. */
export async function mergeSourceUpdates(client, items, signal) {
    const input = { entries: items.map(({ id, title, oldSource, next, current }) => ({ id, title, oldSource, current,
        newSource: next.segments.filter(segment => segment.writable).map(segment => ({ id: segment.id, writable: segment.writable, text: segment.text })) })) };
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
            const segments = next.segments.map(segment => segment.writable ? { ...segment, text: plainText(texts.get(segment.id), '合并片段', 200000) } : segment);
            return { id, segments, note: typeof item.note === 'string' ? item.note.slice(0, 500) : '' };
        });
    });
}
