import { clone, invariant, plainText } from '../core/util.js';
import { createEntry, entryText, GLOBAL_SCOPE } from '../core/state.js';
import { initializeRequest, strategyRequest, maintainRequest, selectRequest, compactRequest } from './requests.js';

export async function classifyEntries(client, entries, naturalLanguage = '', signal) {
    const result = await client.complete({ ...initializeRequest(entries, naturalLanguage), signal });
    invariant(Array.isArray(result.entries) && result.entries.length === entries.length, '初始化没有完整覆盖本批条目');
    const outputs = new Map(result.entries.map(e => [e.id, e]));
    invariant(outputs.size === entries.length, '初始化返回了重复条目');
    return {
        strategy: result.strategy ?? '',
        entries: entries.map(source => {
            const item = outputs.get(source.id);
            invariant(item, `初始化漏掉了条目 ${source.title}`);
            const next = createEntry({ ...source, kind: item.kind, intro: item.intro, retrieveWhen: item.retrieveWhen,
                important: item.important, needsReview: item.needsReview, segments: item.segments });
            invariant(entryText(next) === entryText(source), '初始化分类不得改写原文');
            return next;
        }),
    };
}
export async function alignStrategy(client, strategies, entries, naturalLanguage, signal) {
    const distinct = [...new Set(strategies.filter(Boolean))];
    if (distinct.length <= 1) return plainText(distinct[0] ?? '', '记忆策略', 10000);
    const result = await client.complete({ ...strategyRequest(strategies, entries, naturalLanguage), signal });
    return plainText(result.strategy, '统一记忆策略', 10000);
}

export async function maintain(client, save, messages, signal, scopeId = GLOBAL_SCOPE, observedState = null) {
    return client.complete({ ...maintainRequest(save, messages, scopeId, observedState), signal });
}
export async function select(client, save, messages, { eligible = () => true, selectionLimit = 16, selectionChars = 24000, observedState = null, signal } = {}) {
    const request = selectRequest(save, messages, { eligible, selectionLimit, selectionChars, observedState });
    const catalog = request.input.catalog;
    const result = await client.complete({ ...request, signal });
    invariant(Array.isArray(result.ids) && result.ids.length <= selectionLimit, '前置选材数量或格式无效');
    const allowed = new Set(catalog.map(e => e.id));
    invariant(result.ids.every(id => typeof id === 'string' && allowed.has(id)), '前置选择了不允许的资料');
    return [...new Set(result.ids)];
}
export async function compact(client, save, signal, scopeId = GLOBAL_SCOPE) {
    const request = compactRequest(save, scopeId);
    const memory = request.input.memory;
    const result = await client.complete({ ...request, signal });
    invariant(result.operations?.every(op => ['summary', 'update', 'mergeEvents'].includes(op.type)), '整理只能更新脉络与给出的历史事件');
    const ids = new Set(memory.entries.map(e => e.id));
    invariant(result.operations.every(op => op.type === 'summary' || (op.type === 'mergeEvents' ? Array.isArray(op.sources) && op.sources.every(source => ids.has(source.id)) : ids.has(op.id))), '整理不得修改当前事实或未提供的条目');
    return clone(result);
}
