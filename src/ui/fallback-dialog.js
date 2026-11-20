import { fallbackCopy, FALLBACK_LABELS } from './fallback-copy.js';

/**
 * “本轮记忆选材未完成”弹窗。非模态，玩家可以同时打开鱼忆窗口查看；
 * 选“重新选材”后弹窗不关，显示进度：成功（选材活动结束）后自动关闭，
 * 再次失败时由下一次 choose() 在原处换上新的原因。
 * @param {Document} doc
 * @param {{ openManager?: () => void, stop?: () => void, isSelecting?: () => boolean, subscribe?: (fn: () => void) => () => void }} deps
 */
export function createFallbackDialog(doc, { openManager = () => {}, stop = () => {}, isSelecting = () => false, subscribe = () => () => {} } = {}) {
    let dialog = null, retrying = false, pending = null;
    const make = (tag, className, text) => { const el = doc.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
    const close = () => { retrying = false; if (dialog?.open) dialog.close(); dialog?.remove(); dialog = null; };
    const settle = value => { const resolve = pending?.resolve; pending?.signal?.removeEventListener('abort', pending.aborted); pending = null; resolve?.(value); };
    const unsubscribe = subscribe(() => { if (retrying && !isSelecting()) close(); });
    function shell() {
        if (dialog) { dialog.replaceChildren(); return dialog; }
        dialog = make('dialog', 'dwm-fallback'); dialog.setAttribute('aria-live', 'polite');
        dialog.addEventListener('cancel', event => { event.preventDefault(); if (pending) { settle('cancel'); close(); } });
        doc.body.append(dialog); dialog.show(); return dialog;
    }
    function showRetrying() {
        const box = shell(); retrying = true;
        const title = make('h3', '', '正在重新选材…'); title.tabIndex = -1;
        box.append(title, make('p', 'dwm-fallback-body', '选好后这个提示会自动关闭，正文随即开始生成。'));
        const row = make('div', 'dwm-fallback-actions');
        for (const [label, action] of [[FALLBACK_LABELS.open, () => openManager()], ['停止本轮', () => { stop(); close(); }]]) {
            const b = make('button', '', label); b.type = 'button'; b.addEventListener('click', action); row.append(b);
        }
        box.append(row); title.focus?.({ preventScroll: true });
    }
    function choose(error, { signal } = {}) {
        if (signal?.aborted) return Promise.resolve('cancel');
        const copy = fallbackCopy(error);
        return new Promise(resolve => {
            const aborted = () => { settle('cancel'); close(); };
            pending = { resolve, signal, aborted };
            signal?.addEventListener('abort', aborted, { once: true });
            const box = shell(); retrying = false; box.dataset.reason = copy.reason;
            const title = make('h3', '', copy.title); title.tabIndex = -1;
            const detail = make('details'); detail.append(make('summary', '', '技术信息'), make('p', '', String(error?.message ?? '')));
            box.append(title, make('p', 'dwm-fallback-body', copy.body), detail);
            const row = make('div', 'dwm-fallback-actions'); let first = null;
            for (const action of copy.actions) {
                const b = make('button', action === copy.primary ? 'dwm-fallback-primary' : '', FALLBACK_LABELS[action]); b.type = 'button'; b.dataset.action = action;
                b.addEventListener('click', () => {
                    if (action === 'open') { openManager(); return; }
                    if (action === 'retry') { settle('retry'); showRetrying(); return; }
                    if (action === 'sync') { settle('cancel'); close(); openManager(); return; }
                    settle(action); close();
                });
                if (action === copy.primary) first = b;
                row.append(b);
            }
            box.append(row); (first ?? title).focus?.({ preventScroll: true });
        });
    }
    return { choose, close, destroy: () => { unsubscribe?.(); if (pending) settle('cancel'); close(); }, get element() { return dialog; }, get retrying() { return retrying; } };
}
