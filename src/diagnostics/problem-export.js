import { createTraceStore } from './trace-store.js';

// Read-only, explicit player export. Client callbacks never participate in prompts.
export function createProblemExporter({ controller, context = () => ({}), timers = globalThis, sourceTimeoutMs = 3000 }) {
    const sources = new Map();
    const timeoutMs = Number.isFinite(sourceTimeoutMs) ? Math.max(1, Math.min(3000, sourceTimeoutMs)) : 3000;
    const currentContext = () => {
        const current = context();
        return { ...current, memoryChatId: current.memoryChatId || controller.view().chatId || null };
    };
    function matches(recordContext, current) {
        if (!recordContext) return false;
        if (recordContext.memoryChatId) return Boolean(current.memoryChatId && recordContext.memoryChatId === current.memoryChatId);
        if (current.memoryChatId && recordContext.chatId === current.memoryChatId) return true;
        // Earlier fetch records had only the filename and character display name.
        // A bare filename is ambiguous across characters, so omit it rather than guess.
        return Boolean(current.chatId && current.character && recordContext.chatId === current.chatId && recordContext.character === current.character);
    }
    function currentTraces(current = currentContext()) {
        const exported = controller.traces.exportData();
        const records = exported.records.filter(record => matches(record.context, current));
        return { ...exported, records, totalChars: JSON.stringify(records).length,
            scope: 'current-chat', excludedRecords: exported.records.length - records.length };
    }
    function readSource(source, current) {
        let timer;
        return Promise.race([
            Promise.resolve().then(() => source.read({ context: { ...current } })),
            new Promise((_, reject) => { timer = timers.setTimeout(() => reject(new Error('诊断来源读取超时（最多 3 秒），其余资料仍可导出')), timeoutMs); }),
        ]).finally(() => timers.clearTimeout(timer));
    }
    return {
        currentTraces,
        register({ id, title, read } = {}) {
            if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/i.test(id) || typeof read !== 'function') throw new Error('诊断来源格式无效');
            if (!sources.has(id) && sources.size >= 32) throw new Error('诊断来源最多注册 32 个');
            const entry = { id, title: String(title || id).slice(0, 80), read }; sources.set(id, entry);
            return () => { if (sources.get(id) === entry) sources.delete(id); };
        },
        async export() {
            const current = currentContext(), initialStore = controller.store;
            if (!current.chatId || !current.memoryChatId) throw new Error('请先打开目标角色存档，再导出本次问题。');
            let changed = false;
            const unsubscribe = controller.subscribe?.(view => { if (view.chatId !== current.memoryChatId) changed = true; });
            const assertCurrent = () => {
                const latest = currentContext();
                if (changed || latest.chatId !== current.chatId || latest.memoryChatId !== current.memoryChatId
                    || latest.character !== current.character || controller.store !== initialStore
                    || controller.view().chatId !== current.memoryChatId
                    || controller.store?.state && controller.store.state.chatId !== current.memoryChatId) {
                    throw new Error('导出期间已切换存档或目标存档尚未载入，请在目标存档重新导出。');
                }
            };
            try {
                assertCurrent();
                // Start providers together; even multiple stuck clients cannot make
                // the player wait 3 seconds per source. They are read-only callbacks.
                const attached = (await Promise.all([...sources.values()].map(async source => {
                    try {
                        const data = await readSource(source, current);
                        return sources.get(source.id) === source ? { id: source.id, title: source.title, data } : null;
                    } catch (error) {
                        return sources.get(source.id) === source ? { id: source.id, title: source.title, error: String(error?.message ?? error) } : null;
                    }
                }))).filter(Boolean);
                assertCurrent();
                const view = controller.view(), currentStore = controller.store?.state;
                // Reuse the trace store's credential filtering and hard size bound.
                const filter = createTraceStore({ maxRecords: 1, maxChars: 5000000, maxRecordChars: 5000000 });
                const id = filter.start({ context: current, memory: {
                    status: view.status, error: view.error, initialized: currentStore?.initialized ?? false,
                    enabled: view.enabled, saveEnabled: view.saveEnabled, initialization: view.initialization,
                    revision: currentStore?.revision, activity: view.activity, autoPostPaused: view.autoPostPaused,
                    scope: currentStore?.data?.scopeContext, pendingCount: view.diagnostics?.pendingCount,
                    lastPlan: currentStore ? controller.diagnostics?.lastPlan : null,
                }, sources: attached }); filter.finish(id);
                const captured = filter.snapshot().records[0];
                if (!captured) throw new Error('诊断资料超过导出容量，请先导出较小范围的收发记录。');
                // Validate only captured data (getters and oversized payloads have
                // already been rejected/truncated by the shared sanitizer).
                const safeSources = (captured.sources ?? []).map(source => {
                    const data = source.data;
                    if (data?.context?.chatId && !matches(data.context, current)
                        || data?.chatId && data.chatId !== current.chatId && data.chatId !== current.memoryChatId) {
                        return { id: source.id, title: source.title, error: '该来源返回了其他存档的诊断，已排除' };
                    }
                    if (Array.isArray(data?.runs)) {
                        const runs = data.runs.filter(run => matches(run?.context, current)
                            || run?.context?.chatId === current.chatId && !run.context.character && !run.context.memoryChatId);
                        return { ...source, data: { ...data, runs }, excludedRuns: data.runs.length - runs.length };
                    }
                    return source;
                });
                const traces = currentTraces(current);
                const dates = safeSources.flatMap(source => Array.isArray(source.data?.runs) ? source.data.runs.map(run => Date.parse(run?.startedAt)) : []).filter(Number.isFinite);
                const start = dates.length ? Math.min(...dates) : null;
                const records = start === null ? traces.records.slice(-12) : traces.records.filter(record => Date.parse(record.startedAt) >= start);
                return { format: 'fish-memory-problem', version: 1, exportedAt: new Date().toISOString(),
                    privacy: '包含本轮提示词、剧情和相关状态。配置凭据不导出；正文中自行写入的信息仍会保留。',
                    captureBoundary: '网络记录为浏览器到酒馆或已识别直连接口；未捕获、刷新前或被截断的记录不可恢复。',
                    context: captured.context, memory: captured.memory, sources: safeSources,
                    truncated: captured.truncated ?? false, truncatedFields: captured.truncatedFields ?? [],
                    trace: { ...traces, records, totalChars: JSON.stringify(records).length,
                        selection: start === null ? 'current-chat-latest-12' : 'matching-client-turn-window' } };
            } finally { unsubscribe?.(); }
        },
    };
}
