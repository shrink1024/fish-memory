import { invariant } from './util.js';

// The in-memory save remains schema 2. Older plugins explicitly reject this
// storage schema instead of interpreting pooled references as narrative data.
export const STORAGE_SCHEMA = 3;
export const STORAGE_ENCODING = 'fish-memory-pool-v1';
const MAX_POOL_NODES = 1000000;
const MAX_EXPANDED_NODES = 8000000;
const MAX_EXPANDED_CHARS = 128 * 1024 * 1024;
const MAX_DEPTH = 128;
const HEADER_KEYS = ['id', 'chatId', 'bookName', 'revision'];
const own = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

function dataProperty(object, key) {
    const field = Object.getOwnPropertyDescriptor(object, key);
    invariant(field && Object.hasOwn(field, 'value'), '存档包含无效属性或访问器');
    return field.value;
}
function record(value) {
    invariant(value && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value)), '存档只能包含普通数据对象');
    return value;
}
function header(value) {
    record(value);
    const result = Object.fromEntries(HEADER_KEYS.map(key => [key, dataProperty(value, key)]));
    invariant(['id', 'chatId', 'bookName'].every(key => typeof result[key] === 'string' && result[key].length <= 10000)
        && Number.isSafeInteger(result.revision) && result.revision >= 0, '存档身份无效');
    return result;
}
function denseArray(value) {
    invariant(Array.isArray(value), '存档池节点或引用列表无效');
    const size = dataProperty(value, 'length');
    invariant(size <= MAX_EXPANDED_NODES, '存档数组超过上限');
    invariant(Object.keys(value).length === size, '存档数组包含稀疏项或额外字段');
    for (let i = 0; i < size; i++) dataProperty(value, String(i));
    return value;
}
function bounded(metric) {
    invariant(metric.chars <= MAX_EXPANDED_CHARS && metric.count <= MAX_EXPANDED_NODES, '存档展开后过大，超过安全上限');
    invariant(metric.depth <= MAX_DEPTH, '存档嵌套深度超过上限');
    return metric;
}
function primitiveMetric(value) {
    invariant(value === null || ['string', 'boolean', 'number'].includes(typeof value), '存档池节点类型无效');
    invariant(typeof value !== 'number' || Number.isFinite(value), '存档包含非有限数字');
    return bounded({ chars: JSON.stringify(value).length, count: 1, depth: 1 });
}

/** Each pooled container holds only references to earlier nodes. Computing the
 * expanded size before allocating descendants prevents reference expansion
 * bombs. Object keys remain ordinary strings; special-looking names never use
 * assignment setters or become instructions to the decoder. */
function inspectNode(node, index, pool, metrics) {
    if (!Array.isArray(node)) return primitiveMetric(node);
    denseArray(node);
    const type = node[0];
    if (['u', 'z'].includes(type)) {
        invariant(node.length === 1, '存档特殊值节点无效');
        return { chars: 4, count: 1, depth: 1 };
    }
    invariant(node.length === 2 && ['a', 'o', 'd'].includes(type), '存档池节点格式无效');
    const refs = denseArray(node[1]);
    const object = type !== 'a';
    invariant(!object || refs.length % 2 === 0, '存档对象引用数量无效');
    const keys = new Set();
    let chars = 2, count = 1, depth = 1;
    const members = object ? refs.length / 2 : refs.length;
    chars += Math.max(0, members - 1) + (object ? members : 0);
    for (let offset = 0; offset < refs.length; offset++) {
        const ref = refs[offset];
        invariant(Number.isSafeInteger(ref) && ref >= 0 && ref < index, '存档池引用无效或形成循环');
        const metric = metrics[ref];
        if (object && offset % 2 === 0) {
            const key = pool[ref];
            invariant(typeof key === 'string' && !keys.has(key), '存档对象字段不是文本或存在重复');
            keys.add(key);
        }
        chars += metric.chars; count += metric.count; depth = Math.max(depth, metric.depth + 1);
        bounded({ chars, count, depth });
    }
    return bounded({ chars, count, depth });
}

