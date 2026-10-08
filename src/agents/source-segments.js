import { invariant } from '../core/util.js';

/** Model output only selects permissions and boundaries. All saved text comes
 * from the source; uncertain boundaries must never grant new write access. */
export function sourceSegments(text, segments) {
    invariant(Array.isArray(segments) && segments.length > 0 && segments.length <= 100, '初始化条目必须包含 1–100 个片段');
    const ids = new Set();
    for (const segment of segments) {
        invariant(segment && typeof segment.id === 'string' && segment.id.length > 0 && segment.id.length < 1000 && !ids.has(segment.id), '初始化片段身份缺失或重复');
        ids.add(segment.id);
        invariant(typeof segment.writable === 'boolean', '初始化片段须有明确写权限');
    }
    const protect = () => ({ segments: [{ id: 'body', text, writable: false }], needsReview: true });
    const fromStarts = starts => ({ needsReview: false, segments: segments.map((segment, index) => ({
        id: segment.id, writable: segment.writable, text: text.slice(starts[index], starts[index + 1] ?? text.length),
    })) });

    if (segments.some(segment => Object.hasOwn(segment, 'start'))) {
        // Conflicting old/new descriptions cannot establish a reliable boundary.
        if (segments.some(segment => Object.hasOwn(segment, 'text'))) return protect();
        // The first segment always starts at zero. Other anchors must be unique
        // in the entire source, including overlapping matches, and in order.
        if (segments[0].start !== undefined && segments[0].start !== '') return protect();
        const starts = [0];
        for (const segment of segments.slice(1)) {
            if (typeof segment.start !== 'string' || !segment.start.length) return protect();
            const at = text.indexOf(segment.start);
            if (at <= starts.at(-1) || text.indexOf(segment.start, at + 1) !== -1) return protect();
            if (/[\uDC00-\uDFFF]/.test(text[at]) && /[\uD800-\uDBFF]/.test(text[at - 1])) return protect();
            starts.push(at);
        }
        return fromStarts(starts);
    }

    // A single segment needs no copied body. Older models/fixtures may still
    // echo text; exact copies remain compatible, altered copies are protected.
    if (segments.length === 1 && !Object.hasOwn(segments[0], 'text')) return fromStarts([0]);
    if (!segments.every(segment => typeof segment.text === 'string') || segments.map(segment => segment.text).join('') !== text) return protect();
    let at = 0;
    const starts = segments.map(segment => { const start = at; at += segment.text.length; return start; });
    return fromStarts(starts);
}
