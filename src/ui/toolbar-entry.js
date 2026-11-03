/** Standalone entry, deliberately outside ST/TT's native drawer protocol. */
export function mountToolbarEntry(doc, bindEntry) {
    const toolbar = doc.getElementById('top-settings-holder');
    if (!toolbar || doc.getElementById('dwm-toolbar-entry')) return null;
    const entry = doc.createElement('div'); entry.id = 'dwm-toolbar-entry'; entry.className = 'dwm-toolbar-entry';
    const button = doc.createElement('button'); button.id = 'dwm-toolbar-button'; button.type = 'button';
    button.className = 'dwm-toolbar-button fa-solid fa-fish fa-fw';
    button.title = '鱼忆｜动态世界书与记忆'; button.setAttribute('aria-label', '打开鱼忆管理窗口');
    bindEntry(button); entry.append(button);
    const worldInfoEntry = toolbar.querySelector(':scope > #WI-SP-button');
    if (worldInfoEntry) worldInfoEntry.after(entry); else toolbar.append(entry);
    return button;
}

/** Recover when a host/theme mounts or replaces its toolbar after extension boot. */
export function watchToolbarEntry(doc, bindEntry, Observer = doc.defaultView?.MutationObserver) {
    let button = mountToolbarEntry(doc, bindEntry), stopped = false;
    const refresh = () => {
        if (!stopped && !doc.getElementById('dwm-toolbar-entry')) button = mountToolbarEntry(doc, bindEntry);
    };
    const observer = Observer ? new Observer(refresh) : null;
    if (doc.body) observer?.observe(doc.body, { childList: true, subtree: true });
    return { refresh, destroy() { stopped = true; observer?.disconnect(); button?.parentNode?.remove(); } };
}
