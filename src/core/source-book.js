// Compare the author's current source with this save's initialization baseline.
// Canonical text is used rather than a lossy hash, including activation metadata.
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
function comparableMetadata(entry) {
    // Native editor drag ordering is presentation only; insertion order uses
    // the separate `order` field and must still invalidate the baseline.
    const { displayIndex: _displayIndex, ...metadata } = entry ?? {};
    if (metadata.extensions && typeof metadata.extensions === 'object' && !Array.isArray(metadata.extensions)) {
        const { display_index: _displayIndexExtension, ...extensions } = metadata.extensions;
        if (Object.keys(extensions).length) metadata.extensions = extensions;
        else delete metadata.extensions;
    }
    return canonical(metadata);
}
export function sourceBookChanges(save, raw, configEntryUids = []) {
    if (!save?.initialized) return { changed: false, added: [], removed: [], updated: [] };
    const sources = entries => new Map(Object.values(entries ?? {}).filter(entry => entry?.source).map(entry => [String(entry.source.uid), entry.source]));
    // An incremental sync updates the baseline and is replayed like any commit.
    // Rolling back across it restores the old live sources, so check both.
    const baseline = sources(save.base.entries), live = sources(save.data?.entries);
    const config = new Set(configEntryUids.map(String));
    const current = new Map(raw.filter(entry => !config.has(String(entry.uid))).map(entry => [String(entry.uid), entry]));
    const added = [], removed = [], updated = [];
    const differs = (old, entry) => old.original !== (entry.content ?? '') || JSON.stringify(comparableMetadata(old.metadata)) !== JSON.stringify(comparableMetadata(entry));
    for (const [uid, entry] of current) {
        const old = baseline.get(uid), used = live.get(uid);
        if (!old && !used) added.push(String(entry.comment || uid));
        else if ((old && differs(old, entry)) || (used && differs(used, entry)) || !old) updated.push(String(entry.comment || uid));
    }
    for (const uid of new Set([...baseline.keys(), ...live.keys()])) if (!current.has(uid)) removed.push(String((baseline.get(uid) ?? live.get(uid)).metadata?.comment || uid));
    return { changed: Boolean(added.length || removed.length || updated.length), added, removed, updated };
}
