const POSITION_KEY = 'dwm.floating-position.v1';
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/** A persistent, nonmodal workspace. It never reparents or remounts its contents. */
export function createFloatingManager(doc, { window: win = doc.defaultView, storage, storageKey = POSITION_KEY } = {}) {
    const make = (tag, className, text) => {
        const node = doc.createElement(tag); node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const icon = (path, className = '') => {
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
        if (className) svg.setAttribute('class', className);
        const shape = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); shape.setAttribute('d', path); svg.append(shape); return svg;
    };
    const ttHost = win?.__TAURITAVERN__;
    let ttSnapshot = null, releaseTt = null;
    const element = make('div', 'dwm-floating-root');
    const bubble = make('button', 'dwm-floating-bubble'); bubble.type = 'button'; bubble.id = 'dwm-floating-entry';
    const bubbleCopy = make('span', 'dwm-bubble-copy');
    const status = make('span', 'dwm-bubble-status', '点开管理');
    bubbleCopy.append(make('strong', 'dwm-bubble-name', '鱼忆'), status);
    bubble.append(icon('M4 12C7 5 15 5 19 12C15 19 7 19 4 12Zm0 0L1 8v8l3-4Zm11-1h.01M9 7l2-3 3 3M9 17l2 3 3-3', 'dwm-bubble-fish'), bubbleCopy);
    const panel = make('section', 'dwm-management'); panel.id = 'dwm-management-dialog'; panel.hidden = true;
    if (ttHost) {
        element.dataset.ttMobileSurface = 'none';
        panel.dataset.ttMobileSurface = 'free-window';
        bubble.dataset.ttMobileSurface = 'free-window';
    }
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '鱼忆管理窗口'); panel.setAttribute('aria-modal', 'false');
    const chrome = make('header', 'dwm-management-chrome');
    const heading = make('div', 'dwm-management-heading');
    heading.append(make('strong', '', '鱼忆管理'), make('span', '', '收起后，点鱼忆继续'));
    const positionLabel = make('label', 'dwm-bubble-position-label');
    positionLabel.append(make('span', 'dwm-visually-hidden', '收起后的气泡位置'));
    const positionSelect = make('select', 'dwm-bubble-position');
    for (const [edge, label] of [['left', '左'], ['right', '右']]) {
        for (const [fraction, name] of [[0.2, '上'], [0.5, '中'], [0.8, '下']]) {
            const option = make('option', '', `气泡 · ${label}${name}`); option.value = `${edge}:${fraction}`; positionSelect.append(option);
        }
    }
    positionLabel.append(positionSelect);
    const closeButton = make('button', 'dwm-management-close'); closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '收起鱼忆管理窗口'); closeButton.title = '收起，保留当前页面与草稿';
    closeButton.append(icon('M5 12h14'), make('span', '', '收起'));
    chrome.append(heading, positionLabel, closeButton);
    const body = make('div', 'dwm-management-body'); panel.append(chrome, body); element.append(panel, bubble); doc.body.append(element);

    let opened = false, destroyed = false, opener = null, drag = null, suppressClick = false, observedComposer = null;
    let dock = { edge: 'right', fraction: 0.65 };
    try { storage ??= win?.localStorage; const saved = JSON.parse(storage?.getItem(storageKey) ?? 'null');
        if (['left', 'right'].includes(saved?.edge) && Number.isFinite(saved.fraction)) dock = { edge: saved.edge, fraction: clamp(saved.fraction, 0, 1) };
    } catch { /* Browser storage may be blocked; the manager remains usable. */ }
    const listeners = [], entries = new Set();
    const listen = (target, type, fn, options) => {
        target?.addEventListener(type, fn, options); listeners.push(() => target?.removeEventListener(type, fn, options));
    };
    const save = () => { try { storage?.setItem(storageKey, JSON.stringify(dock)); } catch { /* Position memory is optional. */ } };
    const viewport = () => {
        if (ttSnapshot) {
            const { viewport: v, ime } = ttSnapshot;
            // Android TT reports IME separately; iOS reports a reduced viewport
            // and zero extra offset. Safe-area padding is consumed only once.
            return { width: v.width, height: Math.max(1, v.height - ime.keyboardOffset), left: v.left, top: v.top };
        }
        const v = win?.visualViewport;
        return { width: v?.width || win?.innerWidth || 375, height: v?.height || win?.innerHeight || 812,
            left: v?.offsetLeft || 0, top: v?.offsetTop || 0 };
    };
    const measure = () => {
        const v = viewport(), css = win?.getComputedStyle?.(element);
        const inset = side => ttSnapshot ? Math.max(12, ttSnapshot.safeInsets[side.toLowerCase()]) : parseFloat(css?.[`padding${side}`]) || 8;
        const size = bubble.getBoundingClientRect(), width = size.width || 132, height = size.height || 58;
        const minX = inset('Left'), maxX = Math.max(minX, v.width - inset('Right') - width);
        const minY = inset('Top');
        // Keep clear of the native composer. A fallback also protects hosts with a custom input UI.
        let bottom = v.height - Math.max(inset('Bottom'), Math.min(100, v.height * 0.2));
        const composer = doc.querySelector('#form_sheld') ?? doc.querySelector('#send_form');
        if (composer !== observedComposer) { if (observedComposer) observer?.unobserve(observedComposer); observedComposer = composer; if (composer) observer?.observe(composer); }
        const rect = composer?.getBoundingClientRect();
        if (rect?.height > 0 && rect.width > 0 && rect.top >= v.top && rect.top < v.top + v.height) bottom = Math.min(bottom, rect.top - v.top - 8);
        return { ...v, minX, maxX, minY, maxY: Math.max(minY, bottom - height), bubbleWidth: width };
    };
    const reflectDock = () => {
        const nearest = [0.2, 0.5, 0.8].reduce((best, value) => Math.abs(dock.fraction - value) < Math.abs(dock.fraction - best) ? value : best, 0.5);
        positionSelect.value = `${dock.edge}:${nearest}`;
    };
    function layout() {
        if (destroyed) return;
        const v = viewport();
        for (const key of ['width', 'height', 'left', 'top']) element.style[key] = `${v[key]}px`;
        const bounds = measure();
        if (!drag?.moved) {
            bubble.style.left = `${dock.edge === 'left' ? bounds.minX : bounds.maxX}px`;
            bubble.style.top = `${bounds.minY + dock.fraction * (bounds.maxY - bounds.minY)}px`;
        }
        element.dataset.edge = dock.edge;
        // Scroll only our inner surface when a keyboard covers its focused field.
        const active = doc.activeElement;
        if (opened && active && body.contains(active)) {
            const field = active.getBoundingClientRect(), area = body.getBoundingClientRect();
            if (field.bottom > area.bottom) body.scrollTop += field.bottom - area.bottom + 12;
            else if (field.top < area.top) body.scrollTop -= area.top - field.top + 12;
        }
    }
    const observer = win?.ResizeObserver ? new win.ResizeObserver(layout) : null;
    observer?.observe(bubble);
    const setExpanded = () => {
        for (const entry of entries) {
            entry.setAttribute('aria-expanded', String(opened));
            entry.classList.toggle('openIcon', opened); entry.classList.toggle('closedIcon', !opened);
        }
        bubble.setAttribute('aria-expanded', String(opened));
        panel.hidden = !opened; bubble.hidden = opened;
    };
    function open(source) {
        if (destroyed || opened) return;
        opener = source?.currentTarget ?? source ?? bubble; opened = true; setExpanded(); layout(); closeButton.focus({ preventScroll: true });
    }
    function close({ restoreFocus = true } = {}) {
        if (destroyed || !opened) return;
        opened = false; setExpanded(); layout();
        if (restoreFocus) (opener?.isConnected ? opener : bubble).focus({ preventScroll: true });
        opener = null;
    }
    function bindEntry(entry) {
        if (entries.has(entry)) return;
        entries.add(entry); entry.setAttribute('aria-haspopup', 'dialog'); entry.setAttribute('aria-controls', panel.id); entry.setAttribute('aria-expanded', String(opened));
        listen(entry, 'click', open);
    }
    bubble.setAttribute('aria-haspopup', 'dialog'); bubble.setAttribute('aria-controls', panel.id); bubble.setAttribute('aria-expanded', 'false');
    listen(bubble, 'click', event => {
        if (suppressClick && event.detail !== 0) { suppressClick = false; event.preventDefault(); return; }
        suppressClick = false; open(event);
    });
    listen(closeButton, 'click', () => close());
    listen(doc, 'keydown', event => {
        if (opened && event.key === 'Escape' && !event.defaultPrevented && !doc.querySelector('dialog[open]')) { event.preventDefault(); close(); }
    });
    listen(positionSelect, 'change', () => {
        const [edge, fraction] = positionSelect.value.split(':');
        if (!['left', 'right'].includes(edge) || !Number.isFinite(Number(fraction))) return;
        dock = { edge, fraction: clamp(Number(fraction), 0, 1) }; save(); layout();
    });
    listen(bubble, 'keydown', event => {
        if (!event.shiftKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'ArrowLeft') dock.edge = 'left';
        if (event.key === 'ArrowRight') dock.edge = 'right';
        if (event.key === 'ArrowUp') dock.fraction = clamp(dock.fraction - 0.1, 0, 1);
        if (event.key === 'ArrowDown') dock.fraction = clamp(dock.fraction + 0.1, 0, 1);
        save(); reflectDock(); layout();
    });
    listen(bubble, 'pointerdown', event => {
        if (event.isPrimary === false || event.button !== 0 || opened) return;
        suppressClick = false;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: parseFloat(bubble.style.left), top: parseFloat(bubble.style.top), moved: false };
        try { bubble.setPointerCapture(event.pointerId); } catch { /* Unsupported capture still permits ordinary taps. */ }
    });
    listen(win, 'pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 8) return;
        drag.moved = true; bubble.dataset.dragging = 'true'; event.preventDefault();
        const bounds = measure();
        bubble.style.left = `${clamp(drag.left + dx, bounds.minX, bounds.maxX)}px`;
        bubble.style.top = `${clamp(drag.top + dy, bounds.minY, bounds.maxY)}px`;
    }, { passive: false });
    const finishDrag = event => {
        if (!drag || event.pointerId !== drag.id) return;
        if (drag.moved) {
            suppressClick = true;
            if (event.type !== 'pointercancel') {
                const bounds = measure(), left = parseFloat(bubble.style.left), top = parseFloat(bubble.style.top);
                dock = { edge: left + bounds.bubbleWidth / 2 < bounds.width / 2 ? 'left' : 'right',
                    fraction: bounds.maxY > bounds.minY ? clamp((top - bounds.minY) / (bounds.maxY - bounds.minY), 0, 1) : 0.5 };
                save(); reflectDock();
            }
        }
        try { bubble.releasePointerCapture(drag.id); } catch { /* A cancelled pointer may already have released capture. */ }
        drag = null; delete bubble.dataset.dragging; layout();
    };
    listen(win, 'pointerup', finishDrag); listen(win, 'pointercancel', finishDrag);
    listen(bubble, 'lostpointercapture', event => finishDrag({ type: 'pointercancel', pointerId: event.pointerId }));
    listen(win, 'resize', layout); listen(win?.visualViewport, 'resize', layout); listen(win?.visualViewport, 'scroll', layout); listen(body, 'focusin', layout);
    const render = (view = {}) => {
        if (destroyed) return;
        let text = '点开管理', state = 'idle';
        if (view.enabled === false) { text = '已暂停'; state = 'paused'; }
        else if (view.activity) { text = view.activity.phase === 'cancelling' ? '正在停止' : '正在处理'; state = 'busy'; }
        else if (view.error) { text = '需要处理'; state = 'attention'; }
        else if (!view.initialized) { text = '建立记忆'; state = 'attention'; }
        else if (Number(view.pendingCount) > 0) { text = `${Math.min(999, Math.floor(view.pendingCount))}${view.pendingCount > 999 ? '+' : ''} 条待补记`; state = 'pending'; }
        status.textContent = text; bubble.dataset.state = state;
        bubble.setAttribute('aria-label', `打开鱼忆管理窗口，${text}。可拖动气泡调整位置`);
        bubble.title = `鱼忆 · ${text}；点开管理，拖动可换位置`;
        layout();
    };
    reflectDock(); render({ initialized: true });
    if (ttHost) {
        const report = error => win?.console?.warn?.('鱼忆：TT 布局订阅不可用，继续使用浏览器视口。', error);
        const release = fn => { try { Promise.resolve(fn?.()).catch(report); } catch (error) { report(error); } };
        Promise.resolve(ttHost.ready).then(async () => {
            if (destroyed) return;
            const api = ttHost.api?.layout;
            if (typeof api?.subscribe !== 'function') throw new Error('TT layout API unavailable');
            const unsubscribe = await api.subscribe(snapshot => {
                if (destroyed) return;
                const v = snapshot?.viewport, insets = snapshot?.safeInsets, ime = snapshot?.ime;
                if (!v || !insets || !ime || !['width', 'height', 'left', 'top'].every(key => Number.isFinite(v[key]))
                    || v.width <= 0 || v.height <= 0 || !['top', 'right', 'bottom', 'left'].every(key => Number.isFinite(insets[key]) && insets[key] >= 0)
                    || !Number.isFinite(ime.keyboardOffset) || ime.keyboardOffset < 0) {
                    report(new Error('Invalid TT layout snapshot')); return;
                }
                ttSnapshot = { viewport: { ...v }, safeInsets: { ...insets }, ime: { keyboardOffset: ime.keyboardOffset } };
                for (const side of ['top', 'right', 'bottom', 'left']) element.style.setProperty(`--dwm-safe-${side}`, `${insets[side]}px`);
                layout();
            });
            if (destroyed) release(unsubscribe);
            else releaseTt = () => release(unsubscribe);
        }).catch(report);
    }
    return { element, panel, body, bubble, bindEntry, open, close, toggle: () => opened ? close() : open(), render,
        destroy() {
            if (destroyed) return;
            if (opened && element.contains(doc.activeElement)) close();
            destroyed = true; releaseTt?.(); releaseTt = null;
            for (const remove of listeners) remove(); observer?.disconnect();
            for (const entry of entries) entry.setAttribute('aria-expanded', 'false');
            entries.clear(); drag = null; element.remove();
        } };
}
