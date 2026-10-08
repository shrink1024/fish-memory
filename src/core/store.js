import { clone, invariant, SerialQueue, commonPrefix, isPrefix, uid, plainText } from './util.js';
import { createSave, validateSave, createEntry, normalizeScopeId, GLOBAL_SCOPE } from './state.js';
import { applyMaintenance, applyDataPatch, diffData, auditChanges } from './operations.js';

function anchor(sourceKeys) {
    return { anchorLength: sourceKeys.length, endKey: sourceKeys.length ? sourceKeys.at(-1) : null };
}

function validateInitializationCheckpoint(checkpoint, save) {
    invariant(checkpoint?.version === 1 && ['classification', 'strategy', 'history'].includes(checkpoint.stage), '初始化断点格式无效');
    const identity = checkpoint.identity;
    invariant(identity?.saveId === save.id && identity.chatId === save.chatId && identity.bookName === save.bookName
        && identity.revision === save.revision, '初始化断点不属于当前存档版本');
    invariant([checkpoint.sourceFingerprint, checkpoint.inputFingerprint].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), '初始化断点来源无效');
    invariant(Number.isInteger(checkpoint.classifiedBatches) && Number.isInteger(checkpoint.totalBatches)
        && checkpoint.classifiedBatches >= 0 && checkpoint.classifiedBatches <= checkpoint.totalBatches, '初始化断点进度无效');
    if (checkpoint.stage === 'history') {
        invariant(checkpoint.classifiedBatches === checkpoint.totalBatches && !checkpoint.classification, '初始化历史断点无效');
        invariant(checkpoint.draft && !Object.hasOwn(checkpoint.draft, 'initializationCheckpoint'), '初始化草稿不能嵌套断点');
        validateSave(checkpoint.draft);
        invariant(checkpoint.draft.initialized && checkpoint.draft.chatId === save.chatId && checkpoint.draft.bookName === save.bookName, '初始化草稿归属无效');
    } else {
        invariant(!checkpoint.draft && Array.isArray(checkpoint.classification?.entries)
            && Array.isArray(checkpoint.classification.strategies)
            && checkpoint.classification.strategies.length === checkpoint.classifiedBatches, '初始化分类断点无效');
        checkpoint.classification.entries.forEach(createEntry);
        checkpoint.classification.strategies.forEach(value => plainText(value, '分类策略', 10000));
        if (checkpoint.strategy !== undefined) plainText(checkpoint.strategy, '记忆策略', 10000);
    }
    return checkpoint;
}

function replayOnPath(state, sourceKeys) {
    const common = commonPrefix(state.storyKeys, sourceKeys);
    const next = clone(state);
    let data = clone(next.base), processed = [], journal = [], inventoryDisabledAt = null;
    for (const commit of next.journal) {
        if (commit.anchorLength > common) break;
        data = applyDataPatch(data, commit.patch);
        if (commit.reason !== 'manual') processed = sourceKeys.slice(0, commit.anchorLength);
        inventoryDisabledAt = commit.inventoryDisabledAt;
        journal.push(commit);
    }
    // A regeneration may remove the exact floor where the card paused post
    // processing. Only that card may release its live, chat-local transaction.
    // This also overrides scopeContext patches from earlier development saves.
    data.scopeContext = clone(state.data.scopeContext ?? null);
    // Rolling back a whole memory batch does not undo confirmed attribution of
    // surviving messages. Drop removed/replaced keys, retain the shared prefix.
    data.messageScopes = Object.fromEntries(sourceKeys.slice(0, common)
        .filter(key => state.data.messageScopes?.[key])
        .map(key => [key, state.data.messageScopes[key]]));
    next.data = data; next.processed = processed; next.journal = journal;
    let retainedLength = processed.length;
    for (const commit of journal) retainedLength = Math.max(retainedLength, commit.anchorLength);
    next.storyKeys = sourceKeys.slice(0, retainedLength);
    next.inventoryDisabledAt = inventoryDisabledAt;
    next.audit = [];
    return next;
}

