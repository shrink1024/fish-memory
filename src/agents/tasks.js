import { clone, invariant, plainText } from '../core/util.js';
import { createEntry, entryText, GLOBAL_SCOPE } from '../core/state.js';
import { initializeRequest, strategyRequest, maintainRequest, selectRequest, compactRequest } from './requests.js';
import { sourceSegments } from './source-segments.js';

// The controller keeps the trace open until task validation finishes. Simple
// standalone clients can still execute the same task without diagnostics.
async function completeTask(client, request, accept) {
    return typeof client.completeValidated === 'function'
        ? client.completeValidated(request, accept) : accept(await client.complete(request));
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

export async function maintain(client, save, messages, signal, scopeId = GLOBAL_SCOPE, observedState = null) {
    return completeTask(client, { ...maintainRequest(save, messages, scopeId, observedState), signal }, result => {
        invariant(Array.isArray(result.operations), '后置维护须返回 operations 操作列表；无变化时返回空数组');
        return result;
    });
}
export async function select(client, save, messages, { eligible = () => true, selectionLimit = 16, selectionChars = 24000, observedState = null, signal } = {}) {
    const request = selectRequest(save, messages, { eligible, selectionLimit, selectionChars, observedState });
    const catalog = request.input.catalog;
    return completeTask(client, { ...request, signal }, result => {
        invariant(Array.isArray(result.ids) && result.ids.length <= selectionLimit, '前置选材数量或格式无效');
        const allowed = new Set(catalog.map(e => e.id));
        invariant(result.ids.every(id => typeof id === 'string' && allowed.has(id)), '前置选择了不允许的资料');
        return [...new Set(result.ids)];
    });
}
export async function compact(client, save, signal, scopeId = GLOBAL_SCOPE) {
    const request = compactRequest(save, scopeId);
    const memory = request.input.memory;
    return completeTask(client, { ...request, signal }, result => {
        invariant(Array.isArray(result.operations) && result.operations.every(op => op && ['summary', 'update', 'mergeEvents'].includes(op.type)), '整理只能更新脉络与给出的历史事件');
        const ids = new Set(memory.entries.map(e => e.id));
        invariant(result.operations.every(op => op.type === 'summary' || (op.type === 'mergeEvents' ? Array.isArray(op.sources) && op.sources.every(source => ids.has(source.id)) : ids.has(op.id))), '整理不得修改当前事实或未提供的条目');
        return clone(result);
    });
}
