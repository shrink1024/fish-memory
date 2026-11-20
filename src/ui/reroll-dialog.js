/**
 * “每次询问”：玩家重新生成或右滑生成新回复时，先问沿用上次的资料还是重新挑选。
 * 与“选材未完成”同一位置和样式，非模态；管理窗口收起时也能显示。
 * 关闭、Esc 都按沿用处理（resolve undefined），不额外调用模型。
 * @param {Document} doc
 */
export function createRerollDialog(doc) {
    let dialog = null, pending = null;
    const make = (tag, className, text) => { const el = doc.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
    const close = () => { if (dialog?.open) dialog.close(); dialog?.remove(); dialog = null; };
    const settle = value => {
        const current = pending; pending = null;
        current?.signal?.removeEventListener('abort', current.aborted);
        close(); current?.resolve(value);
    };
    function present({ type, count = 0, entries = [], signal } = {}) {
        if (pending) settle(undefined);
        if (signal?.aborted) return Promise.resolve(undefined);
        return new Promise(resolve => {
            const aborted = () => settle(undefined);
            pending = { resolve, signal, aborted };
            signal?.addEventListener('abort', aborted, { once: true });
            dialog = make('dialog', 'dwm-fallback dwm-reroll'); dialog.setAttribute('aria-live', 'polite');
            dialog.addEventListener('cancel', event => { event.preventDefault(); settle(undefined); });
            dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); settle(undefined); } });
            const title = make('h3', '', `${type === 'swipe' ? '生成新回复' : '重新生成'}：沿用上次挑选的资料吗？`); title.tabIndex = -1;
            const names = entries.slice(0, 5).map(entry => `「${entry.title || '未命名条目'}」`).join('、');
            const picked = count ? `上次为这一轮挑选了 ${count} 条资料：${names}${count > 5 ? ` 等 ${count} 条` : ''}。` : '上次没有为这一轮挑选按需资料，常驻资料照常发送。';
            const body = make('p', 'dwm-fallback-body', `${picked}沿用不会额外调用模型；重新挑选会再调用一次辅助模型。`);
            const row = make('div', 'dwm-fallback-actions');
            const reuse = make('button', 'dwm-fallback-primary', '沿用上次'); reuse.type = 'button'; reuse.addEventListener('click', () => settle('reuse'));
            const refresh = make('button', '', '重新挑选'); refresh.type = 'button'; refresh.addEventListener('click', () => settle('refresh'));
            row.append(reuse, refresh);
            const note = make('p', 'dwm-reroll-note', '按 Esc 关闭时按沿用处理。不想每次询问，可在“设置 → 常用 → 重新生成时的资料”中更改。');
            dialog.append(title, body, row, note);
            doc.body.append(dialog); dialog.show(); reuse.focus?.({ preventScroll: true });
        });
    }
    return { present, close: () => settle(undefined), destroy: () => settle(undefined), get element() { return dialog; } };
}
