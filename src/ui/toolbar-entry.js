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
