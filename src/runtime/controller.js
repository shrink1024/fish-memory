import { LazyAutomation } from './lazy-mode.js';
import { savedCapacityPercent } from '../core/storage-codec.js';
import { assertSourceCapacity } from '../core/capacity.js';
import { classificationPieces, joinClassifications } from '../agents/classification-pieces.js';
import { exportMemoryWorldbook, parseSupplementaryMemory } from '../core/transfer.js';
import { applicationSnapshot, APPLICATION_SCAN, validateApplicationSelection, validateApplicationPositions, selectedApplicationEntries, applyPresetApplication } from '../agents/preset-application.js';
import { throwIfAborted, combineSignals } from '../platform/abort.js';
import { sourceBookChanges, nativeSwitchOverlay, sourceMatches } from '../core/source-book.js';
import { presetSnapshot, PREFERENCE_SCAN, validatePreferenceCandidates, selectedPreferences, applyAuxiliaryPreferences } from '../agents/preset-preferences.js';
import { MemoryStore } from '../core/store.js';
import { sha256Fingerprint } from '../core/content-hash.js';
import { DEFAULT_SETTINGS, MAINTENANCE_EVERY_MAX, templateHint, normalizeTimeoutSettings, validTimeout, canCompactEntry, makeSourceEntry, createEntry, sourceId, entryText, normalizeScopeId, entryScope, scopeSummary, scopeInventory, readableScopes, GLOBAL_SCOPE } from '../core/state.js';
import { playerView, scopeRead, memoryMetrics } from '../core/views.js';
import { clone, invariant, uid, isPrefix, SerialQueue } from '../core/util.js';
import { planWindow } from '../core/window.js';
import { maintenanceFocus, triggeredIds, applyGate } from '../core/focus.js';
import { applyMaintenance } from '../core/operations.js';
import { AgentClient, compatibleConnection, listModels, untilAborted, serializeAgentInput, requestMessages, REASONING_EFFORTS, blockedResponse } from '../agents/client.js';
import { classifyEntries, classifyOrDefer, scanBudget, alignStrategy, maintain, select, compact, mergeSourceUpdates } from '../agents/tasks.js';
import { prescan, scriptOnly, DEFERRED } from '../agents/prescan.js';
import { discoverRules, compileRules, applyRules, evaluateRules } from '../rules/index.js';
import { createTraceStore } from '../diagnostics/trace-store.js';
import { buildPromptPreview } from '../diagnostics/prompt-preview.js';
import { selectionMessages, requestBatches, INITIALIZATION_BATCH_ITEMS, isReadableMessage } from '../agents/requests.js';
import { assemblePromptPlan, previewNarration } from './prompt-plan.js';

export const batches = requestBatches;

async function initializationFingerprint(value) {
    return sha256Fingerprint(JSON.stringify(value));
}

const SUMMARY_COMPACT_CHARS = 8000;

// A player-set tier survives source updates; only the scanned flags refresh.
const keepTier = used => used?.tier ? { tier: used.tier, enabled: used.tier !== 'off' } : {};

const PROFILE_MAX = 20, PROFILE_NAME_MAX = 40;
const sameConnection = (a, b) => Boolean(a && b) && a.endpoint === b.endpoint && a.model === b.model
    && a.apiKey === b.apiKey && (a.maxOutputTokens ?? null) === (b.maxOutputTokens ?? null);
// Stored profiles come from this browser; drop anything malformed rather than fail to start.
function cleanProfiles(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set(), profiles = [];
    for (const item of value) {
        const name = typeof item?.name === 'string' ? item.name.trim() : '';
        if (!name || name.length > PROFILE_NAME_MAX || seen.has(name) || typeof item.endpoint !== 'string' || !item.endpoint || typeof item.model !== 'string' || !item.model) continue;
        const tokens = Number(item.maxOutputTokens);
        seen.add(name);
        profiles.push({ name, endpoint: item.endpoint, model: item.model, apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
            maxOutputTokens: Number.isInteger(tokens) && tokens > 0 ? tokens : undefined });
    }
    return profiles.slice(0, PROFILE_MAX);
}

