export const clone = value => structuredClone(value);
export const uid = (prefix = 'm') => `${prefix}-${crypto.randomUUID()}`;
export function invariant(condition, message) {
    if (!condition) throw new Error(message);
}
export function plainText(value, label, max = 100000) {
    invariant(typeof value === 'string' && value.length <= max, `${label} 必须是长度不超过 ${max} 的文本`);
    return value;
}
export function commonPrefix(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
}
export function isPrefix(a, b) { return a.length <= b.length && commonPrefix(a, b) === a.length; }
export class SerialQueue {
    #tail = Promise.resolve();
    run(work) {
        const task = this.#tail.then(work);
        this.#tail = task.catch(() => {});
        return task;
    }
    idle() { return this.#tail; }
}
export function limitText(text, max = 3000) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
