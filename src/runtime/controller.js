import { sourceBookChanges } from '../core/source-book.js';
import { presetSnapshot, PREFERENCE_SCAN, validatePreferenceCandidates, selectedPreferences, applyAuxiliaryPreferences } from '../agents/preset-preferences.js';
import { MemoryStore } from '../core/store.js';
import { DEFAULT_SETTINGS, makeSourceEntry, entryText, normalizeScopeId, entryScope, scopeSummary, scopeInventory, readableScopes, GLOBAL_SCOPE } from '../core/state.js';
import { playerView, scopeRead, memoryMetrics } from '../core/views.js';
import { clone, invariant, uid, isPrefix, SerialQueue } from '../core/util.js';
import { planWindow } from '../core/window.js';
import { applyMaintenance } from '../core/operations.js';
import { AgentClient, compatibleConnection, untilAborted, serializeAgentInput } from '../agents/client.js';
import { classifyEntries, alignStrategy, maintain, select, compact } from '../agents/tasks.js';
import { discoverRules, compileRules, applyRules, evaluateRules } from '../rules/index.js';
import { createTraceStore } from '../diagnostics/trace-store.js';
import { buildPromptPreview } from '../diagnostics/prompt-preview.js';
import { selectionMessages, requestBatches } from '../agents/requests.js';
import { assemblePromptPlan, previewNarration } from './prompt-plan.js';

export const batches = requestBatches;