/** Storage.write must reject on failure; serial execution is local, not cross-client CAS. */
export class MemoryStore {
    #queue = new SerialQueue();
    constructor(storage, { auditLimit = 100 } = {}) { this.storage = storage; this.auditLimit = auditLimit; this.state = null; }
    snapshot() { invariant(this.state, '尚未载入存档'); return clone(this.state); }
    /** Read a prospective branch without discarding the saved candidate's journal. */
    project(sourceKeys) {
        invariant(this.state?.initialized, '请先初始化');
        return isPrefix(this.state.storyKeys, sourceKeys) ? this.snapshot() : replayOnPath(this.state, sourceKeys);
    }
    async load(chatId, bookName, inherited = null) {
        return this.#queue.run(async () => {
            const stored = inherited ?? await this.storage.read(chatId);
            const next = stored ? clone(validateSave(stored)) : createSave(chatId, bookName);
            invariant(next.bookName === bookName, '当前主世界书与存档基准不同，请重新初始化');
            if (next.chatId !== chatId) {
                next.parentId = next.id; next.id = uid('save'); next.chatId = chatId;
                // Branch history is inherited; the source chat's live authority
                // is not. The card must restore its branch's committed context.
                next.data.scopeContext = null;
                delete next.initializationCheckpoint;
            }
            this.state = next;
            return this.snapshot();
        });
    }
    async #persist(next) {
        const previous = this.state;
        next.revision = previous.revision + 1;
        // Any formal save change invalidates the separate unfinished draft.
        delete next.initializationCheckpoint;
        await this.storage.write(next.chatId, clone(next), previous.revision);
        this.state = next;
        return this.snapshot();
    }
    initializationCheckpoint() {
        if (!this.state?.initializationCheckpoint) return null;
        try { return clone(validateInitializationCheckpoint(this.state.initializationCheckpoint, this.state)); }
        catch { return null; }
    }
    async saveInitializationCheckpoint(checkpoint, { expectedRevision, isCurrent = () => {} } = {}) {
        return this.#queue.run(async () => {
            isCurrent();
            invariant(this.state.revision === expectedRevision, '初始化期间存档已经变化');
            validateInitializationCheckpoint(checkpoint, this.state);
            const next = this.snapshot();
            next.initializationCheckpoint = clone(checkpoint);
            // Checkpoint writes are serialized with regular writes, but they do
            // not certify narrative or advance the formal data revision.
            await this.storage.write(next.chatId, clone(next), this.state.revision);
            this.state = next;
            return clone(next.initializationCheckpoint);
        });
    }
    async initialize(entries, strategy, { expectedRevision } = {}) {
        return this.#queue.run(async () => {
            if (expectedRevision !== undefined) invariant(this.state.revision === expectedRevision, '初始化期间存档已经变化');
            const next = this.snapshot();
            next.data = { entries: Object.fromEntries(entries.map(input => {
                const entry = createEntry(input);
                if (entry.source && !entry.source.baselineSegments) {
                    invariant(entry.segments.map(s => s.text).join('') === entry.source.original, '原书片段与原文不一致');
                    entry.source.baselineSegments = clone(entry.segments);
                }
                return [entry.id, entry];
            })), strategy: plainText(strategy, '记忆策略', 10000), summary: '', inventory: [], inventoryEnabled: next.data.inventoryEnabled,
                scopeSummaries: {}, scopeInventories: {}, scopeContext: clone(next.data.scopeContext ?? null), messageScopes: clone(next.data.messageScopes ?? {}) };
            next.base = clone(next.data); next.processed = []; next.storyKeys = []; next.journal = []; next.audit = []; next.inventoryDisabledAt = null; next.initialized = true;
            return this.#persist(next);
        });
    }
    async replaceFromDraft(draft, expectedRevision) {
        return this.#queue.run(async () => {
            invariant(this.state.revision === expectedRevision && this.state.chatId === draft.chatId, '初始化期间存档已经变化');
            const next = clone(validateSave(draft));
            next.id = this.state.id; next.parentId = this.state.parentId;
            next.preferences = clone(this.state.preferences ?? {});
            // The same atomic write confirms completion and clears a persisted
            // automatic-attempt marker. Failed drafts leave that marker intact.
            delete next.preferences.autoInitialization;
            return this.#persist(next);
        });
    }
    async commit(result, { expectedRevision, sourceKeys, allowedEvidence = sourceKeys, maxChars = {}, reason = 'maintenance', scopeId = GLOBAL_SCOPE }) {
        return this.#queue.run(async () => {
            invariant(this.state.revision === expectedRevision, '存档已更新，拒绝提交旧结果');
            invariant(isPrefix(this.state.processed, sourceKeys), '当前剧情分支已变化');
            invariant(isPrefix(this.state.storyKeys, sourceKeys) || isPrefix(sourceKeys, this.state.storyKeys), '提交路径与当前剧情不符，请先同步分支');
            const { next: data } = applyMaintenance(this.state.data, result, { allowedEvidence, maxChars, scopeId });
            data.messageScopes ??= {};
            if (reason === 'maintenance') for (const key of allowedEvidence) {
                invariant(!data.messageScopes[key] || data.messageScopes[key] === scopeId, '本批正文混有其他范围的归属');
                data.messageScopes[key] = normalizeScopeId(scopeId);
            }
            return this.#commitData(data, sourceKeys, reason);
        });
    }
    async #commitData(data, sourceKeys, reason) {
        const next = this.snapshot();
        const at = new Date().toISOString();
        const patch = diffData(next.data, data);
        if (sourceKeys.length > next.storyKeys.length) next.storyKeys = clone(sourceKeys);
        if (reason === 'inventory-catchup') next.inventoryDisabledAt = null;
        next.journal.push({ id: uid('commit'), ...anchor(sourceKeys), patch, reason, inventoryDisabledAt: next.inventoryDisabledAt });
        next.audit.push(...auditChanges(next.data, data, reason, at));
        next.audit = next.audit.slice(-this.auditLimit);
        next.data = data; next.processed = clone(sourceKeys);
        return this.#persist(next);
    }
    async reconcile(sourceKeys) {
        return this.#queue.run(async () => {
            invariant(this.state?.initialized, '请先初始化');
            if (isPrefix(this.state.storyKeys, sourceKeys)) return { changed: false, pendingFrom: this.state.processed.length };
            const next = replayOnPath(this.state, sourceKeys);
            await this.#persist(next);
            return { changed: true, pendingFrom: next.processed.length, sharedPrefix: commonPrefix(next.processed, sourceKeys) };
        });
    }
    async manual(action, sourceKeys = this.state.processed) {
        return this.#queue.run(async () => {
            invariant(isPrefix(this.state.processed, sourceKeys), '请先同步当前剧情');
            const baseline = isPrefix(this.state.storyKeys, sourceKeys) ? this.snapshot() : replayOnPath(this.state, sourceKeys);
            const data = clone(baseline.data);
            const entry = data.entries[action.id];
            if (action.type === 'inventory-toggle') {
                data.inventoryEnabled = Boolean(action.enabled);
            } else if (action.type === 'scope-context') {
                data.scopeContext = clone(action.context);
                data.messageScopes ??= {};
                for (const [key, scopeId] of Object.entries(action.messageScopes ?? {})) {
                    invariant(sourceKeys.includes(key), '资料归属必须来自当前聊天正文');
                    invariant(!data.messageScopes[key] || data.messageScopes[key] === scopeId, '已确认的正文范围不能改写');
                    data.messageScopes[key] = normalizeScopeId(scopeId);
                }
            } else {
                invariant(entry, '条目不存在');
                if (action.expectedVersion !== undefined) invariant(action.expectedVersion === entry.version, '条目已更新，请先检查新版再保存草稿');
                if (action.type === 'reset') {
                    invariant(action.confirmed === true && entry.source, '恢复原书需要确认且必须有原书来源');
                    entry.segments = clone(entry.source.baselineSegments ?? [{ id: 'body', text: entry.source.original, writable: false }]);
                    entry.intro = ''; entry.retrieveWhen = ''; entry.evidence = []; entry.lastEvidence = []; entry.evidenceTrimmed = false;
                } else if (action.type === 'edit') {
                    const replacement = createEntry({ ...entry, segments: action.segments ?? entry.segments, title: action.title ?? entry.title,
                        intro: action.intro ?? entry.intro, retrieveWhen: action.retrieveWhen ?? entry.retrieveWhen });
                    data.entries[entry.id] = replacement;
                } else if (action.type === 'classify') {
                    data.entries[entry.id] = createEntry({ ...entry, kind: action.kind ?? entry.kind, segments: action.segments ?? entry.segments, needsReview: false });
                } else if (action.type === 'promote') {
                    invariant(entry.kind === 'npc', '只能晋升 NPC 条目'); entry.important = true;
                } else if (action.type === 'promote-from-pool') {
                    invariant(entry.kind === 'npc_pool' && entry.enabled && entry.segments.every(s => s.writable),
                        '只能从可维护的路人合集建立独立人物');
                    const title = plainText(action.title, '人物名称', 300).trim();
                    const intro = plainText(action.intro, '人物简介', 2000).trim();
                    const text = plainText(action.text, '人物正文', 100000).trim();
                    const retrieveWhen = plainText(action.retrieveWhen ?? '', '提取时机', 4000);
                    invariant(title && intro && text, '请填写人物名称、简介和独立正文');
                    invariant(!Object.values(data.entries).some(other => other.kind === 'npc' && other.title === title
                        && (other.lineage ?? []).includes(entry.id)), '这个人物已从该合集独立建档');
                    const independent = createEntry({ id: uid('entry'), title, kind: 'npc', intro, text,
                        retrieveWhen, scopeId: entry.scopeId, important: true, evidence: entry.evidence,
                        lineage: [...new Set([...(entry.lineage ?? []), entry.id])] });
                    data.entries[independent.id] = independent;
                } else throw new Error('未知手动操作');
                if (action.type !== 'promote-from-pool') data.entries[action.id].version++;
            }
            // A manual action does not certify unprocessed narrative as remembered.
            const progress = clone(baseline.processed);
            const next = baseline;
            const at = new Date().toISOString();
            if (sourceKeys.length > next.storyKeys.length) next.storyKeys = clone(sourceKeys);
            next.audit.push(...auditChanges(next.data, data, action.type, at));
            next.audit = next.audit.slice(-this.auditLimit);
            if (action.type === 'inventory-toggle') next.inventoryDisabledAt = action.enabled ? next.inventoryDisabledAt : progress.length;
            next.journal.push({ id: uid('commit'), ...anchor(sourceKeys), patch: diffData(next.data, data), reason: 'manual', inventoryDisabledAt: next.inventoryDisabledAt });
            next.data = data;
            return this.#persist(next);
        });
    }
    async commitInventoryCatchUp(inventories, expectedRevision) {
        return this.#queue.run(async () => {
            invariant(this.state.revision === expectedRevision, '存档已更新，拒绝提交旧结果');
            invariant(this.state.data.inventoryEnabled, '物品清单尚未开启');
            let data = clone(this.state.data);
            for (const [scopeId, items] of Object.entries(inventories)) {
                data = applyMaintenance(data, { operations: [{ type: 'inventory', items }] }, { scopeId }).next;
            }
            return this.#commitData(data, clone(this.state.processed), 'inventory-catchup');
        });
    }
    async finishInventoryCatchUp(expectedRevision) {
        return this.#queue.run(async () => {
            invariant(this.state.revision === expectedRevision, '存档已更新，拒绝提交旧结果');
            invariant(this.state.data.inventoryEnabled, '物品清单尚未开启');
            if (this.state.inventoryDisabledAt === null) return this.snapshot();
            return this.#commitData(clone(this.state.data), clone(this.state.processed), 'inventory-catchup');
        });
    }
    async updatePreferences(patch) {
        return this.#queue.run(async () => {
            const next = this.snapshot();
            next.preferences = { ...(next.preferences ?? {}), ...clone(patch) };
            return this.#persist(next);
        });
    }
    idle() { return this.#queue.idle(); }
}