export class Controller {
    #lazy;
    #lazyDeferredTurn = false;
    #lazyCapacityCache = new WeakMap();
    #lazyCapacityAttempt = null;
    #listeners = new Set();
    #epoch = 0;
    #abort = new AbortController();
    #maintenance = null;
    #initializing = false;
    #compacting = false;
    #nativeBypass = false;
    #contextQueue = new SerialQueue();
    #selectionLeases = new Set();
    #selectionWaiters = new Set();
    #compactMarks = new Map();
    #compactAttempts = new Map();
    #mvuReadSerial = 0;
    #previewSources = new Map();
    #activities = new Map();
    #autoPostPaused = false;
    #pausedPostKeys = new Set();
    #activityClaims = new Map();
    #presetDraft = null;
    #applicationDraft = null;
    #loading = null;
    #loadedTarget = null;
    #worldbookCheck = null;
    #autoInitTask = null;
    #autoInitAttempts = new Set();
    #autoInitialization = null;
    #initializationSourceFingerprint = '';
    #initializationContextFingerprint = '';
    #initializationClassificationFingerprint = '';
    #connectionConfig = null;
    #connectionProfiles = [];
    #modelList = null;
    #persistedConnection = null;
    #pendingProfiles = null;
    #saveFailures = new Map();
    #connectionToken = 0;
    #connectionIdentities = [{mode:'raw',config:null,token:0}];
    #streamTask = null;
    // Story edits while background maintenance runs. Keys of the batch being
    // written let a later edit leave that request alone (see #storyChanged).
    // The main book as last read; its live switches steer selection (see nativeSwitchOverlay).
    #extraBooks = {};
    #nativeRaw = null;
    #storyRevision = 0;
    #maintenancePrefix = null;
    #storyDirty = false;
    constructor(host, { model, traces = createTraceStore(), settings = {}, persistSettings = async () => {}, chooseFallback = async () => 'cancel', connectionStore = null, lazyClock = {} } = {}) {
        this.host = host; this.settings = { ...DEFAULT_SETTINGS, ...settings, ...normalizeTimeoutSettings(settings) };
        if (!Number.isInteger(this.settings.maintenanceEvery) || this.settings.maintenanceEvery < 1 || this.settings.maintenanceEvery > MAINTENANCE_EVERY_MAX) this.settings.maintenanceEvery = DEFAULT_SETTINGS.maintenanceEvery;
        // Player-only, page-lifetime diagnostics. Never include this in view/save/agent data.
        this.traces = traces;
        this.persistSettings = persistSettings; this.chooseFallback = chooseFallback;
        this.sourceChanges = { changed: false, added: [], removed: [], updated: [] };
        this.status = '未初始化'; this.error = ''; this.errorInfo = null; this.scanStages = null; this.sourceSync = null; this.progress = null; this.store = null;
        this.rules = { naturalLanguage: '', script: '', configEntryUids: [] };
        this.compiledRules = compileRules(''); this.constraints = {};
        this.connectionMode = model ? 'test' : 'raw';
        this.diagnostics = { lastPlan: null, lastPreview: null, requests: [] };
        this.mvu = { enabled: false, available: false, status: 'disabled', fields: [], reason: '未启用只读协作' };
        this.client = model ? this.#instrument(model) : this.#client(request => host.rawGenerate(request));
        // The player chose to keep the separate connection (key included) in
        // this browser. A broken stored value falls back to ST's connection.
        this.settings.auxiliaryStream = this.settings.auxiliaryStream === true;
        this.connectionStore = connectionStore;
        if (!model) {
            try {
                const saved = connectionStore?.load?.();
                if (saved?.mode === 'compatible' && saved.endpoint && saved.model) { this.#applyConnection('compatible', saved); this.#persistedConnection = clone(saved); }
            } catch { /* Keep the ST connection when the stored value is unusable. */ }
            try { this.#connectionProfiles = cleanProfiles(connectionStore?.loadProfiles?.()); }
            catch { this.#connectionProfiles = []; }
        }
        this.#lazy = new LazyAutomation({
            identity: () => this.store?.state?.id ?? null,
            saved: () => this.store?.state.preferences?.lazy ?? {},
            enabled: () => {
                if (!this.settings.lazyMode || !this.#enabled() || !this.store || !this.#loadedTarget) return false;
                const current=this.host.statusSnapshot?.()??this.host.snapshot();
                return current.chatId===this.store.state.chatId && current.bookName===this.store.state.bookName
                    && current.chatId===this.#loadedTarget.chatId && current.bookName===this.#loadedTarget.bookName;
            },
            idle: () => !this.#activities.size && !this.#initializing && !this.#maintenance && !this.#compacting && !this.#nativeBypass
                && !this.host.snapshot().generating && !this.store?.state.data.scopeContext?.deferPost,
            plan: () => this.#lazyPlan(), run: job => this.#lazyRun(job),
            save: value => this.#saveLazyState(value), notify: () => this.#notify(),
            errorText: error => error.dwmStorage ? `存档写入失败${error.httpStatus?`（HTTP ${error.httpStatus}）`:''}` : ({quota:'辅助接口额度不足',moderation:'服务方内容审核拒收',capacity:'存档接近容量上限'}[error.kind] ?? (error.dwmBlocked?'服务方内容审核拒收':error.dwmResponseKind||error.dwmResponseInvalid?'模型输出不完整或格式不合格':error.httpStatus?`辅助接口 HTTP ${error.httpStatus}`:'辅助任务未完成，请查看收发记录')),
            capacity: () => this.#lazyCapacity(), diagnostic: error => { this.diagnostics.lazyError = error.kind ?? error.name ?? 'unknown'; },
        }, lazyClock);
    }
    #applyConnection(mode, { endpoint, model, apiKey = '', maxOutputTokens } = {}) {
        const config = { endpoint: String(endpoint ?? '').trim().replace(/\/$/, ''), model: String(model ?? '').trim(), apiKey: String(apiKey ?? ''), maxOutputTokens: maxOutputTokens === '' || maxOutputTokens == null ? undefined : Number(maxOutputTokens) };
        const client = this.#client(['raw', 'tavern'].includes(mode) ? request => this.host.rawGenerate(request) : compatibleConnection(config));
        this.#connectionConfig = ['raw', 'tavern'].includes(mode) ? null : config;
        this.connectionMode = mode; this.client = client;
        const normalizedMode = ['raw','tavern'].includes(mode) ? 'raw' : mode;
        let identity = this.#connectionIdentities.find(item => item.mode === normalizedMode && (normalizedMode === 'raw' || sameConnection(item.config,config)));
        if (!identity) { identity = {mode:normalizedMode,config:normalizedMode === 'raw' ? null : clone(config),token:uid('connection')};this.#connectionIdentities.push(identity);if(this.#connectionIdentities.length>50)this.#connectionIdentities.shift(); }
        this.#connectionToken = identity.token;
        return config;
    }
    #client(generate) {
        return this.#instrument(new AgentClient(generate, { getTimeouts: () => this.settings }));
    }
    #instrument(client) {
        const complete = async (request, accept = result => result) => {
            const presetFingerprint = this.#preset().fingerprint, preferences = this.#auxiliaryPreferences();
            const application = this.#application(), applicationEntries = this.#applicationEntries();
            request = applyPresetApplication(applyAuxiliaryPreferences(request, preferences), applicationEntries);
            const epoch = this.#epoch, start = Date.now(), taskId = uid('stream'), regexSignature = this.host.promptRegexSignature?.();
            let progressAt = 0;
            const onProgress = progress => {
                if (epoch !== this.#epoch || !this.settings.auxiliaryStream || request.signal?.aborted) return;
                if (progress.phase === 'recv' && Date.now() - progressAt < 250) return;
                progressAt = Date.now(); this.#streamTask = { id: taskId, title: request.purpose, mode: 'stream', ...progress }; this.#notify();
            };
            if (this.settings.auxiliaryStream) onProgress({ phase: 'send', chars: 0 });
            const serializedInput = serializeAgentInput(request.input);
            const automatic=this.#lazy?.task?clone(this.diagnostics.lazy):null;
            let trace = this.host.traceCapture?.register({ ...request, input: serializedInput, automatic });
            const startFallback = input => this.traces.start({ source: '鱼忆', label: ({ initialize: '扫描世界书', strategy: '统合记忆策略', select: '前置选材', maintain: '后置维护', compact: '整理事件', preferences: '扫描预设应用', sourceMerge: '合并原书更新' })[request.purpose] ?? request.purpose,
                transport: this.connectionMode === 'test' ? 'test' : 'agent-boundary',
                context: { chatId: this.host.snapshot().chatId }, ...(automatic?{automatic}:{}),
                request: { messages: requestMessages({ ...request, input }) },
                captureNote: '辅助接口记录，未捕获网络包；模拟模式的输出为合成数据。' });
            let fallbackId = trace ? null : startFallback(serializedInput);
            const wrapChars = [...(request.head ?? []), ...(request.tail ?? [])].reduce((n, m) => n + m.content.length, 0);
            const metric = { ...(this.#lazy?.task ? {automatic:clone(this.diagnostics.lazy)} : {}), regexSkipped: (this.#initializing && request.purpose === 'maintain' ? this.#initializationSnapshot() : this.host.snapshot()).messages.filter(m => m.regexSkipped).length, connectionToken: this.#connectionToken, task: request.purpose, at: new Date(start).toISOString(),
                inputChars: request.system.length + serializedInput.length + wrapChars, outputChars: 0, ok: false };
            try {
                throwIfAborted(request.signal);
                const validate = async result => {
                    if (['select','maintain','compact'].includes(request.purpose)) invariant(regexSignature === this.host.promptRegexSignature?.(), '发送正则已变化，旧处理结果未采用；请重试。');
                    onProgress({ phase: 'check', chars: JSON.stringify(result).length });
                    metric.outputChars = JSON.stringify(result).length;
                    if (fallbackId) this.traces.update(fallbackId, { responseBody: result });
                    if (preferences.length && request.purpose !== 'preferences') invariant(this.#preset().fingerprint === presetFingerprint, '请求期间预设已改变，旧偏好结果不再采用');
                    if (applicationEntries.length && request.purpose !== 'preferences') invariant(this.#application().fingerprint === application.fingerprint, '请求期间预设已改变，请重试');
                    return untilAborted(accept(result), request.signal);
                };
                const onAttempt = attempt => {
                    metric.attempts = attempt.attempt + 1;
                    if (!attempt.attempt) return;
                    const error = new Error('模型输出格式未通过校验，正在进行一次纠正重试');
                    trace?.end(error);
                    if (fallbackId) this.traces.finish(fallbackId, { status: 'error', processingError: error.message });
                    trace = this.host.traceCapture?.register(attempt);
                    fallbackId = trace ? null : startFallback(attempt.input);
                    metric.inputChars += attempt.system.length + attempt.input.length + wrapChars;
                };
                const accepted = client instanceof AgentClient
                    ? await untilAborted(client.complete({ ...request, validate, onAttempt, onProgress }), request.signal)
                    : await validate(await untilAborted(client.complete(request), request.signal));
                metric.ok = true;
                if (fallbackId) this.traces.finish(fallbackId, { status: 'complete' });
                trace?.end();
                return accepted;
            } catch (error) {
                if (epoch === this.#epoch && this.#streamTask?.id === taskId) this.#streamTask = { ...this.#streamTask, phase: 'failed', fault: error.dwmStreamFault ?? 'invalid' };
                metric.error = String(error.message ?? error).slice(0, 500);
                metric.outcome = error.dwmYielded ? 'yielded' : error.dwmCancelled ? 'stopped' : error.name === 'AbortError' ? 'cancelled' : 'error';
                trace?.end(error);
                if (fallbackId) this.traces.finish(fallbackId, { status: error.name === 'AbortError' ? 'aborted' : 'error', error: metric.error,
                    processingError: metric.error, processingOutcome: metric.outcome });
                throw error;
            }
            finally {
                if (epoch === this.#epoch) {
                    metric.durationMs = Date.now() - start;
                    this.diagnostics.requests = [...this.diagnostics.requests.slice(-49), metric];
                    this.#notify();
                }
            }
        };
        return { complete: request => complete(request), completeValidated: complete };
    }
    #beginActivity(kind, label, { isCurrent = () => true, signal } = {}) {
        const abort = new AbortController();
        const chatId = this.host.snapshot().chatId;
        const cancellation = combineSignals([this.#abort.signal, abort.signal, signal]);
        const activity = { id: uid('activity'), kind, label, startedAt: Date.now(), phase: 'running', cancellable: true,
            stopLabel: kind === 'select' ? '停止本轮' : kind === 'maintain' || kind === 'compact' ? '停止整理' : '停止等待',
            hint: kind === 'select' ? '停止将结束本轮发送；已有记忆保留。' : this.#backgroundHint(),
            abort, signal: cancellation.signal, dispose: cancellation.dispose, isCurrent,
            epoch: this.#epoch, chatId };
        this.#activities.set(activity.id, activity); this.#notify();
        return activity;
    }
    #backgroundHint() {
        return ['raw', 'tavern'].includes(this.connectionMode)
            ? '停止会中止网络等待并放弃迟到结果；服务端可能继续运行或计费。已保存的进度保留。'
            : '停止当前任务，已保存的进度保留。';
    }
    #pauseAutomaticPost() {
        this.#autoPostPaused = true;
        this.#pausedPostKeys = new Set(this.host.snapshot().messages.map(message => message.key));
    }
    #resumePostForNewReply() {
        if (this.#autoPostPaused && this.host.snapshot().messages.some(message => message.role === 'assistant'
            && String(message.content ?? '').trim() && !this.#pausedPostKeys.has(message.key))) {
            this.#autoPostPaused = false; this.#pausedPostKeys.clear();
        }
    }
    #updateActivity(activity, patch) {
        if (this.#activities.get(activity?.id) !== activity) return;
        Object.assign(activity, patch); this.#notify();
    }
    #endActivity(activity) {
        if (!activity) return;
        activity?.dispose();
        if (this.#activities.get(activity?.id) !== activity) return;
        this.#activities.delete(activity.id);
        if (!this.#activities.size && this.#streamTask && this.#streamTask.phase !== 'failed') this.#streamTask = null;
        this.#notify();
    }
    #assertActivity(activity) {
        this.#assertCurrent(activity.epoch, activity.chatId);
        throwIfAborted(activity.signal);
        invariant(activity.isCurrent(), '本轮已停止或被新的发送替代');
    }
    async #saveActivity(activity, operation) {
        if (['maintain', 'compact', 'inventory'].includes(activity.kind)) await this.#afterSelection(activity);
        this.#assertActivity(activity);
        if (this.#streamTask?.phase === 'check') this.#streamTask = { ...this.#streamTask, phase: 'save' };
        const previous = { label: activity.label, hint: activity.hint };
        this.#updateActivity(activity, { label: '正在保存已完成的结果', cancellable: false, hint: '保存提交期间不能撤回；完成后可停止后续批次。' });
        try { return await operation(); }
        finally { this.#updateActivity(activity, { ...previous, cancellable: !activity.signal.aborted }); }
    }
    async requestStop(id = this.view().activity?.id) {
        const activity = this.#activities.get(id);
        if (!activity) return { stopped: false, reason: '该任务已结束' };
        if (!activity.cancellable || activity.phase === 'cancelling') return { stopped: false, reason: '当前结果正在保存，请稍候' };
        if (activity.epoch !== this.#epoch || activity.chatId !== this.host.snapshot().chatId || !activity.isCurrent()) {
            activity.abort.abort(new Error('本轮已过期'));
            return { stopped: false, reason: '该任务已过期' };
        }
        const native = activity.kind === 'select';
        // A card can release deferPost in its STOP handler. Pause first so that
        // scope cleanup cannot launch old maintenance while this turn ends.
        if (activity.kind !== 'preview') this.#pauseAutomaticPost();
        this.#updateActivity(activity, { phase: 'cancelling', cancellable: false, label: '正在停止',
            hint: native ? '正在结束本轮发送，已保存的记忆保留。' : this.#backgroundHint() });
        activity.abort.abort(Object.assign(new Error('用户已停止本次任务'), { name: 'AbortError', dwmCancelled: true }));
        let stopping;
        if (native) {
            // Call synchronously after the ownership check: no await can let a
            // newer foreground generation become the target of this stop.
            this.host.clearPlan();
            stopping = this.host.stopGeneration?.();
        }
        this.#state(native ? '本轮已停止' : ['maintain', 'compact', 'inventory'].includes(activity.kind) ? '已停止整理。原文保留；下一条回复后自动恢复。' : '已停止等待，已有资料保留。');
        await stopping;
        return { stopped: true };
    }
    #selecting() { return [...this.#selectionLeases].some(lease => lease.epoch === this.#epoch); }
    async #waitForSelection(signal) {
        while (this.#selecting()) {
            let release;
            const waiting = new Promise(resolve => { release = resolve; this.#selectionWaiters.add(resolve); });
            try { await untilAborted(waiting, signal); }
            finally { this.#selectionWaiters.delete(release); }
        }
    }
    async #afterSelection(activity) {
        while (this.#selecting()) {
            let release;
            const waiting = new Promise(resolve => { release = resolve; this.#selectionWaiters.add(resolve); });
            try { await untilAborted(waiting, activity.signal); }
            finally { this.#selectionWaiters.delete(release); }
        }
        this.#assertActivity(activity);
    }
    async #saveLazyState(value) {
        const store=this.store,epoch=this.#epoch,chatId=store?.state.chatId;
        const signal=this.#abort.signal;
        do { await this.#waitForSelection(signal); } while(this.#selecting());
        this.#assertCurrent(epoch,chatId);
        invariant(this.store===store,'存档已切换，自动记录未写入其他存档');
        return store.updatePreferences({lazy:value});
    }
    async #withSelection(task, activity) {
        const lease = { epoch: this.#epoch }, chatId = this.host.snapshot().chatId;
        this.#selectionLeases.add(lease);
        try {
            // Keep already requested model work. Background commits wait for
            // this immutable selection snapshot, while the send stays prompt.
            await untilAborted(this.store?.idle() ?? Promise.resolve(), activity?.signal ?? this.#abort.signal);
            this.#assertCurrent(lease.epoch, chatId);
            if (activity) {
                this.#assertActivity(activity);
                this.#updateActivity(activity, { label: activity.kind === 'preview' ? '正在试选本轮资料' : '前置正在选择本轮资料',
                    hint: activity.kind === 'select' ? '停止将结束本轮发送；已有记忆保留。' : this.#backgroundHint() });
            }
            return await untilAborted(task(), activity?.signal ?? this.#abort.signal);
        } finally {
            this.#selectionLeases.delete(lease);
            if (!this.#selecting()) for (const release of this.#selectionWaiters) release();
        }
    }
    async refreshMvu() {
        const epoch = this.#epoch, chatId = this.host.snapshot().chatId;
        const settings = this.settings, serial = ++this.#mvuReadSerial;
        let result;
        try {
            result = this.settings.mvuEnabled && this.settings.mvuBookName !== this.host.snapshot().bookName
                ? { enabled: true, available: false, status: 'unconfigured', fields: [], reason: '请为当前主世界书保存字段配置；其他卡的字段不会自动套用' }
                : this.settings.mvuEnabled && this.host.readMvu
                ? await this.host.readMvu(this.settings)
                : { enabled: this.settings.mvuEnabled, available: false, status: this.settings.mvuEnabled ? 'unavailable' : 'disabled', fields: [], reason: this.settings.mvuEnabled ? '当前宿主没有可用的 MVU 读取接口' : '未启用只读协作' };
        } catch {
            result = { enabled: this.settings.mvuEnabled, available: false, status: 'unavailable', fields: [], reason: 'MVU 读取暂不可用，本次继续使用正文记忆' };
        }
        this.#assertCurrent(epoch, chatId);
        if (settings !== this.settings || serial !== this.#mvuReadSerial) return {
            enabled: this.settings.mvuEnabled, available: false, status: 'stale', fields: [], reason: '字段配置已变化，本次读取作废' };
        this.mvu = result; this.#notify();
        return clone(result);
    }
    #observedState(projection, snapshot, messages) {
        if (!this.settings.mvuEnabled || this.settings.mvuBookName !== snapshot.bookName) return null;
        if (!projection?.fields?.length || !['ready', 'partial'].includes(projection.status)) return null;
        const latest = snapshot.messages.at(-1);
        if (projection.freshness?.chatId !== snapshot.chatId || projection.freshness?.messageKey !== latest?.key
            || !messages.some(message => message.key === latest.key)) return null;
        return { source: 'MVU read-only observation', messageKey: latest.key,
            persistence: 'unverified', fields: clone(projection.fields) };
    }
    #worldbookOnly() { return this.settings.memoryMode === 'worldbook'; }
    /** Worldbook-only mode: agents and injection see no summary, events or
     * inventory. Stored data is kept, so switching back restores them. */
    #taskView(save) {
        if (save && !this.#worldbookOnly() && this.settings.summaryMode === 'rewrite') return { ...save, summaryRewrite: true };
        if (!this.#worldbookOnly() || !save) return save;
        const view = clone(save);
        view.worldbookOnly = true;
        view.data.summary = ''; view.data.scopeSummaries = {}; view.data.inventoryEnabled = false;
        for (const entry of Object.values(view.data.entries)) if (entry.kind === 'event') entry.enabled = false;
        return view;
    }
    #guarded(save) {
        const copy = clone(save);
        copy.data.entries = Object.fromEntries(applyRules(Object.values(copy.data.entries), this.compiledRules).entries.map(e => [e.id, e]));
        return copy;
    }
    #validateGuarded(save, result, allowedEvidence, scopeId = GLOBAL_SCOPE) {
        const { next, touched } = applyMaintenance(this.#guarded(save).data, result, { allowedEvidence, maxChars: this.#maxChars(save), scopeId });
        for (const id of touched) {
            const entry = next.entries[id];
            if (!entry) continue;
            const rule = evaluateRules(this.compiledRules, entry);
            if (rule.maxChars && (!save.data.entries[id] || entryText(entry) !== entryText(save.data.entries[id]))) {
                invariant(entryText(entry).length <= rule.maxChars, `条目 ${entry.title} 超出作者长度约束`);
            }
        }
    }
    #yieldBackground() {
        let yielded = false;
        for (const activity of this.#activities.values()) {
            if (!['maintain', 'compact', 'inventory'].includes(activity.kind)) continue;
            // Storage has already accepted this write. Let it finish, but abort
            // the enclosing task so it cannot launch or commit another batch.
            yielded = true;
            activity.abort.abort(Object.assign(new Error('后台整理已让出，优先处理本轮'), { name: 'AbortError', dwmYielded: true }));
        }
        if (yielded) this.#state('后台整理暂歇，未记原文保留');
        return yielded;
    }
    #preset() { return presetSnapshot(this.host.readPreset?.() ?? {}); }
    #auxiliaryPreferences() { if (this.store?.state.preferences?.presetApplication) return []; return selectedPreferences(this.store?.state.preferences?.preset, this.#preset()); }
    #application() { return applicationSnapshot(this.host.readPreset?.() ?? {}); }
    #applicationEntries() { return selectedApplicationEntries(this.store?.state.preferences?.presetApplication, this.#application()); }
    async scanPresetApplication() {
        invariant(this.store && !this.view().activity, '请等待存档载入及当前任务完成');
        const preset = this.#application(), store = this.store, bookName = this.host.snapshot().bookName;
        invariant(store.state.bookName === bookName, '请等待当前世界书载入');
        invariant(preset.entries.length, '当前没有可读取的预设文本条目');
        const activity = this.#beginActivity('preferences', '正在推荐预设开关');
        this.#state('正在扫描预设；原设置保留');
        try {
            const selectedIds = await this.client.completeValidated({ purpose: 'preferences', system: APPLICATION_SCAN, input: { entries: preset.entries }, signal: activity.signal }, result => {
                this.#assertActivity(activity);
                invariant(this.store === store && this.host.snapshot().bookName === bookName && this.#application().fingerprint === preset.fingerprint, '扫描期间预设或世界书已改变，请重新扫描');
                return validateApplicationSelection(result, preset);
            });
            this.#assertActivity(activity);
            this.#applicationDraft = { id: uid('preset-application'), chatId: activity.chatId, fingerprint: preset.fingerprint, selectedIds };
            this.#state('已推荐预设开关，可手动调整后应用');
        } catch (error) {
            if (!activity.signal.aborted && activity.epoch === this.#epoch) this.#state('预设推荐未完成，已应用设置保留', error);
            throw error;
        } finally { this.#endActivity(activity); }
    }
    async savePresetApplication(ids, fingerprint, positions) {
        invariant(this.store && !this.view().activity, '请等待存档载入及当前任务完成');
        const epoch = this.#epoch, chatId = this.host.snapshot().chatId, store = this.store, bookName = this.host.snapshot().bookName;
        invariant(store.state.bookName === bookName, '请等待当前世界书载入');
        const preset = this.#application();
        invariant(fingerprint === preset.fingerprint, '预设已改变，请重新检查条目');
        const selectedIds = validateApplicationSelection({ selectedIds: ids }, preset);
        const placement = validateApplicationPositions(positions, preset, selectedIds);
        await store.idle();
        this.#assertCurrent(epoch, chatId);
        invariant(this.store === store && this.host.snapshot().bookName === bookName && this.#application().fingerprint === fingerprint && !this.view().activity, '预设或任务状态已改变，请重试');
        await store.updatePreferences({ presetApplication: { name: preset.name, fingerprint, selectedIds, ...(Object.keys(placement).length ? { positions: placement } : {}) }, preset: null });
        this.#assertCurrent(epoch, chatId);
        this.#applicationDraft = null;
        this.#state('预设副本已应用到此存档的辅助请求');
    }
    async scanPreset() {
        invariant(this.store && !this.#initializing, '请先载入存档，并等待扫描完成');
        invariant(!this.view().activity, '请等待当前辅助任务完成后扫描预设');
        const preset = this.#preset();
        invariant(preset.entries.length, '当前连接没有可读取的预设提示条目');
        const activity = this.#beginActivity('preferences', '正在扫描预设中的通用偏好');
        this.#state('正在扫描预设；不会修改原预设');
        try {
            const candidates = await this.client.completeValidated({ purpose: 'preferences', system: PREFERENCE_SCAN, input: { entries: preset.entries }, signal: activity.signal }, result => {
                this.#assertActivity(activity);
                invariant(this.#preset().fingerprint === preset.fingerprint && this.host.snapshot().bookName === this.store.state.bookName, '扫描期间预设或世界书已改变，请重新扫描');
                return validatePreferenceCandidates(result, preset);
            });
            this.#assertActivity(activity);
            this.#presetDraft = { id: uid('preset-draft'), chatId: activity.chatId, bookName: this.store.state.bookName, name: preset.name,
                fingerprint: preset.fingerprint, candidates };
            this.#state('预设扫描完成，请选择要采用的偏好');
            return { executed: true, message: this.status };
        } catch (error) {
            if (!activity.signal.aborted && activity.epoch === this.#epoch) this.#state('预设扫描未完成，原配置保留', error);
            throw error;
        } finally { this.#endActivity(activity); }
    }
    async confirmPreset(ids) {
        invariant(this.store && !this.#initializing, '请等待当前存档载入完成');
        const epoch = this.#epoch, chatId = this.host.snapshot().chatId;
        const draft = this.#presetDraft, preset = this.#preset();
        invariant(draft && draft.chatId === this.host.snapshot().chatId && draft.bookName === this.store.state.bookName && draft.bookName === this.host.snapshot().bookName && draft.fingerprint === preset.fingerprint, '预设或存档已改变，请重新扫描');
        invariant(Array.isArray(ids) && ids.every(id => draft.candidates.some(item => item.id === id)), '请选择当前扫描中的候选');
        this.#yieldBackground(); await this.store.idle();
        invariant(this.#presetDraft === draft && this.#preset().fingerprint === draft.fingerprint, '配置已改变，请重新扫描');
        await this.store.updatePreferences({ preset: { name: draft.name, fingerprint: draft.fingerprint,
            selected: draft.candidates.filter(item => ids.includes(item.id)) } });
        this.#assertCurrent(epoch, chatId);
        if (this.#presetDraft === draft) this.#presetDraft = null;
        this.#state('辅助偏好已保存到此存档');
        return { executed: true, message: this.status };
    }
    async #lazyManualSuccess(task) {
        if(this.#lazy.task===task)return;
        const state=this.#lazy.state,failures={...(state.failures??{})};let attention=state.attention,changed=false;
        if(attention?.reason==='capacity'&&this.#lazyCapacity(true)<90){delete failures[attention.task??'compact'];attention=null;changed=true;}
        if(failures[task]){delete failures[task];if(attention?.task===task)attention=null;changed=true;}
        if(changed)await this.#lazy.save({failures,attention});
    }
    async setLazyMode(enabled) {
        invariant(typeof enabled === 'boolean', '模式设置无效');
        await this.updateSettings({lazyMode:enabled});
        if (enabled) void this.#lazy.kick();
        return {executed:true,enabled};
    }
    async lazyRetry() {
        await this.#lazy.running;
        // Explicit resume also releases requestStop's background pause, so a
        // stopped maintenance task remains eligible for the forced plan.
        this.#autoPostPaused=false;this.#pausedPostKeys.clear();
        return this.#lazy.kick({force:true});
    }
    async lazyIgnore() {
        invariant(this.settings.lazyMode && !this.#activities.size, '请等待任务结束后处理');
        const state=this.#lazy.state, attention=state.attention, failure=state.failures?.[attention?.task];
        invariant(attention?.reason==='moderation' && failure?.floors?.keys?.length, '只有被拒的剧情楼层可以忽略，原书条目不能按楼层忽略');
        const keys=this.host.snapshot().messages.map(m=>m.key), floors=failure.floors;
        invariant(JSON.stringify(keys.slice(floors.from-1,floors.to))===JSON.stringify(floors.keys), '剧情已变化，请重新核对被拒楼层');
        const failures={...state.failures};delete failures[attention.task];
        const saved = await this.#lazy.save({ignored:[...new Set([...(state.ignored??[]),...floors.keys])],failures,attention:null}, {type:'ignored',from:floors.from,to:floors.to});
        invariant(saved,'忽略状态未能保存，原楼层未跳过');
        await this.#lazy.running;return this.#lazy.kick();
    }
    #lazyCapacity(measure=false) {
        const save=this.store?.state;if(!save)return 0;
        if(!this.#lazyCapacityCache.has(save)&&measure){
            try { this.#lazyCapacityCache.set(save,savedCapacityPercent(save)); }
            catch(error){if(error.kind==='capacity')this.#lazyCapacityCache.set(save,100);else throw error;}
        }
        return this.#lazyCapacityCache.get(save) ?? this.#lazyCapacityAttempt ?? null;
    }
    #lazyView(snapshot) {
        const state=this.#lazy?.state??{}, active=[...this.#activities.values()][0], task=this.#lazy?.task;
        const stoppedTask=!task&&!active?Object.keys(state.failures??{}).find(key=>state.failures[key].reason==='cancelled'):null;
        const retry=Object.values(state.failures??{}).filter(f=>f.nextRetryAt).sort((a,b)=>a.nextRetryAt-b.nextRetryAt)[0];
        const waiting=retry??Object.values(state.failures??{}).find(f=>['connection','output'].includes(f.reason)&&f.attempts===4);
        const retryFailure=task?state.failures?.[task]:waiting;
        const retryReason=['connection','output'].includes(retryFailure?.reason)?retryFailure.reason:null;
        const stages=this.scanStages, history=stages?.history;
        const connection=['raw','tavern'].includes(this.connectionMode)?this.host.auxiliaryReadiness?.():null;
        const waitingReason=!this.store?'等待聊天载入':!snapshot.templateEnabled?templateHint(snapshot.templateStatus):connection?.ready===false?connection.reason??'等待辅助连接就绪':null;
        const ignored=new Set(state.ignored??[]);
        return {enabled:Boolean(this.settings.lazyMode),status:{
            state:task&&state.failures?.[task]?'retrying':({init:'building',initialize:'building',maintain:'maintaining',sync:'syncing',compact:'compacting'}[task??active?.kind]??(stoppedTask?'stopped':retry||Object.values(state.failures??{}).some(f=>['connection','output'].includes(f.reason)&&f.attempts===4)?'waiting-retry':!this.store?.state.initialized?'building':'ready')),
            stage:history?{index:3,total:3,label:'history'}:stages?.books?{index:stages.books.done===stages.books.total?2:1,total:3,label:stages.books.done===stages.books.total?'strategy':'classify'}:null,
            batch:history??stages?.books??null,nextRetryAt:retry?new Date(retry.nextRetryAt).toISOString():null,
            retryReason, waitingReason, stoppedTask:stoppedTask??null, floor:this.store?.state.processed.length??0,
            ignoredFloors:this.store?.state.processed.filter(key=>ignored.has(key)).length??0,
            rememberedFloors:this.store?.state.rememberedKeys?.length??0,updatedAt:state.updatedAt??null,deferredTurn:this.#lazyDeferredTurn,
        },attention:clone(state.attention??null),capacityPercent:this.#lazyCapacity(),recent:this.settings.lazyMode?clone(state.recent??[]):[]};
    }
    async #lazyPlan() {
        const snapshot=this.host.snapshot(),save=this.store?.state;
        if(!save||!snapshot.chatId||!snapshot.bookName||snapshot.group||!snapshot.templateEnabled||!snapshot.messages.length)return [];
        const connection=['raw','tavern'].includes(this.connectionMode)?this.host.auxiliaryReadiness?.():null;
        if(connection?.ready===false)return [];
        if(!save.initialized)return snapshot.messages.some(m=>m.role!=='system'&&(m.regexSkipped||String(m.content??'').trim()))?[{task:'init',reason:'uninitialized'}]:[];
        try { await this.#loadRules(); } catch { return [{task:'sync',reason:'source-unavailable'}]; }
        const jobs=[],failures=this.#lazy.state.failures??{};
        if(this.sourceChanges.changed||Object.keys(this.store.state.sourceHeld??{}).length||failures.sync)jobs.push({task:'sync',reason:'source-change'});
        const pending=save.processed.length<snapshot.messages.length,schedule=this.#maintenanceSchedule(snapshot);
        if(!this.#autoPostPaused&&(pending&&!schedule.waiting||failures.maintain))jobs.push({task:'maintain',reason:'new-story'});
        const percent=this.#lazyCapacity(true);this.#lazyCapacityAttempt=percent;
        if(percent<90&&this.#lazy.state.attention?.reason==='capacity'){
            const next={...failures};delete next.compact;await this.#lazy.save({failures:next,attention:null});
        }
        if(percent>=90||!this.#worldbookOnly()&&(this.#shouldCompact()||failures.compact))jobs.push({task:'compact',reason:percent>=90?'capacity':'memory-growth'});
        return jobs;
    }
    async #lazyRun(job) {
        const before=this.store.state.processed.length;
        this.diagnostics.lazy={task:job.task,trigger:job.reason,attempt:(this.#lazy.state.failures?.[job.task]?.attempts??0)+1,at:new Date().toISOString()};
        if(job.task==='init'){
            const result=await this.initialize({automatic:true});
            return {...result,record:{type:'init',floors:this.store.state.processed.length,rememberedFloors:this.store.state.rememberedKeys?.length??0,
                ignoredFloors:this.store.state.processed.filter(key=>(this.store.state.preferences.lazy?.ignored??[]).includes(key)).length,
                entries:Object.keys(this.store.state.data.entries).length}};
        }
        if(job.task==='sync'){
            const result=await this.syncSourceChanges();
            const synced=this.sourceSync?.synced??0;
            const held=Object.values(this.store.state.sourceHeld??{}).map(p=>({id:p.next.id,title:p.next.title,resolutionId:p.resolutionId}));
            for(const item of held){
                await this.#resolveHeldSource({type:'source-held-resolve',id:item.id,choice:'keep-current',confirmed:true,expectedResolutionId:item.resolutionId}, {allowMissing:true});
                await this.#lazy.save({}, {type:'held-kept',title:item.title});
            }
            if(this.sourceChanges.changed)throw blockedResponse();
            return {...result,record:{type:'sync',count:synced+held.length}};
        }
        if(job.task==='maintain'){
            const retry=this.#lazy.state.failures?.maintain;
            if(retry?.phase==='compact')return {...await this.compact(),record:{type:'compact',merged:0,condensed:1}};
            if(retry?.followUp){
                const pending=retry.followUp,activity=this.#beginActivity('maintain','重试补充条目更新');
                try {
                    await this.#loadRules(activity.epoch,activity.chatId,activity.signal);
                    const snapshot=this.host.snapshot();
                    if(!isPrefix(pending.keys,snapshot.messages.map(m=>m.key)))return {executed:true,record:{type:'paused',reason:'branch-changed'}};
                    const readable=snapshot.messages.filter(m=>pending.readableKeys.includes(m.key));
                    await this.#maintainFollowUp(this.store,readable,pending.keys,pending.ids,{signal:activity.signal,activity,scopeId:pending.scopeId,assertPath:()=>this.#assertSourceCurrent(activity)});
                    return {executed:true,record:this.#lazyRecordedRanges(snapshot.messages,0,pending.keys.length,new Set(readable.map(m=>m.key)))};
                }finally{this.#endActivity(activity);}
            }
            const result=await this.maintain({automatic:true,lazyOwned:true});
            return {...result,record:this.#lazyRecordedRanges(this.host.snapshot().messages,before,this.store.state.processed.length,new Set(this.store.state.rememberedKeys??[]))};
        }
        const result=await this.compact();
        const percent=this.#lazyCapacity(true);this.#lazyCapacityAttempt=percent;
        if(percent>=90)throw Object.assign(new Error('整理后存档仍接近容量上限，请导出备份后自行删减资料'),{kind:'capacity'});
        return {...result,record:{type:'compact',merged:result.merged??0,condensed:result.condensed??0}};
    }
    #lazyRecordedRanges(messages, start, end, remembered) {
        const ranges=[];
        for(let index=start;index<end;index++){
            if(!remembered.has(messages[index]?.key))continue;
            const previous=ranges.at(-1),floor=index+1;
            if(previous?.to===index)previous.to=floor;
            else ranges.push({type:'maintain',from:floor,to:floor});
        }
        return ranges;
    }
    async #lazyScanPause(activity) {
        while(this.settings.lazyMode&&activity.kind==='initialize'&&(this.#lazyDeferredTurn||this.host.snapshot().generating)){
            this.#assertActivity(activity);
            await untilAborted(new Promise(resolve=>setTimeout(resolve,50)),activity.signal);
        }
    }
    #enabled() { return Boolean(this.settings.enabled && this.store?.state.preferences?.enabled !== false); }
    #initializationNotice(state, message, retry = false) {
        this.#autoInitialization = state ? { state, message, retry } : null;
        this.#notify();
    }
    /** Host readiness events start work in the background, never hold up ST's event emitter. */
    readinessChanged() {
        if (this.settings.lazyMode && this.#lazy) return this.#lazy.kick();
        const target = this.host.snapshot();
        if (this.#autoInitTask?.chatId === target.chatId && this.#autoInitTask.bookName === target.bookName) return this.#autoInitTask.promise;
        const task = { chatId: target.chatId, bookName: target.bookName, promise: null };
        this.#autoInitTask = task;
        task.promise = Promise.resolve().then(async () => {
            if (!this.settings.enabled) return;
            if (!target.chatId || !target.bookName || target.group) {
                this.#initializationNotice(null); return;
            }
            const { epoch, signal } = await this.#readyForChat(target);
            const current = () => { this.#assertCurrent(epoch, target.chatId); invariant(this.host.snapshot().bookName === target.bookName, '角色主世界书已改变'); };
            if (this.store.state.bookName !== target.bookName) return;
            if (!this.#enabled() || this.store.state.initialized) { this.#initializationNotice(null); return; }
            if (this.#initializing) return;
            const save = this.store.state, snapshot = this.host.snapshot();
            if (save.preferences?.autoInitialization || this.#autoInitAttempts.has(save.id)) {
                this.#initializationNotice('retry', '上次初始化未完成，原资料保留；可手动重试', true); return;
            }
            const story = snapshot.messages.filter(message => message.role !== 'system');
            if (save.parentId || story.some(message => message.role === 'user') || story.length > 1) {
                this.#initializationNotice('manual', '此档已有剧情或继承资料，请手动扫描以建立完整记忆', true); return;
            }
            if (!story.length || !String(story[0].content ?? '').trim()) {
                this.#initializationNotice('waiting', '自动建档等待开场内容就绪'); return;
            }
            if (!snapshot.templateEnabled) { this.#initializationNotice('waiting', `${templateHint(snapshot.templateStatus)}；就绪后自动建立新档记忆`); return; }
            if (snapshot.generating || save.data.scopeContext?.deferPost) {
                this.#initializationNotice('waiting', '本轮正在生成或保存，结束后检查新档初始化'); return;
            }
            const connection = ['raw', 'tavern'].includes(this.connectionMode) ? this.host.auxiliaryReadiness?.() : null;
            if (connection?.ready === false) { this.#initializationNotice('waiting', connection.reason || '辅助模型尚未连接；连接就绪后自动建档'); return; }
            try { await this.#loadRules(epoch, target.chatId, signal); }
            catch (error) { current(); this.#initializationNotice('waiting', `主世界书尚不可读取：${error.message}；就绪后自动重试`); return; }
            await untilAborted(this.#contextQueue.idle(), signal);
            await untilAborted(this.store.idle(), signal); current();
            // Readiness work can outlive a first send, a toggle or a manual retry.
            const latest = this.host.snapshot();
            if (!this.#enabled() || this.#initializing || this.store.state.initialized) return;
            if (latest.generating || this.store.state.data.scopeContext?.deferPost
                || latest.messages.some(message => message.role === 'user')) {
                this.#initializationNotice('manual', '剧情已开始；本轮使用原生资料，可手动扫描当前存档', true); return;
            }
            this.#autoInitAttempts.add(save.id);
            await this.initialize({ automatic: true });
        }).catch(error => {
            if (this.host.snapshot().chatId === task.chatId && this.#autoInitTask === task && !this.#initializing) {
                this.#initializationNotice('retry', `自动初始化未完成：${error.message}；可手动重试`, true);
            }
            return { executed: false, reason: error.message };
        }).finally(() => { if (this.#autoInitTask === task) this.#autoInitTask = null; });
        return task.promise;
    }
    uiStatus() {
        const view = this.view();
        return { chatId: view.chatId, enabled: view.enabled, initialized: Boolean(view.save?.initialized),
            activity: view.activity, status: view.status, error: view.error, pendingCount: view.diagnostics.pendingCount,
            autoPostPaused: view.autoPostPaused, initialization: view.initialization, lazy: view.lazy };
    }
    claimActivity({ owner, chatId }) {
        invariant(typeof owner === 'string' && owner.length > 0 && owner.length <= 100, '状态栏 owner 无效');
        invariant(chatId && chatId === this.host.snapshot().chatId, '只能接管当前聊天的状态栏');
        const claim = { owner, chatId };
        this.#activityClaims.set(owner, claim); this.#notify();
        return () => { if (this.#activityClaims.get(owner) === claim) { this.#activityClaims.delete(owner); this.#notify(); } };
    }
    async #readyForChat(target = this.host.snapshot()) {
        const matches = value => value?.chatId === target.chatId && value?.bookName === target.bookName;
        invariant(target.chatId && target.bookName && !target.group, '请先打开带主世界书的单角色聊天');
        invariant(matches(this.host.snapshot()), '存档已切换，本次处理已作废');
        const loading = this.#loading && matches(this.#loading.target) && !this.#loading.abort.signal.aborted
            ? this.#loading.promise : !matches(this.#loadedTarget) ? this.chatChanged() : null;
        if (loading) await loading;
        invariant(matches(this.host.snapshot()) && matches(this.#loadedTarget) && this.store?.state.chatId === target.chatId, '存档已切换或尚未载入，本次处理已作废');
        throwIfAborted(this.#abort.signal);
        return { epoch: this.#epoch, signal: this.#abort.signal };
    }
    async whenCommitted() {
        const target = this.host.snapshot();
        const { epoch, signal } = await this.#readyForChat(target);
        const chatId = target.chatId;
        await untilAborted(this.#contextQueue.idle(), signal);
        await untilAborted(this.store?.idle() ?? Promise.resolve(), signal);
        this.#assertCurrent(epoch, chatId);
        return this.#commitStatus(chatId);
    }
    #commitStatus(chatId) {
        const context = this.store?.state.data.scopeContext;
        const snapshot = this.host.statusSnapshot?.() ?? this.host.snapshot();
        return { chatId, revision: this.store?.state.revision ?? null, status: this.status, error: this.error,
            context: context ? { owner: context.owner, activeScopeId: context.activeScopeId,
                requestedScopeIds: clone(context.requestedScopeIds), deferPost: Boolean(context.deferPost) } : null,
            pendingCount: Math.max(0, snapshot.messages.length - (this.store?.state.processed.length ?? 0)) };
    }
    async whenIdle() {
        const target = this.host.snapshot();
        const { epoch, signal } = await this.#readyForChat(target);
        const chatId = target.chatId;
        await untilAborted(this.#contextQueue.idle(), signal);
        if (this.#maintenance) await untilAborted(this.#maintenance.catch(() => {}), signal);
        await untilAborted(this.store?.idle() ?? Promise.resolve(), signal);
        this.#assertCurrent(epoch, chatId);
        return this.#commitStatus(chatId);
    }
    #contextKeys() {
        const keys = this.host.snapshot().messages.map(m => m.key);
        const pending = this.host.pendingReplacement?.();
        if (!pending || !this.store?.state.initialized) return keys;
        const previous = this.store.state.storyKeys;
        // Scope preparation belongs to the existing saved path until a new
        // reply is finalized. In particular, an empty swipe slot must not
        // erase the previous candidate while the card is still preparing.
        return previous.length === pending.prefixKeys.length + 1 && isPrefix(pending.prefixKeys, previous)
            ? clone(previous) : pending.prefixKeys;
    }
    async setContext(input) {
        const target = this.host.snapshot();
        const { epoch, signal } = await this.#readyForChat(target);
        const chatId = target.chatId;
        return untilAborted(this.#contextQueue.run(async () => {
            this.#assertCurrent(epoch, chatId);
            invariant(this.store, '请等待当前聊天载入完成');
            invariant(input && typeof input.owner === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(input.owner), '上下文 owner 无效');
            const activeScopeId = normalizeScopeId(input.activeScopeId);
            invariant(input.requestedScopeIds === undefined || Array.isArray(input.requestedScopeIds), 'requestedScopeIds 必须是数组');
            const requestedScopeIds = [...new Set((input.requestedScopeIds ?? []).map(normalizeScopeId))];
            invariant(requestedScopeIds.length <= 16, '一次最多请求 16 个资料范围');
            invariant(input.deferPost === undefined || typeof input.deferPost === 'boolean', 'deferPost 必须是布尔值');
            if (input.postScopeId !== undefined) normalizeScopeId(input.postScopeId);
            invariant(!this.store.state.data.scopeContext || this.store.state.data.scopeContext.owner === input.owner, '当前聊天已有其他调用方管理资料范围');
            this.#yieldBackground();
            await this.store.idle();
            this.#assertCurrent(epoch, chatId);
            const keys = this.#contextKeys();
            if (this.store.state.initialized) await this.store.reconcile(keys);
            this.#assertCurrent(epoch, chatId);
            const previous = this.store.state.data.scopeContext;
            invariant(!previous || previous.owner === input.owner, '当前聊天已有其他调用方管理资料范围');
            invariant(!(input.deferPost && previous?.deferPost && activeScopeId !== previous.activeScopeId), '等待卡提交期间不能切换当前范围');
            invariant(input.postScopeId === undefined || previous?.deferPost, 'postScopeId 只能用于提交已暂停的本轮');
            const state = this.store.snapshot();
            const messageScopes = {};
            const attribution = previous?.deferPost && !input.deferPost
                ? normalizeScopeId(input.postScopeId ?? activeScopeId)
                : normalizeScopeId(previous?.activeScopeId);
            // Earlier failed work retains its original scope; only new, unassigned
            // narrative is attributed when the card explicitly commits its turn.
            if (!previous?.deferPost || !input.deferPost) {
                for (const key of keys.slice(state.processed.length)) {
                    if (!state.data.messageScopes?.[key]) messageScopes[key] = attribution;
                }
            }
            const context = { owner: input.owner, activeScopeId, requestedScopeIds, deferPost: Boolean(input.deferPost) };
            await this.store.manual({ type: 'scope-context', context, messageScopes }, keys);
            this.#assertCurrent(epoch, chatId);
            if (this.store.initializationCheckpoint()) {
                this.#initializationContextFingerprint = await initializationFingerprint(this.#initializationInputs(this.store));
                this.#assertCurrent(epoch, chatId);
            }
            this.host.clearPlan(); this.#notify();
            if (!context.deferPost && this.#enabled() && this.store.state.initialized) this.maintain({ automatic: true }).catch(() => {});
            if (!context.deferPost && !this.#initializing) this.readinessChanged();
            return { apiVersion: 1, chatId, revision: this.store.state.revision, context: clone(context), pendingCount: keys.length - this.store.state.processed.length };
        }), signal);
    }
    async clearContext(owner) {
        const target = this.host.snapshot();
        const { epoch, signal } = await this.#readyForChat(target);
        const chatId = target.chatId;
        return untilAborted(this.#contextQueue.run(async () => {
            this.#assertCurrent(epoch, chatId);
            invariant(this.store, '请等待当前聊天载入完成');
            invariant(!this.store.state.data.scopeContext || this.store.state.data.scopeContext.owner === owner, '只有上下文 owner 可以清除');
            this.#yieldBackground();
            await this.store.idle();
            this.#assertCurrent(epoch, chatId);
            const keys = this.#contextKeys();
            if (this.store.state.initialized) await this.store.reconcile(keys);
            this.#assertCurrent(epoch, chatId);
            const context = this.store.state.data.scopeContext;
            invariant(!context || context.owner === owner, '只有上下文 owner 可以清除');
            invariant(!context?.deferPost, '请先提交或取消暂停的本轮，再清除范围');
            const messageScopes = {};
            for (const key of keys.slice(this.store.state.processed.length)) {
                if (!this.store.state.data.messageScopes?.[key]) messageScopes[key] = normalizeScopeId(context?.activeScopeId);
            }
            await this.store.manual({ type: 'scope-context', context: null, messageScopes }, keys);
            this.#assertCurrent(epoch, chatId);
            if (this.store.initializationCheckpoint()) {
                this.#initializationContextFingerprint = await initializationFingerprint(this.#initializationInputs(this.store));
                this.#assertCurrent(epoch, chatId);
            }
            this.host.clearPlan(); this.#notify();
            return { apiVersion: 1, chatId, revision: this.store.state.revision, context: null };
        }), signal);
    }
    async readScope(scopeId) {
        normalizeScopeId(scopeId);
        const target = this.host.snapshot();
        const assertBinding = () => {
            const current = this.host.snapshot();
            invariant(current.chatId === target.chatId && this.store?.state.chatId === target.chatId, '存档已切换，本次资料读取已作废');
            invariant(current.bookName === target.bookName && this.store.state.bookName === target.bookName,
                '角色主世界书已改变，请重新扫描后再读取资料；旧资料保留');
        };
        await this.whenCommitted();
        assertBinding();
        invariant(this.store?.state.initialized, '请先完成初始化');
        const epoch = this.#epoch, chatId = target.chatId;
        await this.#loadRules(epoch, chatId);
        this.#assertCurrent(epoch, chatId); assertBinding();
        const save = this.#guarded(this.host.pendingReplacement?.()
            ? this.store.project(this.host.generationSnapshot().messages.map(m => m.key)) : this.store.snapshot());
        return { apiVersion: 1, chatId, revision: save.revision, ...scopeRead(save, scopeId) };
    }
    view() {
        const snapshot = this.host.statusSnapshot?.() ?? this.host.snapshot(), preset = this.#preset(), application = this.#application();
        const activities = [...this.#activities.values()].filter(activity => activity.isCurrent())
            .sort((a, b) => Number(b.kind === 'select') - Number(a.kind === 'select') || b.startedAt - a.startedAt)
            .map(({ id, kind, label, startedAt, phase, cancellable, stopLabel, hint }) => ({ id, kind, label, startedAt, phase, cancellable, stopLabel, hint }));
        return { lazy: this.#lazyView(snapshot), chatId: snapshot.chatId, status: this.status, error: this.error, progress: clone(this.progress), settings: clone(this.settings),
            activity: activities[0] ?? null, activities, autoPostPaused: this.#autoPostPaused,
            initialization: clone(this.#autoInitialization), sourceChanges: clone(this.sourceChanges),
            maintenance: this.#maintenanceSchedule(snapshot), initializationResume: this.initializationResumeSummary(),
            window: this.host.windowStatus?.() ?? { omittedCount: null, reason: this.#hasNarrativeMemory(this.store?.state) ? '实际省略以发送记录为准' : '尚无故事脉络，保留原文' },
            warnings: [...(this.host.getWarnings?.() ?? []), ...(this.store?.state.initialized && this.store.state.processed.length
                && !Array.isArray(this.store.state.rememberedKeys) ? [{ code: 'legacy-history-coverage',
                    message: '旧记忆缺少逐楼阅读记录，无法确认的旧消息会保留原文。需要重新缩减历史时，请先备份聊天，再重新扫描。' }] : [])],
            enabled: this.#enabled(), saveEnabled: this.store?.state.preferences?.enabled !== false,
            activityClaimed: [...this.#activityClaims.values()].some(claim => claim.chatId === snapshot.chatId),
            presetApplication: { ...application, saved: clone(this.store?.state.preferences?.presetApplication ?? null),
                draft: clone(this.#applicationDraft), stale: Boolean(this.store?.state.preferences?.presetApplication
                    && this.store.state.preferences.presetApplication.fingerprint !== application.fingerprint) },
            preset: { name: preset.name, available: Boolean(preset.entries.length),
                stale: Boolean(this.store?.state.preferences?.preset && this.store.state.preferences.preset.fingerprint !== preset.fingerprint),
                saved: clone(this.store?.state.preferences?.preset ?? null), draft: clone(this.#presetDraft) },
            readiness: { chat: Boolean(snapshot.chatId), book: Boolean(snapshot.bookName), template: Boolean(snapshot.templateEnabled), templateStatus: snapshot.templateStatus ?? null, single: !snapshot.group },
            worldbook: this.host.worldbookStatus?.() ?? null,
            worldbookChecking: Boolean(this.#worldbookCheck && this.#worldbookCheck.target.chatId === snapshot.chatId && this.#worldbookCheck.target.bookName === snapshot.bookName),
            save: this.store?.state ? playerView(this.store.state) : null,
            compactable: this.#compactInfo(), errorInfo: clone(this.errorInfo), scanStages: clone(this.scanStages), sourceSync: clone(this.sourceSync),
            authorAlwaysIds: this.store?.state ? Object.values(this.store.state.data.entries).filter(entry => evaluateRules(this.compiledRules, entry).always).map(entry => entry.id) : [],
            gateIds: this.store?.state ? Object.values(this.store.state.data.entries).filter(entry => evaluateRules(this.compiledRules, entry).gate).map(entry => entry.id) : [],
            sourceBook: this.store?.state?.bookName ?? '', connectionMode: this.connectionMode,
            connection: { mode: this.connectionMode, endpoint: this.#connectionConfig?.endpoint ?? '', model: this.#connectionConfig?.model ?? '', maxOutputTokens: this.#connectionConfig?.maxOutputTokens, hasApiKey: Boolean(this.#connectionConfig?.apiKey) },
            connectionProfiles: this.#connectionProfiles.map(profile => ({ name: profile.name, endpoint: profile.endpoint, model: profile.model,
                maxOutputTokens: profile.maxOutputTokens, hasApiKey: Boolean(profile.apiKey), active: sameConnection(profile, this.#connectionConfig) })),
            modelList: clone(this.#modelList), task: clone(this.#streamTask),
            connectionPersist: { state: this.#saveFailures.size ? 'failed' : 'saved',
                lastSaved: this.#persistedConnection?.model ?? '沿用酒馆连接', failures: [...this.#saveFailures.values()],
                pendingName: this.#pendingProfiles?.find(p => sameConnection(p, this.#connectionConfig))?.name ?? null },
            connectionLastRequest: clone(this.diagnostics.requests.findLast(r => r.connectionToken === this.#connectionToken) ?? null),
            mvu: clone(this.mvu), diagnostics: { ...clone(this.diagnostics), memory: memoryMetrics(this.store?.state),
                pendingCount: Math.max(0, snapshot.messages.length - (this.store?.state.processed.length ?? 0)) } };
    }
    subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
    #notify() { for (const fn of this.#listeners) fn(this.view()); }
    #state(status, error = '') {
        this.status = status; this.error = typeof error === 'string' ? error : String(error?.message ?? '');
        this.errorInfo = this.error ? { kind: error?.dwmBlocked ? 'filter' : error?.dwmEntryError ? 'oversize' : error?.kind ?? 'unknown',
            ...(error?.httpStatus ? {status:error.httpStatus} : {}), ...(error?.blockReason ? {code:error.blockReason} : {}), ...(error?.dwmEntryError ? {entry:error.dwmEntryError} : {}) } : null;
        this.#notify();
    }
    #assertCurrent(epoch, chatId) {
        invariant(epoch === this.#epoch && this.host.snapshot().chatId === chatId, '存档已切换，本次处理已作废');
        throwIfAborted(this.#abort.signal);
    }
    async start() { await this.chatChanged(); if(this.settings.lazyMode)queueMicrotask(()=>this.#lazy.kick({event:true})); return this; }
    async checkWorldbook() {
        const target = this.host.snapshot();
        if (this.#worldbookCheck?.target.chatId === target.chatId && this.#worldbookCheck.target.bookName === target.bookName) return this.#worldbookCheck.promise;
        const idle = () => !this.#loading && !this.#initializing && !this.progress && !this.view().activity
            && !this.host.snapshot().generating;
        invariant(idle(), '请等待当前扫描、生成或存档载入完成，再检查世界书');
        invariant(typeof this.host.checkWorldbook === 'function', '当前宿主不支持检查世界书');
        const epoch = this.#epoch, task = { target, promise: null };
        this.#worldbookCheck = task;
        task.promise = Promise.resolve().then(async () => {
            const result = await this.host.checkWorldbook();
            this.#assertCurrent(epoch, target.chatId);
            invariant(this.host.snapshot().bookName === target.bookName, '检查期间主世界书已改变，请重新检查');
            // A user check never starts a model task or replaces an existing
            // memory baseline. Only load a previously unavailable chat when idle.
            if (idle()) {
                if (!this.store && ['ready', 'empty'].includes(result.state)) {
                    await this.chatChanged();
                    invariant(this.host.snapshot().chatId === target.chatId && this.host.snapshot().bookName === target.bookName,
                        '检查期间聊天或主世界书已改变，请重新检查');
                }
                else if (!this.store?.state.initialized) {
                    if (this.#autoInitialization?.state === 'waiting') this.#autoInitialization = null;
                    this.#state(['ready', 'empty'].includes(result.state) ? '主世界书已就绪，可手动建立记忆' : result.message);
                }
            }
            return { executed: true, message: result.message };
        }).finally(() => {
            if (this.#worldbookCheck === task) this.#worldbookCheck = null;
            this.#notify();
        });
        this.#notify();
        return task.promise;
    }
    chatChanged() {
        const target = this.host.snapshot();
        if (this.#loading?.target.chatId === target.chatId && this.#loading.target.bookName === target.bookName
            && !this.#loading.abort.signal.aborted) return this.#loading.promise;
        if (this.#initializing && this.#loadedTarget?.chatId === target.chatId && this.#loadedTarget.bookName === target.bookName) return Promise.resolve();
        this.#loading?.abort.abort(Object.assign(new Error('存档已切换，本次载入已作废'), { name: 'AbortError' }));
        const loading = { target, abort: new AbortController(), promise: null };
        this.#loading = loading;
        // Publish the promise before notifying subscribers. Card listeners may
        // ask for the scope while this same CHAT_CHANGED event is still running.
        loading.promise = Promise.resolve().then(() => untilAborted(this.#loadChat(loading), loading.abort.signal)).catch(error => {
            if (this.#loading === loading && !loading.abort.signal.aborted && this.host.snapshot().chatId === target.chatId
                && this.host.snapshot().bookName === target.bookName) this.#state('存档载入失败，请检查报错后重新打开聊天', error);
            throw error;
        }).finally(() => {
            if (this.#loading === loading) this.#loading = null;
        });
        return loading.promise;
    }
    async #loadChat(loading) {
        this.#lazy?.stop(); this.#lazyDeferredTurn = false; this.#lazyCapacityAttempt = null;
        throwIfAborted(loading.abort.signal);
        invariant(this.#loading === loading && this.host.snapshot().chatId === loading.target.chatId
            && this.host.snapshot().bookName === loading.target.bookName, '存档已切换，本次载入已作废');
        this.store = null; this.#lazy?.bind();
        this.#loadedTarget = null;
        this.cancel('正在切换存档', { keepLoading: true });
        // Another CHAT_CHANGED listener may already have claimed this new chat.
        // Revoke old-chat owners only; a newly issued claim remains valid.
        const currentChatId = this.host.snapshot().chatId;
        for (const [owner, claim] of this.#activityClaims) if (claim.chatId !== currentChatId) this.#activityClaims.delete(owner);
        this.#presetDraft = null;
        this.#applicationDraft = null;
        this.sourceChanges = { changed: false, added: [], removed: [], updated: [] };
        this.#autoInitialization = null;
        this.#initializationSourceFingerprint = ''; this.#initializationContextFingerprint = ''; this.#initializationClassificationFingerprint = '';
        this.#epoch++; this.#streamTask = null; this.scanStages = null; this.sourceSync = null; this.#extraBooks = {}; this.store = null; this.#maintenance = null; this.#initializing = false;
        this.#autoPostPaused = false;
        this.#pausedPostKeys.clear();
        this.diagnostics = { lastPlan: null, lastPreview: null, requests: [] }; this.#compactMarks.clear(); this.#compactAttempts.clear();
        this.mvu = { enabled: this.settings.mvuEnabled, available: false, status: 'unchecked', fields: [], reason: '尚未读取当前聊天' };
        if (this.host.restoreLegacyWindow) await this.host.restoreLegacyWindow();
        await this.#restoreWindow();
        const epoch = this.#epoch, snapshot = this.host.snapshot();
        if (!snapshot.chatId || !snapshot.bookName) { this.#state(this.host.worldbookStatus?.().message ?? '请选择带主世界书的角色聊天'); return; }
        if (snapshot.group) { this.#state('此开发版先支持单角色聊天'); return; }
        const store = new MemoryStore(this.host.storage, { auditLimit: this.settings.auditLimit });
        await untilAborted(store.load(snapshot.chatId, snapshot.bookName, null, { allowBookMismatch: true }), loading.abort.signal);
        this.#assertCurrent(epoch, snapshot.chatId);
        invariant(this.host.snapshot().bookName === snapshot.bookName, '载入期间主世界书已改变，请重新检查');
        this.store = store; this.#lazy?.bind();
        this.#loadedTarget = { chatId: snapshot.chatId, bookName: snapshot.bookName };
        if (store.state.bookName !== snapshot.bookName) {
            this.sourceChanges = { changed: true, rebound: true, added: [], removed: [], updated: [] };
            this.#state('主世界书绑定已改变，旧资料保留；请备份后重新扫描');
            this.#initializationNotice('retry', '主世界书绑定已改变，请备份后重新扫描；成功前保留旧资料', true);
            return;
        }
        let raw;
        try {
            raw = await this.#loadRules(epoch, snapshot.chatId);
            if (store.initializationCheckpoint()) {
                this.#initializationSourceFingerprint = await initializationFingerprint({ raw, rules: this.rules });
                this.#initializationContextFingerprint = await initializationFingerprint(this.#initializationInputs(store));
                this.#initializationClassificationFingerprint = await initializationFingerprint(this.#classificationInputs(store));
                this.#assertCurrent(epoch, snapshot.chatId);
            }
        }
        catch (error) {
            if (store.state.initialized) throw error;
            this.#assertCurrent(epoch, snapshot.chatId);
            this.#state('主世界书暂不可读取，等待就绪', error); return;
        }
        if (store.state.initialized) await store.reconcile(snapshot.messages.map(m => m.key));
        this.#assertCurrent(epoch, snapshot.chatId);
        // Replay can cross an incremental source sync; recheck before the window decides.
        if (raw) this.sourceChanges = sourceBookChanges(store.state, raw, this.rules.configEntryUids, this.#extraBooks);
        await this.#syncWindow();
        this.#state(store.state.initialized ? '可用' : '未初始化');
        if (this.settings.lazyMode) queueMicrotask(() => this.#lazy?.kick({event:true}));
        if (this.settings.mvuEnabled) await this.refreshMvu();
    }
    async #loadRules(epoch = this.#epoch, chatId = this.host.snapshot().chatId, signal = this.#abort.signal) {
        const raw = await untilAborted(this.host.loadWorldbook(), signal);
        this.#assertCurrent(epoch, chatId);
        throwIfAborted(signal);
        this.rules = discoverRules(raw);
        this.compiledRules = compileRules(this.rules.script);
        const sources = [...Object.values(this.store?.state?.base.entries ?? {}), ...Object.values(this.store?.state?.data.entries ?? {})];
        const names = [...new Set(sources.map(e => e.source?.book).filter(book => book && book !== this.store.state.bookName))];
        const external = await Promise.all(names.map(async book => {
            try { return [book, await untilAborted(this.host.loadWorldbook(book), signal)]; } catch { throwIfAborted(signal); return [book, null]; }
        }));
        this.#assertCurrent(epoch, chatId); this.#extraBooks = Object.fromEntries(external);
        this.sourceChanges = sourceBookChanges(this.store?.state, raw, this.rules.configEntryUids, this.#extraBooks);
        this.#nativeRaw = raw;
        if (this.store?.state && this.host.snapshot().bookName !== this.store.state.bookName) {
            this.sourceChanges = { ...this.sourceChanges, changed: true, rebound: true };
        }
        return raw;
    }
    async #assertSourceCurrent(activity) {
        await this.#loadRules(activity.epoch, activity.chatId, activity.signal);
        this.#assertActivity(activity);
        invariant(!this.sourceChanges.changed, '原书已变化：请在“资料”页点“只同步变化的条目”，或备份后重新扫描；旧资料保留，旧处理结果不再采用。');
    }
    cancel(reason = '本轮已取消，记忆未变', { keepLoading = false } = {}) {
        const cancelledInitialization = this.#initializing;
        if (!keepLoading) this.#loading?.abort.abort(Object.assign(new Error('当前载入等待已取消'), { name: 'AbortError' }));
        this.#abort.abort(new Error('已取消'));
        this.#abort = new AbortController();
        this.#epoch++;
        this.#initializing = false; this.#maintenance = null; this.#compacting = false; this.#nativeBypass = false;
        this.#storyDirty = false; this.#maintenancePrefix = null;
        for (const activity of this.#activities.values()) activity.dispose();
        this.#activities.clear();
        for (const release of this.#selectionWaiters) release();
        this.host.clearPlan();
        this.progress = null;
        if (cancelledInitialization && this.store?.state.chatId === this.host.snapshot().chatId) {
            this.#initializationNotice('retry', '扫描已中断，已保存的进度保留；可继续扫描', true);
        }
        this.#state(reason);
    }
    /** Fill-in help for the separate connection. A blank key reuses the saved
     * one only for the same endpoint, exactly as applying a connection does. */
    async fetchModels({ endpoint, apiKey } = {}) {
        const normalized = String(endpoint ?? '').trim().replace(/\/$/, '');
        invariant(normalized, '请先填写接口基础地址');
        const key = apiKey || (normalized === this.#connectionConfig?.endpoint ? this.#connectionConfig.apiKey : '');
        const models = await listModels({ endpoint: normalized, apiKey: key });
        this.#modelList = { endpoint: normalized, models };
        this.#notify();
        return { executed: true, message: `已获取 ${models.length} 个模型，可在“选择模型”下拉框里挑选` };
    }
    async updateConnection({ mode = 'raw', endpoint, model, apiKey, maxOutputTokens }) {
        invariant(!this.view().activity, '请先停止或等待当前任务完成，再应用连接；当前任务继续运行。');
        // Blank means retain the session key only for the same endpoint. Never
        // forward an existing credential when changing to a different server.
        const normalizedEndpoint = endpoint?.trim().replace(/\/$/, '');
        const retainedKey = normalizedEndpoint && normalizedEndpoint === this.#connectionConfig?.endpoint ? this.#connectionConfig.apiKey : '';
        this.#commitConnection(mode, { endpoint: normalizedEndpoint, model, apiKey: apiKey || retainedKey, maxOutputTokens });
    }
    #commitConnection(mode, input) {
        const config = this.#applyConnection(mode, input);
        const saved = ['raw', 'tavern'].includes(mode) ? null : { mode: 'compatible', ...config };
        try { this.connectionStore?.save?.(saved); this.#persistedConnection = clone(saved); this.#saveFailures.delete('connection'); }
        catch (error) { this.#connectionFailure(error, 'connection', saved); }
        this.#state(this.#saveFailures.size ? '连接已切换，仅本次会话有效；本机保存未完成' : '连接已更新');
        this.readinessChanged();
    }
    #connectionFailure(error, stage, value) {
        const name = ['SecurityError', 'QuotaExceededError'].includes(error?.name) ? error.name : 'Error';
        this.#saveFailures.set(stage, { stage, name, ...(Number.isInteger(error?.code) ? {code:error.code} : {}), bytes: new TextEncoder().encode(JSON.stringify(value)).length });
    }
    async retryConnectionSave() {
        invariant(!this.view().activity, '请等待当前任务完成');
        this.#commitConnection(this.connectionMode, this.#connectionConfig ?? {});
        if (this.#pendingProfiles) this.#storeProfiles(this.#pendingProfiles);
        if (this.#saveFailures.size) throw new Error('本机保存仍未完成；当前会话连接保留。');
        return { executed: true, message: '已保存到本机' };
    }
    connectionDiagnostics() {
        return { failures: clone([...this.#saveFailures.values()]), browser: globalThis.navigator?.userAgent ?? '' };
    }

    /** Named separate connections kept in this browser, keys included, so a
     * player can switch between services without retyping them. */
    async saveConnectionProfile(name) {
        const label = String(name ?? '').trim();
        invariant(label && label.length <= PROFILE_NAME_MAX, `配置名称应为 1–${PROFILE_NAME_MAX} 个字`);
        invariant(this.connectionMode === 'compatible' && this.#connectionConfig, '请先应用一个单独的兼容接口，再保存为配置');
        const replacing = this.#connectionProfiles.some(profile => profile.name === label);
        invariant(replacing || this.#connectionProfiles.length < PROFILE_MAX, `最多保存 ${PROFILE_MAX} 套配置，请先删除不用的`);
        const profile = { name: label, ...clone(this.#connectionConfig) };
        this.#storeProfiles(replacing ? this.#connectionProfiles.map(item => item.name === label ? profile : item) : [...this.#connectionProfiles, profile]);
        return { executed: true, message: replacing ? `已更新配置「${label}」` : `已保存配置「${label}」` };
    }
    async useConnectionProfile(name) {
        const profile = this.#connectionProfiles.find(item => item.name === name);
        invariant(profile, '没有找到这套配置');
        invariant(!this.view().activity, '请先停止或等待当前任务完成，再切换连接；当前任务继续运行。');
        // A profile is a full snapshot: restore its key exactly, even when empty.
        // The form's "blank keeps the saved key" rule does not apply here.
        const { name: label, ...config } = profile;
        this.#commitConnection('compatible', config);
        return { executed: true, message: `已切换到「${label}」；下一次辅助任务将使用此连接` };
    }
    async deleteConnectionProfile(name) {
        invariant(this.#connectionProfiles.some(item => item.name === name), '没有找到这套配置');
        this.#storeProfiles(this.#connectionProfiles.filter(item => item.name !== name));
        return { executed: true, message: `已删除配置「${name}」；当前生效的连接不变` };
    }
    #storeProfiles(profiles) {
        try { this.connectionStore?.saveProfiles?.(profiles); }
        catch (error) {
            this.#pendingProfiles = clone(profiles); this.#connectionFailure(error, 'profiles', profiles); this.#notify();
            throw new Error('本机保存失败：命名配置未保存，当前会话连接已切换。可重试保存或导出诊断。');
        }
        this.#pendingProfiles = null; this.#saveFailures.delete('profiles');
        this.#connectionProfiles = profiles;
        this.#notify();
    }
    async setSaveEnabled(enabled) {
        invariant(this.store, '请等待当前存档载入完成');
        const epoch = this.#epoch, chatId = this.host.snapshot().chatId;
        if (!enabled) this.#lazy?.stop();
        if (!enabled) for (const activity of this.#activities.values()) if (activity.kind === 'initialize') {
            activity.abort.abort(Object.assign(new Error('此存档记忆已暂停，初始化结果不再采用'), { name: 'AbortError', dwmCancelled: true }));
        }
        this.#yieldBackground();
        await this.store.updatePreferences({ enabled: Boolean(enabled) });
        this.#assertCurrent(epoch, chatId);
        this.host.clearPlan(); await this.#syncWindow();
        this.#state(enabled ? this.settings.enabled ? '此存档已启用记忆' : '此存档已启用；插件总开关仍关闭' : '此存档记忆已暂停，资料保留');
        this.readinessChanged();
        return { executed: true, message: this.status };
    }
    async updateSettings(patch) {
        if ('lazyMode' in patch) invariant(typeof patch.lazyMode === 'boolean', '模式设置无效');
        if (Object.hasOwn(patch, 'auxiliaryStream')) invariant(typeof patch.auxiliaryStream === 'boolean', '流式响应设置无效');
        const next = { ...this.settings, ...patch, timeoutSettingsVersion: 1 };
        if ('mvuFields' in patch) next.mvuBookName = this.host.snapshot().bookName;
        invariant(Number.isInteger(next.recentTurns) && next.recentTurns >= 1 && next.recentTurns <= 1000, '保留轮数应为 1–1000');
        invariant(['full', 'worldbook'].includes(next.memoryMode), '记忆范围只能是完整记忆或仅动态世界书');
        invariant(['append', 'rewrite'].includes(next.summaryMode), '脉络写法只能是追加或整段重写');
        invariant(Number.isInteger(next.scanConcurrency) && next.scanConcurrency >= 1 && next.scanConcurrency <= 6, '扫描并发数应为 1–6');
        invariant(REASONING_EFFORTS.includes(next.auxReasoningEffort), '辅助思考强度无效');
        invariant(Number.isInteger(next.maintenanceEvery) && next.maintenanceEvery >= 1 && next.maintenanceEvery <= MAINTENANCE_EVERY_MAX, `自动维护间隔应为 1–${MAINTENANCE_EVERY_MAX} 次 AI 回复`);
        for (const key of ['timeoutMs', 'initializationTimeoutMs']) {
            invariant(validTimeout(next[key]), '辅助模型超时时间应为 0（关闭插件限时）或 1000–86400000 毫秒的整数');
        }
        for (const [key, min, max] of [['batchChars', 1, 200000], ['historyBatchChars', 1000, 400000], ['selectionLimit', 1, 200], ['selectionChars', 100, 200000], ['compactChars', 1000, 1000000], ['compactEvery', 1, 1000]]) {
            invariant(Number.isInteger(next[key]) && next[key] >= min && next[key] <= max, `${key} 超出允许范围`);
        }
        invariant(Array.isArray(next.mvuFields) && next.mvuFields.length <= 16 && next.mvuFields.every(field => typeof field.path === 'string' && typeof field.label === 'string'), 'MVU 最多配置16个字段，每项需有路径和名称');
        await this.persistSettings(next);
        this.settings = next;
        if (!next.enabled || !next.lazyMode) this.#lazy?.stop();
        if (!next.enabled) {
            this.#yieldBackground(); this.host.clearPlan();
            for (const activity of this.#activities.values()) if (activity.kind === 'initialize') {
                activity.abort.abort(Object.assign(new Error('插件已停用，初始化结果不再采用'), { name: 'AbortError', dwmCancelled: true }));
            }
            this.#initializationNotice(null);
        }
        if (this.store?.state) await this.#syncWindow();
        if ('mvuEnabled' in patch || 'mvuFields' in patch) await this.refreshMvu();
        this.#notify();
        if (next.enabled) this.readinessChanged();
    }
    async #syncWindow({ duringInitialization = false } = {}) {
        const snapshot = this.host.snapshot();
        if ((this.#initializing && !duringInitialization) || this.#nativeBypass || snapshot.chatId !== this.store?.state?.chatId) return;
        const remembered = new Set(this.store.state.rememberedKeys ?? []);
        const actions = planWindow(snapshot.messages, this.store.state.processed, {
            enabled: this.#enabled() && !this.sourceChanges.changed && this.settings.windowEnabled && !this.#worldbookOnly() && this.#hasNarrativeMemory(this.store.state), recentTurns: this.settings.recentTurns,
            canOmit: message => this.#scopeRemembered(this.store.state, message, remembered),
        });
        if (actions.length) await this.host.applyWindow(actions);
    }
    #hasNarrativeMemory(save) {
        // A successful empty operation list is not proof that old narrative was
        // retained. Keep source text until at least a narrative summary exists.
        return Boolean(save?.data.summary?.trim() || Object.values(save?.data.scopeSummaries ?? {}).some(text => text.trim()));
    }
    #scopeRemembered(save, message, remembered) {
        if (!remembered.has(message.key)) return false;
        const scopeId = save.data.messageScopes?.[message.key] ?? GLOBAL_SCOPE;
        return Boolean(scopeSummary(save.data, scopeId).trim());
    }
    async #restoreWindow() {
        const actions = planWindow(this.host.snapshot().messages, [], { enabled: false, recentTurns: this.settings.recentTurns });
        if (actions.length) await this.host.applyWindow(actions);
    }
    async #waitForInitializationContext(activity) {
        await untilAborted(this.#contextQueue.idle(), activity.signal);
        this.#assertActivity(activity);
        const waiting = () => this.store.state.data.scopeContext?.deferPost || this.host.snapshot().generating;
        if (!waiting()) return;
        this.#updateActivity(activity, { label: '等待本轮正文与状态保存后继续建档', hint: '本轮继续走原生流程；已读世界书保留在内存，尚未替换动态资料。' });
        await new Promise((resolve, reject) => {
            let dispose;
            const finish = error => { dispose?.(); activity.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
            const check = () => { try { this.#assertActivity(activity); if (!waiting()) finish(); } catch (error) { finish(error); } };
            const aborted = () => finish(activity.signal.reason);
            dispose = this.subscribe(check);
            activity.signal.addEventListener('abort', aborted, { once: true });
            check();
        });
    }
    #initializationSnapshot() {
        return this.host.initializationSnapshot?.() ?? this.host.snapshot();
    }
    #initializationInputs(store) {
        return { scopeContext: store.state.data.scopeContext, messageScopes: store.state.data.messageScopes,
            inventoryEnabled: store.state.data.inventoryEnabled, externalSources: this.#externalFingerprintEntries(store), promptRegex: this.host.promptRegexSignature?.() ?? null, ...this.#appliedRequestInputs(store),
            classificationProtocol: 3, historyReadProtocol: 2, batchItems: INITIALIZATION_BATCH_ITEMS };
    }
    /** Only what actually reaches auxiliary requests: the applied preset entries
     * and confirmed language/term preferences. The whole preset and unrelated
     * save preferences used to be fingerprinted, so editing an unselected preset
     * entry, or a preset read differently after a reload, threw away a finished
     * worldbook scan and started it over. */
    #appliedRequestInputs(store) {
        const preferences = store === this.store ? this.#auxiliaryPreferences() : [];
        const application = store === this.store ? this.#applicationEntries().map(({ id, role, position, content }) => ({ id, role, position, content })) : [];
        return { appliedPreferences: preferences, appliedPreset: application, batchChars: this.settings.batchChars };
    }
    #initializationRequestSettings(store) {
        return JSON.stringify(this.#classificationInputs(store));
    }
    #externalFingerprintEntries(store) {
        const sources = new Map([...Object.values(store.state.base.entries), ...Object.values(store.state.data.entries)]
            .filter(e => e.source?.book && e.source.book !== store.state.bookName).map(e => [e.id, e.source]));
        return [...sources].sort(([a],[b])=>a.localeCompare(b)).map(([id,source])=>({id,raw:this.#extraBooks[source.book]?.find(row=>String(row.uid)===String(source.uid))??null}));
    }
    #classificationInputs(store) {
        return { ...this.#appliedRequestInputs(store), externalSources: this.#externalFingerprintEntries(store), classificationProtocol: 3, batchItems: INITIALIZATION_BATCH_ITEMS };
    }
    #initializationIdentity(store) {
        return { saveId: store.state.id, chatId: store.state.chatId, bookName: store.state.bookName, revision: store.state.revision };
    }
    initializationResumeSummary() {
        const save = this.store?.state, checkpoint = save?.initializationCheckpoint;
        if (!this.#initializationSourceFingerprint || !this.#initializationContextFingerprint
            || !checkpoint || checkpoint.version !== 1 || checkpoint.identity?.saveId !== save.id
            || checkpoint.identity.chatId !== save.chatId || checkpoint.identity.bookName !== save.bookName
            || checkpoint.identity.revision !== save.revision
            || checkpoint.sourceFingerprint !== this.#initializationSourceFingerprint
            || checkpoint.inputFingerprint !== this.#initializationContextFingerprint
                && checkpoint.classificationFingerprint !== this.#initializationClassificationFingerprint) return null;
        const historyMatches = checkpoint.inputFingerprint === this.#initializationContextFingerprint;
        return { stage: checkpoint.stage, classifiedBatches: checkpoint.classifiedBatches, totalBatches: checkpoint.totalBatches,
            processedCount: historyMatches ? checkpoint.draft?.processed?.length ?? 0 : 0, updatedAt: checkpoint.updatedAt };
    }
    async initialize({ automatic = false } = {}) {
        invariant(this.store, '请先打开角色聊天');
        invariant(!this.#initializing && !this.#maintenance, '已有处理正在运行');
        const context = this.host.snapshot();
        invariant(context.templateEnabled, templateHint(context.templateStatus));
        invariant(!this.store.state.data.scopeContext?.deferPost && !context.generating, '请等待本轮正文与状态保存完成，再开始初始化');
        const epoch = this.#epoch, targetStore = this.store;
        let activity, signal;
        this.#initializing = true;
        try {
            this.host.clearPlan();
            this.#autoPostPaused = false;
            activity = this.#beginActivity('initialize', '正在读取角色世界书');
            signal = activity.signal;
            this.#initializationNotice('running', automatic ? '正在自动建立新档记忆' : '正在建立存档记忆');
            this.#state('初始化中；继续发送将使用原生流程');
            if (automatic && !targetStore.state.preferences?.autoInitialization) {
                // Mark the first automatic attempt before spending a model call.
                // Manual retries retain this marker and the already saved checkpoint.
                await this.#saveActivity(activity, () => targetStore.updatePreferences({ autoInitialization: { attemptedAt: new Date().toISOString() } }));
            }
            const raw = await this.#loadRules(epoch, context.chatId, signal);
            const sourceFingerprint = await initializationFingerprint({ raw, rules: this.rules });
            this.#assertActivity(activity);
            this.#initializationSourceFingerprint = sourceFingerprint;
            const requestSettings = this.#initializationRequestSettings(targetStore);
            const assertSettings = () => invariant(requestSettings === this.#initializationRequestSettings(targetStore), '初始化设置或预设已变化，请手动重试；原资料保留');
            let inputFingerprint = await initializationFingerprint(this.#initializationInputs(targetStore));
            this.#assertActivity(activity); assertSettings();
            this.#initializationContextFingerprint = inputFingerprint;
            const classificationFingerprint = await initializationFingerprint(this.#classificationInputs(targetStore));
            this.#initializationClassificationFingerprint = classificationFingerprint;
            const entries = raw.filter(e => !this.rules.configEntryUids.includes(e.uid)).map(e => makeSourceEntry(context.bookName, e));
            // Reinitialization retains the explicit external selection, not every row in those books.
            const selectedExtra = new Map(), retainedExternal = new Map(), retainedBases = {};
            for (const entry of [...Object.values(targetStore.state.base.entries), ...Object.values(targetStore.state.data.entries)]) {
                if (entry.source?.external === true && entry.source.book !== context.bookName) selectedExtra.set(entry.id, entry);
            }
            for (const copy of selectedExtra.values()) {
                const source = copy.source, book = this.#extraBooks[source.book];
                const row = Array.isArray(book) ? book.find(e => String(e.uid) === String(source.uid)) : null;
                if (row) { const entry = makeSourceEntry(source.book, row); entry.source.external = true; entries.push(entry); }
                else {
                    const retained = createEntry(clone(copy)); entries.push(retained); retainedExternal.set(retained.id, retained);
                    retainedBases[retained.id] = clone(targetStore.state.base.entries[retained.id] ?? retained);
                }
            }

            assertSourceCapacity(targetStore.state, entries, {replace:true,baseEntries:retainedBases});
            // Disabled and pure-script entries are settled without a model call.
            const { settled, pending } = prescan(entries.filter(e => !retainedExternal.has(e.id)));
            for (const [id, entry] of retainedExternal) settled.set(id, entry);
            const groups = batches(classificationPieces(pending, this.settings.batchChars), this.settings.batchChars, entryText, INITIALIZATION_BATCH_ITEMS);
            let checkpoint = targetStore.initializationCheckpoint();
            let resetCheckpoint = false;
            if (checkpoint?.sourceFingerprint !== sourceFingerprint || checkpoint?.inputFingerprint !== inputFingerprint
                && checkpoint?.classificationFingerprint !== classificationFingerprint
                || checkpoint?.totalBatches !== groups.length) { resetCheckpoint = Boolean(checkpoint); checkpoint = null; }
            if (checkpoint) {
                // A truncated/corrupt checkpoint must never certify missing or
                // rewritten source entries merely because its header matches.
                try {
                    const restored = checkpoint.stage === 'history' ? Object.values(checkpoint.draft.base.entries).filter(entry => !settled.has(entry.id)) : checkpoint.classification.entries;
                    const expected = checkpoint.stage === 'history' ? pending : groups.slice(0, checkpoint.classifiedBatches).flat();
                    const byId = new Map(restored.map(entry => [entry.id, entry]));
                    invariant(restored.length === expected.length && byId.size === expected.length && expected.every(source => {
                        const entry = byId.get(source.id);
                        return entry && entryText(entry) === entryText(source) && entry.source?.book === source.source.book
                            && entry.source.uid === source.source.uid && entry.source.original === source.source.original
                            && JSON.stringify(entry.source.metadata) === JSON.stringify(source.source.metadata);
                    }), '初始化断点原书不完整');
                } catch { resetCheckpoint = true; checkpoint = null; }
            }
            const baseCheckpoint = () => ({ version: 1, sourceFingerprint, inputFingerprint, classificationFingerprint, targetBookName: context.bookName,
                identity: this.#initializationIdentity(targetStore), classifiedBatches: 0, totalBatches: groups.length });
            checkpoint ??= { ...baseCheckpoint(), stage: 'classification', classification: { entries: [], strategies: [] } };
            let classified = checkpoint.stage === 'history' ? Object.values(checkpoint.draft.base.entries) : checkpoint.classification.entries;
            let strategies = checkpoint.classification?.strategies ?? [];
            let strategy = checkpoint.stage === 'history' ? checkpoint.draft.base.strategy : checkpoint.strategy;
            // Classification inputs do not include the live card scope. A card
            // can finish its first turn while these independent book batches run.
            const saveClassification = async () => {
                this.#assertActivity(activity); assertSettings();
                const identity = this.#initializationIdentity(targetStore);
                inputFingerprint = await initializationFingerprint(this.#initializationInputs(targetStore));
                this.#assertActivity(activity); assertSettings();
                checkpoint = { ...checkpoint, identity, inputFingerprint, classificationFingerprint, updatedAt: new Date().toISOString() };
                await this.#saveActivity(activity, () => targetStore.saveInitializationCheckpoint(checkpoint, {
                    expectedRevision: identity.revision, isCurrent: () => { this.#assertActivity(activity); assertSettings(); },
                }));
                this.#initializationContextFingerprint = inputFingerprint;
            };
            // Book batches are independent: keep a few in flight, but accept and
            // checkpoint them strictly in order so progress stays a contiguous
            // prefix and one slow batch never holds back saving finished ones.
            const wave = this.settings.lazyMode ? 1 : Math.max(1, Math.min(6, Number.isInteger(this.settings.scanConcurrency) ? this.settings.scanConcurrency : 1));
            this.scanStages = { books: {done: checkpoint.classifiedBatches,total:groups.length}, history: null, ...(resetCheckpoint ? {restartNote:'旧扫描断点与当前协议或输入不一致，已重新开始扫描；正式资料保留。'} : {}) };
            const inFlight = new Map(), budget = scanBudget(this.settings.batchChars);
            let nextBatch = checkpoint.classifiedBatches;
            const launch = () => {
                if (this.settings.lazyMode && (this.#lazyDeferredTurn || this.host.snapshot().generating)) return;
                while (nextBatch < groups.length && inFlight.size < wave) {
                    const index = nextBatch++;
                    const request = classifyOrDefer(this.client, groups[index], this.rules.naturalLanguage, signal, budget);
                    request.catch(() => {}); // Observed in order below; never an unhandled rejection.
                    inFlight.set(index, request);
                }
            };
            await this.#lazyScanPause(activity); launch();
            for (let i = checkpoint.classifiedBatches; i < groups.length; i++) {
                this.progress = { stage: '扫描世界书', done: i, total: groups.length }; this.#notify();
                this.#updateActivity(activity, { label: `扫描世界书 ${i + 1}/${groups.length}` });
                if (!inFlight.has(i)) { await this.#lazyScanPause(activity); launch(); }
                const result = await inFlight.get(i); inFlight.delete(i);
                this.#assertActivity(activity); assertSettings();
                classified.push(...result.entries); strategies.push(result.strategy);
                this.scanStages.books.done = i + 1;
                checkpoint = { ...checkpoint, stage: i + 1 === groups.length ? 'strategy' : 'classification',
                    classifiedBatches: i + 1, classification: { entries: classified, strategies } };
                await saveClassification();
                launch();
            }
            // A history-stage checkpoint already holds the settled entries.
            const byId = new Map([...settled.values(), ...classified].map(entry => [entry.id, entry]));
            const ruled = applyRules(joinClassifications(entries, [...byId.values()]), this.compiledRules);
            this.constraints = ruled.constraints;
            await this.#lazyScanPause(activity);
            if (strategy === undefined) {
                this.progress = { stage: '统合记忆策略', done: 0, total: 1 };
                this.#updateActivity(activity, { label: '正在统合记忆策略' });
                strategy = await alignStrategy(this.client, strategies, ruled.entries.filter(entry => entry.status !== DEFERRED), this.rules.naturalLanguage, signal);
                checkpoint = { ...checkpoint, stage: 'strategy', strategy };
                await saveClassification();
            }
            let committed = false;
            // Live scope changes invalidate only the historical draft in this
            // attempt. Already accepted classification remains available here.
            for (let attempt = 0; attempt < 3 && !committed; attempt++) {
                await this.#waitForInitializationContext(activity); assertSettings();
                const identity = this.#initializationIdentity(targetStore), baseRevision = identity.revision;
                inputFingerprint = await initializationFingerprint(this.#initializationInputs(targetStore));
                this.#assertActivity(activity); assertSettings();
                const assertDraftCurrent = () => {
                    this.#assertActivity(activity); assertSettings();
                    if (targetStore.state.revision !== baseRevision) throw Object.assign(new Error('初始化期间资料范围已变化'), { dwmInitializationChanged: true });
                };
                const savedCheckpoint = targetStore.initializationCheckpoint();
                const previousDraft = savedCheckpoint?.stage === 'history' && savedCheckpoint.sourceFingerprint === sourceFingerprint
                    && savedCheckpoint.inputFingerprint === inputFingerprint ? savedCheckpoint.draft : null;
                const draft = new MemoryStore({ read: async () => previousDraft, write: async (_chatId, value) => {
                    assertDraftCurrent();
                    const nextCheckpoint = { version: 1, stage: 'history', sourceFingerprint, inputFingerprint, classificationFingerprint, identity, targetBookName: context.bookName,
                        classifiedBatches: groups.length, totalBatches: groups.length, updatedAt: new Date().toISOString(), draft: value };
                    await targetStore.saveInitializationCheckpoint(nextCheckpoint, { expectedRevision: baseRevision, isCurrent: assertDraftCurrent });
                    this.#initializationContextFingerprint = inputFingerprint;
                } }, { auditLimit: this.settings.auditLimit });
                try {
                    await draft.load(context.chatId, context.bookName); assertDraftCurrent();
                    if (!previousDraft) {
                        draft.state.data.scopeContext = clone(targetStore.state.data.scopeContext ?? null);
                        draft.state.data.messageScopes = clone(targetStore.state.data.messageScopes ?? {});
                        draft.state.data.inventoryEnabled = targetStore.state.data.inventoryEnabled;
                        await this.#saveActivity(activity, () => draft.initialize(ruled.entries, strategy, { baseEntries: retainedBases }));
                    }
                    await this.#saveActivity(activity, () => draft.reconcile(this.host.snapshot().messages.map(m => m.key)));
                    await this.#processBatches(draft, this.#initializationSnapshot().messages, signal, activity);
                    await this.#waitForInitializationContext(activity); assertDraftCurrent();
                    // Strong sends during scanning use native prompts and are
                    // caught up only after their selected reply/scope settles.
                    const latest = this.#initializationSnapshot().messages, keys = latest.map(m => m.key);
                    if (!isPrefix(draft.state.processed, keys)) await this.#saveActivity(activity, () => draft.reconcile(keys));
                    if (draft.state.processed.length < latest.length) await this.#processBatches(draft, latest, signal, activity);
                    assertDraftCurrent();
                    if (targetStore.state.data.scopeContext?.deferPost || this.host.snapshot().generating) continue;
                    const latestRaw = await this.#loadRules(epoch, context.chatId, signal);
                    const latestFingerprint = await initializationFingerprint({ raw: latestRaw, rules: discoverRules(latestRaw) });
                    this.#assertActivity(activity);
                    this.#initializationSourceFingerprint = latestFingerprint;
                    invariant(latestFingerprint === sourceFingerprint, '扫描期间原书或规则已变化，已有资料保留，请重试');
                    assertDraftCurrent();
                    const commitKeys = this.host.snapshot().messages.map(message => message.key);
                    if (targetStore.state.data.scopeContext?.deferPost || this.host.snapshot().generating
                        || draft.state.processed.length !== commitKeys.length || !isPrefix(draft.state.processed, commitKeys)) continue;
                    await this.#saveActivity(activity, () => targetStore.replaceFromDraft(draft.snapshot(), baseRevision));
                    this.sourceChanges = sourceBookChanges(targetStore.state, latestRaw, this.rules.configEntryUids, this.#extraBooks);
                    committed = true;
                } catch (error) {
                    this.#assertActivity(activity);
                    if (!error.dwmInitializationChanged && !error.dwmInitializationPathChanged) throw error;
                }
            }
            invariant(committed, '扫描期间状态持续变化，原资料保留；请在本轮结束后重试初始化');
            this.#assertActivity(activity);
            await this.#saveActivity(activity, () => this.#syncWindow({ duringInitialization: true }));
            this.#assertActivity(activity);
            const reviewCount = Object.values(targetStore.state.data.entries).filter(entry => entry.needsReview).length;
            const blockedCount = Object.values(targetStore.state.data.entries).filter(entry => entry.scanBlocked).length;
            const completed = this.#enabled() ? '存档扫描已完成，记忆已启用' : '存档扫描已完成；记忆尚未启用';
            this.#state(`${completed}${reviewCount ? `；其中 ${reviewCount} 条待核对，请在“资料”查看` : ''}${blockedCount ? `；${blockedCount} 条被辅助接口的内容审核拒收，暂按原世界书发送` : ''}`);
            this.#initializationNotice(null);
            await this.#lazyManualSuccess('init');
            return { executed: true, message: this.status };
        } catch (error) {
            if (epoch === this.#epoch) {
                if (!signal?.aborted) this.#state('初始化未完成，保留原资料', error);
                this.#initializationNotice('retry', signal?.aborted ? '初始化已停止，原资料保留；可手动重试' : `初始化未完成：${error.message}；可手动重试`, true);
            }
            throw error;
        }
        finally { if (epoch === this.#epoch) { this.#initializing = false; this.progress = null; } this.#endActivity(activity); }
    }
    async #processBatches(store, messages, signal, activity) {
        const keys = messages.map(m => m.key), regexSignature = this.host.promptRegexSignature?.();
        const pending = messages.slice(store.state.processed.length);
        const scopes = store.state.data.messageScopes ?? {};
        const activeScopeId = normalizeScopeId(store.state.data.scopeContext?.activeScopeId);
        invariant(!store.state.data.scopeContext?.deferPost, '卡尚未提交本轮范围，后置等待中');
        const scoped = pending.map(message => ({ ...message, scopeId: normalizeScopeId(scopes[message.key] ?? message.scopeId ?? activeScopeId) }));
        const runs = [];
        for (const message of scoped) {
            if (runs.at(-1)?.[0].scopeId === message.scopeId) runs.at(-1).push(message);
            else runs.push([message]);
        }
        // Initialization reads long histories: each batch carries fixed memory
        // overhead, so it uses larger batches than per-turn maintenance.
        const limit = activity.kind === 'initialize' ? this.settings.historyBatchChars ?? this.settings.batchChars : this.settings.batchChars;
        const groups = runs.flatMap(run => batches(run, limit));
        let count = store.state.processed.length, condenseFailed = false;
        const storyRevision = this.#storyRevision;
        if (activity.kind === 'initialize' && this.scanStages) this.scanStages.history = {done:0,total:groups.length};
        try { for (const [batchIndex, batch] of groups.entries()) {
            await this.#lazyScanPause(activity);
            // Published before any wait in this iteration (selection, MVU), so an
            // edit during those waits is judged against this batch, not the last.
            const batchPrefix = keys.slice(0, count + batch.length);
            if (store === this.store) this.#maintenancePrefix = batchPrefix;
            this.#assertActivity(activity);
            if (store === this.store) await this.#afterSelection(activity);
            if (store === this.store && this.#selecting()) break;
            // Later batches were cut from a story that has since changed; stop
            // here and let maintain() restart once on the current messages.
            if (store === this.store && this.#storyRevision !== storyRevision) { this.#storyDirty = true; break; }
            this.progress = { stage: '维护剧情记忆', done: count, total: messages.length }; this.#notify();
            this.#updateActivity(activity, { label: activity.kind === 'initialize' ? `扫描历史剧情 ${count}/${messages.length}` : `正在整理最近 ${messages.length - count} 条消息` });
            const before = store.snapshot();
            const scopeId = batch[0].scopeId;
            invariant(batch.every(message => message.scopeId === scopeId), '混合范围批次需要明确逐楼归属');
            let observedState = null;
            // Never apply today's variables to earlier initialization/catch-up batches.
            if (store === this.store && this.settings.mvuEnabled && batch.at(-1)?.key === this.host.snapshot().messages.at(-1)?.key) {
                const projection = await untilAborted(this.refreshMvu(), signal);
                this.#assertActivity(activity);
                observedState = this.#observedState(projection, this.host.snapshot(), batch);
            }
            const ignored = new Set(this.store?.state.preferences?.lazy?.ignored ?? []);
            const readable = batch.filter(message => isReadableMessage(message) && !ignored.has(message.key)), evidence = readable.map(m => m.key);
            const view = this.#taskView(this.#guarded(before));
            const assertPath = async end => {
                this.#assertActivity(activity);
                if (store === this.store) await this.#afterSelection(activity);
                if (store === this.store) await this.#assertSourceCurrent(activity);
                invariant(regexSignature === this.host.promptRegexSignature?.(), '发送正则已变化，旧处理结果未采用；请重试。');
                if (!isPrefix(keys.slice(0, end), this.host.snapshot().messages.map(message => message.key))) {
                    throw Object.assign(new Error('当前剧情候选已变化，旧整理结果不再提交'), { dwmInitializationPathChanged: store !== this.store });
                }
            };
            if (store === this.store && !isPrefix(batchPrefix, this.host.snapshot().messages.map(message => message.key))) { this.#storyDirty = true; break; }
            // Large memories send only the entries this batch touches in full.
            let result;
            try { result = readable.length ? await maintain(this.client, view, readable, signal, scopeId, observedState,
                candidate => this.#validateGuarded(before, candidate, evidence, scopeId), { focus: maintenanceFocus(view, scopeId, readable) }) : { operations: [] }; }
            catch (error) { error.dwmFloors = {from:count+1,to:count+batch.length,keys:batch.map(m=>m.key)}; throw error; }
            await assertPath(count + batch.length);
            this.#validateGuarded(before, result, evidence, scopeId);
            count += batch.length;
            if (activity.kind === 'initialize' && this.scanStages?.history) this.scanStages.history.done = batchIndex + 1;
            await this.#saveActivity(activity, () => store.commit(result, { expectedRevision: before.revision, sourceKeys: keys.slice(0, count),
                allowedEvidence: evidence, maxChars: this.#maxChars(before), scopeId }));
            this.#assertActivity(activity);
            if (result.needEntries?.length) await this.#maintainFollowUp(store, readable, keys.slice(0, count), result.needEntries, { signal, activity, scopeId, assertPath: () => assertPath(count) });
            if (!condenseFailed && !this.#worldbookOnly() && scopeSummary(store.state.data, scopeId).length >= SUMMARY_COMPACT_CHARS) {
                condenseFailed = !await this.#condenseSummary(store, scopeId, { signal, activity });
            }
        } } finally { if (store === this.store) this.#maintenancePrefix = null; }
    }
    /** Entries the first pass saw only in the catalog get one targeted pass.
     * The batch itself is already committed; a failure here costs only these updates. */
    async #maintainFollowUp(store, readable, sourceKeys, ids, { signal, activity, scopeId, assertPath }) {
        const before = store.snapshot(), evidence = readable.map(m => m.key);
        try {
            const view = this.#taskView(this.#guarded(before));
            const result = await maintain(this.client, view, readable, signal, scopeId, null,
                candidate => this.#validateGuarded(before, candidate, evidence, scopeId), { focus: new Set(ids), followUp: true });
            await assertPath();
            if (!result.operations.length) return;
            this.#validateGuarded(before, result, evidence, scopeId);
            await this.#saveActivity(activity, () => store.commit(result, { expectedRevision: before.revision, sourceKeys,
                allowedEvidence: evidence, maxChars: this.#maxChars(before), scopeId }));
            this.#assertActivity(activity);
        } catch (error) {
            this.#assertActivity(activity);
            if (signal?.aborted || error.name === 'AbortError' || error.dwmInitializationPathChanged || error.dwmYielded) throw error;
            if(this.settings.lazyMode)throw Object.assign(error,{dwmLazyFollowUp:{ids,keys:sourceKeys,scopeId,readableKeys:readable.map(m=>m.key)}});
            console.warn('[鱼忆] 补充条目更新未完成，本批其余结果已保存', error);
        }
    }
    /** The running summary only grows during maintenance; rewrite it once it
     * passes the threshold so later batches stay small. Returns false on failure. */
    async #condenseSummary(store, scopeId, { signal, activity }) {
        const before = store.snapshot();
        try {
            const result = await compact(this.client, this.#guarded(before), signal, scopeId, { summaryOnly: true });
            this.#assertActivity(activity);
            result.operations = result.operations.filter(op => op.type === 'summary');
            if (!result.operations.length) return false;
            this.#validateGuarded(before, result, [], scopeId);
            await this.#saveActivity(activity, () => store.commit(result, { expectedRevision: before.revision, sourceKeys: before.processed,
                allowedEvidence: [], maxChars: this.#maxChars(before), reason: 'compact', scopeId }));
            this.#assertActivity(activity);
            return true;
        } catch (error) {
            this.#assertActivity(activity);
            if (signal?.aborted || error.name === 'AbortError' || error.dwmYielded) throw error;
            console.warn('[鱼忆] 常驻脉络整理未完成，稍后重试', error);
            if(this.settings.lazyMode)throw Object.assign(error,{dwmLazyPhase:'compact'});
            return false;
        }
    }
    #maxChars(save) {
        return Object.fromEntries(Object.values(save.data.entries).flatMap(entry => {
            const rule = evaluateRules(this.compiledRules, entry);
            return rule.maxChars ? [[entry.id, rule.maxChars]] : [];
        }));
    }
    #maintenanceSchedule(snapshot = this.host.snapshot()) {
        const pending = snapshot.messages.slice(this.store?.state.processed.length ?? 0);
        const pendingReplies = pending.filter(message => message.role === 'assistant' && String(message.content ?? '').trim()).length;
        const full = pending.reduce((sum, message) => sum + String(message.content ?? '').length, 0) >= this.settings.batchChars;
        return { every: this.settings.maintenanceEvery, pendingReplies, waiting: pending.length > 0 && pendingReplies < this.settings.maintenanceEvery && !full };
    }
    async maintain({ automatic = false, lazyOwned = false } = {}) {
        if (automatic && this.settings.lazyMode && !lazyOwned) return this.#lazy.kick();
        if (this.host.pendingReplacement?.()) return { executed: false, reason: '正在重新生成回复，完成后再更新记忆' };
        if (automatic) this.#resumePostForNewReply();
        if (automatic && this.#autoPostPaused) return { executed: false, reason: '自动整理已暂停，下一条回复后恢复' };
        if (this.#maintenance) return this.#maintenance;
        if (this.#selecting()) return { executed: false, reason: '正在准备本轮资料，稍后自动补记' };
        if (this.store?.state.data.scopeContext?.deferPost) return { executed: false, reason: '角色卡正在确认本轮归属，稍后自动补记' };
        if (!this.#enabled()) return { executed: false, reason: '记忆已暂停，请先启用当前存档与插件总开关' };
        invariant(this.store?.state.initialized, '请先完成初始化');
        invariant(!this.#initializing, '初始化正在处理历史');
        const schedule = this.#maintenanceSchedule();
        if (automatic && schedule.waiting && !this.error) {
            const reason = `已积累 ${schedule.pendingReplies}/${schedule.every} 轮，达到间隔后自动补记；待补记原文保留`;
            this.#state(reason); return { executed: false, reason };
        }
        this.#autoPostPaused = false;
        const activity = this.#beginActivity('maintain', '后置正在读取记忆规则');
        const epoch = this.#epoch, signal = activity.signal, store = this.store;
        const task = async () => {
            this.#state('正在维护');
            try {
                await this.#loadRules(epoch, store.state.chatId, signal);
                invariant(!this.sourceChanges.changed, '原书已变化：请在“资料”页点“只同步变化的条目”，或备份后在设置中重新扫描；旧动态资料保留。');
                const messages = this.host.snapshot().messages;
                await this.#saveActivity(activity, () => store.reconcile(messages.map(m => m.key)));
                await this.#processBatches(store, messages, signal, activity);
                this.#assertActivity(activity);
                await this.#saveActivity(activity, () => this.#syncWindow());
                this.#assertActivity(activity);
                const remaining = store.state.processed.length < this.host.snapshot().messages.length;
                this.#state(remaining ? '待补记原文已保留，继续对话后补齐' : '补记已完成');
                await this.#lazyManualSuccess('maintain');
                return { executed: true, message: this.status };
            } catch (error) {
                if (error.dwmYielded) return { executed: false, reason: '后台整理已让出，优先处理本轮；未记原文保留' };
                if (epoch === this.#epoch && !signal.aborted) this.#state('记忆待补齐，可继续对话', error); throw error;
            }
            finally { if (epoch === this.#epoch) this.progress = null; this.#endActivity(activity); }
        };
        const pending = task();
        this.#maintenance = pending;
        try { return await pending; } finally {
            if (this.#maintenance === pending) this.#maintenance = null;
            if (this.#storyDirty && epoch === this.#epoch) {
                this.#storyDirty = false;
                // Automatic continuation: skipped while the player has paused
                // automatic maintenance, and never clears that pause.
                Promise.resolve().then(() => epoch === this.#epoch && !this.#autoPostPaused && (this.settings.lazyMode ? this.#lazy.kick() : this.maintain())).catch(() => {});
            }
        }
    }
    async previewPlan() {
        const activity = this.#beginActivity('preview', '正在试选本轮资料');
        this.#state('正在试选资料');
        try {
            return await this.#withSelection(async () => {
                await this.#loadRules(activity.epoch, activity.chatId, activity.signal);
                const replacing = Boolean(this.host.pendingReplacement?.());
                if (!replacing) await this.#saveActivity(activity, () => this.store?.reconcile(this.host.snapshot().messages.map(m => m.key)));
                const plan = await this.#buildPlan(activity, { project: replacing,
                    readSnapshot: () => replacing ? this.host.generationSnapshot() : this.host.snapshot() });
                this.#recordPlan(plan, 'preview');
                this.#state('试选已完成（未发送）');
                return plan;
            }, activity);
        } catch (error) {
            if (activity.epoch === this.#epoch && !activity.signal.aborted) this.#state('试选未完成', error);
            throw error;
        } finally { this.#endActivity(activity); }
    }
    registerPreviewSource({ id, title, read }) {
        invariant(typeof id === 'string' && id.length <= 100 && typeof title === 'string' && typeof read === 'function', '预览来源格式无效');
        const source = { id, title, read };
        this.#previewSources.set(id, source);
        return () => { if (this.#previewSources.get(id) === source) this.#previewSources.delete(id); };
    }
    async previewPrompts() {
        const inspect = () => this.host.previewSnapshot?.() ?? this.host.snapshot();
        const snapshot = inspect(), epoch = this.#epoch;
        invariant(snapshot.chatId && snapshot.bookName, '请先打开带主世界书的角色聊天');
        const save = this.store?.snapshot() ?? null, settings = clone(this.settings), presetFingerprint = this.#preset().fingerprint, applicationFingerprint = this.#application().fingerprint;
        const unchanged = () => {
            const latest = inspect();
            invariant(epoch === this.#epoch && latest.chatId === snapshot.chatId && latest.bookName === snapshot.bookName
                && JSON.stringify(latest.messages) === JSON.stringify(snapshot.messages) && latest.userInput === snapshot.userInput
                && this.store?.state?.revision === save?.revision && JSON.stringify(this.settings) === JSON.stringify(settings) && this.#preset().fingerprint === presetFingerprint && this.#application().fingerprint === applicationFingerprint,
            '读取期间存档、输入或资料有变化，请刷新预览');
        };
        // Read rules locally: no reconcile, clearPlan, initialization, trace or model call.
        const rawEntries = await this.host.loadWorldbook(snapshot.bookName);
        unchanged();
        const rules = discoverRules(rawEntries), compiledRules = compileRules(rules.script);
        const names = [...new Set([...Object.values(save?.base.entries ?? {}), ...Object.values(save?.data.entries ?? {})].map(e=>e.source?.book).filter(book=>book&&book!==snapshot.bookName))];
        const extraBooks = Object.fromEntries(await Promise.all(names.map(async book=>{try{return [book,await this.host.loadWorldbook(book)]}catch{return [book,null]}})));
        unchanged();
        const sourceChanged = sourceBookChanges(save, rawEntries, rules.configEntryUids, extraBooks).changed;
        // Selection and injection read the book's live switches; maintenance does not.
        const liveSave = nativeSwitchOverlay(save, rawEntries, extraBooks);
        let projection = null;
        if (settings.mvuEnabled && settings.mvuBookName === snapshot.bookName && this.host.readMvu) {
            try { projection = await this.host.readMvu(settings); } catch { /* Optional observation stays unknown. */ }
        }
        unchanged();
        const observedState = this.#observedState(projection, snapshot, snapshot.messages);
        const scopes = readableScopes(save?.data.scopeContext);
        // The same gate as sending, so the preview's catalog and must-send list agree with it.
        const gate = liveSave?.initialized ? applyGate(liveSave, snapshot.messages.filter(isReadableMessage), snapshot.userInput, { rules: entry => evaluateRules(compiledRules, entry) })
            : { gated: new Set(), save: liveSave };
        const eligible = entry => scopes.has(entryScope(entry)) && !gate.gated.has(entry.id) && (this.host.previewEligible ? this.host.previewEligible(entry) : entry.enabled);
        const result = buildPromptPreview({ snapshot, save, selectionSave: gate.save, settings, rules, compiledRules, rawEntries, eligible,
            connectionMode: this.connectionMode, observedState,
            busy: { initializing: this.#initializing, maintaining: Boolean(this.#maintenance), compacting: this.#compacting } });
        const sourceWarning = '原书已变化：旧基准的前置、后置和记忆注入暂不可用。请先导出聊天 JSONL 备份并重新扫描，或在发送时明确选择按原书发送。';
        if (sourceChanged) {
            result.warnings.push(sourceWarning);
            for (const stage of result.stages) if (['fish-select', 'fish-maintain'].includes(stage.agent.id)) {
                Object.assign(stage, { status: 'unavailable', input: null, explanation: sourceWarning, uncertainties: [sourceWarning] });
            }
        }
        const currentSave = !sourceChanged && save?.chatId === snapshot.chatId && save?.bookName === snapshot.bookName
            && isPrefix(save.processed, snapshot.messages.map(m => m.key)) ? gate.save : null;
        const narration = previewNarration(currentSave, { eligible, compiledRules, configEntryUids: rules.configEntryUids });
        if (sourceChanged) { narration.status = 'unavailable'; narration.explanation = sourceWarning; }
        else if (!currentSave && save?.initialized) narration.explanation = '保存快照不属于当前聊天或所选剧情；实际发送会先载入或回放，当前不展示旧片段。';
        for (const stage of result.stages) {
            if (stage.input) {
                const adapted = applyPresetApplication(applyAuxiliaryPreferences({ system: stage.system, input: stage.input }, this.#auxiliaryPreferences()), this.#applicationEntries());
                stage.system = adapted.system; stage.input = adapted.input;
                if (adapted.head) stage.head = adapted.head;
                if (adapted.tail) stage.tail = adapted.tail;
            }
        }
        if (save?.preferences?.preset && save.preferences.preset.fingerprint !== this.#preset().fingerprint) result.warnings.push('当前预设已改变，旧辅助偏好暂不采用；请在预设应用中重新检查并确认。');
        if (save?.preferences?.presetApplication && save.preferences.presetApplication.fingerprint !== applicationFingerprint) result.warnings.push('预设已改变，旧预设副本暂不应用；请到预设应用重新确认。');
        result.stages.unshift(narration);
        result.warnings.push('预览按普通发送与点击刷新时的输入草稿计算；重生成、续写、宏展开、原生预算和第三方处理可能改变最终请求。实际发送仍以“实际记录”为准。');
        if (save && !isPrefix(save.processed, snapshot.messages.map(m => m.key))) result.warnings.push('当前候选回复与已存记忆路径不一致；实际发送会先校正记忆，下列内容暂按保存快照展示。');
        if (save?.data.scopeContext?.owner) result.warnings.push('角色卡管理了资料范围：发送前卡的流程判定可能先切换可读取范围，下列鱼忆选材仍基于此刻范围。');
        for (const source of [...this.#previewSources.values()]) {
            const provider = { id: source.id, title: source.title };
            const unknownAgent = () => ({ id: `${encodeURIComponent(source.id)}:unassigned`, title: `${source.title} · 未标注 Agent`,
                description: '该来源未标注这些阶段的 Agent 归属，不能据此确定 Agent 数量或职责。', identified: false });
            let timer;
            try {
                const external = await Promise.race([Promise.resolve().then(() => source.read()), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('读取超时')), 5000); })]);
                if (this.#previewSources.get(source.id) !== source) continue;
                invariant(Array.isArray(external?.stages), '来源没有返回预览阶段');
                result.stages.push(...external.stages.map(stage => {
                    const copy = clone(stage), suppliedAgent = copy.agent;
                    const identified = suppliedAgent?.identified !== false && typeof suppliedAgent?.id === 'string' && suppliedAgent.id.trim()
                        && typeof suppliedAgent.title === 'string' && suppliedAgent.title.trim();
                    const agent = identified ? { ...suppliedAgent,
                        id: suppliedAgent.id === 'narration' ? 'narration' : `${encodeURIComponent(source.id)}:agent:${encodeURIComponent(suppliedAgent.id)}`,
                        description: typeof suppliedAgent.description === 'string' && suppliedAgent.description.trim() ? suppliedAgent.description : '该来源未提供此 Agent 的职责说明。',
                        identified: true } : unknownAgent();
                    return { ...copy, id: `${source.id}:${stage.id}`, provider: { ...provider }, agent,
                        kind: ['request', 'injection'].includes(copy.kind) ? copy.kind : 'unknown',
                        title: stage.title?.startsWith(`${source.title} ·`) ? stage.title : `${source.title} · ${stage.title}` };
                }));
                result.warnings.push(...(external.warnings ?? []).map(warning => `${source.title}：${warning}`));
            } catch (error) {
                result.stages.push({ id: `${source.id}:unavailable`, title: source.title, provider, agent: unknownAgent(), kind: 'unknown',
                    status: 'unavailable', explanation: `本次无法读取：${error.message}`, system: '', input: null, uncertainties: ['该来源的提示词未包含在此预览中。'] });
            } finally { clearTimeout(timer); }
            unchanged();
        }
        unchanged();
        return result;
    }
    #recordPlan(plan, mode) {
        const record = { requestId: plan.requestId, at: new Date().toISOString(), mode,
            selectedIds: clone(plan.selectedIds), mandatoryIds: clone(plan.mandatoryIds ?? []), triggeredIds: clone(plan.triggeredIds ?? []), gatedIds: clone(plan.gatedIds ?? []), summary: plan.summary, inventory: plan.inventory, details: plan.details,
            entries: plan.entries.filter(e => plan.selectedIds.includes(e.id)).map(e => ({ id: e.id, title: e.title, kind: e.kind,
                constant: e.constant, important: e.important, version: e.version, contentChars: entryText(e).length })),
            mvu: clone(plan.mvu),
            entryChars: plan.entries.filter(e => plan.selectedIds.includes(e.id)).reduce((n, e) => n + entryText(e).length, 0),
            pendingCount: this.host.snapshot().messages.length - this.store.state.processed.length,
            status: mode === 'preview' ? '试选，未注入' : '已交给酒馆，最终请求尚未核验' };
        this.diagnostics[mode === 'preview' ? 'lastPreview' : 'lastPlan'] = record; this.#notify();
    }
    recordObservation({ requestId, observedIds, status }) {
        const plan = this.diagnostics.lastPlan;
        if (plan?.requestId !== requestId) return;
        plan.observedIds = clone(observedIds); plan.status = status; this.#notify();
    }
    async #buildPlan(activity, { readSnapshot = () => this.host.snapshot(), project = false } = {}) {
        invariant(this.store?.state.initialized, '请先完成初始化');
        this.#assertActivity(activity);
        invariant(!this.sourceChanges.changed, '原书已变化：请先在“资料”页同步变化的条目，或选择本轮按原世界书发送。');
        const snapshot = readSnapshot(), stored = nativeSwitchOverlay(project ? this.store.project(snapshot.messages.map(m => m.key)) : this.store.snapshot(), this.#nativeRaw, this.#extraBooks);
        const rules = entry => evaluateRules(this.compiledRules, entry), readable = snapshot.messages.filter(isReadableMessage);
        // Gated entries never reach the catalog, so selection spends no slot on
        // them, and an author `always` does not send them either.
        const { gated, save } = applyGate(stored, readable, snapshot.userInput, { rules });
        const scopes = readableScopes(save.data.scopeContext);
        const eligible = entry => scopes.has(entryScope(entry)) && (this.host.eligible ? this.host.eligible(entry, snapshot) : entry.enabled);
        const recent = selectionMessages(snapshot, save, this.settings.recentTurns);
        const projection = this.settings.mvuEnabled ? await untilAborted(this.refreshMvu(), activity.signal) : null;
        this.#assertActivity(activity);
        const observedState = this.#observedState(projection, snapshot, recent);
        const forced = triggeredIds(save, readable, snapshot.userInput, { eligible, rules });
        const selectable = entry => eligible(entry) && !gated.has(entry.id);
        const picked = await select(this.client, this.#taskView(save), recent, { eligible: selectable, selectionLimit: this.settings.selectionLimit,
            selectionChars: this.settings.selectionChars, observedState, forced, authorGuidance: this.rules.naturalLanguage, messageCount: snapshot.messages.length, signal: activity.signal });
        const ids = [...new Set([...forced, ...picked])];
        this.#assertActivity(activity);
        await this.#assertSourceCurrent(activity);
        invariant(save.revision === this.store.state.revision, '选材期间资料更新，请重试本轮');
        // The plan itself carries the live switches too, so injection agrees with selection.
        invariant(JSON.stringify(snapshot.messages.map(m => m.key)) === JSON.stringify(readSnapshot().messages.map(m => m.key)), '选材期间剧情候选已变化，请重试本轮');
        return { requestId: uid('request'), chatId: snapshot.chatId, mvu: observedState, triggeredIds: forced, gatedIds: [...gated],
            ...assemblePromptPlan(this.#taskView(save), ids, { eligible: selectable, compiledRules: this.compiledRules, configEntryUids: this.rules.configEntryUids }) };
    }

    #lazyNeedsNativeFallback() {
        if(!this.settings.lazyMode)return false;
        const blocking = failure => ['connection','output','quota','moderation','storage','paused'].includes(failure?.reason);
        if(blocking(this.#lazy.state.attention)||Object.values(this.#lazy.state.failures??{}).some(blocking))return true;
        // These workers already defer commits to the selection lease. Work
        // which changes the source baseline uses native sending until it ends.
        return [...this.#activities.values()].some(activity=>!['maintain','compact','inventory','select'].includes(activity.kind));
    }
    async generationBefore({ type, dryRun, isCurrent = () => true, signal } = {}) {
        if (dryRun || !isCurrent() || ['quiet', 'impersonate'].includes(type)) return;
        if (signal?.aborted) return { cancel: true };
        for (const activity of this.#activities.values()) if (activity.kind === 'select') {
            activity.abort.abort(Object.assign(new Error('已由新的发送替换'), { name: 'AbortError' }));
        }
        this.host.clearPlan();
        if (this.host.restoreLegacyWindow) await this.host.restoreLegacyWindow();
        if (this.#initializing || ['quiet', 'impersonate'].includes(type)) {
            if (this.#initializing && this.settings.lazyMode) this.#lazyDeferredTurn = true;
            this.#nativeBypass = true;
            if (this.#initializing && !['quiet', 'impersonate'].includes(type)) this.#state('初始化仍在进行；本轮使用原生资料，完成后补记');
            await this.#restoreWindow(); return;
        }
        if (!this.#enabled() || !this.store?.state.initialized || this.#lazyNeedsNativeFallback()) { this.#nativeBypass = true; await this.#restoreWindow(); return; }
        const epoch = this.#epoch, chatId = this.host.snapshot().chatId;
        const activity = this.#beginActivity('select', '前置正在读取记忆规则', { isCurrent, signal });
        try {
            await this.#withSelection(async () => {
                if (!isCurrent()) return;
                await this.#loadRules(epoch, chatId, activity.signal);
                if (!isCurrent()) return;
                const replacing = Boolean(this.host.pendingReplacement?.());
                const readSnapshot = () => this.host.generationSnapshot?.({ type }) ?? this.host.snapshot();
                if (!replacing) await this.#saveActivity(activity, () => this.store.reconcile(this.host.snapshot().messages.map(m => m.key)));
                if (!isCurrent()) return;
                const plan = await this.#buildPlan(activity, { readSnapshot, project: replacing });
                if (!isCurrent()) return;
                if (!this.#enabled()) { this.#nativeBypass = true; await this.#restoreWindow(); return; }
                {
                    const snapshot = readSnapshot(), projected = this.store.project(snapshot.messages.map(m => m.key));
                    const remembered = new Set(projected.rememberedKeys ?? []);
                    // A rolled-back batch may also contain older valid text.
                    // Restore that text when the projected summary no longer
                    // certifies it, before ST builds the outgoing history.
                    const actions = planWindow(snapshot.messages, projected.processed, {
                        enabled: this.settings.windowEnabled && !this.#worldbookOnly() && this.#hasNarrativeMemory(projected), recentTurns: this.settings.recentTurns,
                        canOmit: message => this.#scopeRemembered(projected, message, remembered),
                    });
                    if (actions.length) await this.#saveActivity(activity, () => this.host.applyWindow(actions));
                    this.#assertActivity(activity);
                }
                this.host.setPlan(plan); this.#recordPlan(plan, 'send');
                // A successful retry must not keep displaying the previous
                // selection failure while the native request is ready to run.
                this.#state('本轮资料已就绪');
            }, activity);
        } catch (error) {
            if (activity.signal.aborted || !isCurrent() || epoch !== this.#epoch || this.host.snapshot().chatId !== chatId) return { cancel: true };
            this.host.clearPlan(); this.#state('前置选材失败', error);
            this.#updateActivity(activity, { label: '选材未完成，等待你的处理', hint: '可重新选材、按原世界书发送，或停止本轮。' });
            const choice = await untilAborted(this.settings.lazyMode ? Promise.resolve('original') : this.chooseFallback(error, { signal: activity.signal }), activity.signal).catch(error => {
                if (activity.signal.aborted) return 'cancel';
                throw error;
            });
            if (activity.signal.aborted || !isCurrent() || epoch !== this.#epoch || this.host.snapshot().chatId !== chatId) return { cancel: true };
            if (choice === 'retry') return this.generationBefore({ type, dryRun, isCurrent, signal });
            if (choice === 'original') { this.#nativeBypass = true; await this.#restoreWindow(); return; }
            await this.host.stopGeneration?.();
            return { cancel: true };
        } finally { this.#endActivity(activity); }
    }
    messageReceived({ type } = {}) {
        if (this.settings.lazyMode && !['quiet','impersonate'].includes(type)) { this.#resumePostForNewReply(); this.#lazy.kick({event:true}); return; }
        if (this.#initializing || !this.#enabled() || !this.store?.state.initialized || ['quiet', 'impersonate'].includes(type)) return;
        const epoch = this.#epoch;
        // Receive signals are scheduled by the adapter after the final selected message is saved.
        const prepare = type === 'continue' || type === 'append' || type === 'appendFinal'
            ? this.store.reconcile(this.host.snapshot().messages.slice(0, -1).map(m => m.key)) : Promise.resolve();
        prepare.then(() => epoch === this.#epoch && this.maintain({ automatic: true })).then(() => {
            if (epoch === this.#epoch && !this.#autoPostPaused && !this.#worldbookOnly() && this.#shouldCompact()) this.compact().catch(() => {});
        }).catch(() => {});
    }
    generationPreSendIdle() {
        if (!this.#initializing || !this.#lazyDeferredTurn || this.host.snapshot().generating) return;
        this.#lazyDeferredTurn = false; this.#nativeBypass = false; this.#notify();
    }
    generationInputConsumed() {
        if (!this.#initializing || !this.settings.lazyMode) return;
        this.#lazyDeferredTurn = true; this.#nativeBypass = true; this.#notify();
    }
    generationStopped() {
        this.#lazyDeferredTurn = false;
        this.#pauseAutomaticPost();
        for (const activity of this.#activities.values()) if (activity.kind === 'select') {
            activity.abort.abort(Object.assign(new Error('本轮发送已停止'), { name: 'AbortError' }));
        }
        this.host.clearPlan(); this.#nativeBypass = false;
        this.#state('本轮发送已停止，已有记忆保留');
    }
    generationEnded() {
        this.#nativeBypass = false; this.#lazyDeferredTurn = false;
        if (this.settings.lazyMode) queueMicrotask(() => this.#lazy.kick());
        this.#notify();
        return this.#syncWindow().catch(error => { this.error = error.message; this.#notify(); });
        // Not proof of a successful reply; adapter handles finalized messages.
    }
    #storyChanged() {
        this.#storyRevision++;
        // Deleting or swiping messages after the batch being written cannot
        // change that batch. Cancelling it would resend the same paid request
        // on every edit (FM: long saves deleting replies one by one), so the
        // request finishes and the run restarts once from the current story.
        const prefix = this.#maintenancePrefix;
        if (this.#maintenance && !this.#initializing && prefix && isPrefix(prefix, this.host.snapshot().messages.map(m => m.key))) return;
        if (this.settings.lazyMode) this.#lazy.stop();
        this.cancel();
        if (this.settings.lazyMode) { queueMicrotask(() => this.#lazy.kick({event:true})); return; }
        const epoch = this.#epoch;
        // ST awaits event listeners while its UI is in SWIPING/deletion state.
        // Reconcile asynchronously; never make that lock wait for a model.
        if (this.store?.state.initialized) Promise.resolve().then(() => epoch === this.#epoch && this.maintain()).catch(() => {});
    }
    messageSwiped() { this.#storyChanged(); }
    messageDeleted() { this.#storyChanged(); }
    messageSwipeDeleted() { this.#storyChanged(); }
    /** Bring changed source entries into this save without a full rescan.
     * New entries are classified; entries the story never touched take the new
     * source; entries both the author and the story changed are merged by the
     * model from the old source, the new source and the current version.
     * Protected text is never sent. Removed entries are dropped. */
    async syncSourceChanges({ sourceBook } = {}) {
        if (!sourceBook && this.store?.state.initialized) {
            const main = this.store.state.bookName;
            const extra = [...new Set([...Object.values(this.store.state.base.entries), ...Object.values(this.store.state.data.entries)].map(e => e.source?.book).filter(book => book && book !== main))];
            if (extra.length) {
                const results = [];
                for (const book of [main, ...extra]) {
                    try { results.push({...(await this.syncSourceChanges({ sourceBook: book })),book}); }
                    catch (error) { this.#state('原世界书部分同步，未完成的来源资料保留', error); throw error; }
                }
                this.sourceSync = {synced:results.reduce((n,r)=>n+(r.sync?.synced??0),0),held:results.flatMap(r=>r.sync?.held??[])};
                const message = results.map(r => `${r.book}：${r.message}`).join('；'); this.#state(message); return {executed:true,message};
            }
        }
        invariant(this.store?.state.initialized && !this.#initializing, '请先完成初始化');
        invariant(!this.view().activity, '请等待当前任务完成后再同步原书');
        const activity = this.#beginActivity('sync', '正在核对原书变化');
        const { epoch, signal } = activity, store = this.store;
        this.#state('正在同步原书变化');
        try {
            const primaryRaw = await this.#loadRules(epoch, activity.chatId, signal);
            const state = store.snapshot(), book = sourceBook ?? state.bookName;
            let raw = book === state.bookName ? primaryRaw : this.#extraBooks[book];
            if (!Array.isArray(raw) && book !== state.bookName) {
                const message = '来源世界书不可用，已跳过同步；已加入的副本仍可正常使用。';
                return { executed: false, reason: message, message, sync: {synced:0,held:[],unavailable:[book]} };
            }
            invariant(Array.isArray(raw), '主世界书不可用，现有资料保留。');
            if (book !== state.bookName) {
                const ids = new Set([...Object.values(state.base.entries), ...Object.values(state.data.entries)].filter(e => e.source?.book === book).map(e => String(e.source.uid)));
                raw = raw.filter(e => ids.has(String(e.uid)));
            }
            const rawFingerprint = await initializationFingerprint(raw);
            const config = new Set(book === state.bookName ? this.rules.configEntryUids.map(String) : []);
            const current = new Map(raw.filter(entry => !config.has(String(entry.uid))).map(entry => [String(entry.uid), entry]));
            const bySource = entries => new Map(Object.values(entries).filter(entry => entry.source?.book === book).map(entry => [String(entry.source.uid), entry]));
            const live = bySource(state.data.entries), baseline = bySource(state.base.entries);
            const removed = (book === state.bookName ? [...new Set([...live.keys(), ...baseline.keys()])] : []).filter(uid => !current.has(uid))
                .map(uid => (live.get(uid) ?? baseline.get(uid)).id);
            const base = {}, data = {}, classify = [], textChanged = new Map(), pendingHeld = {}, existingHeld = [];
            for (const [uid, entry] of current) {
                const used = live.get(uid), old = baseline.get(uid) ?? used;
                if (!used && !old) { classify.push(makeSourceEntry(book, entry)); continue; }
                if (used && sourceMatches(state.sourceHeld?.[used.id]?.next?.source, entry)) {
                    existingHeld.push(used.id); continue; // Same pending decision; do not pay to classify it again.
                }
                if (state.sourceHeld?.[used?.id] && sourceMatches(used.source,entry) && sourceMatches(old.source,entry)) pendingHeld[used.id]=null;
                const sameText = (used ?? old).source.original === (entry.content ?? '');
                const sameMeta = JSON.stringify((used ?? old).source.metadata) === JSON.stringify(entry);
                if (sameText && sameMeta && old.source.original === used?.source.original) continue;
                if (sameText && used?.status === DEFERRED && !entry.disable) {
                    // Skipped while disabled at scan time; classify now that it is on.
                    classify.push(makeSourceEntry(book, entry));
                    textChanged.set(sourceId(book, entry.uid), { used, old: null });
                    continue;
                }
                if (sameText) {
                    // Metadata only (keys, order, toggles): no model call.
                    const refresh = item => item && createEntry({ ...item, title: entry.comment || item.title, enabled: item.tier ? item.tier !== 'off' : !entry.disable, constant: entry.constant,
                        source: { ...item.source, metadata: clone(entry) } });
                    if (used) data[used.id] = { ...refresh(used), version: used.version + 1 };
                    if (baseline.get(uid)) base[old.id] = refresh(baseline.get(uid));
                    continue;
                }
                classify.push(makeSourceEntry(book, entry)); // The old version this live entry was derived from (after a rollback the baseline may already be newer).
                const derived = baseline.get(uid)?.source.original === used?.source.original ? baseline.get(uid) : null;
                textChanged.set(sourceId(book, entry.uid), { used, old: derived });
            }
            if (classify.length) assertSourceCapacity(state, classify);
            const { settled, pending } = prescan(classify);
            const classified = [...settled.values()];
            const groups = batches(pending, this.settings.batchChars, entryText, INITIALIZATION_BATCH_ITEMS);
            const budget = scanBudget(this.settings.batchChars);
            for (let i = 0; i < groups.length; i++) {
                this.#updateActivity(activity, { label: `扫描变化条目 ${i + 1}/${groups.length}` });
                const result = await classifyOrDefer(this.client, groups[i], this.rules.naturalLanguage, signal, budget);
                this.#assertActivity(activity);
                classified.push(...result.entries);
            }
            const ruled = applyRules(classified, this.compiledRules).entries;
            // Same baseline as initialization, so "恢复原书" restores this classification.
            for (const entry of ruled) if (entry.source && entryText(entry) === entry.source.original) entry.source.baselineSegments = clone(entry.segments);
            const merges = [], held = [], mergeHeld = [];
            for (const next of ruled) {
                if (book !== state.bookName) next.source.external = true;
                const change = textChanged.get(next.id);
                // A refused rescan of a scanned entry is not a sync: its memory and
                // baseline stay, and the source change stays pending.
                if (next.scanBlocked && change?.used && change.used.status !== DEFERRED) { held.push(next.id); continue; }
                base[next.id] = next;
                const writable = entry => (entry?.segments ?? []).filter(segment => segment.writable).map(segment => segment.text).join('');
                const touched = change?.used && entryText(change.used) !== change.used.source.original;
                if (touched && next.segments.some(segment => segment.writable)) {
                    merges.push({ id: next.id, title: next.title, current: writable(change.used), next, used: change.used,
                        oldSource: change.old ? writable(change.old) : change.used.segments.every(segment => segment.writable) ? change.used.source.original : '' });
                } else data[next.id] = { ...next, ...keepTier(change?.used), version: (change?.used?.version ?? 0) + 1 };
            }
            if (merges.length) {
                this.#updateActivity(activity, { label: `合并 ${merges.length} 条剧情改过的条目` });
                const merged = await mergeSourceUpdates(this.client, merges, signal);
                this.#assertActivity(activity);
                for (const item of merged) {
                    const source = merges.find(entry => entry.id === item.id);
                    if (item.held) {
                        pendingHeld[item.id] = { next: clone(source.next), resolutionId: uid('source-held') };
                        delete base[item.id]; held.push(item.id); mergeHeld.push(item.id); continue;
                    }
                    data[item.id] = { ...source.next, ...keepTier(source.used), segments: item.segments, version: source.used.version + 1,
                        evidence: clone(source.used.evidence ?? []), lineage: clone(source.used.lineage ?? []) };
                }
            }
            let fresh = await this.host.loadWorldbook(book); this.#assertActivity(activity);
            if (book !== state.bookName) fresh = fresh.filter(e => current.has(String(e.uid)) || live.has(String(e.uid)) || baseline.has(String(e.uid)));
            invariant(await initializationFingerprint(fresh) === rawFingerprint, '来源世界书在同步期间变化，结果未采用，请重试。');
            if (Object.keys(base).length || Object.keys(data).length || removed.length || Object.keys(pendingHeld).length) {
                await this.#saveActivity(activity, () => store.syncSource({ base, data, removed, held: pendingHeld }, { expectedRevision: state.revision }));
            }
            this.#assertActivity(activity);
            this.sourceChanges = sourceBookChanges(store.state, primaryRaw, this.rules.configEntryUids, this.#extraBooks);
            this.sourceSync = { synced: Object.keys(data).length + removed.length, held: [...held, ...existingHeld] };
            const deferred = ruled.filter(entry => entry.scanBlocked && !held.includes(entry.id)).length;
            const refusedHeld = held.length-mergeHeld.length;
            const summary = `原书${held.length || existingHeld.length ? '部分' : '已'}同步：新增 ${classify.length - textChanged.size} 条，更新 ${Object.keys(data).length - (classify.length - textChanged.size)} 条（其中 ${merges.length-mergeHeld.length} 条与剧情合并），删除 ${removed.length} 条`
                + (refusedHeld ? `；${refusedHeld} 条的新版被辅助接口的内容审核拒收，没有同步，原资料保留` : '')
                + (mergeHeld.length + existingHeld.length ? `；${mergeHeld.length + existingHeld.length} 条长资料无法安全分段合并，当前版本继续使用；请选择采用新原文或保留当前版本` : '')
                + (deferred ? `；${deferred} 条被内容审核拒收，暂按原世界书发送` : '');
            this.#state(summary);
            if (!this.sourceChanges.changed) await this.#lazyManualSuccess('sync');
            return { executed: true, message: summary, sync: clone(this.sourceSync) };
        } catch (error) {
            if (epoch === this.#epoch && !signal.aborted) this.#state('原书同步未完成，原资料保留', error);
            throw error;
        } finally { this.#endActivity(activity); }
    }
    exportMemory() {
        invariant(this.store?.state.initialized && !this.#initializing && !this.view().activity, '请等待当前任务完成后导出');
        return exportMemoryWorldbook(this.store.snapshot());
    }
    async extraBookPreview(name) {
        invariant(this.store?.state.initialized, '请先完成初始化');
        const epoch = this.#epoch, chatId = this.host.snapshot().chatId, main = this.store.state.bookName;
        const books = await this.host.listWorldbooks?.() ?? [];
        this.#assertCurrent(epoch, chatId);
        if (!name) return { books: books.map(b => {
            const item=typeof b==='string'?{name:b}:b;
            return {...item,primary:item.name===main,addedCount:Object.values(this.store.state.data.entries).filter(e=>e.source?.book===item.name).length};
        }).sort((a,b)=>Number(b.primary)-Number(a.primary)||a.name.localeCompare(b.name)) };
        invariant(name !== main && books.some(b => (typeof b === 'string' ? b : b.name) === name), '请选择其他来源世界书');
        const raw = await this.host.loadWorldbook(name); this.#assertCurrent(epoch, chatId);
        const entries = Object.values(this.store.state.data.entries), names = new Set(entries.map(e => e.title));
        const rows = raw.map(row => {
            const title = String(row.comment || `条目 ${row.uid}`), content = row.content ?? '', id = sourceId(name, row.uid);
            const flag = entries.some(e => e.id === id) ? 'added' : title.includes('[DWM Rules]') || typeof content === 'string' && scriptOnly(content) ? 'script'
                : typeof content !== 'string' || content.length > 10000000 || title.length > 500 ? 'toolong' : names.has(title) ? 'dup' : row.disable ? 'off' : '';
            return {id,uid:row.uid,title,chars:typeof content === 'string' ? content.length : 0,flag};
        });
        return { name, entries: rows, snapshot: await initializationFingerprint(raw) };
    }
    async addFromBook(name, uids, expectedSnapshot) {
        invariant(this.store?.state.initialized && !this.view().activity, '请等待当前任务完成');
        invariant(Array.isArray(uids) && uids.length > 0 && uids.length <= 1000 && new Set(uids.map(String)).size === uids.length, '请选择1–1000个不同条目');
        const activity = this.#beginActivity('extra-book', '正在读取来源世界书'), store = this.store, added = [], refused = [];
        try {
            const preview = await this.extraBookPreview(name); this.#assertActivity(activity);
            invariant(!expectedSnapshot || preview.snapshot === expectedSnapshot, '来源世界书已变化，请重新预览');
            const selected = new Set(uids.map(String));
            invariant(preview.entries.filter(e => selected.has(String(e.uid)) && !['added','script','toolong'].includes(e.flag)).length === selected.size, '所选条目不可加入或已存在');
            const raw = await this.host.loadWorldbook(name); this.#assertActivity(activity);
            invariant(await initializationFingerprint(raw) === preview.snapshot, '来源世界书已变化，请重新预览');
            await this.#loadRules(activity.epoch, activity.chatId, activity.signal); this.#assertActivity(activity);
            invariant(!this.sourceChanges.changed, '请先同步已有来源世界书的变化');
            const entries = raw.filter(r => selected.has(String(r.uid))).map(r => {
                const e = makeSourceEntry(name,r); e.source.external = true;
                return createEntry({...e,enabled:true}); // Explicitly selected disabled rows are classified, then restored to off.
            });
            assertSourceCapacity(store.state, entries);
            const groups = batches(entries,this.settings.batchChars,entryText,INITIALIZATION_BATCH_ITEMS), budget = scanBudget(this.settings.batchChars);
            for (let index=0; index<groups.length; index++) {
                this.#updateActivity(activity,{label:`扫描并加入 ${index+1}/${groups.length}`});
                const result = await classifyOrDefer(this.client,groups[index],this.rules.naturalLanguage,activity.signal,budget); this.#assertActivity(activity);
                const current = await this.host.loadWorldbook(name); this.#assertActivity(activity);
                invariant(await initializationFingerprint(current) === preview.snapshot, '来源世界书已变化，已加入批次保留，请重新预览');
                refused.push(...result.blocked);
                const classified = applyRules(result.entries.filter(e=>!e.scanBlocked),this.compiledRules).entries.map(e=>{
                    const entry = createEntry({...e,enabled:!e.source.metadata.disable,status:'confirmed'});
                    entry.source.baselineSegments=clone(entry.segments);return entry;
                });
                if (classified.length) {
                    await this.#saveActivity(activity,()=>store.manual({type:'extra-book',entries:classified},this.host.snapshot().messages.map(m=>m.key)));
                    added.push(...classified.map(e=>e.id));
                }
            }
            this.host.clearPlan(); await this.#loadRules(activity.epoch,activity.chatId,activity.signal);
            const message=`已加入 ${added.length} 条${refused.length ? `；${refused.length} 条未通过扫描，未加入` : ''}`;this.#state(message);
            return {executed:true,added,refused,message};
        } catch(error) {
            if (this.store===store) this.#state(`加入未完成，已加入 ${added.length} 条的批次保留`,activity.signal.aborted ? '' : error.message);
            throw error;
        } finally { this.#endActivity(activity); }
    }
    supplementaryBooks() { return this.host.supplementaryBooks?.() ?? []; }
    async readSupplementaryBook(name) {
        invariant(this.supplementaryBooks().includes(name) && typeof this.host.readSupplementaryBook === 'function', '请选择当前聊天绑定的附加世界书');
        const epoch = this.#epoch, chatId = this.host.snapshot().chatId;
        const book = await this.host.readSupplementaryBook(name);
        this.#assertCurrent(epoch, chatId);
        return parseSupplementaryMemory(JSON.stringify(book), { name, json: true });
    }
    async importSupplementaryMemory(entries, saveId, scopeId = GLOBAL_SCOPE) {
        invariant(this.store?.state.initialized && !this.#initializing && !this.view().activity, '请先完成初始化并等待当前任务结束');
        invariant(this.store.state.id === saveId, '存档已切换，请重新选择导入材料');
        invariant(normalizeScopeId(scopeId) === normalizeScopeId(this.store.state.data.scopeContext?.activeScopeId), '资料范围已改变，请重新选择导入材料');
        // Revalidate the preview at the write boundary. Import never marks old floors processed.
        const parsed = parseSupplementaryMemory(JSON.stringify({ entries: entries.map(e => ({ comment: e.title, content: e.content })) }), { json: true });
        const store = this.store, activity = this.#beginActivity('import', '正在导入补充记忆');
        try {
            await this.#saveActivity(activity, () => store.manual({ type: 'import-memory', entries: parsed.entries,
                scopeId: store.state.data.scopeContext?.activeScopeId ?? GLOBAL_SCOPE }, this.host.snapshot().messages.map(m => m.key)));
            this.#assertActivity(activity); this.host.clearPlan();
            this.#state('补充记忆已导入；重复的同名同正文条目已跳过');
        } finally { this.#endActivity(activity); }
    }
    async setEntryTiers(ids, tier) {
        invariant(this.store?.state.initialized && !this.view().activity && !this.#initializing, '请等待当前任务完成后批量调整');
        invariant(['constant', 'onDemand', 'off'].includes(tier) && Array.isArray(ids) && ids.length > 0 && ids.length <= 1000
            && new Set(ids).size === ids.length, '请选择 1–1000 个不同条目和有效档位');
        const store = this.store, entries = ids.map(id => store.state.data.entries[id]);
        invariant(entries.every(Boolean), '部分条目已不存在，请重新选择');
        let items = entries.map(e => ({ id: e.id, expectedVersion: e.version }));
        const pending = tier === 'off' ? [] : entries.filter(e => e.status === DEFERRED);
        const activity = this.#beginActivity('classify', pending.length ? '正在扫描待启用条目' : '正在批量调整档位');
        const refused = new Set();
        try {
            if (pending.length) {
                await this.#loadRules(activity.epoch, activity.chatId, activity.signal);
                invariant(!this.sourceChanges.changed, '原世界书已变化，请先同步变化的条目再批量启用');
                const budget = scanBudget(this.settings.batchChars);
                for (const group of batches(pending, this.settings.batchChars, entryText, INITIALIZATION_BATCH_ITEMS)) {
                    const result = await classifyOrDefer(this.client, group, this.rules.naturalLanguage, activity.signal, budget);
                    this.#assertActivity(activity);
                    for (const id of result.blocked) refused.add(id);
                    for (const entry of applyRules(result.entries.filter(entry => !refused.has(entry.id)), this.compiledRules).entries) {
                        const item = items.find(item => item.id === entry.id);
                        invariant(item, '扫描结果包含未知条目'); item.classified = { ...entry, status: 'confirmed' };
                    }
                }
            }
            this.#assertActivity(activity);
            // Entries the provider refused to scan keep their tier and stay native.
            items = items.filter(item => !refused.has(item.id));
            if (!items.length) throw blockedResponse();
            await this.#saveActivity(activity, () => store.manual({ type: 'tiers', tier, items }, this.host.snapshot().messages.map(m => m.key)));
            this.#assertActivity(activity); this.host.clearPlan();
            this.#state(`已一次保存 ${items.length} 条的档位${refused.size ? `；${refused.size} 条被辅助接口的内容审核拒收，档位未变` : ''}`);
            return { executed: true, message: this.status };
        } finally { this.#endActivity(activity); }
    }
    async manual(action) {
        invariant(this.store?.state.initialized && !this.#initializing, '请先完成初始化');
        if (action.type === 'source-held-resolve') return this.#resolveHeldSource(action);
        if (action.type === 'tier' && action.tier !== 'off' && this.store.state.data.entries[action.id]?.status === DEFERRED) {
            return this.#scanDeferredForTier(action);
        }
        if (['reset', 'restore-entry'].includes(action.type)) {
            await this.#loadRules();
            invariant(!this.sourceChanges.changed, '原书已变化，旧基准不能当作新版重置；请先同步变化的条目。');
        }
        const entry = this.store.state.data.entries[action.id];
        if (entry && ['edit', 'classify'].includes(action.type)) {
            const rule = evaluateRules(this.compiledRules, entry);
            if (rule.locked && action.segments?.some(s => s.writable)) throw new Error('作者脚本已锁定此条，不能解除维护保护');
        }
        await this.store.manual(action, this.host.snapshot().messages.map(m => m.key));
        await this.#lazyManualSuccess('edit');
        this.#notify();
        if (action.type === 'inventory-toggle' && action.enabled && this.store.state.inventoryDisabledAt !== null) {
            // Recompute the inventory only; replay must not overwrite other current memories.
            await this.#catchUpInventory();
        }
    }
    async #resolveHeldSource(action, {allowMissing=false} = {}) {
        invariant(action.confirmed === true, '处理待决定的原书变化需要确认');
        invariant(['adopt-source', 'keep-current'].includes(action.choice), '请选择采用新原文或保留当前版本');
        invariant(!this.view().activity, '请等待当前任务完成后再处理原书变化');
        const activity = this.#beginActivity('sync', '正在处理这条原书变化'), store = this.store;
        try {
            const raw = await this.#loadRules(activity.epoch, activity.chatId, activity.signal);
            this.#assertActivity(activity);
            const pending = store.state.sourceHeld?.[action.id], next = pending?.next;
            invariant(next?.source, '该条目已没有待决定的原书变化');
            const book = next.source.book === store.state.bookName ? raw : this.#extraBooks[next.source.book];
            const row = book?.find(entry => String(entry.uid) === String(next.source.uid));
            invariant(sourceMatches(next.source, row) || allowMissing && action.choice==='keep-current' && next.source.book!==store.state.bookName && !row, '来源原书已变化或不可用，请重新同步后核对这一条');
            const revision = store.state.revision;
            await this.#saveActivity(activity, () => store.manual({ ...action, expectedRevision: revision }, this.host.snapshot().messages.map(m => m.key)));
            this.#assertActivity(activity); this.host.clearPlan();
            this.sourceChanges = sourceBookChanges(store.state, raw, this.rules.configEntryUids, this.#extraBooks);
            this.sourceSync = { synced: 1, held: this.sourceChanges.held.map(entry => entry.id) };
            const message = action.choice === 'adopt-source' ? '已采用新原文，改动记录已保留' : '已保留当前版本，原书这一版已记为已处理';
            this.#state(message); return { executed: true, message };
        } finally { this.#endActivity(activity); }
    }
    /** Disabled at scan time, so never classified. Turning it on scans just
     * this entry once (one model call) before the tier takes effect. */
    async #scanDeferredForTier(action) {
        invariant(!this.view().activity, '请等待当前任务完成后再调整');
        const activity = this.#beginActivity('classify', '正在扫描此条');
        this.#state('正在扫描此条');
        try {
            await this.#loadRules(activity.epoch, activity.chatId, activity.signal);
            const entry = this.store.state.data.entries[action.id];
            invariant(entry?.status === DEFERRED, '条目已变化，请重试');
            const result = await classifyEntries(this.client, [entry], this.rules.naturalLanguage, activity.signal, {batchChars:this.settings.batchChars});
            this.#assertActivity(activity);
            const [classified] = applyRules(result.entries, this.compiledRules).entries;
            await this.#saveActivity(activity, () => this.store.manual({ ...action, classified: { ...classified, status: 'confirmed' } }, this.host.snapshot().messages.map(m => m.key)));
            this.#assertActivity(activity);
            this.#state('已扫描并调整档位');
            return { executed: true, message: '已扫描此条并调整档位' };
        } catch (error) {
            if (activity.epoch === this.#epoch && !activity.signal.aborted) this.#state('此条扫描未完成，档位未变', error);
            throw error;
        } finally { this.#endActivity(activity); }
    }
    async #catchUpInventory() {
        const activity = this.#beginActivity('inventory', '正在补记物品');
        this.#state('正在补记物品');
        try {
            await this.#assertSourceCurrent(activity);
            const save = this.store.snapshot(), snapshot = this.host.snapshot();
            const start = save.inventoryDisabledAt ?? save.processed.length;
            const history = snapshot.messages.slice(start);
            if (!history.length) {
                await this.#saveActivity(activity, () => this.store.finishInventoryCatchUp(save.revision));
                this.#assertActivity(activity); this.#state('物品补记已完成'); return;
            }
            let working = clone(save);
            const runs = [];
            for (const message of history) {
                const scopeId = normalizeScopeId(save.data.messageScopes?.[message.key] ?? GLOBAL_SCOPE);
                if (runs.at(-1)?.scopeId === scopeId) runs.at(-1).messages.push(message);
                else runs.push({ scopeId, messages: [message] });
            }
            const inventories = {};
            for (const run of runs) for (const batch of batches(run.messages, this.settings.batchChars)) {
                this.#assertActivity(activity);
                const result = await maintain(this.client, this.#guarded(working), batch, activity.signal, run.scopeId);
                this.#assertActivity(activity);
                await this.#assertSourceCurrent(activity);
                invariant(Array.isArray(result.operations), '物品补记格式无效');
                const operations = result.operations.filter(op => op.type === 'inventory');
                working.data = applyMaintenance(working.data, { operations }, { scopeId: run.scopeId }).next;
                inventories[run.scopeId] = scopeInventory(working.data, run.scopeId);
            }
            await this.#saveActivity(activity, () => this.store.commitInventoryCatchUp(inventories, save.revision));
            this.#assertActivity(activity); this.#state('物品补记已完成');
        } catch (error) {
            if (activity.epoch === this.#epoch && !activity.signal.aborted) this.#state('物品补记未完成，原文保留', error);
            throw error;
        } finally { this.#endActivity(activity); }
    }
    async compact() {
        invariant(this.store?.state.initialized, '请先初始化');
        if (this.#worldbookOnly()) return { executed: false, reason: '仅动态世界书模式不整理脉络与事件' };
        if (this.#compacting || this.#initializing || this.#selecting() || this.store.state.data.scopeContext?.deferPost) return { executed: false, reason: '当前任务尚未结束，稍后可整理事件' };
        const info = this.#compactInfo();
        if (!info.entries && !info.summaryChars) return { executed: false, reason: '暂无可整理的内容', message: '暂无可整理的内容' };
        this.#compacting = true;
        const activity = this.#beginActivity('compact', '后置正在整理历史事件');
        const epoch = this.#epoch, base = this.store.snapshot();
        const scopeId = normalizeScopeId(base.data.scopeContext?.activeScopeId);
        const covered = { ...this.#compactMeasure(scopeId), anchorLength: base.processed.length, endKey: base.processed.at(-1) ?? null };
        this.#compactAttempts.set(scopeId, covered);
        this.#state('正在整理历史事件');
        try {
            await this.#loadRules(epoch, base.chatId, activity.signal);
            invariant(!this.sourceChanges.changed, '原书已变化，请先同步变化的条目。');
            const result = await compact(this.client, this.#guarded(base), activity.signal, scopeId);
            this.#assertActivity(activity);
            await this.#assertSourceCurrent(activity);
            await this.#afterSelection(activity);
            const current = this.store.snapshot();
            // Append-only new events do not invalidate updates to untouched old entries.
            result.operations = result.operations.filter(op => op.type === 'summary'
                ? scopeSummary(current.data, scopeId) === scopeSummary(base.data, scopeId)
                : ['mergeEvents', 'mergeEntries'].includes(op.type) ? op.sources.every(source => current.data.entries[source.id]?.version === base.data.entries[source.id]?.version)
                : current.data.entries[op.id]?.version === base.data.entries[op.id]?.version);
            const evidence = [...new Set(Object.values(base.data.entries).filter(e => entryScope(e) === scopeId).flatMap(e => e.evidence))];
            this.#validateGuarded(current, result, evidence, scopeId);
            if (result.operations.length) await this.#saveActivity(activity, () => this.store.commit(result, { expectedRevision: current.revision,
                sourceKeys: current.processed, allowedEvidence: evidence, maxChars: this.#maxChars(current), reason: 'compact', scopeId }));
            this.#assertActivity(activity);
            // A concurrent maintenance may have added facts this request never read.
            const completed = this.#compactMeasure(scopeId);
            const mark = { ...covered, at: new Date().toISOString(), size: completed.count === covered.count ? completed.size : covered.size };
            await this.#saveActivity(activity, () => this.store.updatePreferences({ compaction: { ...this.store.state.preferences?.compaction, [scopeId]: mark } }));
            this.#assertActivity(activity);
            this.#compactMarks.set(scopeId, mark);
            this.#compactAttempts.delete(scopeId);
            this.#state(result.operations.length ? '记忆整理已完成' : '无可合并或精简的内容，资料未变');
            await this.#lazyManualSuccess('compact');
            return { executed: true, message: this.status, changed: result.operations.length > 0, before: info, after: this.#compactInfo(),
                merged:result.operations.filter(op=>['mergeEvents','mergeEntries'].includes(op.type)).reduce((n,op)=>n+op.sources.length-1,0),condensed:result.operations.filter(op=>['summary','update'].includes(op.type)).length };
        } catch (error) { if (epoch === this.#epoch && !activity.signal.aborted) this.#state('整理未完成', error); throw error; }
        finally { if (epoch === this.#epoch) this.#compacting = false; this.#endActivity(activity); }
    }
    #compactInfo() {
        const save = this.store?.state;
        if (!save?.initialized) return { entries: 0, events: 0, entryChars: 0, summaryChars: 0 };
        const scope = normalizeScopeId(save.data.scopeContext?.activeScopeId);
        const entries = Object.values(save.data.entries).filter(e => entryScope(e) === scope && canCompactEntry(e) && !evaluateRules(this.compiledRules, e).locked);
        return { lastAt: save.preferences?.compaction?.[scope]?.at ?? null, entries: entries.length, events: entries.filter(e => e.kind === 'event').length,
            entryChars: entries.reduce((n, e) => n + entryText(e).length, 0), summaryChars: scopeSummary(save.data, scope).length };
    }
    #compactMeasure(scopeId = normalizeScopeId(this.store.state.data.scopeContext?.activeScopeId)) {
        const state = this.store.state;
        const commits = state.journal.filter(j => j.reason === 'maintenance');
        const related = j => scopeId === GLOBAL_SCOPE && Object.hasOwn(j.patch, 'summary')
            || Object.hasOwn(j.patch.scopeChanges?.scopeSummaries ?? {}, scopeId)
            || Object.values(j.patch.entries).some(entry => entry && entryScope(entry) === scopeId && canCompactEntry(entry));
        return { count: commits.filter(related).length, cycles: commits.length, commitId: commits.at(-1)?.id ?? null,
            summaryChars: scopeSummary(state.data, scopeId).length,
            size: scopeSummary(state.data, scopeId).length + Object.values(state.data.entries)
                .filter(e => entryScope(e) === scopeId && canCompactEntry(e)).reduce((n, e) => n + entryText(e).length, 0) };
    }
    #shouldCompact() {
        if (!this.store?.state.initialized) return false;
        const scopeId = normalizeScopeId(this.store.state.data.scopeContext?.activeScopeId);
        const current = this.#compactMeasure();
        if (!current.size || !current.count) return false;
        const saved = this.#compactMarks.get(scopeId) ?? this.store.state.preferences?.compaction?.[scopeId];
        const valid = saved && Number.isInteger(saved.count) && saved.count <= current.count
            && this.store.state.journal.some(commit => commit.id === saved.commitId)
            && (!saved.anchorLength || this.store.state.processed[saved.anchorLength - 1] === saved.endKey);
        const last = valid ? saved : { count: 0, size: 0 };
        const attempt = this.#compactAttempts.get(scopeId);
        if (attempt && this.store.state.journal.some(commit => commit.id === attempt.commitId)
            && current.cycles >= attempt.cycles && current.cycles - attempt.cycles < 3) return false;
        // Every maintenance rewrites the whole summary; keep it short enough to
        // fit an ordinary output budget before it truncates every later batch.
        return current.count - last.count >= this.settings.compactEvery
            || (current.size >= this.settings.compactChars && current.size >= Math.max(1, last.size * 1.25))
            || (current.summaryChars >= SUMMARY_COMPACT_CHARS && current.summaryChars >= Math.max(1, (last.summaryChars ?? 0) * 1.1));
    }
}
