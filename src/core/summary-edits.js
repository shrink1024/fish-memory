import { GLOBAL_SCOPE, scopeSummary } from './state.js';

const LEGACY_LENGTHS = Object.freeze({short: 4000, standard: 8000, long: 16000});
export const DEFAULT_SUMMARY_LENGTH = 8000;

// Invalid saved values recover to the default. Invalid writes must be rejected.
export function parseSummaryLength(value) {
    if (typeof value === 'string' && Object.hasOwn(LEGACY_LENGTHS, value)) return LEGACY_LENGTHS[value];
    return Number.isInteger(value) && value >= 2000 && value <= 50000 ? value : null;
}

export function summaryThreshold(setting) {
    return parseSummaryLength(setting) ?? DEFAULT_SUMMARY_LENGTH;
}

export function setScopeSummary(data, scopeId, text) {
    if (scopeId === GLOBAL_SCOPE) data.summary = text;
    else (data.scopeSummaries ??= {})[scopeId] = text;
}

export function patchedSummary(patch, scopeId) {
    return scopeId === GLOBAL_SCOPE ? patch.summary : patch.scopeChanges?.scopeSummaries?.[scopeId];
}

// Preserve removed facts locally. Never send a history of deleted drafts to the model.
export function removedSummaryClauses(before, after) {
    const parts = before.split(/[。！？!?；;，,\n\r]+|\.\s+(?=[A-Z])/u);
    const removed = new Set(parts.map(text => text.trim()).filter(text => text && !after.includes(text)));
    // For a pure inline deletion also protect the exact excised phrase.
    if (after.length < before.length) {
        let first = 0;
        while (first < after.length && before[first] === after[first]) first++;
        if (before.endsWith(after.slice(first))) {
            const phrase = before.slice(first, first + before.length - after.length).trim();
            if (phrase.length >= 2 && !after.includes(phrase)) removed.add(phrase);
        }
    }
    return [...removed];
}

export function summaryEditPolicy(journal, scopeId) {
    const edits = journal.filter(commit => commit.summaryEdit?.scopeId === scopeId);
    const undone = new Set(edits.map(commit => commit.summaryEdit.undoOf).filter(Boolean));
    const removed = new Set();
    for (const commit of edits) {
        if (undone.has(commit.id) || commit.summaryEdit.undoOf) continue;
        const after = patchedSummary(commit.patch, scopeId);
        for (const text of removed) if (after.includes(text)) removed.delete(text);
        for (const text of commit.summaryEdit.removed) removed.add(text);
    }
    return {last: edits.at(-1), removed};
}

export function summaryUndoState(save) {
    const id = save?.entryChanges?.summaryUndo;
    if (!id) return null;
    const commit = save.journal.find(item => item.id === id && item.summaryEdit && !item.summaryEdit.undoOf);
    if (!commit) return null;
    const {scopeId} = commit.summaryEdit;
    const canUndo = scopeSummary(save.data, scopeId) === patchedSummary(commit.patch, scopeId);
    return {id, kind: 'summary', scopeId, titles: [], canUndo, saveId: save.id, revision: save.revision};
}
