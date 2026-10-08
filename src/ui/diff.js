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
        append('remove', left.join(''));
        append('add', right.join(''));
    }
    append('equal', tail ? a.slice(a.length - tail).join('') : '');
    return result;
}
