const SENSITIVE_KEYS = new Set(['headers', 'header', 'authorization', 'proxyauthorization', 'apikey', 'accesskey', 'secretkey', 'key', 'auth', 'bearer', 'session', 'token', 'accesstoken', 'refreshtoken', 'password', 'passwd', 'secret', 'clientsecret', 'cookie', 'setcookie', 'credentials', 'customincludebody', 'customexcludebody']);
const ADDRESS_KEYS = new Set(['url', 'uri', 'endpoint', 'baseurl', 'apiurl', 'apiserver', 'serverurl', 'reverseproxy', 'proxy']);
const CONTENT_KEYS = new Set(['content', 'text', 'input', 'system', 'prompt', 'arguments', 'responseraw', 'responsebody']);
const RESERVED_KEYS = new Set(['id', 'startedAt', 'endedAt', 'status', 'truncated', 'truncatedFields']);
const STATUSES = new Set(['pending', 'complete', 'error', 'aborted']);
const normalizeKey = key => key.replace(/[^a-z0-9]/gi, '').toLowerCase();
const isSensitive = key => SENSITIVE_KEYS.has(key) || /(?:password|passwd|apikey|accesskey|secret|token|headers)$/.test(key) || key.startsWith('apikey');
const isAddress = key => ADDRESS_KEYS.has(key) || /(?:url|endpoint)$/.test(key);
const limit = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const own = (object, key, value) => Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });

function routeOnly(value) {
    if (typeof value !== 'string') return '';
    const route = value.split(/[?#]/, 1)[0];
    if (!/^[a-z][a-z\d+.-]*:/i.test(route)) return route.startsWith('//') ? routeOnly(`https:${route}`) : route;
    try {
        const url = new URL(route);
        return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : '';
    } catch { return ''; }
}

// JSON size without serializing large prompt strings. Stop at a complete code
// point and account for escaped control characters and lone UTF-16 surrogates.
function boundedString(value, budget) {
    if (budget < 2) return null;
    let size = 2, index = 0;
    while (index < value.length) {
        const code = value.charCodeAt(index), next = value.charCodeAt(index + 1);
        const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
        const cost = pair ? 2 : code >= 0xd800 && code <= 0xdfff ? 6
            : code === 34 || code === 92 ? 2 : code < 32 ? [8, 9, 10, 12, 13].includes(code) ? 2 : 6 : 1;
        if (size + cost > budget) break;
        size += cost; index += pair ? 2 : 1;
    }
    return { value: value.slice(0, index), size, truncated: index !== value.length };
}

/** Copy only data properties. Prompt bodies are opaque data, not configuration. */
function capture(value, budget, { content = false, depth = 0, ancestors = new Set() } = {}) {
    if (typeof value === 'string') return boundedString(value, budget);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        const safe = typeof value === 'number' && !Number.isFinite(value) ? null : value;
        const size = String(safe).length;
        return size <= budget ? { value: safe, size, truncated: false } : null;
    }
    if (typeof value === 'bigint') return { ...boundedString(`${value}n`, budget), truncated: true };
    if (typeof value !== 'object') return null;
    if (depth > 40 || ancestors.has(value)) return { ...boundedString(depth > 40 ? '[Depth limit]' : '[Circular]', budget), truncated: true };
    let descriptors;
    try {
        if (value instanceof Error) value = { name: value.name, message: value.message };
        descriptors = Object.getOwnPropertyDescriptors(value);
    } catch { return { ...boundedString('[Unavailable]', budget), truncated: true }; }
    if (budget < 2) return null;
    const array = Array.isArray(value), result = array ? [] : {}, nextAncestors = new Set(ancestors); nextAncestors.add(value);
    let size = 2, count = 0, truncated = false;
    const keys = Object.keys(descriptors).filter(key => descriptors[key].enumerable);
    for (const key of keys) {
        const field = descriptors[key], normalized = normalizeKey(key);
        if (!content && (isSensitive(normalized) || isAddress(normalized))) continue;
        if (!Object.hasOwn(field, 'value')) { truncated = true; continue; }
        let item = field.value;
        if (item === undefined) continue;
        if (!content && normalized === 'route') item = routeOnly(item);
        if (!content && ['connection', 'connectionconfig'].includes(normalized)) {
            try {
                const connection = Object.getOwnPropertyDescriptors(item ?? {});
                const address = ['route', 'endpoint', 'url'].map(name => connection[name]?.value).find(candidate => typeof candidate === 'string');
                item = { route: routeOnly(address) };
            } catch { item = { route: '' }; }
        }
        const encodedKey = array ? null : boundedString(key, budget);
        if (!array && (!encodedKey || encodedKey.truncated)) { truncated = true; break; }
        const keySize = array ? 0 : encodedKey.size + 1;
        const overhead = keySize + Number(count > 0);
        if (size + overhead + 2 > budget) { truncated = true; break; }
        const copied = capture(item, budget - size - overhead, { content: content || CONTENT_KEYS.has(normalized), depth: depth + 1, ancestors: nextAncestors });
        if (!copied || !Object.hasOwn(copied, 'value')) { truncated = true; continue; }
        if (array) result.push(copied.value); else own(result, key, copied.value);
        count++; size += overhead + copied.size; truncated ||= copied.truncated;
    }
    return { value: result, size, truncated };
}

function copy(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(copy);
    const result = {};
    for (const [key, item] of Object.entries(value)) own(result, key, copy(item));
    return result;
}

/** Session-only bounded diagnostics. It never touches chat data or storage. */
export function createTraceStore({ maxRecords = 100, maxChars = 12000000, maxRecordChars = 2000000 } = {}) {
    maxRecords = limit(maxRecords, 100); maxChars = limit(maxChars, 12000000);
    maxRecordChars = Math.min(limit(maxRecordChars, 2000000), maxChars);
    const records = new Map(), listeners = new Set(), prefix = Date.now().toString(36);
    let sequence = 0, totalChars = 0, droppedRecords = 0, notifying = false;
    const reserve = Math.min(512, Math.floor(maxRecordChars / 3));
    const notify = () => {
        if (notifying) return;
        notifying = true;
        try { for (const listener of [...listeners]) { try {
            const result = listener();
            if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
        } catch { /* Diagnostics must not affect generation. */ } } }
        finally { notifying = false; }
    };
    function put(entry, key, value, size = JSON.stringify(value).length) {
        const previous = entry.sizes.get(key);
        const fieldSize = JSON.stringify(key).length + 1 + size;
        own(entry.data, key, value); entry.sizes.set(key, fieldSize);
        entry.chars += fieldSize - (previous ?? 0) + Number(previous === undefined && entry.sizes.size > 1);
    }
    function drop(id) {
        const entry = records.get(id);
        if (!entry) return;
        totalChars -= entry.chars; records.delete(id); droppedRecords++;
    }
    function enforce() {
        for (const [id, entry] of records) if (entry.chars > maxRecordChars) drop(id);
        while (records.size > maxRecords || totalChars > maxChars) drop(records.keys().next().value);
    }
    function apply(entry, patch) {
        const omitted = key => { if (entry.omitted.size < 8) entry.omitted.add(key.slice(0, 40)); };
        let descriptors;
        try { descriptors = Object.getOwnPropertyDescriptors(patch ?? {}); }
        catch { descriptors = {}; omitted('[patch]'); }
        if (descriptors.truncated?.value === true) {
            entry.upstreamTruncated = true;
            const fields = descriptors.truncatedFields?.value;
            if (Array.isArray(fields)) for (const key of fields.slice(0, 8)) if (typeof key === 'string') omitted(key);
            if (!entry.omitted.size) omitted('[upstream]');
        }
        for (const [key, descriptor] of Object.entries(descriptors)) {
            const normalized = normalizeKey(key);
            if (!descriptor.enumerable || RESERVED_KEYS.has(key) || isSensitive(normalized) || isAddress(normalized)) continue;
            if (!Object.hasOwn(descriptor, 'value')) { omitted(key); continue; }
            if (descriptor.value === undefined) continue;
            const encodedKey = boundedString(key, maxRecordChars);
            if (!encodedKey || encodedKey.truncated) { omitted(key); continue; }
            const keySize = encodedKey.size;
            const budget = Math.max(0, maxRecordChars - reserve - entry.chars + (entry.sizes.get(key) ?? 0) - keySize - 2);
            let value = descriptor.value;
            if (normalized === 'route') value = routeOnly(value);
            // Wrap each field so the same credential/connection filtering applies
            // to both top-level patches and nested request envelopes.
            const wrapped = capture({ [key]: value }, budget + keySize + 3);
            if (!wrapped || !Object.hasOwn(wrapped.value ?? {}, key)) { omitted(key); continue; }
            const captured = wrapped.value[key], size = wrapped.size - keySize - 3;
            put(entry, key, captured, size);
            if (wrapped.truncated) omitted(key); else if (!entry.upstreamTruncated) entry.omitted.delete(key.slice(0, 40));
        }
        if (entry.omitted.size) {
            put(entry, 'truncated', true);
            put(entry, 'truncatedFields', [...entry.omitted].slice(0, 8).map(key => key.slice(0, 40)));
        } else if (entry.data.truncated) {
            put(entry, 'truncated', false); put(entry, 'truncatedFields', []);
        }
    }
    function mutate(id, patch, finish = false) {
        const entry = records.get(id);
        if (!entry) return false;
        const previousChars = entry.chars;
        try {
            apply(entry, patch);
            const statusDescriptor = Object.getOwnPropertyDescriptor(patch ?? {}, 'status');
            const status = statusDescriptor?.value;
            const errorDescriptor = Object.getOwnPropertyDescriptor(patch ?? {}, 'error');
            if (finish || STATUSES.has(status)) {
                const next = STATUSES.has(status) && (!finish || status !== 'pending') ? status : errorDescriptor?.value ? 'error' : 'complete';
                put(entry, 'status', next);
                if (next !== 'pending') put(entry, 'endedAt', entry.data.endedAt ?? new Date().toISOString());
            }
        } catch { put(entry, 'truncated', true); }
        totalChars += entry.chars - previousChars; enforce(); notify(); return records.has(id);
    }
    const snapshot = () => ({ records: [...records.values()].map(entry => copy(entry.data)), droppedRecords, totalChars, maxChars, maxRecords });
    return {
        start(patch = {}) {
            const id = `${prefix}-${++sequence}`, entry = { data: {}, sizes: new Map(), chars: 2, omitted: new Set() };
            try {
                put(entry, 'id', id); put(entry, 'startedAt', new Date().toISOString()); put(entry, 'endedAt', null); put(entry, 'status', 'pending');
                apply(entry, patch);
            } catch { put(entry, 'truncated', true); }
            records.set(id, entry); totalChars += entry.chars; enforce(); notify(); return id;
        },
        update: (id, patch = {}) => mutate(id, patch),
        finish: (id, patch = {}) => mutate(id, patch, true),
        snapshot,
        subscribe(listener) { if (typeof listener === 'function') listeners.add(listener); return () => listeners.delete(listener); },
        clear() { records.clear(); totalChars = 0; droppedRecords = 0; notify(); },
        exportData: () => ({ format: 'fish-memory-trace', version: 1, exportedAt: new Date().toISOString(), ...snapshot() }),
    };
}