export class Controller {
    #listeners = new Set();
    #epoch = 0;
    #abort = new AbortController();
    #maintenance = null;
    #initializing = false;
    #compacting = false;
    #nativeBypass = false;
    #contextQueue = new SerialQueue();
    #selectionLeases = new Set();
    #compactMarks = new Map();
    #compactAttempts = new Map();
    #mvuReadSerial = 0;
    #previewSources = new Map();
    #activities = new Map();
    #autoPostPaused = false;
    #pausedPostKeys = new Set();
    #activityClaims = new Map();
    #presetDraft = null;
    #loading = null;
    #autoInitTask = null;
    #autoInitAttempts = new Set();
    #autoInitialization = null;
    constructor(host, { model, traces = createTraceStore(), settings = {}, persistSettings = async () => {}, chooseFallback = async () => 'cancel' } = {}) {
        this.host = host; this.settings = { ...DEFAULT_SETTINGS, ...settings };
        // Player-only, page-lifetime diagnostics. Never include this in view/save/agent data.
        this.traces = traces;
        this.persistSettings = persistSettings; this.chooseFallback = chooseFallback;
        this.sourceChanges = { changed: false, added: [], removed: [], updated: [] };
        this.status = '未初始化'; this.error = ''; this.progress = null; this.store = null;
        this.rules = { naturalLanguage: '', script: '', configEntryUids: [] };
        this.compiledRules = compileRules(''); this.constraints = {};
        this.connectionMode = model ? 'test' : 'raw';
        this.diagnostics = { lastPlan: null, lastPreview: null, requests: [] };
        this.mvu = { enabled: false, available: false, status: 'disabled', fields: [], reason: '未启用只读协作' };
        this.client = model ? this.#instrument(model) : this.#client(request => host.rawGenerate(request));
    }
    #client(generate) {
        return this.#instrument(new AgentClient(generate, { timeoutMs: this.settings.timeoutMs, initializationTimeoutMs: this.settings.initializationTimeoutMs }));
    }
    #instrument(client) {
        const complete = async (request, accept = result => result) => {
            const presetFingerprint = this.#preset().fingerprint, preferences = this.#auxiliaryPreferences();
            request = applyAuxiliaryPreferences(request, preferences);
            const epoch = this.#epoch, start = Date.now();
            const serializedInput = serializeAgentInput(request.input);
            const trace = this.host.traceCapture?.register({ ...request, input: serializedInput });
            const fallbackId = trace ? null : this.traces.start({ source: '鱼忆', label: ({ initialize: '扫描世界书', strategy: '统合记忆策略', select: '前置选材', maintain: '后置维护', compact: '整理事件', preferences: '扫描预设偏好' })[request.purpose] ?? request.purpose,
                transport: this.connectionMode === 'test' ? 'test' : 'agent-boundary',
                context: { chatId: this.host.snapshot().chatId },
                request: { messages: [{ role: 'system', content: request.system }, { role: 'user', content: serializedInput }] },
                captureNote: '辅助接口记录，未捕获网络包；模拟模式的输出为合成数据。' });
            const metric = { task: request.purpose, at: new Date(start).toISOString(),
                inputChars: request.system.length + serializedInput.length, outputChars: 0, ok: false };
            try {
                request.signal?.throwIfAborted();
                const result = await untilAborted(client.complete(request), request.signal);
                metric.outputChars = JSON.stringify(result).length;
                // Retain the model response even if task validation rejects it.
                if (fallbackId) this.traces.update(fallbackId, { responseBody: result });
                if (preferences.length && request.purpose !== 'preferences') invariant(this.#preset().fingerprint === presetFingerprint, '请求期间预设已改变，旧偏好结果不再采用');
                const accepted = await untilAborted(accept(result), request.signal);
                metric.ok = true;
                if (fallbackId) this.traces.finish(fallbackId, { status: 'complete' });
                trace?.end();
                return accepted;
            } catch (error) {
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
    #beginActivity(kind, label, { isCurrent = () => true } = {}) {
        const abort = new AbortController();
        const activity = { id: uid('activity'), kind, label, startedAt: Date.now(), phase: 'running', cancellable: true,
            stopLabel: kind === 'select' ? '停止本轮' : kind === 'maintain' || kind === 'compact' ? '停止整理' : '停止等待',
            hint: kind === 'select' ? '停止将结束本轮发送；已有记忆保留。' : this.#backgroundHint(),
            abort, signal: AbortSignal.any([this.#abort.signal, abort.signal]), isCurrent,
            epoch: this.#epoch, chatId: this.host.snapshot().chatId };
        this.#activities.set(activity.id, activity); this.#notify();
        return activity;
    }
    #backgroundHint() {
        return ['raw', 'tavern'].includes(this.connectionMode)
            ? '停止后不再采用结果；已发给酒馆的请求可能继续运行。已保存的进度保留。'
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
        if (this.#activities.get(activity?.id) !== activity) return;
        this.#activities.delete(activity.id); this.#notify();
    }
    #assertActivity(activity) {
        this.#assertCurrent(activity.epoch, activity.chatId);
        activity.signal.throwIfAborted();
        invariant(activity.isCurrent(), '本轮已停止或被新的发送替代');
    }
    async #saveActivity(activity, operation) {
        this.#assertActivity(activity);
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
    async #withSelection(task, activity) {
        const lease = { epoch: this.#epoch }, chatId = this.host.snapshot().chatId;
        this.#selectionLeases.add(lease);
        try {
            // Only atomic storage writes block the foreground. In-flight model
            // work yields locally; no host-wide STOP can cancel the new send.
            const yielded = this.#yieldBackground();
            if (yielded && activity?.kind === 'select') this.#pauseAutomaticPost();
            await untilAborted(this.store?.idle() ?? Promise.resolve(), activity?.signal ?? this.#abort.signal);
            this.#assertCurrent(lease.epoch, chatId);
            if (activity) {
                this.#assertActivity(activity);
                this.#updateActivity(activity, { label: activity.kind === 'preview' ? '正在试选本轮资料' : '前置正在选择本轮资料',
                    hint: activity.kind === 'select' ? '停止将结束本轮发送；已有记忆保留。' : this.#backgroundHint() });
            }
            return await task();
        } finally { this.#selectionLeases.delete(lease); }
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
            if (rule.maxChars) invariant(entryText(entry).length <= rule.maxChars, `条目 ${entry.title} 超出作者长度约束`);
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
    #auxiliaryPreferences() { return selectedPreferences(this.store?.state.preferences?.preset, this.#preset()); }
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
            if (!activity.signal.aborted && activity.epoch === this.#epoch) this.#state('预设扫描未完成，原配置保留', error.message);
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
    #enabled() { return Boolean(this.settings.enabled && this.store?.state.preferences?.enabled !== false); }
    #initializationNotice(state, message, retry = false) {
        this.#autoInitialization = state ? { state, message, retry } : null;
        this.#notify();
    }
    /** Host readiness events start work in the background, never hold up ST's event emitter. */
    readinessChanged() {
        const target = this.host.snapshot();
        if (this.#autoInitTask?.chatId === target.chatId && this.#autoInitTask.bookName === target.bookName) return this.#autoInitTask.promise;
        const task = { chatId: target.chatId, bookName: target.bookName, promise: null };
        this.#autoInitTask = task;
        task.promise = Promise.resolve().then(async () => {
            if (!this.settings.enabled) return;
            if (!target.chatId || !target.bookName || target.group) {
                this.#initializationNotice('waiting', target.group ? '自动建档等待单角色聊天' : '自动建档等待角色主世界书就绪'); return;
            }
            const { epoch, signal } = await this.#readyForChat(target);
            const current = () => { this.#assertCurrent(epoch, target.chatId); invariant(this.host.snapshot().bookName === target.bookName, '角色主世界书已改变'); };
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
            if (!snapshot.templateEnabled) { this.#initializationNotice('waiting', '请启用 ST-Prompt-Template；就绪后自动建立新档记忆'); return; }
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
            autoPostPaused: view.autoPostPaused, initialization: view.initialization };
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
            ? this.#loading.promise : !matches(this.store?.state) ? this.chatChanged() : null;
        if (loading) await loading;
        invariant(matches(this.host.snapshot()) && matches(this.store?.state), '存档已切换或尚未载入，本次处理已作废');
        this.#abort.signal.throwIfAborted();
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
        return { chatId, revision: this.store?.state.revision ?? null, status: this.status, error: this.error,
            context: context ? { owner: context.owner, activeScopeId: context.activeScopeId,
                requestedScopeIds: clone(context.requestedScopeIds), deferPost: Boolean(context.deferPost) } : null,
            pendingCount: Math.max(0, this.host.snapshot().messages.length - (this.store?.state.processed.length ?? 0)) };
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
            this.host.clearPlan(); this.#notify();
            return { apiVersion: 1, chatId, revision: this.store.state.revision, context: null };
        }), signal);
    }
    async readScope(scopeId) {
        normalizeScopeId(scopeId);
        const target = this.host.snapshot();
        await this.whenCommitted();
        invariant(this.store?.state.initialized, '请先完成初始化');
        const epoch = this.#epoch, chatId = target.chatId;
        await this.#loadRules(epoch, chatId);
        this.#assertCurrent(epoch, chatId);
        const save = this.#guarded(this.host.pendingReplacement?.()
            ? this.store.project(this.host.generationSnapshot().messages.map(m => m.key)) : this.store.snapshot());
        return { apiVersion: 1, chatId, revision: save.revision, ...scopeRead(save, scopeId) };
    }
    view() {
        const snapshot = this.host.snapshot(), preset = this.#preset();
        const activities = [...this.#activities.values()].filter(activity => activity.isCurrent())
            .sort((a, b) => Number(b.kind === 'select') - Number(a.kind === 'select') || b.startedAt - a.startedAt)
            .map(({ id, kind, label, startedAt, phase, cancellable, stopLabel, hint }) => ({ id, kind, label, startedAt, phase, cancellable, stopLabel, hint }));
        return { chatId: snapshot.chatId, status: this.status, error: this.error, progress: clone(this.progress), settings: clone(this.settings),
            activity: activities[0] ?? null, activities, autoPostPaused: this.#autoPostPaused,
            initialization: clone(this.#autoInitialization), sourceChanges: clone(this.sourceChanges),
            enabled: this.#enabled(), saveEnabled: this.store?.state.preferences?.enabled !== false,
            activityClaimed: [...this.#activityClaims.values()].some(claim => claim.chatId === snapshot.chatId),
            preset: { name: preset.name, available: Boolean(preset.entries.length),
                stale: Boolean(this.store?.state.preferences?.preset && this.store.state.preferences.preset.fingerprint !== preset.fingerprint),
                saved: clone(this.store?.state.preferences?.preset ?? null), draft: clone(this.#presetDraft) },
            readiness: { chat: Boolean(snapshot.chatId), book: Boolean(snapshot.bookName), template: Boolean(snapshot.templateEnabled), single: !snapshot.group },
            save: this.store?.state ? playerView(this.store.snapshot()) : null,
            sourceBook: this.store?.state?.bookName ?? '', connectionMode: this.connectionMode,
            mvu: clone(this.mvu), diagnostics: { ...clone(this.diagnostics), memory: memoryMetrics(this.store?.state),
                pendingCount: Math.max(0, this.host.snapshot().messages.length - (this.store?.state.processed.length ?? 0)) } };
    }
    subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
    #notify() { for (const fn of this.#listeners) fn(this.view()); }
    #state(status, error = '') { this.status = status; this.error = error; this.#notify(); }
    #assertCurrent(epoch, chatId) {
        invariant(epoch === this.#epoch && this.host.snapshot().chatId === chatId, '存档已切换，本次处理已作废');
        this.#abort.signal.throwIfAborted();
    }
    async start() { await this.chatChanged(); return this; }
    chatChanged() {
        const target = this.host.snapshot();
        if (this.#loading?.target.chatId === target.chatId && this.#loading.target.bookName === target.bookName
            && !this.#loading.abort.signal.aborted) return this.#loading.promise;
        if (this.#initializing && this.store?.state.chatId === target.chatId && this.store.state.bookName === target.bookName) return Promise.resolve();
        this.#loading?.abort.abort(Object.assign(new Error('存档已切换，本次载入已作废'), { name: 'AbortError' }));
        const loading = { target, abort: new AbortController(), promise: null };
        this.#loading = loading;
        // Publish the promise before notifying subscribers. Card listeners may
        // ask for the scope while this same CHAT_CHANGED event is still running.
        loading.promise = Promise.resolve().then(() => untilAborted(this.#loadChat(loading), loading.abort.signal)).finally(() => {
            if (this.#loading === loading) this.#loading = null;
        });
        return loading.promise;
    }
    async #loadChat(loading) {
        loading.abort.signal.throwIfAborted();
        invariant(this.#loading === loading && this.host.snapshot().chatId === loading.target.chatId
            && this.host.snapshot().bookName === loading.target.bookName, '存档已切换，本次载入已作废');
        this.store = null;
        this.cancel('正在切换存档', { keepLoading: true });
        // Another CHAT_CHANGED listener may already have claimed this new chat.
        // Revoke old-chat owners only; a newly issued claim remains valid.
        const currentChatId = this.host.snapshot().chatId;
        for (const [owner, claim] of this.#activityClaims) if (claim.chatId !== currentChatId) this.#activityClaims.delete(owner);
        this.#presetDraft = null;
        this.sourceChanges = { changed: false, added: [], removed: [], updated: [] };
        this.#autoInitialization = null;
        this.#epoch++; this.store = null; this.#maintenance = null; this.#initializing = false;
        this.#autoPostPaused = false;
        this.#pausedPostKeys.clear();
        this.diagnostics = { lastPlan: null, lastPreview: null, requests: [] }; this.#compactMarks.clear(); this.#compactAttempts.clear();
        this.mvu = { enabled: this.settings.mvuEnabled, available: false, status: 'unchecked', fields: [], reason: '尚未读取当前聊天' };
        if (this.host.restoreLegacyWindow) await this.host.restoreLegacyWindow();
        await this.#restoreWindow();
        const epoch = this.#epoch, snapshot = this.host.snapshot();
        if (!snapshot.chatId || !snapshot.bookName) { this.#state('请选择带主世界书的角色聊天'); return; }
        if (snapshot.group) { this.#state('此开发版先支持单角色聊天'); return; }
        const store = new MemoryStore(this.host.storage, { auditLimit: this.settings.auditLimit });
        await untilAborted(store.load(snapshot.chatId, snapshot.bookName), loading.abort.signal);
        this.#assertCurrent(epoch, snapshot.chatId);
        this.store = store;
        try { await this.#loadRules(epoch, snapshot.chatId); }
        catch (error) {
            if (store.state.initialized) throw error;
            this.#assertCurrent(epoch, snapshot.chatId);
            this.#state('主世界书暂不可读取，等待就绪', error.message); return;
        }
        if (store.state.initialized) await store.reconcile(snapshot.messages.map(m => m.key));
        this.#assertCurrent(epoch, snapshot.chatId);
        await this.#syncWindow();
        this.#state(store.state.initialized ? '可用' : '未初始化');
        if (this.settings.mvuEnabled) await this.refreshMvu();
    }
    async #loadRules(epoch = this.#epoch, chatId = this.host.snapshot().chatId, signal = this.#abort.signal) {
        const raw = await untilAborted(this.host.loadWorldbook(), signal);
        this.#assertCurrent(epoch, chatId);
        signal.throwIfAborted();
        this.rules = discoverRules(raw);
        this.compiledRules = compileRules(this.rules.script);
        this.sourceChanges = sourceBookChanges(this.store?.state, raw, this.rules.configEntryUids);
        return raw;
    }
    async #assertSourceCurrent(activity) {
        await this.#loadRules(activity.epoch, activity.chatId, activity.signal);
        this.#assertActivity(activity);
        invariant(!this.sourceChanges.changed, '原书已变化：请先导出聊天 JSONL 备份，再重新扫描；旧资料保留，旧处理结果不再采用。');
    }
    cancel(reason = '本轮已取消，记忆未变', { keepLoading = false } = {}) {
        if (!keepLoading) this.#loading?.abort.abort(Object.assign(new Error('当前载入等待已取消'), { name: 'AbortError' }));
        this.#abort.abort(new Error('已取消'));
        this.#abort = new AbortController();
        this.#epoch++;
        this.#initializing = false; this.#maintenance = null; this.#compacting = false; this.#nativeBypass = false;
        this.#activities.clear();
        this.host.clearPlan();
        this.progress = null;
        this.#state(reason);
    }
    async updateConnection({ mode = 'raw', endpoint, model, apiKey }) {
        invariant(!this.view().activity, '请先停止或等待当前任务完成，再应用连接；当前任务继续运行。');
        const client = this.#client(['raw', 'tavern'].includes(mode) ? request => this.host.rawGenerate(request)
            : compatibleConnection({ endpoint, model, apiKey }));
        this.connectionMode = mode; this.client = client;
        this.#state('连接已更新');
        this.readinessChanged();
    }
    async setSaveEnabled(enabled) {
        invariant(this.store, '请等待当前存档载入完成');
        const epoch = this.#epoch, chatId = this.host.snapshot().chatId;
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
        const next = { ...this.settings, ...patch };
        if ('mvuFields' in patch) next.mvuBookName = this.host.snapshot().bookName;
        invariant(Number.isInteger(next.recentTurns) && next.recentTurns >= 1 && next.recentTurns <= 1000, '保留轮数应为 1–1000');
        for (const [key, min, max] of [['batchChars', 1, 200000], ['selectionLimit', 1, 200], ['selectionChars', 100, 200000], ['compactChars', 1000, 1000000], ['compactEvery', 1, 1000]]) {
            invariant(Number.isInteger(next[key]) && next[key] >= min && next[key] <= max, `${key} 超出允许范围`);
        }
        invariant(Array.isArray(next.mvuFields) && next.mvuFields.length <= 16 && next.mvuFields.every(field => typeof field.path === 'string' && typeof field.label === 'string'), 'MVU 最多配置16个字段，每项需有路径和名称');
        await this.persistSettings(next);
        this.settings = next;
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
        const actions = planWindow(snapshot.messages, this.store.state.processed, {
            enabled: this.#enabled() && !this.sourceChanges.changed && this.settings.windowEnabled, recentTurns: this.settings.recentTurns,
        });
        if (actions.length) await this.host.applyWindow(actions);
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
    async initialize({ automatic = false } = {}) {
        invariant(this.store, '请先打开角色聊天');
        invariant(!this.#initializing && !this.#maintenance, '已有处理正在运行');
        const context = this.host.snapshot();
        invariant(context.templateEnabled, '请启用 ST-Prompt-Template');
        invariant(!this.store.state.data.scopeContext?.deferPost && !context.generating, '请等待本轮正文与状态保存完成，再开始初始化');
        this.#initializing = true; this.host.clearPlan();
        this.#autoPostPaused = false;
        const activity = this.#beginActivity('initialize', '正在读取角色世界书');
        const epoch = this.#epoch, signal = activity.signal;
        const targetStore = this.store;
        this.#initializationNotice('running', automatic ? '正在自动建立新档记忆' : '正在建立存档记忆');
        this.#state('初始化中；继续发送将使用原生流程');
        try {
            if (automatic || targetStore.state.preferences?.autoInitialization) {
                // Persist before the first model call so a refresh cannot silently
                // spend another full scan after an interrupted or failed attempt.
                await this.#saveActivity(activity, () => targetStore.updatePreferences({ autoInitialization: { attemptedAt: new Date().toISOString() } }));
            }
            const raw = await this.#loadRules(epoch, context.chatId, signal);
            const entries = raw.filter(e => !this.rules.configEntryUids.includes(e.uid)).map(e => makeSourceEntry(context.bookName, e));
            const groups = batches(entries, this.settings.batchChars, entryText);
            let classified = [], strategies = [];
            for (let i = 0; i < groups.length; i++) {
                this.progress = { stage: '扫描世界书', done: i, total: groups.length }; this.#notify();
                this.#updateActivity(activity, { label: `扫描世界书 ${i + 1}/${groups.length}` });
                const result = await classifyEntries(this.client, groups[i], this.rules.naturalLanguage, signal);
                this.#assertActivity(activity);
                classified.push(...result.entries); strategies.push(result.strategy);
            }
            const ruled = applyRules(classified, this.compiledRules);
            this.constraints = ruled.constraints;
            this.progress = { stage: '统合记忆策略', done: 0, total: 1 };
            this.#updateActivity(activity, { label: '正在统合记忆策略' });
            const strategy = await alignStrategy(this.client, strategies, ruled.entries, this.rules.naturalLanguage, signal);
            this.#assertActivity(activity);
            let committed = false;
            // Card scope updates remain usable while scanning. A changed scope
            // invalidates only the history draft, not the classified worldbook.
            for (let attempt = 0; attempt < 3 && !committed; attempt++) {
                await this.#waitForInitializationContext(activity);
                const baseRevision = targetStore.state.revision;
                const draft = new MemoryStore({ read: async () => null, write: async () => {} }, { auditLimit: this.settings.auditLimit });
                await draft.load(context.chatId, context.bookName);
                draft.state.data.scopeContext = clone(targetStore.state.data.scopeContext ?? null);
                draft.state.data.messageScopes = clone(targetStore.state.data.messageScopes ?? {});
                await draft.initialize(ruled.entries, strategy);
                if (!targetStore.state.data.inventoryEnabled) await draft.manual({ type: 'inventory-toggle', enabled: false });
                await this.#processBatches(draft, this.host.snapshot().messages, signal, activity);
                await this.#waitForInitializationContext(activity);
                if (targetStore.state.revision !== baseRevision) continue;
                // Strong sends during scanning use native prompts and are caught
                // up only once their final selected reply and scope have settled.
                const latest = this.host.snapshot().messages;
                const keys = latest.map(m => m.key);
                if (!isPrefix(draft.state.processed, keys)) await draft.reconcile(keys);
                if (draft.state.processed.length < latest.length) await this.#processBatches(draft, latest, signal, activity);
                this.#assertActivity(activity);
                if (targetStore.state.revision !== baseRevision || targetStore.state.data.scopeContext?.deferPost || this.host.snapshot().generating) continue;
                const latestRaw = await untilAborted(this.host.loadWorldbook(), signal);
                invariant(!sourceBookChanges(draft.state, latestRaw, this.rules.configEntryUids).changed, '扫描期间原书已变化，已有资料保留，请重试');
                await this.#saveActivity(activity, () => targetStore.replaceFromDraft(draft.snapshot(), baseRevision));
                this.sourceChanges = sourceBookChanges(targetStore.state, latestRaw, this.rules.configEntryUids);
                committed = true;
            }
            invariant(committed, '扫描期间状态持续变化，原资料保留；请在本轮结束后重试初始化');
            this.#assertActivity(activity);
            await this.#saveActivity(activity, () => this.#syncWindow({ duringInitialization: true }));
            this.#assertActivity(activity);
            const reviewCount = Object.values(targetStore.state.data.entries).filter(entry => entry.needsReview).length;
            const completed = this.#enabled() ? '存档扫描已完成，记忆已启用' : '存档扫描已完成；记忆尚未启用';
            this.#state(`${completed}${reviewCount ? `；其中 ${reviewCount} 条待核对，请在“资料”查看` : ''}`);
            this.#initializationNotice(null);
            return { executed: true, message: this.status };
        } catch (error) {
            if (epoch === this.#epoch) {
                if (!signal.aborted) this.#state('初始化未完成，保留原资料', error.message);
                this.#initializationNotice('retry', signal.aborted ? '初始化已停止，原资料保留；可手动重试' : `初始化未完成：${error.message}；可手动重试`, true);
            }
            throw error;
        }
        finally { if (epoch === this.#epoch) { this.#initializing = false; this.progress = null; } this.#endActivity(activity); }
    }
    async #processBatches(store, messages, signal, activity) {
        const keys = messages.map(m => m.key);
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
        const groups = runs.flatMap(run => batches(run, this.settings.batchChars));
        let count = store.state.processed.length;
        for (const batch of groups) {
            this.#assertActivity(activity);
            if (store === this.store && this.#selecting()) break;
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
            const result = await maintain(this.client, this.#guarded(before), batch, signal, scopeId, observedState);
            this.#assertActivity(activity);
            if (store === this.store) await this.#assertSourceCurrent(activity);
            if (store === this.store) invariant(isPrefix(keys.slice(0, count + batch.length), this.host.snapshot().messages.map(message => message.key)), '当前剧情候选已变化，旧整理结果不再提交');
            this.#validateGuarded(before, result, batch.map(m => m.key), scopeId);
            count += batch.length;
            await this.#saveActivity(activity, () => store.commit(result, { expectedRevision: before.revision, sourceKeys: keys.slice(0, count),
                allowedEvidence: batch.map(m => m.key), maxChars: this.#maxChars(before), scopeId }));
            this.#assertActivity(activity);
        }
    }
    #maxChars(save) {
        return Object.fromEntries(Object.values(save.data.entries).flatMap(entry => {
            const rule = evaluateRules(this.compiledRules, entry);
            return rule.maxChars ? [[entry.id, rule.maxChars]] : [];
        }));
    }
    async maintain({ automatic = false } = {}) {
        if (this.host.pendingReplacement?.()) return { executed: false, reason: '正在重新生成回复，完成后再更新记忆' };
        if (automatic) this.#resumePostForNewReply();
        if (automatic && this.#autoPostPaused) return { executed: false, reason: '自动整理已暂停，下一条回复后恢复' };
        if (this.#maintenance) return this.#maintenance;
        if (this.#selecting()) return { executed: false, reason: '正在准备本轮资料，稍后自动补记' };
        if (this.store?.state.data.scopeContext?.deferPost) return { executed: false, reason: '角色卡正在确认本轮归属，稍后自动补记' };
        if (!this.#enabled()) return { executed: false, reason: '记忆已暂停，请先启用当前存档与插件总开关' };
        invariant(this.store?.state.initialized, '请先完成初始化');
        invariant(!this.#initializing, '初始化正在处理历史');
        this.#autoPostPaused = false;
        const activity = this.#beginActivity('maintain', '后置正在读取记忆规则');
        const epoch = this.#epoch, signal = activity.signal, store = this.store;
        const task = async () => {
            this.#state('正在维护');
            try {
                await this.#loadRules(epoch, store.state.chatId, signal);
                invariant(!this.sourceChanges.changed, '原书已变化：请先导出聊天备份，再在设置中重新扫描；旧动态资料保留。');
                const messages = this.host.snapshot().messages;
                await this.#saveActivity(activity, () => store.reconcile(messages.map(m => m.key)));
                await this.#processBatches(store, messages, signal, activity);
                this.#assertActivity(activity);
                await this.#saveActivity(activity, () => this.#syncWindow());
                this.#assertActivity(activity);
                const remaining = store.state.processed.length < this.host.snapshot().messages.length;
                this.#state(remaining ? '待补记原文已保留，继续对话后补齐' : '补记已完成');
                return { executed: true, message: this.status };
            } catch (error) {
                if (error.dwmYielded) return { executed: false, reason: '后台整理已让出，优先处理本轮；未记原文保留' };
                if (epoch === this.#epoch && !signal.aborted) this.#state('记忆待补齐，可继续对话', error.message); throw error;
            }
            finally { if (epoch === this.#epoch) this.progress = null; this.#endActivity(activity); }
        };
        const pending = task();
        this.#maintenance = pending;
        try { return await pending; } finally { if (this.#maintenance === pending) this.#maintenance = null; }
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
            if (activity.epoch === this.#epoch && !activity.signal.aborted) this.#state('试选未完成', error.message);
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
        const save = this.store?.snapshot() ?? null, settings = clone(this.settings), presetFingerprint = this.#preset().fingerprint;
        const unchanged = () => {
            const latest = inspect();
            invariant(epoch === this.#epoch && latest.chatId === snapshot.chatId && latest.bookName === snapshot.bookName
                && JSON.stringify(latest.messages) === JSON.stringify(snapshot.messages) && latest.userInput === snapshot.userInput
                && this.store?.state?.revision === save?.revision && JSON.stringify(this.settings) === JSON.stringify(settings) && this.#preset().fingerprint === presetFingerprint,
            '读取期间存档、输入或资料有变化，请刷新预览');
        };
        // Read rules locally: no reconcile, clearPlan, initialization, trace or model call.
        const rawEntries = await this.host.loadWorldbook(snapshot.bookName);
        unchanged();
        const rules = discoverRules(rawEntries), compiledRules = compileRules(rules.script);
        const sourceChanged = sourceBookChanges(save, rawEntries, rules.configEntryUids).changed;
        let projection = null;
        if (settings.mvuEnabled && settings.mvuBookName === snapshot.bookName && this.host.readMvu) {
            try { projection = await this.host.readMvu(settings); } catch { /* Optional observation stays unknown. */ }
        }
        unchanged();
        const observedState = this.#observedState(projection, snapshot, snapshot.messages);
        const scopes = readableScopes(save?.data.scopeContext);
        const eligible = entry => scopes.has(entryScope(entry)) && (this.host.previewEligible ? this.host.previewEligible(entry) : entry.enabled);
        const result = buildPromptPreview({ snapshot, save, settings, rules, compiledRules, rawEntries, eligible,
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
            && isPrefix(save.processed, snapshot.messages.map(m => m.key)) ? save : null;
        const narration = previewNarration(currentSave, { eligible, compiledRules, configEntryUids: rules.configEntryUids });
        if (sourceChanged) { narration.status = 'unavailable'; narration.explanation = sourceWarning; }
        else if (!currentSave && save?.initialized) narration.explanation = '保存快照不属于当前聊天或所选剧情；实际发送会先载入或回放，当前不展示旧片段。';
        for (const stage of result.stages) {
            if (stage.input) { const adapted = applyAuxiliaryPreferences({ system: stage.system, input: stage.input }, this.#auxiliaryPreferences()); stage.system = adapted.system; stage.input = adapted.input; }
        }
        if (save?.preferences?.preset && save.preferences.preset.fingerprint !== this.#preset().fingerprint) result.warnings.push('当前预设已改变，旧辅助偏好暂不采用；请在设置中重新扫描并确认。');
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
            selectedIds: clone(plan.selectedIds), summary: plan.summary, inventory: plan.inventory, details: plan.details,
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
        invariant(!this.sourceChanges.changed, '原书已变化：请先导出聊天备份并重新扫描，或选择本轮按原世界书发送。');
        const snapshot = readSnapshot(), save = project ? this.store.project(snapshot.messages.map(m => m.key)) : this.store.snapshot();
        const scopes = readableScopes(save.data.scopeContext);
        const eligible = entry => scopes.has(entryScope(entry)) && (this.host.eligible ? this.host.eligible(entry, snapshot) : entry.enabled);
        const recent = selectionMessages(snapshot, save, this.settings.recentTurns);
        const projection = this.settings.mvuEnabled ? await untilAborted(this.refreshMvu(), activity.signal) : null;
        this.#assertActivity(activity);
        const observedState = this.#observedState(projection, snapshot, recent);
        const ids = await select(this.client, save, recent, { eligible, selectionLimit: this.settings.selectionLimit,
            selectionChars: this.settings.selectionChars, observedState, signal: activity.signal });
        this.#assertActivity(activity);
        await this.#assertSourceCurrent(activity);
        invariant(save.revision === this.store.state.revision, '选材期间资料更新，请重试本轮');
        invariant(JSON.stringify(snapshot.messages.map(m => m.key)) === JSON.stringify(readSnapshot().messages.map(m => m.key)), '选材期间剧情候选已变化，请重试本轮');
        return { requestId: uid('request'), chatId: snapshot.chatId, mvu: observedState,
            ...assemblePromptPlan(save, ids, { eligible, compiledRules: this.compiledRules, configEntryUids: this.rules.configEntryUids }) };
    }

    async generationBefore({ type, dryRun, isCurrent = () => true } = {}) {
        if (dryRun || !isCurrent()) return;
        this.host.clearPlan();
        if (this.host.restoreLegacyWindow) await this.host.restoreLegacyWindow();
        if (this.#initializing || ['quiet', 'impersonate'].includes(type)) {
            this.#nativeBypass = true;
            if (this.#initializing && !['quiet', 'impersonate'].includes(type)) this.#state('初始化仍在进行；本轮使用原生资料，完成后补记');
            await this.#restoreWindow(); return;
        }
        if (!this.#enabled() || !this.store?.state.initialized) { await this.#restoreWindow(); return; }
        const epoch = this.#epoch, chatId = this.host.snapshot().chatId;
        const activity = this.#beginActivity('select', '前置正在读取记忆规则', { isCurrent });
        try {
            await this.#withSelection(async () => {
                if (!isCurrent()) return;
                await this.#loadRules(epoch, chatId, activity.signal);
                if (!isCurrent()) return;
                const replacing = Boolean(this.host.pendingReplacement?.());
                const readSnapshot = () => this.host.generationSnapshot?.() ?? this.host.snapshot();
                if (!replacing) await this.#saveActivity(activity, () => this.store.reconcile(this.host.snapshot().messages.map(m => m.key)));
                if (!isCurrent()) return;
                const plan = await this.#buildPlan(activity, { readSnapshot, project: replacing });
                if (!isCurrent()) return;
                if (!this.#enabled()) { this.#nativeBypass = true; await this.#restoreWindow(); return; }
                {
                    const snapshot = readSnapshot(), projected = this.store.project(snapshot.messages.map(m => m.key));
                    // A rolled-back batch may also contain older valid text.
                    // Restore that text when the projected summary no longer
                    // certifies it, before ST builds the outgoing history.
                    const actions = planWindow(snapshot.messages, projected.processed, {
                        enabled: this.settings.windowEnabled, recentTurns: this.settings.recentTurns,
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
            this.host.clearPlan(); this.#state('前置选材失败', error.message);
            this.#updateActivity(activity, { label: '选材未完成，等待你的处理', hint: '可重新选材、按原世界书发送，或停止本轮。' });
            const choice = await untilAborted(this.chooseFallback(error, { signal: activity.signal }), activity.signal).catch(error => {
                if (activity.signal.aborted) return 'cancel';
                throw error;
            });
            if (activity.signal.aborted || !isCurrent() || epoch !== this.#epoch || this.host.snapshot().chatId !== chatId) return { cancel: true };
            if (choice === 'retry') return this.generationBefore({ type, dryRun, isCurrent });
            if (choice === 'original') { this.#nativeBypass = true; await this.#restoreWindow(); return; }
            await this.host.stopGeneration?.();
            return { cancel: true };
        } finally { this.#endActivity(activity); }
    }
    messageReceived({ type } = {}) {
        if (this.#initializing || !this.#enabled() || !this.store?.state.initialized || ['quiet', 'impersonate'].includes(type)) return;
        const epoch = this.#epoch;
        // Receive signals are scheduled by the adapter after the final selected message is saved.
        const prepare = type === 'continue' || type === 'append' || type === 'appendFinal'
            ? this.store.reconcile(this.host.snapshot().messages.slice(0, -1).map(m => m.key)) : Promise.resolve();
        prepare.then(() => epoch === this.#epoch && this.maintain({ automatic: true })).then(() => {
            if (epoch === this.#epoch && !this.#autoPostPaused && this.#shouldCompact()) this.compact().catch(() => {});
        }).catch(() => {});
    }
    generationStopped() { const userStopped = this.status === '本轮已停止'; this.#pauseAutomaticPost(); this.cancel(userStopped ? '本轮已停止' : '本轮被酒馆或角色卡取消，记忆未变'); }
    generationEnded() {
        this.#nativeBypass = false;
        this.#notify();
        return this.#syncWindow().catch(error => { this.error = error.message; this.#notify(); });
        // Not proof of a successful reply; adapter handles finalized messages.
    }
    async messageSwiped() { this.cancel(); if (this.store?.state.initialized) await this.maintain(); }
    async messageDeleted() { this.cancel(); if (this.store?.state.initialized) await this.maintain(); }
    async messageSwipeDeleted() { this.cancel(); if (this.store?.state.initialized) await this.maintain(); }
    async manual(action) {
        invariant(this.store?.state.initialized && !this.#initializing, '请先完成初始化');
        if (action.type === 'reset') {
            await this.#loadRules();
            invariant(!this.sourceChanges.changed, '原书已变化，旧基准不能当作新版重置；请先备份并重新扫描。');
        }
        const entry = this.store.state.data.entries[action.id];
        if (entry && ['edit', 'classify'].includes(action.type)) {
            const rule = evaluateRules(this.compiledRules, entry);
            if (rule.locked && action.segments?.some(s => s.writable)) throw new Error('作者脚本已锁定此条，不能解除维护保护');
        }
        await this.store.manual(action, this.host.snapshot().messages.map(m => m.key));
        this.#notify();
        if (action.type === 'inventory-toggle' && action.enabled && this.store.state.inventoryDisabledAt !== null) {
            // Recompute the inventory only; replay must not overwrite other current memories.
            await this.#catchUpInventory();
        }
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
            if (activity.epoch === this.#epoch && !activity.signal.aborted) this.#state('物品补记未完成，原文保留', error.message);
            throw error;
        } finally { this.#endActivity(activity); }
    }
    async compact() {
        invariant(this.store?.state.initialized, '请先初始化');
        if (this.#compacting || this.#initializing || this.#selecting() || this.store.state.data.scopeContext?.deferPost) return { executed: false, reason: '当前任务尚未结束，稍后可整理事件' };
        this.#compacting = true;
        const activity = this.#beginActivity('compact', '后置正在整理历史事件');
        const epoch = this.#epoch, base = this.store.snapshot();
        const scopeId = normalizeScopeId(base.data.scopeContext?.activeScopeId);
        this.#compactAttempts.set(scopeId, this.#compactMeasure().count);
        this.#state('正在整理历史事件');
        try {
            await this.#loadRules(epoch, base.chatId, activity.signal);
            invariant(!this.sourceChanges.changed, '原书已变化，请先备份并重新扫描。');
            const result = await compact(this.client, this.#guarded(base), activity.signal, scopeId);
            this.#assertActivity(activity);
            await this.#assertSourceCurrent(activity);
            if (this.#selecting()) { this.#state('本次整理已让出，优先准备本轮资料'); return; }
            const current = this.store.snapshot();
            // Append-only new events do not invalidate updates to untouched old entries.
            result.operations = result.operations.filter(op => op.type === 'summary'
                ? scopeSummary(current.data, scopeId) === scopeSummary(base.data, scopeId)
                : op.type === 'mergeEvents' ? op.sources.every(source => current.data.entries[source.id]?.version === base.data.entries[source.id]?.version)
                : current.data.entries[op.id]?.version === base.data.entries[op.id]?.version);
            const evidence = [...new Set(Object.values(base.data.entries).filter(e => entryScope(e) === scopeId).flatMap(e => e.evidence))];
            this.#validateGuarded(current, result, evidence, scopeId);
            if (result.operations.length) await this.#saveActivity(activity, () => this.store.commit(result, { expectedRevision: current.revision,
                sourceKeys: current.processed, allowedEvidence: evidence, maxChars: this.#maxChars(current), reason: 'compact', scopeId }));
            this.#assertActivity(activity);
            this.#compactMarks.set(scopeId, this.#compactMeasure());
            this.#compactAttempts.delete(scopeId);
            this.#state('整理已完成');
            return { executed: true, message: this.status };
        } catch (error) { if (epoch === this.#epoch && !activity.signal.aborted) this.#state('整理未完成', error.message); throw error; }
        finally { if (epoch === this.#epoch) this.#compacting = false; this.#endActivity(activity); }
    }
    #compactMeasure() {
        const state = this.store.state, scopeId = normalizeScopeId(state.data.scopeContext?.activeScopeId);
        return { count: state.journal.filter(j => j.reason === 'maintenance').length,
            size: scopeSummary(state.data, scopeId).length + Object.values(state.data.entries)
                .filter(e => e.enabled && entryScope(e) === scopeId && e.kind === 'event').reduce((n, e) => n + entryText(e).length, 0) };
    }
    #shouldCompact() {
        if (!this.store?.state.initialized) return false;
        const scopeId = normalizeScopeId(this.store.state.data.scopeContext?.activeScopeId);
        const current = this.#compactMeasure(), last = this.#compactMarks.get(scopeId) ?? { count: 0, size: 0 };
        const attempt = this.#compactAttempts.get(scopeId);
        if (attempt !== undefined && current.count - attempt < 3) return false;
        return current.count - last.count >= this.settings.compactEvery
            || (current.size >= this.settings.compactChars && current.size >= Math.max(1, last.size * 1.25));
    }
}