function poolTree(value) {
    const pool = [], metrics = [], indexByNode = new Map(), objects = new WeakMap(), active = new Set();
    const intern = node => {
        const signature = JSON.stringify(node);
        if (indexByNode.has(signature)) return indexByNode.get(signature);
        invariant(pool.length < MAX_POOL_NODES, '存档池节点超过上限');
        const index = pool.length, metric = inspectNode(node, index, pool, metrics);
        pool.push(node); metrics.push(metric); indexByNode.set(signature, index);
        return index;
    };
    const visit = (item, depth = 1) => {
        invariant(depth <= MAX_DEPTH, '存档嵌套深度超过上限');
        if (item === undefined) return intern(['u']);
        if (Object.is(item, -0)) return intern(['z']);
        if (item === null || typeof item !== 'object') { primitiveMetric(item); return intern(item); }
        invariant(!active.has(item), '存档包含循环引用');
        if (objects.has(item)) return objects.get(item);
        active.add(item);
        const refs = [];
        if (Array.isArray(item)) {
            denseArray(item);
            for (let i = 0; i < item.length; i++) refs.push(visit(dataProperty(item, String(i)), depth + 1));
        } else {
            record(item);
            const descriptors = Object.getOwnPropertyDescriptors(item);
            invariant(!Object.getOwnPropertySymbols(item).some(key => Object.getOwnPropertyDescriptor(item, key)?.enumerable), '存档不支持 Symbol 字段');
            for (const key of Object.keys(descriptors)) {
                const field = descriptors[key];
                if (!field.enumerable) continue;
                invariant(Object.hasOwn(field, 'value'), '存档不能包含访问器属性');
                refs.push(intern(key), visit(field.value, depth + 1));
            }
        }
        const index = intern([Array.isArray(item) ? 'a' : Object.getPrototypeOf(item) === null ? 'd' : 'o', refs]);
        objects.set(item, index); active.delete(item);
        return index;
    };
    const root = visit(value);
    return { pool, root };
}

export function encodeSave(save) {
    const identity = header(save);
    invariant(dataProperty(save, 'schema') === 2, '不支持的内存存档格式，请勿覆盖现有数据');
    const { pool, root } = poolTree(save);
    return { schema: STORAGE_SCHEMA, encoding: STORAGE_ENCODING, ...identity, pool, root };
}

export function decodeSave(stored) {
    if (stored === null || stored === undefined) return stored;
    const identity = header(stored), schema = dataProperty(stored, 'schema');
    // Legacy data follows the same bounded plain-data path. This also returns a
    // detached object when storage is an in-memory test adapter.
    if (schema === 2) return decodeSave(encodeSave(stored));
    invariant(schema === STORAGE_SCHEMA && dataProperty(stored, 'encoding') === STORAGE_ENCODING,
        '不支持的持久化存档格式，请勿覆盖现有数据');
    const pool = denseArray(dataProperty(stored, 'pool')), root = dataProperty(stored, 'root');
    invariant(pool.length > 0 && pool.length <= MAX_POOL_NODES, '存档池节点数量无效');
    invariant(Number.isSafeInteger(root) && root >= 0 && root < pool.length, '存档根引用无效');
    const metrics = [];
    for (let i = 0; i < pool.length; i++) metrics.push(inspectNode(pool[i], i, pool, metrics));
    // Never reuse expanded objects: mutation of one journal entry must not
    // mutate another entry or the immutable source baseline.
    const expand = ref => {
        const node = pool[ref];
        if (!Array.isArray(node)) return node;
        if (node[0] === 'u') return undefined;
        if (node[0] === 'z') return -0;
        const refs = node[1];
        if (node[0] === 'a') return refs.map(expand);
        const value = node[0] === 'd' ? Object.create(null) : {};
        for (let i = 0; i < refs.length; i += 2) own(value, pool[refs[i]], expand(refs[i + 1]));
        return value;
    };
    const decoded = expand(root);
    invariant(decoded?.schema === 2 && HEADER_KEYS.every(key => decoded[key] === identity[key]), '存档池内容与外层身份不一致');
    return decoded;
}
