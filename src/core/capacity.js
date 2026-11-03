import { expandedChars } from './storage-codec.js';

function draftOf(save) {
    const { initializationCheckpoint: _checkpoint, sourceHeld: _held, ...rest } = save;
    return { ...rest, journal: [], audit: [], data: save.base, processed: [], storyKeys: [], rememberedKeys: [] };
}
function check(value, message) {
    try { return expandedChars(value); }
    catch (error) {
        if (!error.dwmCapacity) throw error;
        error.message = message;
        throw error;
    }
}
/** Explicit reserve diagnostic; regular writes use the encoder's actual limit. */
export function assertRebuildCapacity(save) {
    return check({ saved: save, rebuilding: draftOf(save) }, '保存未完成：存档已接近容量上限，需为重新扫描预留空间。原资料未改变。请先导出备份，再删减部分资料。');
}
/** Check source admission before paid classification, including two full-entry
 * updates and an atomic rescan. This bounds the whole save, not one title/body. */
export function assertSourceCapacity(save, entries, { replace = false, baseEntries = {} } = {}) {
    const normalized = Object.fromEntries(entries.map(entry => [entry.id, entry.source ? {
        ...entry, source: { ...entry.source, baselineSegments: entry.source.baselineSegments ?? entry.segments },
    } : entry]));
    const next = { ...save, data: { ...save.data, entries: { ...(replace ? {} : save.data.entries), ...normalized } },
        base: { ...save.base, entries: { ...(replace ? {} : save.base.entries), ...normalized, ...baseEntries } },
        ...(replace ? { journal: [], audit: [], initializationCheckpoint: undefined, sourceHeld: undefined } : {}) };
    const message = '扫描或加入未开始：资料总量超过存档容量，需为重新扫描预留空间。原资料未改变。请减少所选条目或缩短超长条目后重试。';
    // Reinitialization keeps the current save until its new draft commits.
    if (replace) check({ saved: save, rebuilding: draftOf(next) }, message);
    return check({ saved: next, edits: [normalized, normalized], rebuilding: draftOf(next) }, message);
}
