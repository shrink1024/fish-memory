const fail = code => { throw Object.assign(new Error(`connection-headers:${code}`), { dwmHeaderIssue: code }); };
const blocked = /^(?:host|cookie|cookie2|origin|referer|content-length|content-type|connection|upgrade|transfer-encoding|accept-encoding|access-control-request-.+|sec-.+|proxy-.+)$/i;
/** Full list replacement. Omission retains only on the same endpoint; blank
 * values may reuse a saved value with the same case-insensitive name. */
export function resolveHeaders(input, saved = []) {
    if (input === undefined) return saved.map(item => ({ ...item }));
    if (!Array.isArray(input) || input.length > 20) fail('limit');
    const previous = new Map(saved.map(item => [item.name.toLowerCase(), item.value])), seen = new Set();
    return input.map(item => {
        const name = typeof item?.name === 'string' ? item.name.trim() : '';
        if (!name || name.length > 200 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || blocked.test(name)) fail('name');
        const lower = name.toLowerCase(); if (seen.has(lower)) fail('duplicate'); seen.add(lower);
        const value = item.value === '' || item.value == null ? previous.get(lower) : typeof item.value==='string'?item.value.trim():item.value;
        if (typeof value !== 'string' || !value.length) fail('missing');
        if (value.length > 16384 || /[^\t\x20-\x7e\x80-\xff]/.test(value)) fail('value');
        return { name, value };
    });
}
export const headerIdentity = headers => JSON.stringify((headers ?? []).map(({ name, value }) => [name.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b)));
export function requestHeaders(apiKey, custom = [], json = false) {
    const headers = { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
    for (const { name, value } of resolveHeaders(custom)) {
        for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
        Object.defineProperty(headers, name, { value, enumerable: true, configurable: true });
    }
    return headers;
}
