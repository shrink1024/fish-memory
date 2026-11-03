import { clone, invariant } from '../core/util.js';

// Short ids exist only for this request. They never enter saves or prompt plans.
const identities = new WeakMap();
const FORMAT = { version: 1, defaults: { scopeId: 'global', constant: false },
    stateColumns: ['contentChars', 'recentEvidenceCount'] };

/** Lossless wire projection: stable descriptions precede changing statistics. */
export function encodeSelectionInput(input, allIds) {
    const slots = new Map(allIds.map((id, index) => [id, index])), reserved = new Set(allIds), ids = new Map();
    const catalogState = [];
    const catalog = input.catalog.map(entry => {
        let id = entry.id;
        if (id.length > 24) {
            id = `e${slots.get(entry.id).toString(36)}`;
            while (reserved.has(id)) id = `_${id}`;
        }
        ids.set(id, entry.id);
        const { contentChars, recentEvidenceCount, scopeId, constant, ...description } = entry;
        catalogState.push([contentChars, recentEvidenceCount]);
        return { ...description, id, ...(scopeId !== 'global' ? { scopeId } : {}), ...(constant ? { constant: true } : {}) };
    });
    const { strategy, scopeContext, selectionLimit, selectionChars, authorGuidance, summary, observedState, progress, messages } = input;
    const wire = clone({ catalogFormat: FORMAT, strategy, scopeContext, selectionLimit, selectionChars,
        ...(authorGuidance !== undefined ? { authorGuidance } : {}), catalog,
        summary, catalogState, ...(observedState !== undefined ? { observedState } : {}),
        ...(progress !== undefined ? { progress } : {}), messages });
    identities.set(wire, ids);
    return wire;
}

/** Expand defaults and the row-aligned state table without changing wire ids. */
export function selectionCatalog(input) {
    return input.catalog.map((entry, index) => ({ ...input.catalogFormat.defaults, ...entry,
        contentChars: input.catalogState[index][0], recentEvidenceCount: input.catalogState[index][1] }));
}

export function decodeSelectionIds(input, ids) {
    const map = identities.get(input);
    invariant(map && ids.every(id => typeof id === 'string' && map.has(id)), '前置选择了目录中不允许的资料，请仅使用本批目录原 id');
    return ids.map(id => map.get(id));
}
