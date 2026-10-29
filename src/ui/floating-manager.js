const POSITION_KEY = 'dwm.floating-position.v1';
const WINDOW_KEY = 'dwm.floating-window.v1';
const MIN_WIDTH = 560, MIN_HEIGHT = 420, COMPACT_WIDTH = 720;
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/** A persistent, nonmodal workspace. It never reparents or remounts its contents. */
export function createFloatingManager(doc, { window: win = doc.defaultView, storage, storageKey = POSITION_KEY, windowKey = WINDOW_KEY } = {}) {
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
    // One title bar: drag it to move; the panel fills titleSlot and statusSlot.
    const chrome = make('header', 'dwm-management-chrome');
    const heading = make('div', 'dwm-management-heading');
    const titleSlot = make('span', 'dwm-management-subtitle');
    heading.append(icon('M3 12c3-6 11-7 15 0-4 7-12 6-15 0zm0 0-2-3v6zM15 11h.01', 'dwm-management-logo'), make('strong', '', '鱼忆'), titleSlot);
    const statusSlot = make('div', 'dwm-management-status');
    const maximizeButton = make('button', 'dwm-management-icon dwm-management-maximize'); maximizeButton.type = 'button';
    maximizeButton.setAttribute('aria-label', '最大化'); maximizeButton.title = '最大化';
    maximizeButton.append(icon('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'));
    const closeButton = make('button', 'dwm-management-close dwm-management-icon'); closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '收起鱼忆管理窗口'); closeButton.title = '收起，保留当前页面与草稿';
    closeButton.append(icon('M5 12h14'));
    chrome.append(heading, statusSlot, maximizeButton, closeButton);
    const body = make('div', 'dwm-management-body'); panel.append(chrome, body);
    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => {
        const handle = make('div', `dwm-resize dwm-resize-${edge}`); handle.dataset.edge = edge; handle.setAttribute('aria-hidden', 'true'); panel.append(handle); return handle;
    });
    element.append(panel, bubble); doc.body.append(element);

    let opened = false, destroyed = false, opener = null, drag = null, suppressClick = false, observedComposer = null;
    let dock = { edge: 'right', fraction: 0.65, size: 'compact' };
    let frame = null, maximized = false, moving = null;
    try { storage ??= win?.localStorage; const saved = JSON.parse(storage?.getItem(storageKey) ?? 'null');
        if (['left', 'right'].includes(saved?.edge) && Number.isFinite(saved.fraction)) dock = { ...dock, edge: saved.edge, fraction: clamp(saved.fraction, 0, 1) };
        if (['compact', 'full'].includes(saved?.size)) dock.size = saved.size;
    } catch { /* Browser storage may be blocked; the manager remains usable. */ }
    try { const saved = JSON.parse(storage?.getItem(windowKey) ?? 'null');
        if (['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved?.[key]))) frame = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
        maximized = saved?.maximized === true;
    } catch { /* A broken window size falls back to the default frame. */ }
    const listeners = [], entries = new Set();
    const listen = (target, type, fn, options) => {
        target?.addEventListener(type, fn, options); listeners.push(() => target?.removeEventListener(type, fn, options));
    };
    const save = () => { try { storage?.setItem(storageKey, JSON.stringify(dock)); } catch { /* Position memory is optional. */ } };
    const saveFrame = () => { try { storage?.setItem(windowKey, JSON.stringify({ ...frame, maximized })); } catch { /* Size memory is optional. */ } };
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
    // The window frame, clamped into the reachable viewport. Narrow screens use the full surface.
    const placeWindow = () => {
        const v = viewport(), compact = v.width <= COMPACT_WIDTH;
        panel.dataset.layout = compact ? 'compact' : maximized ? 'maximized' : 'window';
        maximizeButton.hidden = compact;
        maximizeButton.title = maximized ? '还原' : '最大化'; maximizeButton.setAttribute('aria-label', maximizeButton.title);
        if (compact || maximized) { for (const key of ['left', 'top', 'width', 'height']) panel.style[key] = ''; return; }
        const margin = 12;
        const width = clamp(frame?.width ?? Math.min(1040, v.width - margin * 2), Math.min(MIN_WIDTH, v.width - margin * 2), v.width - margin * 2);
        const height = clamp(frame?.height ?? Math.min(780, v.height * 0.78), Math.min(MIN_HEIGHT, v.height - margin * 2), v.height - margin * 2);
        const x = clamp(frame?.x ?? v.width - width - margin, margin, v.width - width - margin);
        const y = clamp(frame?.y ?? margin, margin, v.height - height - margin);
        Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
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
        element.dataset.edge = dock.edge; element.dataset.bubbleSize = dock.size;
        if (!moving) placeWindow();
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
    listen(maximizeButton, 'click', () => { maximized = !maximized; saveFrame(); layout(); });
    // Move by the title bar, resize by any edge or corner. Both stop at the viewport.
    const startFrame = (event, edge) => {
        if (event.isPrimary === false || event.button !== 0 || panel.dataset.layout !== 'window') return;
        if (!edge && event.target?.closest?.('button, select, input, a')) return;
        const rect = panel.getBoundingClientRect();
        moving = { id: event.pointerId, edge, x: event.clientX, y: event.clientY, rect: { x: rect.left - viewport().left, y: rect.top - viewport().top, width: rect.width, height: rect.height } };
        event.preventDefault();
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Capture is optional. */ }
    };
    listen(chrome, 'pointerdown', event => startFrame(event, ''));
    for (const handle of handles) listen(handle, 'pointerdown', event => startFrame(event, handle.dataset.edge));
    listen(win, 'pointermove', event => {
        if (!moving || event.pointerId !== moving.id) return;
        const v = viewport(), dx = event.clientX - moving.x, dy = event.clientY - moving.y, r = moving.rect, margin = 12;
        let { x, y, width, height } = r;
        if (!moving.edge) { x = clamp(r.x + dx, margin, v.width - r.width - margin); y = clamp(r.y + dy, margin, v.height - r.height - margin); }
        if (moving.edge.includes('e')) width = clamp(r.width + dx, MIN_WIDTH, v.width - r.x - margin);
        if (moving.edge.includes('s')) height = clamp(r.height + dy, MIN_HEIGHT, v.height - r.y - margin);
        if (moving.edge.includes('w')) { width = clamp(r.width - dx, MIN_WIDTH, r.x + r.width - margin); x = r.x + r.width - width; }
        if (moving.edge.includes('n')) { height = clamp(r.height - dy, MIN_HEIGHT, r.y + r.height - margin); y = r.y + r.height - height; }
        frame = { x, y, width, height };
        Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
    });
    const finishFrame = event => {
        if (!moving || event.pointerId !== moving.id) return;
        moving = null; saveFrame(); layout();
    };
    listen(win, 'pointerup', finishFrame); listen(win, 'pointercancel', finishFrame);
    listen(bubble, 'keydown', event => {
        if (!event.shiftKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'ArrowLeft') dock.edge = 'left';
        if (event.key === 'ArrowRight') dock.edge = 'right';
        if (event.key === 'ArrowUp') dock.fraction = clamp(dock.fraction - 0.1, 0, 1);
        if (event.key === 'ArrowDown') dock.fraction = clamp(dock.fraction + 0.1, 0, 1);
        save(); layout();
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
                save();
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
    render({ initialized: true });
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
    const setDock = patch => {
        if (['left', 'right'].includes(patch?.edge)) dock = { ...dock, edge: patch.edge };
        if (Number.isFinite(patch?.fraction)) dock = { ...dock, fraction: clamp(patch.fraction, 0, 1) };
        if (['compact', 'full'].includes(patch?.size)) dock = { ...dock, size: patch.size };
        save(); layout();
    };
    return { element, panel, body, bubble, titleSlot, statusSlot, bindEntry, open, close, toggle: () => opened ? close() : open(), render,
        dock: () => ({ ...dock }), setDock,
        destroy() {
            if (destroyed) return;
            if (opened && element.contains(doc.activeElement)) close();
            destroyed = true; releaseTt?.(); releaseTt = null;
            for (const remove of listeners) remove(); observer?.disconnect();
            for (const entry of entries) entry.setAttribute('aria-expanded', 'false');
            entries.clear(); drag = null; element.remove();
        } };
}
