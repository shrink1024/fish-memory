// Compare the author's current source with this save's initialization baseline.
// Canonical text is used rather than a lossy hash, including activation metadata.
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
// On/off and blue/green switches are flipped at runtime by card scripts. They
// decide whether an entry is used this turn, not what the author wrote, so they
// are read live (nativeSwitchOverlay) instead of blocking sends as a change.
const SWITCHES = ['disable', 'constant'];
function comparableMetadata(entry) {
    // Native editor drag ordering is presentation only; insertion order uses
    // the separate `order` field and must still invalidate the baseline.
    const { displayIndex: _displayIndex, ...metadata } = entry ?? {};
    for (const key of SWITCHES) delete metadata[key];
    if (metadata.extensions && typeof metadata.extensions === 'object' && !Array.isArray(metadata.extensions)) {
        const { display_index: _displayIndexExtension, ...extensions } = metadata.extensions;
        if (Object.keys(extensions).length) metadata.extensions = extensions;
        else delete metadata.extensions;
    }
    return canonical(metadata);
}
export function sourceMatches(source, raw) {
    return Boolean(source && raw && source.original === (raw.content ?? '')
        && JSON.stringify(comparableMetadata(source.metadata)) === JSON.stringify(comparableMetadata(raw)));
}
function compareBook(save, raw, configEntryUids = []) {
    if (!save?.initialized) return { changed: false, added: [], removed: [], updated: [] };
    const sources = entries => new Map(Object.values(entries ?? {}).filter(entry => entry?.source).map(entry => [String(entry.source.uid), entry.source]));
    // An incremental sync updates the baseline and is replayed like any commit.
    // Rolling back across it restores the old live sources, so check both.
    const baseline = sources(save.base.entries), live = sources(save.data?.entries);
    const config = new Set(configEntryUids.map(String));
    const current = new Map(raw.filter(entry => !config.has(String(entry.uid))).map(entry => [String(entry.uid), entry]));
    const added = [], removed = [], updated = [], held = [];
    const differs = (old, entry) => !sourceMatches(old, entry);
    for (const [uid, entry] of current) {
        const old = baseline.get(uid), used = live.get(uid);
        if (!old && !used) added.push(String(entry.comment || uid));
        else if ((old && differs(old, entry)) || (used && differs(used, entry)) || !old) {
            const pending = Object.values(save.sourceHeld ?? {}).find(item => item.next?.source?.book === used?.book
                && String(item.next.source.uid) === uid && sourceMatches(item.next.source, entry));
            if (pending) held.push({ id: pending.next.id, title: String(entry.comment || uid), book: used.book,
                resolutionId: pending.resolutionId, choices: ['adopt-source', 'keep-current'] });
            else updated.push(String(entry.comment || uid));
        }
    }
    for (const uid of new Set([...baseline.keys(), ...live.keys()])) if (!current.has(uid)) removed.push(String((baseline.get(uid) ?? live.get(uid)).metadata?.comment || uid));
    // Entries skipped at scan time (off in the book) that the book now turns on:
    // sent natively until scanned; offered for an optional sync, never blocking.
    // Entries the auxiliary provider refused are not offered again: the same scan would be refused.
    const pendingScan = Object.values(save.data?.entries ?? {}).filter(entry => entry.status === 'deferred' && entry.source
        && !entry.tier && !entry.scanBlocked && current.get(String(entry.source.uid)) && !current.get(String(entry.source.uid)).disable).map(entry => entry.title);
    return { changed: Boolean(added.length || removed.length || updated.length), added, removed, updated, pendingScan, held };
}

/** External books only manage explicitly imported UIDs; newly added source
 * entries do not silently expand this save's paid processing scope. */
export function sourceBookChanges(save, raw, configEntryUids = [], extraBooks = {}) {
    if (!save?.initialized) return { changed: false, added: [], removed: [], updated: [] };
    const forBook = (book, entries) => Object.fromEntries(Object.entries(entries ?? {}).filter(([,e]) => e.source?.book === book));
    const scoped = book => ({ ...save, base: { ...save.base, entries: forBook(book, save.base.entries) }, data: { ...save.data, entries: forBook(book, save.data.entries) } });
    const result = compareBook(scoped(save.bookName), raw, configEntryUids);
    const names = new Set([...Object.values(save.base.entries), ...Object.values(save.data.entries)].map(e => e.source?.book).filter(b => b && b !== save.bookName));
    const unavailable = [];
    for (const book of names) {
        if (!Array.isArray(extraBooks[book])) { unavailable.push(book); continue; }
        const scope = scoped(book), ids = new Set([...Object.values(scope.base.entries), ...Object.values(scope.data.entries)].map(e => String(e.source.uid)));
        const change = compareBook(scope, extraBooks[book].filter(e => ids.has(String(e.uid))));
        // A copied external entry survives removal from its optional update source.
        for (const key of ['added','updated','pendingScan']) result[key] = [...(result[key] ?? []), ...(change[key] ?? []).map(title => `${book} · ${title}`)];
        result.held.push(...change.held);
        result.changed ||= Boolean(change.added.length || change.updated.length);
    }
    if (unavailable.length) result.unavailable = unavailable;
    return result;
}

/** Selection and injection follow the book's live switches for entries the
 * player has not tiered. Returns the same save when nothing differs. Never-
 * scanned entries stay out of selection; the adapter sends them natively. */
export function nativeSwitchOverlay(save, raw, extraBooks = {}) {
    if (!save?.initialized || !Array.isArray(raw)) return save;
    const current = new Map(raw.map(entry => [`${save.bookName}\0${entry.uid}`, entry]));
    for (const [book, entries] of Object.entries(extraBooks)) for (const entry of entries ?? []) current.set(`${book}\0${entry.uid}`, entry);
    let view = null;
    for (const entry of Object.values(save.data.entries)) {
        if (!entry.source || entry.tier) continue;
        const native = current.get(`${entry.source.book}\0${entry.source.uid}`);
        if (!native) continue;
        const enabled = !native.disable && entry.status !== 'deferred', constant = Boolean(native.constant);
        if (enabled === entry.enabled && constant === Boolean(entry.constant)) continue;
        view ??= structuredClone(save);
        Object.assign(view.data.entries[entry.id], { enabled, constant });
    }
    return view ?? save;
}
