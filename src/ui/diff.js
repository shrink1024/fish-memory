// Text-only difference data. Rendering uses textContent, including untrusted book text.
// Keep work bounded for unusually large worldbook entries.
export function diffText(before = '', after = '') {
    before = String(before); after = String(after);
    if (before === after) return before ? [{ type: 'equal', text: before }] : [];
    const a = Array.from(before), b = Array.from(after);
    let head = 0, tail = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    while (tail < a.length - head && tail < b.length - head && a[a.length - tail - 1] === b[b.length - tail - 1]) tail++;
    const left = a.slice(head, a.length - tail), right = b.slice(head, b.length - tail);
    const result = [];
    const append = (type, text) => {
        if (!text) return;
        if (result.at(-1)?.type === type) result.at(-1).text += text;
        else result.push({ type, text });
    };
    append('equal', a.slice(0, head).join(''));
    if (left.length * right.length <= 160000) {
        const width = right.length + 1;
        const scores = new Uint32Array((left.length + 1) * width);
        for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
            scores[i * width + j] = left[i] === right[j]
                ? scores[(i + 1) * width + j + 1] + 1
                : Math.max(scores[(i + 1) * width + j], scores[i * width + j + 1]);
        }
        let i = 0, j = 0;
        while (i < left.length || j < right.length) {
            if (i < left.length && j < right.length && left[i] === right[j]) { append('equal', left[i++]); j++; }
            else if (j < right.length && (i === left.length || scores[i * width + j + 1] > scores[(i + 1) * width + j])) append('add', right[j++]);
            else append('remove', left[i++]);
        }
    } else {
        // Long entries: compare sentences first, then refine small replaced pairs.
        const ops = sentenceDiff(left.join(''), right.join(''));
        for (let k = 0; k < ops.length; k++) {
            const op = ops[k], next = ops[k + 1];
            if (op.type === 'remove' && next?.type === 'add' && Array.from(op.text).length * Array.from(next.text).length <= 160000) {
                for (const part of diffText(op.text, next.text)) append(part.type, part.text);
                k++;
            } else append(op.type, op.text);
        }
    }
    append('equal', tail ? a.slice(a.length - tail).join('') : '');
    return result;
}

const sentences = text => text.match(/[^。！？!?\n]*[。！？!?\n]+|[^。！？!?\n]+$/g) ?? [];
/** Myers diff over sentences; cheap when few sentences differ. Gives up to a
 * plain replace past maxEdits so a rewritten entry stays bounded. */
function sentenceDiff(before, after, maxEdits = 2000) {
    const a = sentences(before), b = sentences(after), n = a.length, m = b.length, offset = maxEdits + 1;
    const v = new Int32Array(2 * offset + 1), trace = [];
    for (let d = 0; d <= maxEdits; d++) {
        trace.push(v.slice(offset - d, offset + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1, y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[offset + k] = x;
            if (x >= n && y >= m) return backtrack(trace, a, b, d);
        }
    }
    return [{ type: 'remove', text: before }, { type: 'add', text: after }];
}
function backtrack(trace, a, b, depth) {
    const ops = [];
    let x = a.length, y = b.length;
    for (let d = depth; d > 0; d--) {
        const prev = trace[d], at = k => prev[k + d];
        const k = x - y, down = k === -d || (k !== d && at(k - 1) < at(k + 1));
        const pk = down ? k + 1 : k - 1, px = at(pk), py = px - pk;
        while (x > px + (down ? 0 : 1) && y > py + (down ? 1 : 0)) ops.push({ type: 'equal', text: a[--x] }), y--;
        if (down) ops.push({ type: 'add', text: b[--y] }); else ops.push({ type: 'remove', text: a[--x] });
    }
    while (x > 0 && y > 0) ops.push({ type: 'equal', text: a[--x] }), y--;
    const merged = [];
    for (const op of ops.reverse()) {
        if (merged.at(-1)?.type === op.type) merged.at(-1).text += op.text; else merged.push({ ...op });
    }
    return merged;
}
