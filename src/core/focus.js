import { entryScope, normalizeScopeId } from './state.js';

/** Writable memory sent in full with one maintenance batch. Above this, only
 * the entries the batch plausibly touches go in full; the rest is a catalog. */
export const FOCUS_CHARS = 40000;
const SPLIT = /[\s/|、,，;；·・:：()（）【】[\]「」『』<>《》"'“”‘’!！?？.。-]+/u;

function matcher(entry) {
    const terms = new Set(String(entry.title ?? '').split(SPLIT).filter(term => [...term].length >= 2));
    const patterns = [];
    for (const key of Array.isArray(entry.source?.metadata?.key) ? entry.source.metadata.key : []) {
        if (typeof key !== 'string' || !key.trim()) continue;
        const regex = key.trim().match(/^\/(.+)\/([a-z]*)$/s);
        if (regex) { try { patterns.push(new RegExp(regex[1], regex[2].replace(/[gy]/g, ''))); } catch { /* invalid author regex: ignore */ } }
        else if ([...key.trim()].length >= 2) terms.add(key.trim());
    }
    return text => {
        let hits = 0;
        for (const term of terms) if (text.includes(term.toLocaleLowerCase())) hits++;
        for (const pattern of patterns) if (pattern.test(text)) hits++;
        return hits;
    };
}

/** Entries recently written by maintenance stay in focus so a continuing
 * scene keeps its working set even when names are not repeated. */
export function recentlyTouched(save, commits = 3) {
    return new Set(save.journal.filter(commit => commit.reason === 'maintenance').slice(-commits)
        .flatMap(commit => Object.keys(commit.patch?.entries ?? {})));
}

/** Returns null when the whole writable memory fits; otherwise a Set of ids. */
export function maintenanceFocus(save, scopeId, messages, { hot = recentlyTouched(save), limitChars = FOCUS_CHARS } = {}) {
    scopeId = normalizeScopeId(scopeId);
    const candidates = Object.values(save.data.entries).filter(e => e.enabled && entryScope(e) === scopeId && e.segments.some(s => s.writable));
    const size = e => e.segments.filter(s => s.writable).reduce((n, s) => n + s.text.length, 0) + String(e.intro ?? '').length;
    if (candidates.reduce((n, e) => n + size(e), 0) <= limitChars) return null;
    const text = messages.map(m => String(m.content ?? '')).join('\n').toLocaleLowerCase();
    const scored = candidates.map(e => ({ e, score: (e.constant ? 1000 : 0) + (hot.has(e.id) ? 500 : 0) + matcher(e)(text) * 10 }))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    const focus = new Set();
    let used = 0;
    for (const { e } of scored) {
        const chars = size(e);
        if (used + chars > limitChars && focus.size) continue;
        focus.add(e.id); used += chars;
    }
    return focus;
}
