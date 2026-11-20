import { setScopeSummary, removedSummaryClauses, summaryEditPolicy, summaryUndoState } from './summary-edits.js';
import { rememberEncodedSize } from './storage-codec.js';
import { applyEntryChange, activeRemovals, enforceRemovals } from './entry-changes.js';
import { clone, invariant, SerialQueue, commonPrefix, isPrefix, uid, plainText, limitText } from './util.js';
import { createSave, validateSave, createEntry, normalizeScopeId, scopeInventory, scopeSummary, normalizeInventoryItems, GLOBAL_SCOPE, TIERS, splitSourceText } from './state.js';
import { applyMaintenance, applyDataPatch, diffData, auditChanges, entryAuditRecord, compactionMeasure } from './operations.js';

const inventoryIssue = code => Object.assign(new Error(`inventory-edit:${code}`), {dwmInventoryEdit:code});
const sameItems = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const setInventory = (data,scopeId,items) => { if(scopeId===GLOBAL_SCOPE)data.inventory=clone(items);else(data.scopeInventories??={})[scopeId]=clone(items); };
const inventoryFromPatch = (patch,scopeId) => scopeId===GLOBAL_SCOPE?patch.inventory:patch.scopeChanges?.scopeInventories?.[scopeId];
function forceInventoryPatch(patch,scopeId,items){
    if(scopeId===GLOBAL_SCOPE)patch.inventory=clone(items);
    else ((patch.scopeChanges??={}).scopeInventories??={})[scopeId]=clone(items);
}
function inventoryUndoTarget(state,scopeId){
    const undone=new Set(state.journal.flatMap(c=>c.inventoryEdit?.undoOf?[c.inventoryEdit.undoOf]:[]));
    return [...state.journal].reverse().find(c=>c.inventoryEdit?.scopeId===scopeId&&!c.inventoryEdit.undoOf&&!undone.has(c.id));
}

function anchor(sourceKeys) {
    return { anchorLength: sourceKeys.length, endKey: sourceKeys.length ? sourceKeys.at(-1) : null };
}

function textEdit(before, after) {
    let start = 0, end = before.length, tail = after.length;
    while (start < end && start < tail && before[start] === after[start]) start++;
    while (end > start && tail > start && before[end - 1] === after[tail - 1]) { end--; tail--; }
    return { start, end, text: after.slice(start, tail) };
}
function reapplyManualField(previous, edited, current, conflict) {
    if (JSON.stringify(previous) === JSON.stringify(edited)) return clone(current);
    if (JSON.stringify(previous) === JSON.stringify(current) || JSON.stringify(edited) === JSON.stringify(current)) return clone(edited);
    if ([previous, edited, current].every(value => typeof value === 'string')) {
        const manual = textEdit(previous, edited), branch = textEdit(previous, current);
        const overlapping = !(manual.end <= branch.start || branch.end <= manual.start)
            || manual.start === manual.end && branch.start === branch.end && manual.start === branch.start;
        if (overlapping) { conflict(); return current; }
        const offset = branch.end <= manual.start ? current.length - previous.length : 0;
        return current.slice(0, manual.start + offset) + manual.text + current.slice(manual.end + offset);
    }
    return clone(edited);
}

