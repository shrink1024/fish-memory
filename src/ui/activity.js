/** Small, stable task feedback. No prompt text or timer-driven panel rerenders. */
export function elapsedLabel(startedAt, now = Date.now()) {
    const value = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
    if (!Number.isFinite(value)) return '';
    const seconds = Math.max(0, Math.floor((now - value) / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function createActivityIndicator(doc, { onStop, onRecover, now = Date.now, timers = doc.defaultView ?? globalThis } = {}) {
    const make = (tag, className) => { const node = doc.createElement(tag); node.className = className; return node; };
    const element = make('section', 'dwm-activity'); element.hidden = true; element.setAttribute('aria-label', '鱼忆运行状态');
    const mark = make('span', 'dwm-activity-mark'); mark.setAttribute('aria-hidden', 'true');
    const copy = make('div', 'dwm-activity-copy'), line = make('div', 'dwm-activity-line');
    const label = make('strong', 'dwm-activity-label'); label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite');
    const clock = make('span', 'dwm-activity-clock'); clock.setAttribute('aria-live', 'off');
    const hint = make('span', 'dwm-activity-hint');
    const action = make('button', 'dwm-activity-stop'); action.type = 'button';
    const recover = make('button', 'dwm-activity-recover'); recover.type = 'button'; recover.hidden = true; recover.textContent = '重试补记';
    const dismiss = make('button', 'dwm-activity-dismiss'); dismiss.type = 'button'; dismiss.textContent = '收起';
    dismiss.setAttribute('aria-label', '收起鱼忆运行提示');
    line.append(label, clock); copy.append(line, hint); element.append(mark, copy, action, recover, dismiss);
    let activity = null, previous = null, context, notice = '', actionError = '', timer = null, stopping = null, destroyed = false, finishTimer = null, recovery = false, recoveryKind = 'maintain', dismissedInitialization = '';
    const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
    const tick = () => set(clock, activity ? elapsedLabel(activity.startedAt, now()) : '');
    function paint() {
        if (destroyed) return;
        element.hidden = !activity && !notice;
        element.dataset.phase = activity ? activity.phase : 'finished';
        set(label, activity ? `鱼忆 · ${activity.label}` : `鱼忆 · ${notice}`);
        set(hint, actionError || activity?.hint || ''); hint.hidden = !actionError && !activity?.hint;
        action.hidden = !activity;
        action.disabled = !activity?.cancellable || stopping === activity?.id || activity?.phase === 'cancelling';
        set(action, stopping === activity?.id || activity?.phase === 'cancelling' ? '正在停止…' : activity?.stopLabel || '停止任务');
        action.title = activity?.cancellable ? '' : activity?.hint || '正在保存，请稍候';
        dismiss.hidden = Boolean(activity); recover.hidden = Boolean(activity) || !recovery || !notice;
        set(recover, recoveryKind === 'initialize' ? '建立记忆 / 重试' : '重试补记');
        tick();
        if (activity && timer === null && timers.setInterval) timer = timers.setInterval(tick, 1000);
        if (!activity && timer !== null) { timers.clearInterval(timer); timer = null; }
    }
    action.addEventListener('click', async () => {
        if (!activity?.cancellable || action.disabled) return;
        const id = activity.id; stopping = id; actionError = ''; paint();
        try {
            const result = await onStop?.(id);
            if (result?.stopped === false && activity?.id === id) actionError = result.reason || '当前任务尚未停止。';
        }
        catch (error) { if (activity?.id === id) actionError = error?.message || '未能停止，请重试。'; }
        finally { if (stopping === id) { stopping = null; paint(); } }
    });
    recover.addEventListener('click', async () => { recover.disabled = true; try { await onRecover?.(recoveryKind); } finally { recover.disabled = false; } });
    dismiss.addEventListener('click', () => { dismissedInitialization = notice; notice = ''; paint(); });
    return {
        element,
        render(view) {
            if (destroyed) return;
            const nextContext = view.chatId ?? view.save?.id ?? view.sourceBook ?? '';
            if (context !== nextContext) { previous = null; notice = ''; dismissedInitialization = ''; context = nextContext; if (finishTimer !== null) timers.clearTimeout?.(finishTimer); finishTimer = null; }
            if (activity?.id !== view.activity?.id) actionError = '';
            activity = view.activity ?? null;
            if (activity) { previous = activity; notice = ''; if (finishTimer !== null) timers.clearTimeout?.(finishTimer); finishTimer = null; }
            else if (previous) {
                notice = view.status || (view.error ? '本次处理未完成，已有资料保留' : '本次处理已结束');
                recovery = Boolean((previous.kind === 'maintain' && view.save?.initialized || previous.kind === 'initialize') && (view.error || view.autoPostPaused) && view.enabled !== false);
                recoveryKind = previous.kind === 'initialize' ? 'initialize' : 'maintain';
                previous = null;
                if (!view.error && !view.autoPostPaused && !/停止|取消|待补记|未完成/.test(notice) && timers.setTimeout) {
                    finishTimer = timers.setTimeout(() => { notice = ''; finishTimer = null; paint(); }, 4000);
                }
            }
            if (!activity && view.initialization && view.enabled !== false && !view.save?.initialized && view.initialization.state !== 'running') {
                if (dismissedInitialization !== view.initialization.message) notice = view.initialization.message;
                recovery = Boolean(view.initialization.retry); recoveryKind = 'initialize';
                if (finishTimer !== null) timers.clearTimeout?.(finishTimer); finishTimer = null;
            }
            if (!activity && view.enabled === false && recoveryKind === 'initialize') { notice = ''; recovery = false; }
            paint();
        },
        destroy() { destroyed = true; if (finishTimer !== null) timers.clearTimeout?.(finishTimer); if (timer !== null) timers.clearInterval(timer); timer = null; element.remove(); },
    };
}

/** Keep feedback above the native composer, also when the manager is closed. */
export function mountActivityFooter(doc, controller) {
    const indicator = createActivityIndicator(doc, { onStop: id => controller.requestStop(id),
        onRecover: kind => (kind === 'initialize' ? controller.initialize() : controller.maintain()).catch(() => {}) });
    indicator.element.className += ' dwm-activity-footer';
    let observer = null, destroyed = false;
    const place = () => {
        if (destroyed) return;
        const anchor = doc.querySelector('#form_sheld') ?? doc.querySelector('#send_form');
        if (anchor?.parentNode && indicator.element.parentNode !== anchor.parentNode) anchor.parentNode.insertBefore(indicator.element, anchor);
    };
    const render = () => { if (!destroyed) { const view = controller.view(); indicator.render(view); indicator.element.classList.toggle('dwm-activity-claimed', Boolean(view.activityClaimed)); place(); } };
    const unsubscribe = controller.subscribe(render);
    render();
    const host = doc.querySelector('#sheld');
    if (host && doc.defaultView?.MutationObserver) {
        observer = new doc.defaultView.MutationObserver(place); observer.observe(host, { childList: true });
    }
    return { destroy() { destroyed = true; unsubscribe(); observer?.disconnect(); indicator.destroy(); } };
}
