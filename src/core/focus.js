import { entryScope, normalizeScopeId } from './state.js';

/** Writable memory sent in full with one maintenance batch. Above this, only
 * the entries the batch plausibly touches go in full; the rest is a catalog. */
export const FOCUS_CHARS = 40000;
const SPLIT = /[\s/|、,，;；·・:：()（）【】[\]「」『』<>《》"'“”‘’!！?？.。-]+/u;

/** Text prepared once for many matchers: author regexes see the original. */
export const matchText = raw => ({ raw, lower: raw.toLocaleLowerCase() });
/** Hits of an entry's title words (optional) and its original-book keys in text.
 * Plain keys match case-insensitively; `/regex/flags` keys run on the original
 * text with the author's own flags. `minKeyLength` 2 keeps the maintenance
 * focus from waking on single characters; author triggers accept any key. */
export function matcher(entry, { titles = true, minKeyLength = 2 } = {}) {
    const terms = new Set(titles ? String(entry.title ?? '').split(SPLIT).filter(term => [...term].length >= 2).map(term => term.toLocaleLowerCase()) : []);
    const patterns = [];
    for (const key of Array.isArray(entry.source?.metadata?.key) ? entry.source.metadata.key : []) {
        if (typeof key !== 'string' || !key.trim()) continue;
        const regex = key.trim().match(/^\/(.+)\/([a-z]*)$/s);
        if (regex) { try { patterns.push(new RegExp(regex[1], regex[2].replace(/[gy]/g, ''))); } catch { /* invalid author regex: ignore */ } }
        else if ([...key.trim()].length >= minKeyLength) terms.add(key.trim().toLocaleLowerCase());
    }
    return ({ raw, lower }) => {
        let hits = 0;
        for (const term of terms) if (lower.includes(term)) hits++;
        for (const pattern of patterns) if (pattern.test(raw)) hits++;
        return hits;
    };
}

/** Entries recently written by maintenance stay in focus so a continuing
 * scene keeps its working set even when names are not repeated. */
export function recentlyTouched(save, commits = 3) {
    return new Set(save.journal.filter(commit => commit.reason === 'maintenance').slice(-commits)
        .flatMap(commit => Object.keys(commit.patch?.entries ?? {})));
}

/** Messages read for author `trigger` rules besides the player's input. */
export const TRIGGER_SCAN_MESSAGES = 4;
/** Author `trigger` rules: entries whose original-book keywords appear in the
 * player's input or the latest messages are sent, without asking the model. */
export function triggeredIds(save, messages, userInput, { rules, eligible = () => true }) {
    const text = matchText([userInput ?? '', ...messages.slice(-TRIGGER_SCAN_MESSAGES).map(m => String(m.content ?? ''))].join('\n'));
    if (!text.raw.trim()) return [];
    return Object.values(save.data.entries).filter(e => e.enabled && eligible(e) && rules(e).trigger && matcher(e, { titles: false, minKeyLength: 1 })(text) > 0).map(e => e.id);
}

/** Returns null when the whole writable memory fits; otherwise a Set of ids. */
export function maintenanceFocus(save, scopeId, messages, { hot = recentlyTouched(save), limitChars = FOCUS_CHARS } = {}) {
    scopeId = normalizeScopeId(scopeId);
    const candidates = Object.values(save.data.entries).filter(e => e.enabled && entryScope(e) === scopeId && e.segments.some(s => s.writable));
    const size = e => e.segments.filter(s => s.writable).reduce((n, s) => n + s.text.length, 0) + String(e.intro ?? '').length;
    if (candidates.reduce((n, e) => n + size(e), 0) <= limitChars) return null;
    const text = matchText(messages.map(m => String(m.content ?? '')).join('\n'));
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