function reapplyManualEntry(previous, edited, current) {
    let needsReview = false;
    const conflict = () => { needsReview = true; };
    for (const key of ['title', 'kind', 'intro', 'retrieveWhen', 'important', 'importanceIndependent', 'needsReview', 'enabled', 'tier']) {
        current[key] = reapplyManualField(previous[key], edited[key], current[key], conflict);
    }
    const ids = segments => segments.map(segment => segment.id).join('\0');
    if (ids(previous.segments) !== ids(edited.segments) || ids(previous.segments) !== ids(current.segments)) {
        if (JSON.stringify(previous.segments) === JSON.stringify(current.segments)) current.segments = clone(edited.segments);
        else if (JSON.stringify(previous.segments) !== JSON.stringify(edited.segments)) conflict();
    } else {
        for (let index = 0; index < current.segments.length; index++) {
            for (const key of ['text', 'writable']) current.segments[index][key] = reapplyManualField(
                previous.segments[index][key], edited.segments[index][key], current.segments[index][key], conflict);
        }
    }
    current.needsReview ||= needsReview;
    current.version++;
    return createEntry(current);
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
        invariant(checkpoint.draft.initialized && checkpoint.draft.chatId === save.chatId
            && checkpoint.draft.bookName === (checkpoint.targetBookName ?? save.bookName), '初始化草稿归属无效');
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
    const survivingSummaryEdits = new Set(state.journal.filter(c => c.summaryEdit && c.anchorLength <= common).map(c => c.id));
    const undoneMerges=new Set(state.journal.map(c=>c.entryChange?.undoMergeId).filter(Boolean));
    const uncovered = new Set();
    let data = clone(next.base), originalData = clone(next.base), processed = [], journal = [], inventoryDisabledAt = null;
    for (const commit of next.journal) {
        const originalNext = applyDataPatch(originalData, commit.patch);
        if(commit.entryChange?.undoMergeId){
            // The matching automatic merge is omitted below; replaying this
            // snapshot would resurrect facts from a discarded reply.
            journal.push({...commit,...anchor(sourceKeys.slice(0,Math.min(common,commit.anchorLength))),patch:{entries:{}}});
            originalData=originalNext;continue;
        }
        let replayCommit=commit;
        if(undoneMerges.has(commit.id)){
            const ids=new Set((commit.merges??[]).flatMap(m=>[m.targetId,...m.sourceIds]));
            replayCommit={...commit,patch:{...commit.patch,entries:Object.fromEntries(Object.entries(commit.patch.entries).filter(([id])=>!ids.has(id)))}};
        }
        if (commit.summaryBasis && !survivingSummaryEdits.has(commit.summaryBasis.id)) {
            // This batch read a player edit anchored later than the floors it processed.
            for (const key of commit.summaryBasis.readKeys ?? []) uncovered.add(key);
            const scope = commit.summaryBasis.scopeId;
            const patch = clone(replayCommit.patch);
            if (scope === GLOBAL_SCOPE) delete patch.summary;
            else if (patch.scopeChanges?.scopeSummaries) delete patch.scopeChanges.scopeSummaries[scope];
            replayCommit = {...replayCommit, patch};
        }
        if (commit.anchorLength <= common) {
            data = applyDataPatch(data, replayCommit.patch);
            if (commit.reason !== 'manual') processed = sourceKeys.slice(0, Math.max(processed.length, commit.anchorLength));
            inventoryDisabledAt = commit.inventoryDisabledAt;
            journal.push(replayCommit);
        } else if (commit.summaryEdit) {
            // A summary draft describes the story at the moment it was saved.
            originalData = originalNext;
            continue;
        } else if (commit.reason === 'manual') {
            // An explicit player correction is not generated narrative. Replay
            // only fields that player actually changed, on surviving entries;
            // never resurrect an NPC/event belonging to the discarded reply.
            const corrected = clone(data);
            // A confirmed merge can replay only while all its inputs still
            // match this branch. Otherwise retain the branch's own entries.
            if (commit.entryChange?.kind === 'merge') {
                const matches = commit.entryChange.sourceIds.every(id => JSON.stringify(data.entries[id]) === JSON.stringify(originalData.entries[id]));
                if (matches) {
                    data = applyDataPatch(data, commit.patch);
                    journal.push({ ...commit, ...anchor(sourceKeys.slice(0,common)) });
                }
                originalData = originalNext; continue;
            }
            for (const [id, value] of Object.entries(commit.patch.entries)) {
                const current = corrected.entries[id], previous = originalData.entries[id];
                if (!current && !previous && value?.kind === 'npc' && !value.source && value.lineage?.length
                    && value.lineage.every(parent => corrected.entries[parent])) {
                    corrected.entries[id] = clone(value);
                    corrected.entries[id].evidence = value.evidence.filter(key => sourceKeys.slice(0, common).includes(key));
                    corrected.entries[id].lastEvidence = value.lastEvidence.filter(key => sourceKeys.slice(0, common).includes(key));
                    continue;
                }
                if (!current && !previous && value?.origin === 'import' && !value.source) {
                    corrected.entries[id] = createEntry({ ...clone(value), evidence: [], lastEvidence: [] });
                    continue;
                }
                if (!current || !previous || !value) continue;
                corrected.entries[id] = reapplyManualEntry(previous, value, current);
            }
            if (commit.restoreEntry) {
                const {id,withTier}=commit.restoreEntry, target=commit.patch.entries[id], current=corrected.entries[id];
                if(current && target?.source) corrected.entries[id]=createEntry({...current,title:target.title,kind:target.kind,
                    intro:target.intro,retrieveWhen:target.retrieveWhen,segments:clone(target.segments),source:clone(target.source),needsReview:target.needsReview,
                    evidence:[],lastEvidence:[],evidenceTrimmed:false,version:current.version+1,
                    ...(withTier?{tier:target.tier,enabled:target.enabled,constant:target.constant,important:target.important}:{})});
            }
            if (commit.sourceResolution) {
                const id = commit.sourceResolution.id, target = commit.patch.entries[id];
                if (corrected.entries[id] && target?.source) corrected.entries[id] = createEntry({ ...clone(target), version: corrected.entries[id].version + 1 });
            }
            if (Object.hasOwn(commit.patch, 'inventoryEnabled')) corrected.inventoryEnabled = commit.patch.inventoryEnabled;
            let inventoryEdit;
            if (commit.inventoryEdit) {
                const scopeId = normalizeScopeId(commit.inventoryEdit.scopeId);
                inventoryEdit = {...commit.inventoryEdit,before:clone(scopeInventory(data,scopeId))};
                setInventory(corrected,scopeId,normalizeInventoryItems(inventoryFromPatch(commit.patch,scopeId)));
            }
            const patch = diffData(data, corrected);
            if (inventoryEdit) forceInventoryPatch(patch,inventoryEdit.scopeId,scopeInventory(corrected,inventoryEdit.scopeId));
            if (Object.keys(patch.entries).length || Object.hasOwn(patch, 'inventoryEnabled') || inventoryEdit) {
                inventoryDisabledAt = corrected.inventoryEnabled ? inventoryDisabledAt : Math.min(commit.inventoryDisabledAt ?? processed.length, processed.length);
                journal.push({ ...commit, ...anchor(sourceKeys.slice(0, common)), patch, inventoryDisabledAt, ...(inventoryEdit?{inventoryEdit}:{}) });
                data = corrected;
            }
        }
        // Later commits can have shorter anchors (e.g. compaction), so an
        // invalid earlier anchor must not truncate the rest of the journal.
        originalData = originalNext;
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
    if (Array.isArray(state.rememberedKeys)) {
        const retained = new Set(processed);
        next.rememberedKeys = state.rememberedKeys.filter(key => retained.has(key) && !uncovered.has(key));
    }
    let retainedLength = processed.length;
    for (const commit of journal) retainedLength = Math.max(retainedLength, commit.anchorLength);
    next.storyKeys = sourceKeys.slice(0, retainedLength);
    next.inventoryDisabledAt = inventoryDisabledAt;
    const manualReasons = new Set(['edit', 'reset', 'classify', 'promote', 'promote-from-pool', 'import-memory', 'extra-book', 'source-held-resolve']);
    next.audit = state.audit.filter(item => survivingSummaryEdits.has(item.id) || item.reason === 'rollback-remove'
        || (manualReasons.has(item.reason) && data.entries[item.entryId]));
    return enforceRemovals(next);
}

/** Storage.write must reject on failure; serial execution is local, not cross-client CAS. */
export class MemoryStore {
    #queue = new SerialQueue();
    constructor(storage, { auditLimit = 100 } = {}) { this.storage = storage; this.auditLimit = auditLimit; this.state = null; this.lastRollback=null; }
    snapshot() { invariant(this.state, '尚未载入存档'); return clone(this.state); }
    /** Read a prospective branch without discarding the saved candidate's journal. */
    project(sourceKeys) {
        invariant(this.state?.initialized, '请先初始化');
        return isPrefix(this.state.storyKeys, sourceKeys) ? this.snapshot() : replayOnPath(this.state, sourceKeys);
    }
    async load(chatId, bookName, inherited = null, { allowBookMismatch = false } = {}) {
        return this.#queue.run(async () => {
            const stored = inherited ?? await this.storage.read(chatId);
            const next = stored ? clone(validateSave(stored)) : createSave(chatId, bookName);
            invariant(allowBookMismatch || next.bookName === bookName, '当前主世界书与存档基准不同，请重新初始化');
            if (next.chatId !== chatId) {
                next.parentId = next.id; next.id = uid('save'); next.chatId = chatId;
                // Branch history is inherited; the source chat's live authority
                // is not. The card must restore its branch's committed context.
                next.data.scopeContext = null;
                delete next.initializationCheckpoint;
            }
            if (stored?.chatId === next.chatId) rememberEncodedSize(next, stored);
            this.state = next;
            this.lastRollback=null;
            return this.snapshot();
        });
    }
    async #persist(next, { preserveClassification = false } = {}) {
        const previous = this.state;
        next.revision = previous.revision + 1;
        // Any formal save change invalidates the separate unfinished draft.
        delete next.initializationCheckpoint;
        // Live card scope is not an input to worldbook classification. Retain
        // accepted batches; the controller separately revalidates/restarts the
        // history draft against the new scope before it can be committed.
        if (preserveClassification && previous.initializationCheckpoint?.classificationFingerprint) {
            next.initializationCheckpoint = clone(previous.initializationCheckpoint);
            next.initializationCheckpoint.identity.revision = next.revision;
        }
        // Production storage encodes once and enforces its actual hard limit.
        // Rebuild reserves are admission checks, not a second traversal here;
        // legacy saves above the reserve threshold can still be reduced.
        const submitted = clone(next);
        await this.#write(next.chatId, submitted, previous.revision);
        rememberEncodedSize(next, submitted);
        this.state = next;
        return this.snapshot();
    }
    initializationCheckpoint() {
        if (!this.state?.initializationCheckpoint) return null;
        try { return clone(validateInitializationCheckpoint(this.state.initializationCheckpoint, this.state)); }
        catch { return null; }
    }
    async #write(chatId, submitted, revision) {
        try { await this.storage.write(chatId, submitted, revision); }
        catch (error) {
            // The same HTTP/TypeError shapes can come from model calls or
            // chat persistence. Tag at the actual write boundary, not by text.
            throw Object.assign(new Error(error?.message ?? String(error), {cause:error}), error, {dwmStorage:true});
        }
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
            const submitted = clone(next);
            await this.#write(next.chatId, submitted, this.state.revision);
            rememberEncodedSize(next, submitted);
            this.state = next;
            return clone(next.initializationCheckpoint);
        });
    }
    async initialize(entries, strategy, { expectedRevision, baseEntries = {} } = {}) {
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
            next.base = clone(next.data); delete next.sourceHeld; delete next.entryChanges;
            for (const [id, entry] of Object.entries(baseEntries)) { invariant(next.data.entries[id], '复原基线缺少对应资料'); next.base.entries[id] = createEntry(entry); }
            next.processed = []; next.rememberedKeys = []; next.storyKeys = []; next.journal = []; next.audit = []; next.inventoryDisabledAt = null; next.initialized = true;
            const saved=await this.#persist(next);this.lastRollback=null;return saved;
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
            const saved=await this.#persist(next);this.lastRollback=null;return saved;
        });
    }
    async commit(result, { expectedRevision, sourceKeys, allowedEvidence = sourceKeys, maxChars = {}, reason = 'maintenance', scopeId = GLOBAL_SCOPE, automatic = false }) {
        return this.#queue.run(async () => {
            invariant(this.state.revision === expectedRevision, '存档已更新，拒绝提交旧结果');
            invariant(isPrefix(this.state.processed, sourceKeys), '当前剧情分支已变化');
            invariant(isPrefix(this.state.storyKeys, sourceKeys) || isPrefix(sourceKeys, this.state.storyKeys), '提交路径与当前剧情不符，请先同步分支');
            const currentKeys = new Set(sourceKeys);
            invariant(allowedEvidence.every(key => currentKeys.has(key)), '维护依据不属于当前剧情');
            const summaryOps = result.operations.filter(op => op.type === 'summary' || op.type === 'appendSummary');
            const policy = summaryOps.length ? summaryEditPolicy(this.state.journal, scopeId) : null;
            const removedClauses = policy ? [...policy.removed] : [];
            const restoresDeletion = removedClauses.length && summaryOps.some(op =>
                typeof op.text === 'string' && removedClauses.some(text => op.text.includes(text)));
            if (restoresDeletion) result = {...result, operations: result.operations.filter(op => !summaryOps.includes(op))};
            const { next: data, rejected, merges } = applyMaintenance(this.state.data, result, { allowedEvidence, maxChars, scopeId, removals: activeRemovals(this.state), requireEdits: true, allowAutomaticMerge:reason==='compact' });
            if (restoresDeletion) rejected.push({code:'summary-edited-content', entryId:'$summary', scopeId, title:'', kind:'summary', evidence:allowedEvidence});
            data.messageScopes ??= {};
            if (reason === 'maintenance') for (const key of allowedEvidence) {
                invariant(!data.messageScopes[key] || data.messageScopes[key] === scopeId, '本批正文混有其他范围的归属');
                data.messageScopes[key] = normalizeScopeId(scopeId);
            }
            // Advance the attempted batch without paying to retry it, but do
            // not certify rejected text changes as safely replaceable history.
            const unresolved=new Set(rejected.filter(item=>item.code.startsWith('patch-')).flatMap(item=>item.evidence));
            return this.#commitData(data, sourceKeys, reason, reason === 'maintenance' && !restoresDeletion ? allowedEvidence.filter(key=>!unresolved.has(key)) : [], {
                ...(policy?.last ? {summaryBasis: {id: policy.last.id, scopeId, ...(reason === 'maintenance' ? {readKeys: allowedEvidence} : {})}} : {}),
                ...(automatic?{automatic:true,readKeys:reason==='maintenance'?clone(allowedEvidence):[]}:{}),...(rejected.length?{rejected}: {}),...(merges.length?{merges}: {})});
        });
    }
    async #commitData(data, sourceKeys, reason, rememberedKeys = [], provenance = {}) {
        const next = this.snapshot();
        const at = new Date().toISOString();
        const commitId=uid('commit');
        const patch = diffData(next.data, data);
        if(provenance.merges?.length){
            const ids=[...new Set(provenance.merges.flatMap(item=>[item.targetId,...item.sourceIds]))];
            next.entryChanges??={removed:{}};
            delete next.entryChanges.undo;
            delete next.entryChanges.summaryUndo;
            next.entryChanges.automaticUndo={id:uid('entry-undo'),kind:'merge',automatic:true,commitId,
                titles:[...new Set(provenance.merges.flatMap(m=>m.sourceIds).map(id=>next.data.entries[id]?.title).filter(Boolean))],
                before:Object.fromEntries(ids.map(id=>[id,clone(next.data.entries[id]??null)])),
                after:Object.fromEntries(ids.map(id=>[id,clone(data.entries[id]??null)])),removedBefore:{},storyKeys:clone(sourceKeys)};
        }
        if (sourceKeys.length > next.storyKeys.length) next.storyKeys = clone(sourceKeys);
        if (reason === 'inventory-catchup') next.inventoryDisabledAt = null;
        next.journal.push({ id: commitId, ...anchor(sourceKeys), patch, reason, inventoryDisabledAt: next.inventoryDisabledAt, ...provenance });
        next.audit.push(...auditChanges(next.data, data, reason, at).map(row=>{
            const merge=provenance.merges?.find(m=>m.targetId===row.entryId||m.sourceIds.includes(row.entryId));
            return merge?{...row,reason:'automatic-merge',merge:clone(merge)}:row;
        }));
        next.audit.push(...(provenance.rejected??[]).map(item=>({id:uid('audit'),entryId:item.entryId,scopeId:item.scopeId,at,
            reason:item.code,outcome:'rejected',title:item.title,kind:item.kind,before:'',after:'',evidence:clone(item.evidence),
            ...(item.editIndex!==undefined?{editIndex:item.editIndex,segmentId:item.segmentId}:{})})));
        next.audit = next.audit.slice(-this.auditLimit);
        next.data = data; next.processed = clone(sourceKeys);
        // Progress can cross externally hidden floors. Only messages actually
        // supplied to maintenance may be omitted after they become visible.
        const unresolved=new Set(reason==='maintenance'?(provenance.rejected??[]).filter(item=>item.code.startsWith('patch-')).flatMap(item=>item.evidence):[]);
        next.rememberedKeys = [...new Set([...(next.rememberedKeys ?? []), ...rememberedKeys])].filter(key=>!unresolved.has(key));
        return this.#persist(next);
    }
    /** Incremental source sync: replace changed baseline entries and record the
     * live result as a commit at the current progress, so branches and
     * rollbacks replay it like any other memory change. */
    async syncSource({ base = {}, data = {}, removed = [], held = {} }, { expectedRevision }) {
        return this.#queue.run(async () => {
            invariant(this.state?.initialized, '请先完成初始化');
            invariant(this.state.revision === expectedRevision, '资料在同步期间已变化，请重新同步');
            const next = this.snapshot(), at = new Date().toISOString();
            next.sourceHeld = { ...(next.sourceHeld ?? {}) };
            for (const id of [...removed, ...Object.keys(base), ...Object.keys(data)]) delete next.sourceHeld[id];
            for (const [id, pending] of Object.entries(held)) {
                if (pending === null) delete next.sourceHeld[id]; else next.sourceHeld[id] = clone(pending);
            }
            const nextData = clone(next.data);
            for (const id of removed) { delete nextData.entries[id]; delete next.base.entries[id]; }
            for (const [id, entry] of Object.entries(base)) next.base.entries[id] = createEntry(entry);
            for (const [id, entry] of Object.entries(data)) nextData.entries[id] = createEntry(entry);
            const sourceKeys = clone(next.processed);
            next.journal.push({ id: uid('commit'), ...anchor(sourceKeys), patch: diffData(next.data, nextData), reason: 'source-sync', inventoryDisabledAt: next.inventoryDisabledAt });
            next.audit.push(...auditChanges(next.data, nextData, 'source-sync', at));
            next.audit = next.audit.slice(-this.auditLimit);
            next.data = nextData;
            return this.#persist(next);
        });
    }
    async reconcile(sourceKeys) {
        return this.#queue.run(async () => {
            invariant(this.state?.initialized, '请先初始化');
            if (isPrefix(this.state.storyKeys, sourceKeys)) return { changed: false, pendingFrom: this.state.processed.length };
            const previous=this.state,common=commonPrefix(previous.storyKeys,sourceKeys),remaining=new Set(sourceKeys);
            const next = replayOnPath(previous, sourceKeys),patch=diffData(previous.data,next.data);
            const discardedRanges=[];
            previous.storyKeys.forEach((key,index)=>{if(remaining.has(key))return;const last=discardedRanges.at(-1);if(last?.to===index)last.to=index+1;else discardedRanges.push({from:index+1,to:index+1});});
            const rollback={id:uid('rollback'),chatId:previous.chatId,at:new Date().toISOString(),
                invalidatedRange:{from:common+1,to:previous.storyKeys.length},discardedRanges,
                affectedEntries:Object.entries(patch.entries).map(([id,entry])=>({id,title:(entry??previous.data.entries[id]).title,kind:(entry??previous.data.entries[id]).kind,action:entry?'restored':'removed'})),
                summaryChanged:Object.hasOwn(patch,'summary')||Object.hasOwn(patch.scopeChanges??{},'scopeSummaries'),
                inventoryChanged:Object.hasOwn(patch,'inventory')||Object.hasOwn(patch.scopeChanges??{},'scopeInventories')};
            for (const item of rollback.affectedEntries) {
                if (item.action === 'removed') {
                    next.audit.push(entryAuditRecord(previous.data.entries[item.id], 'rollback-remove', rollback.at));
                }
            }
            next.audit = next.audit.slice(-this.auditLimit);
            const reverted = previous.journal.filter(commit => commit.summaryEdit && commit.anchorLength > common);
            if (reverted.length) rollback.revertedSummaryEdits = reverted.map(commit => ({
                id: commit.id, scopeId: commit.summaryEdit.scopeId, action: commit.summaryEdit.undoOf ? 'undo' : 'edit'
            }));
            if (next.entryChanges?.summaryUndo && !summaryUndoState(next)) delete next.entryChanges.summaryUndo;
            try{await this.#persist(next);}
            catch(error){throw Object.assign(error instanceof Error?error:new Error(String(error)),{dwmRollbackFailed:true});}
            this.lastRollback={...rollback,revision:this.state.revision};
            return { changed: true, pendingFrom: next.processed.length, sharedPrefix: commonPrefix(next.processed, sourceKeys),rollback:clone(this.lastRollback) };
        });
    }
    inventoryEditState(scopeId = GLOBAL_SCOPE) {
        scopeId=normalizeScopeId(scopeId);
        const state=this.state,reason=!state?.initialized?'uninitialized':!state.data.inventoryEnabled?'disabled':state.inventoryDisabledAt!==null?'catch-up':null;
        const target=state?inventoryUndoTarget(state,scopeId):null;
        return {scopeId,saveId:state?.id??null,revision:state?.revision??null,canEdit:!reason,reason,undoCommitId:target?.id??null,
            canUndo:!reason&&Boolean(target)&&sameItems(scopeInventory(state.data,scopeId),inventoryFromPatch(target.patch,scopeId))};
    }
    async manual(action, sourceKeys = this.state.processed) {
        return this.#queue.run(async () => {
            invariant(isPrefix(this.state.processed, sourceKeys), '请先同步当前剧情');
            const baseline = isPrefix(this.state.storyKeys, sourceKeys) ? this.snapshot() : replayOnPath(this.state, sourceKeys);
            const data = clone(baseline.data);
            const entry = data.entries[action.id];
            let inventoryEdit;
            if (action.type === 'audit-clear') {
                invariant(entry && !entry.source, '仅鱼忆新增条目可单独清除记录');
                invariant(action.confirmed === true, '清除记录需要确认');
                baseline.audit = baseline.audit.filter(item => item.entryId !== action.id);
                return this.#persist(baseline);
            }
            if (action.type === 'source-held-resolve') {
                invariant(action.confirmed === true, '处理待决定的原书变化需要确认');
                invariant(['adopt-source', 'keep-current'].includes(action.choice), '请选择采用新原文或保留当前版本');
                invariant(action.expectedRevision === undefined || action.expectedRevision === this.state.revision, '资料已变化，请重新核对');
                const pending = baseline.sourceHeld?.[action.id], nextSource = pending?.next;
                invariant(entry?.source && nextSource?.id === entry.id && nextSource.source?.book === entry.source.book
                    && String(nextSource.source.uid) === String(entry.source.uid), '该条目已没有待决定的原书变化');
                invariant(action.expectedResolutionId === undefined || action.expectedResolutionId === pending.resolutionId, '待决定的原书版本已变化，请重新核对');
                invariant(action.expectedVersion === undefined || action.expectedVersion === entry.version, '条目已更新，请重新核对后确认');
                baseline.base.entries[entry.id] = createEntry(nextSource);
                data.entries[entry.id] = createEntry(action.choice === 'keep-current'
                    ? { ...entry, source: clone(nextSource.source), version: entry.version + 1 }
                    : { ...nextSource, ...(entry.tier ? { tier: entry.tier, enabled: entry.tier !== 'off' } : {}), version: entry.version + 1 });
                delete baseline.sourceHeld[entry.id];
            } else if (action.type === 'extra-book') {
                invariant(Array.isArray(action.entries) && action.entries.length > 0 && action.entries.length <= 1000, '加入条目数量无效');
                for (const input of action.entries) {
                    const added = createEntry(input);
                    invariant(added.source?.book && added.source.book !== baseline.bookName && !data.entries[added.id] && !baseline.base.entries[added.id], '来源条目已存在或无效');
                    data.entries[added.id] = added;
                    // Explicit additions belong to the save, not to a discarded reply.
                    baseline.base.entries[added.id] = clone(added);
                }
            } else if (action.type === 'import-memory') {
                invariant(Array.isArray(action.entries) && action.entries.length > 0 && action.entries.length <= 1000, '补充记忆数量无效');
                for (const row of action.entries) {
                    const title = plainText(row.title, '条目名称', 500), text = plainText(row.content, '补充正文', 100000);
                    const scopeId = normalizeScopeId(action.scopeId);
                    if (Object.values(data.entries).some(e => normalizeScopeId(e.scopeId) === scopeId && e.title === title && e.segments.map(s => s.text).join('') === text)) continue;
                    const imported = createEntry({ id: uid('entry'), title, kind: 'fact', scopeId, constant: true, enabled: true, origin: 'import',
                        intro: text.slice(0, 300), retrieveWhen: '玩家导入的既往剧情，作为已提供的背景参考。',
                        segments: [{ id: 'body', text, writable: false }] });
                    data.entries[imported.id] = imported;
                }
            } else if (action.type === 'tiers') {
                invariant(TIERS.includes(action.tier) && Array.isArray(action.items) && action.items.length > 0 && action.items.length <= 1000, '批量档位参数无效，最多 1000 条');
                invariant(new Set(action.items.map(item => item.id)).size === action.items.length, '批量条目不能重复');
                for (const item of action.items) {
                    const current = data.entries[item.id];
                    invariant(current && current.version === item.expectedVersion, '条目已变化，请重新选择后应用');
                    invariant(action.tier === 'off' || current.status !== 'deferred' || item.classified, '未扫描条目需要先分类');
                    data.entries[item.id] = createEntry({ ...current, ...(item.classified ?? {}), id: current.id,
                        source: current.source, scopeId: current.scopeId, evidence: current.evidence, lineage: current.lineage,
                        // A successful rescan clears an earlier refusal; createEntry drops the false marker.
                        scanBlocked: item.classified ? false : current.scanBlocked,
                        tier: action.tier, enabled: action.tier !== 'off', version: current.version + 1 });
                }
            } else if (['inventory-edit','inventory-edit-undo'].includes(action.type)) {
                invariant(action.expectedSaveId === this.state.id, '存档已切换，本次处理已作废');
                invariant(Number.isInteger(action.expectedRevision) && action.expectedRevision === this.state.revision, '资料已更新，请重新核对后保存');
                if (!data.inventoryEnabled) throw inventoryIssue('disabled');
                if (baseline.inventoryDisabledAt !== null) throw inventoryIssue('catch-up');
                const scopeId=normalizeScopeId(action.scopeId),before=clone(scopeInventory(data,scopeId));
                let items;
                if (action.type==='inventory-edit-undo') {
                    const target=inventoryUndoTarget(baseline,scopeId);
                    if(!target||target.id!==action.commitId)throw inventoryIssue('no-undo');
                    if(!sameItems(before,inventoryFromPatch(target.patch,scopeId)))throw inventoryIssue('changed');
                    items=normalizeInventoryItems(target.inventoryEdit.before);
                    inventoryEdit={scopeId,before,undoOf:target.id};
                } else {
                    items=normalizeInventoryItems(action.items);
                    invariant(items.every(item=>item.name.trim()),'物品名称无效');
                    if(sameItems(before,items))return this.#persist(baseline);
                    inventoryEdit={scopeId,before};
                }
                setInventory(data,scopeId,items);
            } else if (action.type === 'inventory-toggle') {
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
                if (['reset', 'restore-entry'].includes(action.type)) {
                    invariant(action.confirmed === true && entry.source, '恢复原书需要确认且必须有原书来源');
                    const initial = baseline.base.entries[entry.id];
                    entry.title = initial?.title ?? entry.source.metadata?.comment ?? entry.title;
                    entry.kind = initial?.kind ?? entry.kind;
                    entry.needsReview = Boolean(initial?.needsReview);
                    entry.segments = clone(entry.source.baselineSegments ?? [{ id: 'body', text: entry.source.original, writable: false }]);
                    entry.intro = baseline.base.entries[entry.id]?.intro ?? '';
                    entry.retrieveWhen = baseline.base.entries[entry.id]?.retrieveWhen ?? '';
                    entry.evidence = []; entry.lastEvidence = []; entry.evidenceTrimmed = false;
                    if (action.type === 'restore-entry' && action.withTier) {
                        const scanned = baseline.base.entries[entry.id];
                        delete entry.tier; entry.enabled = scanned?.enabled ?? true;
                        entry.constant = scanned?.constant ?? false; entry.important = scanned?.important ?? false;
                    }
                } else if (action.type === 'edit') {
                    const replacement = createEntry({ ...entry, segments: (action.segments ?? entry.segments).flatMap(segment => typeof segment.text === 'string' && segment.text.length > 100000 ? splitSourceText(segment.text).map((part,index)=>({...segment,text:part.text,id:index?uid('segment'):segment.id})) : [segment]), title: action.title ?? entry.title,
                        intro: action.intro ?? entry.intro, retrieveWhen: action.retrieveWhen ?? entry.retrieveWhen });
                    data.entries[entry.id] = replacement;
                } else if (action.type === 'tier') {
                    invariant(TIERS.includes(action.tier), '档位只能是常驻、按需或关闭');
                    // A never-scanned (deferred) entry arrives classified by the controller.
                    const base = action.classified ? createEntry({ ...action.classified, evidence: entry.evidence, lineage: entry.lineage, version: entry.version }) : entry;
                    data.entries[entry.id] = createEntry({ ...base, tier: action.tier, enabled: action.tier !== 'off' });
                } else if (action.type === 'tier-reset') {
                    // Back to the tier of the scanned baseline (initialization or latest sync).
                    const scanned = baseline.base.entries[entry.id];
                    const { tier: _tier, ...rest } = entry;
                    data.entries[entry.id] = createEntry({ ...rest, enabled: scanned ? scanned.enabled : true,
                        constant: scanned ? scanned.constant : false, important: scanned ? scanned.important : false });
                } else if (action.type === 'classify') {
                    data.entries[entry.id] = createEntry({ ...entry, kind: action.kind ?? entry.kind, segments: action.segments ?? entry.segments, needsReview: false });
                } else if (action.type === 'promote') {
                    invariant(entry.kind === 'npc', '只能晋升 NPC 条目');
                    if (!entry.important) entry.importanceIndependent = true;
                    entry.important = true;
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
                        retrieveWhen, scopeId: entry.scopeId, important: true, importanceIndependent: true, evidence: entry.evidence,
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
            if (action.type === 'restore-entry') next.audit = next.audit.filter(item => item.entryId !== action.id);
            else if (!['tier', 'tiers', 'tier-reset'].includes(action.type)) next.audit.push(...auditChanges(next.data, data, action.type, at));
            next.audit = next.audit.slice(-this.auditLimit);
            if (action.type === 'inventory-toggle' && !action.enabled && next.data.inventoryEnabled) next.inventoryDisabledAt = progress.length;
            const patch = diffData(next.data, data);
            if(inventoryEdit)forceInventoryPatch(patch,inventoryEdit.scopeId,scopeInventory(data,inventoryEdit.scopeId));
            next.journal.push({ id: uid('commit'), ...anchor(sourceKeys), patch, reason: 'manual', inventoryDisabledAt: next.inventoryDisabledAt,
                ...(inventoryEdit?{inventoryEdit}:{}),
                ...(action.type==='restore-entry'?{restoreEntry:{id:action.id,withTier:Boolean(action.withTier)}}:{}),
                ...(action.type==='source-held-resolve'?{sourceResolution:{id:action.id,choice:action.choice}}:{}) });
            next.data = data;
            return this.#persist(next, { preserveClassification: action.type === 'scope-context' });
        });
    }
    async changeSummary(action, sourceKeys) {
        return this.#queue.run(async () => {
            const save = this.state;
            invariant(save?.initialized && action.expectedSaveId === save.id && action.expectedRevision === save.revision
                && isPrefix(save.storyKeys, sourceKeys), 'summary-edit:changed');
            const undo = action.type === 'entry-change-undo';
            const slot = undo ? summaryUndoState(save) : null;
            if (undo) invariant(action.confirmed === true && slot?.canUndo && slot.id === action.undoId, 'summary-edit:undo-changed');
            const scopeId = normalizeScopeId(undo ? slot.scopeId : action.scopeId);
            const before = scopeSummary(save.data, scopeId);
            const original = undo ? save.journal.find(commit => commit.id === slot.id).summaryEdit : null;
            const text = undo ? original.before : plainText(action.text, '故事脉络', Math.max(100000, before.length));
            if (before === text) return this.snapshot();
            const next = this.snapshot();
            setScopeSummary(next.data, scopeId, text);
            const id = uid('summary-edit'), at = new Date().toISOString();
            const reason = undo ? 'summary-edit-undo' : 'summary-edit';
            next.journal.push({id, ...anchor(sourceKeys), reason: 'manual', inventoryDisabledAt: next.inventoryDisabledAt,
                patch: diffData(save.data, next.data), summaryEdit: {scopeId, before,
                    removed: undo ? [] : removedSummaryClauses(before, text), ...(undo ? {undoOf: slot.id} : {})}});
            next.audit.push({id, at, reason, entryId: '$summary', scopeId, kind: 'summary', before: limitText(before), after: limitText(text), evidence: []});
            next.audit = next.audit.slice(-this.auditLimit);
            next.entryChanges ??= {removed: {}};
            delete next.entryChanges.undo;
            delete next.entryChanges.automaticUndo;
            if (undo) delete next.entryChanges.summaryUndo;
            else next.entryChanges.summaryUndo = id;
            next.storyKeys = clone(sourceKeys);
            return this.#persist(next);
        });
    }
    async changeEntries(action, sourceKeys = this.state.storyKeys) {
        return this.#queue.run(async () => {
            invariant(this.state?.initialized, 'entry-change:uninitialized');
            const { next, kind, sourceIds, undoMergeId } = applyEntryChange(this.state, action, sourceKeys);
            const patch = diffData(this.state.data, next.data);
            next.journal.push({ id: uid('commit'), ...anchor(sourceKeys), patch, reason: 'manual',
                inventoryDisabledAt: next.inventoryDisabledAt, entryChange: { kind, sourceIds, ...(undoMergeId?{undoMergeId}:{}) } });
            next.audit.push(...auditChanges(this.state.data,next.data,`entry-${kind}`,new Date().toISOString()));
            next.audit=next.audit.slice(-this.auditLimit);
            if(sourceKeys.length>next.storyKeys.length)next.storyKeys=clone(sourceKeys);
            if(undoMergeId){
                const scopes=new Set(sourceIds.flatMap(id=>next.data.entries[id]?[normalizeScopeId(next.data.entries[id].scopeId)]:[]));
                for(const scopeId of scopes)(next.preferences.compaction??={})[scopeId]={...compactionMeasure(next,scopeId),
                    ...anchor(next.processed),at:new Date().toISOString()};
            }
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
            return this.#persist(next, {preserveClassification:Object.keys(patch).every(key=>key==='lazy')});
        });
    }
    idle() { return this.#queue.idle(); }
}
