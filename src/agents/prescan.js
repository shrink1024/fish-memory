import { createEntry, entryText } from '../core/state.js';

// Entries settled by the program before a scan, without a model call.
// Disabled entries are scanned once they are enabled (via "只同步变化的条目");
// until then they stay locked and never reach the story.
export const DEFERRED = 'deferred';

/** Pure Prompt Template code: nothing but EJS blocks and @@ directives. Mixed
 * text such as `<% if (x) { %>正文<% } %>` still goes to the model. */
export function scriptOnly(text) {
    const source = String(text ?? '');
    if (!source.includes('<%')) return false;
    const rest = source.replace(/<%[\s\S]*?%>/g, '').replace(/^[ \t]*@@\S.*$/gm, '').replace(/[\s{}()[\];,]/g, '');
    return rest.length <= Math.max(8, Math.floor(source.length * 0.02));
}

export function prescanEntry(entry) {
    if (!entry.enabled) return createEntry({ ...entry, kind: 'fact', intro: '', retrieveWhen: '', needsReview: false, status: DEFERRED });
    if (!scriptOnly(entryText(entry))) return null;
    const keys = (Array.isArray(entry.source?.metadata?.key) ? entry.source.metadata.key : [])
        .filter(key => typeof key === 'string' && key.trim()).slice(0, 12).map(key => key.trim().slice(0, 40));
    return createEntry({ ...entry, kind: 'rule', needsReview: false,
        segments: entry.segments.map(segment => ({ ...segment, writable: false })),
        intro: `脚本条目「${entry.title}」`,
        retrieveWhen: keys.length ? `原书关键词：${keys.join('、')}；出现这些关键词或对应情境时提取` : '由原书设置或脚本决定，通常无需按剧情单独提取' });
}

/** Split source entries into model-free settlements and the rest, in order. */
export function prescan(entries) {
    const settled = new Map(), pending = [];
    for (const entry of entries) {
        const done = prescanEntry(entry);
        if (done) settled.set(entry.id, done); else pending.push(entry);
    }
    return { settled, pending };
}
