export const clone = value => structuredClone(value);
export function uid(prefix = 'm') {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`;
    if (typeof crypto?.getRandomValues !== 'function') throw new Error('当前浏览器无法生成安全的存档身份，请更新浏览器或使用 HTTPS / 本机地址打开酒馆后重试。');
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
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
