import { parseSupplementaryMemory } from '../core/transfer.js';
import { buildRuleDocument, compileRules, formToScript } from '../rules/index.js';
import { diffText } from './diff.js';
import { createTraceViewer } from './trace-viewer.js';
import { createPromptPreview } from './prompt-preview.js';
import { createActivityIndicator } from './activity.js';
import { DEFAULT_SETTINGS, MAINTENANCE_EVERY_MAX, templateHint, entryTier, gatedTier } from '../core/state.js';

const TIERS = [['constant', '常驻', '每轮都发送'], ['onDemand', '按需', '发送前由鱼忆判断要不要发'], ['off', '关闭', '不发送，后台也不再更新']];
const TIER_NAMES = Object.fromEntries(TIERS.map(([id, name]) => [id, name]));
const KIND_NAMES = { fact: '设定', rule: '规则', npc: '人物', npc_pool: '路人', event: '事件', inventory: '物品' };
const TASK_NAMES = { initialize: '扫描世界书', strategy: '统合记忆策略', maintain: '后台整理', select: '发送前选材', compact: '整理事件', preferences: '扫描预设', sourceMerge: '合并原书更新' };
const REASONS = { maintenance: '后台整理', compaction: '整理事件', 'source-sync': '同步原书', 'inventory-catchup': '补记物品',
    edit: '你修改了正文', reset: '你恢复了初始版本', classify: '你改了保护', promote: '你晋升了重要人物', 'promote-from-pool': '你从路人里建档',
    tier: '你改了档位', tiers: '你批量改了档位', 'tier-reset': '你恢复了扫描时的档位', 'import-memory': '你导入了旧总结' };
let panelSequence = 0;
const textOf = entry => (entry?.segments ?? []).map(segment => segment.text).join('');
const display = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
const timeOf = value => {
    if (!value) return '尚无时间记录';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
};
const countOf = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—';
// What a row shows at a glance: changed from the source book, or made by 鱼忆.
const origin = entry => !entry.source ? 'new' : textOf(entry) !== (entry.source.original ?? '') ? 'changed' : 'same';
const protection = entry => {
    const locked = (entry.segments ?? []).filter(segment => !segment.writable).length;
    return !locked ? 'none' : locked === entry.segments.length ? 'all' : 'part';
};

/**
 * Player workspace. `statusSlot` and `titleSlot` let the floating window show
 * the state line in its own title bar; `appearance` exposes the bubble dock.
 */
export function mountPanel(container, controller, { exportProblem, statusSlot = null, titleSlot = null, appearance = null } = {}) {
    if (!container?.ownerDocument) throw new TypeError('需要可挂载的容器');
    const doc = container.ownerDocument;
    const traceViewer = createTraceViewer(doc, controller.traces, { exportProblem });
    const promptPreview = createPromptPreview(doc, controller);
    const activityIndicator = createActivityIndicator(doc, { onStop: id => cancelTask(id),
        onRecover: kind => call(() => kind === 'initialize' ? controller.initialize() : controller.maintain()) });
    const panelId = `dwm-workspace-${++panelSequence}`;
    let tab = 'library', section = 'entries', settingsNav = 'basic', logView = 'memory', diagnosticsMode = 'actual';
    let selected = null, search = '', kindFilter = '', tierFilter = '', changedOnly = false;
    let selectMode = false, selectAnchor = null, batchTier = null, tierMenu = null, moreMenu = false, dialog = null;
    const picked = new Set(), help = new Set();
    // Author `gate` entries: the scan's important flag alone does not make them constant.
    let gateIds = new Set();
    const tierOf = entry => gateIds.has(entry.id) ? gatedTier(entry) : entryTier(entry);
    let detailView = 'content', editing = false, mobileDetail = false, visibleCount = 120;
    let localError = '', notice = '', busy = false, destroyed = false, cancelRequested = false, composing = false, queuedRender = false;
    let transferDraft = null, transferBook = '', transferSource = 'book', transferDownload = null;
    const clearTransferDownload = () => { if (transferDownload) { transferDownload.api.revokeObjectURL(transferDownload.url); transferDownload = null; } };
    let ruleNL = '', ruleScript = '', ruleOutput = '', ruleMatch = { field: 'title', op: 'contains', value: '', action: 'lock', limit: '' };
    let recentTurnsDraft = null, timeoutDraft = null, cadenceDraft = null, mvuDraft = null, lastSaveId = null, localPreview = null;
    let applicationSelection = new Set(), applicationPositions = {}, applicationKey = null;
    let connectionChoice = null, profileNameDraft = '', connectionDraftKey = null;
    const entryDrafts = new Map(), poolDrafts = new Map(), expanded = new Set(), scrollPositions = new Map();
    const connectionDraft = { endpoint: '', model: '', apiKey: '', maxOutputTokens: undefined };
    const storage = (() => { try { return doc.defaultView?.localStorage ?? null; } catch { return null; } })();
    let listWidth = (() => { try { return Number(storage?.getItem('dwm.list-width.v1')) || null; } catch { return null; } })();

    /* ---------- builders ---------- */
    const h = (tag, className = '', content) => {
        const el = doc.createElement(tag);
        if (className) el.className = className;
        if (content !== undefined) el.textContent = String(content);
        return el;
    };
    const focusKey = (element, key) => { element.dataset.focus = key; return element; };
    const field = (label, value, onChange, { area = false, type = 'text', placeholder = '', key = label, hint = '' } = {}) => {
        const wrap = h('label', 'dwm-field');
        wrap.append(h('span', 'dwm-label', label));
        const input = focusKey(h(area ? 'textarea' : 'input'), key);
        if (!area) input.type = type;
        input.value = value ?? ''; input.placeholder = placeholder;
        input.addEventListener('input', () => onChange(input.value));
        wrap.append(input);
        if (hint) wrap.append(h('span', 'dwm-muted dwm-hint', hint));
        return { wrap, input };
    };
    const button = (label, action, { primary = false, danger = false, ghost = false, disabled = false, navigation = false, key = label, className = '', title = '' } = {}) => {
        const b = focusKey(h('button', `dwm-button ${primary ? 'dwm-primary' : ''} ${danger ? 'dwm-danger' : ''} ${ghost ? 'dwm-ghost' : ''} ${className}`, label), key);
        b.type = 'button'; b.disabled = disabled || (!navigation && busy);
        if (title) b.title = title;
        b.addEventListener('click', action);
        return b;
    };
    const row = (...children) => { const el = h('div', 'dwm-row'); el.append(...children.filter(Boolean)); return el; };
    const prose = (text, empty = '暂无记录。') => h('div', 'dwm-prose', text || empty);
    const badge = (text, className = '') => h('span', `dwm-badge ${className}`, text);
    const lamp = tier => { const el = h('span', `dwm-lamp dwm-lamp-${tier}`); el.setAttribute('aria-hidden', 'true'); return el; };
    function details(title, key, className = 'dwm-disclosure') {
        const el = h('details', className);
        el.open = expanded.has(key);
        const summary = focusKey(h('summary', '', title), `disclosure-${key}`);
        el.append(summary);
        el.addEventListener('toggle', () => { if (el.open) expanded.add(key); else expanded.delete(key); });
        return el;
    }
    function selectField(label, value, options, onChange, key = label) {
        const wrap = h('label', 'dwm-field'); wrap.append(h('span', 'dwm-label', label));
        const input = focusKey(h('select'), key);
        for (const [id, text] of options) { const option = h('option', '', text); option.value = id; input.append(option); }
        input.value = value;
        input.addEventListener('change', () => onChange(input.value));
        wrap.append(input); return { wrap, input };
    }
    /** Push-button switch: one pressed option among several. */
    function segments(options, value, onPick, { key, label = '', small = false, disabled = false, withLamps = false } = {}) {
        const group = h('div', `dwm-seg ${small ? 'dwm-seg-small' : ''}`); group.setAttribute('role', 'group');
        if (label) group.setAttribute('aria-label', label);
        for (const [id, text, hint] of options) {
            const b = focusKey(h('button', ''), `${key}-${id}`); b.type = 'button';
            if (withLamps) b.append(lamp(id));
            b.append(h('span', '', text));
            if (hint) b.title = hint;
            b.setAttribute('aria-pressed', String(String(value) === String(id)));
            b.disabled = disabled || busy;
            b.addEventListener('click', () => { if (String(value) !== String(id)) onPick(id); });
            group.append(b);
        }
        return group;
    }
    /** On/off switch with its label. */
    function toggle(label, checked, description, onChange, disabled = false) {
        const wrap = h('div', 'dwm-setting');
        const copy = h('div', 'dwm-setting-label'); copy.append(h('strong', '', label));
        if (description) copy.append(h('span', 'dwm-muted', description));
        const input = focusKey(h('button', 'dwm-switch'), label); input.type = 'button';
        input.setAttribute('role', 'switch'); input.setAttribute('aria-checked', String(Boolean(checked))); input.setAttribute('aria-label', label);
        input.disabled = disabled || busy;
        input.addEventListener('click', () => onChange(!checked));
        wrap.append(copy, input); wrap.labelBox = copy; wrap.switchControl = input; return wrap;
    }
    /** One settings line: label (+ optional help) on the left, controls on the right. */
    function setting(label, controls, { description = '', helpKey = '', helpText = '' } = {}) {
        const wrap = h('div', 'dwm-setting');
        const copy = h('div', 'dwm-setting-label');
        const title = h('strong', '', label);
        if (helpKey) title.append(helpButton(helpKey));
        copy.append(title);
        if (description) copy.append(h('span', 'dwm-muted', description));
        if (helpKey && help.has(helpKey)) copy.append(h('span', 'dwm-helptext', helpText));
        const right = h('div', 'dwm-setting-control'); right.append(...[controls].flat().filter(Boolean));
        wrap.append(copy, right); return wrap;
    }
    function helpButton(key) {
        const b = focusKey(h('button', 'dwm-help', 'ⓘ'), `help-${key}`); b.type = 'button'; b.setAttribute('aria-label', '说明');
        b.setAttribute('aria-expanded', String(help.has(key)));
        b.addEventListener('click', () => { if (help.has(key)) help.delete(key); else help.add(key); render(); });
        return b;
    }
    const group = (...children) => { const el = h('div', 'dwm-group'); el.append(...children.filter(Boolean)); return el; };
    const heading = (text, aside) => { const el = h('div', 'dwm-page-head'); el.append(h('h3', '', text)); if (aside) el.append(...[aside].flat()); return el; };

    async function call(operation, success = '已保存') {
        if (busy || destroyed) return;
        busy = true; cancelRequested = false; localError = ''; notice = ''; render();
        try { const result = await operation(); if (!cancelRequested) notice = result?.executed === false ? result.reason : result?.message || success; }
        catch (error) { if (cancelRequested || error?.dwmCancelled || error?.dwmYielded) notice = controller.view().status; else localError = error?.message || '操作未完成，请稍后重试。'; }
        finally { busy = false; cancelRequested = false; if (!destroyed) render(); }
    }
    async function cancelTask(id) {
        localError = '';
        try {
            const result = await controller.requestStop?.(id);
            if (result?.stopped) { cancelRequested = true; notice = controller.view().status || '已请求停止'; }
            else notice = result?.reason || '当前任务尚未停止。';
            render(); return result;
        }
        catch (error) { localError = error?.message || '取消失败，请稍后重试。'; }
        render();
    }
    function initialize(view) {
        if (view.save?.initialized && !doc.defaultView?.confirm?.('请先用酒馆导出此聊天 JSONL 备份。重新扫描会在成功后替换当前动态资料；失败会保留已有资料。是否重新扫描整个存档？')) return;
        call(() => controller.initialize(), '存档扫描已完成');
    }
    function progressText(progress) {
        if (typeof progress === 'string') return progress;
        const stage = typeof progress?.stage === 'string' ? progress.stage : '正在处理';
        const done = Number(progress?.done), total = Number(progress?.total);
        return Number.isFinite(done) && Number.isFinite(total) && total > 0 ? `${stage} · ${Math.max(0, done)} / ${total}` : stage;
    }
    function navigate(nextTab) { tab = nextTab; localError = ''; notice = ''; tierMenu = null; moreMenu = false; render(); }
    function openEntry(id) {
        search = ''; kindFilter = ''; tierFilter = ''; changedOnly = false; visibleCount = 120;
        selected = id; section = 'entries'; mobileDetail = true; detailView = 'content'; editing = false; tab = 'library'; render(); focusDetail();
    }
    function focusDetail() { container.querySelector('[data-detail-heading]')?.focus({ preventScroll: true }); }
    function captureInteraction() {
        const active = container.contains(doc.activeElement) ? doc.activeElement : null;
        for (const el of container.querySelectorAll('[data-scroll]')) {
            // Hidden mobile lists report zero; keep their last visible position.
            if (typeof el.getClientRects === 'function' && !el.getClientRects().length) continue;
            scrollPositions.set(el.dataset.scroll, [el.scrollTop, el.scrollLeft]);
        }
        return active ? { key: active.dataset.focus, start: active.selectionStart, end: active.selectionEnd, top: active.scrollTop } : null;
    }
    function restoreInteraction(state) {
        for (const el of container.querySelectorAll('[data-scroll]')) {
            const position = scrollPositions.get(el.dataset.scroll);
            if (position) { el.scrollTop = position[0]; el.scrollLeft = position[1]; }
        }
        if (!state?.key) return;
        const replacement = [...container.querySelectorAll('[data-focus]')].find(el => el.dataset.focus === state.key);
        if (!replacement || replacement.disabled) return;
        replacement.focus({ preventScroll: true });
        if (Number.isInteger(state.start) && ['text', 'search', 'password', 'url', 'tel'].includes(replacement.type)) replacement.setSelectionRange(state.start, state.end);
        else if (Number.isInteger(state.start) && replacement.tagName === 'TEXTAREA') replacement.setSelectionRange(state.start, state.end);
        replacement.scrollTop = state.top ?? 0;
    }

    /* ---------- frame ---------- */
    const TABS = [['library', '资料'], ['round', '本轮'], ['log', '记录'], ['settings', '设置']];
    function render() {
        if (destroyed) return;
        if (composing) { queuedRender = true; return; }
        const interaction = captureInteraction();
        let view;
        try { view = controller.view(); }
        catch (error) { container.replaceChildren(h('p', 'dwm-error', error?.message || '无法读取当前状态')); return; }
        if (lastSaveId !== (view.save?.id ?? null)) {
            lastSaveId = view.save?.id ?? null; selected = null; mobileDetail = false; editing = false; detailView = 'content'; localPreview = null;
            entryDrafts.clear(); poolDrafts.clear(); scrollPositions.clear(); picked.clear(); selectMode = false; tierMenu = null; dialog = null;
            transferDraft = null; transferBook = ''; clearTransferDownload();
        }
        gateIds = new Set(view.gateIds ?? []);
        promptPreview.setContext(`${view.save?.id ?? ''}:${view.sourceBook ?? ''}`);
        const root = h('div', 'dwm-panel');
        const shell = h('div', 'dwm-shell');
        if (titleSlot) titleSlot.textContent = titleText(view);
        const status = renderStatus(view);
        if (statusSlot) statusSlot.replaceChildren(status);
        else { const head = h('header', 'dwm-head'); head.append(h('strong', 'dwm-head-title', titleText(view) ? `鱼忆 · ${titleText(view)}` : '鱼忆'), status); shell.append(head); }
        const nav = h('nav', 'dwm-tabs'); nav.setAttribute('aria-label', '鱼忆工作台'); nav.setAttribute('role', 'tablist');
        TABS.forEach(([id, title], index) => {
            const b = button(title, () => navigate(id), { navigation: true, key: `tab-${id}`, className: `dwm-tab ${tab === id ? 'dwm-active-tab' : ''}` });
            if (id === 'library' && view.save?.initialized) b.append(h('span', 'dwm-tab-count', Object.keys(view.save.data?.entries ?? {}).length));
            b.id = `${panelId}-tab-${id}`; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(tab === id)); b.setAttribute('aria-controls', `${panelId}-content`); b.tabIndex = tab === id ? 0 : -1;
            b.addEventListener('keydown', event => {
                const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
                if (next < 0) return;
                event.preventDefault(); navigate(TABS[next][0]); container.querySelector(`#${panelId}-tab-${TABS[next][0]}`)?.focus();
            }); nav.append(b);
        }); shell.append(nav);
        // All task cancellation comes from the runtime's actual activity. Do not
        // offer cancellation for a UI-only "busy" flag during an atomic save.
        activityIndicator.render(view);
        if (view.activity) shell.append(activityIndicator.element);
        shell.append(renderFeedback(view));
        const content = h('div', `dwm-content dwm-content-${tab}`); content.id = `${panelId}-content`;
        // Every render rebuilds this node; keep each tab's scroll position.
        content.dataset.scroll = `content-${tab}-${tab === 'log' ? logView : tab === 'library' ? section : ''}`; content.setAttribute('role', 'tabpanel'); content.setAttribute('aria-labelledby', `${panelId}-tab-${tab}`);
        if (tab === 'settings') renderSettings(content, view);
        else if (!view.save?.initialized && tab !== 'log') renderFirstRun(content, view);
        else if (tab === 'library') renderLibrary(content, view);
        else if (tab === 'round') renderRound(content, view);
        else renderLog(content, view);
        shell.append(content);
        if (dialog) shell.append(renderDialog(view));
        if (notice) { const toast = h('div', 'dwm-toast', notice); toast.setAttribute('role', 'status'); shell.append(toast); }
        root.append(shell); container.replaceChildren(root); restoreInteraction(interaction);
        traceViewer.setActive(tab === 'log' && logView === 'traces' && diagnosticsMode === 'actual');
    }
    const titleText = view => [view.sourceBook, view.save ? `已记入 ${countOf(view.save.processedCount)} 条消息` : ''].filter(Boolean).join(' · ');
    function renderStatus(view) {
        const state = h('div', 'dwm-statebar'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite'); state.setAttribute('aria-atomic', 'true');
        const pending = Number(view.diagnostics?.pendingCount ?? view.diagnostics?.memory?.pendingCount) || 0;
        const dot = kind => h('span', `dwm-status-dot ${kind}`);
        if (!view.settings?.enabled) state.append(dot('dwm-status-idle'), h('span', '', '插件总开关已关闭'), button('打开', () => call(() => controller.updateSettings({ enabled: true })), { ghost: true, className: 'dwm-link-button' }));
        else if (view.save?.initialized && view.saveEnabled === false) state.append(dot('dwm-status-idle'), h('span', '', '此存档记忆已暂停'), button('启用', () => call(() => controller.setSaveEnabled(true)), { ghost: true, className: 'dwm-link-button' }));
        else if (view.progress) state.append(dot('dwm-status-busy'), h('span', '', progressText(view.progress)));
        else if (view.error) state.append(dot('dwm-status-error'), h('span', '', view.status || '需要处理'));
        else if (!view.save?.initialized) state.append(dot('dwm-status-idle'), h('span', '', view.status && view.status !== '未初始化' ? view.status : '此存档还没有建立记忆'));
        else if (view.autoPostPaused && !view.activity) state.append(dot('dwm-status-busy'), h('span', '', '自动整理暂停到下一条回复'), button('立即补记', () => call(() => controller.maintain()), { ghost: true, className: 'dwm-link-button' }));
        else if (pending > 0) state.append(dot(''), h('span', '', `${countOf(pending)} 条消息还没整理进记忆`), button('现在整理', () => call(() => controller.maintain(), '补记完成'), { ghost: true, className: 'dwm-link-button', disabled: Boolean(view.activity) }));
        else state.append(dot(''), h('span', '', view.status && !['可用', '已就绪'].includes(view.status) ? view.status : '已就绪 · 记忆是最新的'));
        return state;
    }
    function renderFeedback(view) {
        const feedback = h('div', 'dwm-feedback');
        if (localError) { const error = h('p', 'dwm-error', localError); error.setAttribute('role', 'alert'); feedback.append(error); }
        if (view.error) {
            const error = details(`出了点问题：${view.status || '任务未完成'}`, 'task-error', 'dwm-disclosure dwm-error-box'); error.append(prose(view.error));
            error.append(row(view.save?.initialized && /记忆待补齐|正在维护|补记/.test(view.status) && button('重试补记', () => call(() => controller.maintain())),
                typeof exportProblem === 'function' && button('导出本次问题', () => {
                    // The export and its fallback download link live on the 收发 page.
                    tab = 'log'; logView = 'traces'; diagnosticsMode = 'actual'; render(); traceViewer.exportProblem();
                }, { ghost: true, key: 'error-export-problem' })));
            error.append(h('p', 'dwm-muted', '找作者反馈时，把导出的文件一起发过去。文件里有相关剧情和提示词，发之前可以先看一眼。'));
            feedback.append(error);
        }
        const changes = view.sourceChanges;
        if (changes?.changed) {
            const box = h('div', 'dwm-banner dwm-banner-warn');
            box.append(h('p', '', `角色卡的世界书更新了：新增 ${changes.added.length} 条、修改 ${changes.updated.length} 条、删除 ${changes.removed.length} 条。同步前，相关的整理先暂停。`),
                row(button('只同步变化的条目', () => call(() => controller.syncSourceChanges(), '原书变化已同步'), { primary: true, disabled: Boolean(view.activity) || !view.save?.initialized }),
                    button('整本重新扫描…', () => { settingsNav = 'advanced'; navigate('settings'); }, { navigation: true, ghost: true })));
            box.setAttribute('role', 'status'); feedback.append(box);
        } else if (changes?.pendingScan?.length) {
            const box = h('div', 'dwm-banner');
            box.append(h('p', '', `原世界书里新打开了 ${changes.pendingScan.length} 条扫描时关闭的条目，暂按原世界书方式发送。`),
                button('扫描它们', () => call(() => controller.syncSourceChanges(), '原书变化已同步'), { disabled: Boolean(view.activity) || !view.save?.initialized }));
            feedback.append(box);
        }
        return feedback;
    }

    /* ---------- first run ---------- */
    function renderWorldbookCheck(parent, view) {
        const status = view.worldbook;
        if (status?.primaryName) parent.append(h('p', 'dwm-muted', `当前角色主世界书：${status.primaryName}`));
        if (status?.message) {
            const text = h('p', ['ready', 'bound', 'empty'].includes(status.state) ? 'dwm-muted' : 'dwm-warning', status.message);
            text.setAttribute('role', 'status'); parent.append(text);
        }
        if (status && typeof controller.checkWorldbook === 'function') {
            parent.append(button(view.worldbookChecking ? '正在检查世界书…' : '重新检查世界书', () => call(() => controller.checkWorldbook()), {
                disabled: view.readiness?.chat === false || view.readiness?.single === false || Boolean(view.worldbookChecking || view.progress || view.activity),
            }), h('p', 'dwm-muted dwm-hint', '检查角色主绑定和文件读取，不调用辅助模型。'));
        }
    }
    function renderFirstRun(parent, view) {
        const panel = h('section', 'dwm-welcome');
        const scanning = Boolean(view.progress) || view.activity?.kind === 'initialize';
        panel.append(h('h3', '', scanning ? '正在建立记忆' : '为这个存档建立记忆'));
        panel.append(h('p', '', scanning
            ? '先扫描世界书，再读一遍已有剧情。期间可以照常聊天，这几轮按原世界书发送，扫完后会补上。'
            : '鱼忆会扫描角色卡的世界书和已有剧情，为这个存档建一份可以随剧情更新的副本，原世界书不会被改。新开的聊天会自动开始；已经有剧情的旧聊天需要手动开始。'));
        const readiness = view.readiness ?? {};
        const checks = [['角色聊天', readiness.chat], ['角色绑定了世界书', readiness.book], ['单角色聊天', readiness.single], ['提示词模板已启用', readiness.template]];
        const conditions = h('ul', 'dwm-readiness');
        for (const [label, ready] of checks) conditions.append(h('li', ready ? 'dwm-ready' : 'dwm-warning', `${ready ? '✓' : '○'} ${label}`));
        panel.append(conditions);
        if (readiness.template === false) panel.append(h('p', 'dwm-warning', `${templateHint(readiness.templateStatus)}。`));
        renderWorldbookCheck(panel, view);
        if (view.initialization?.message) panel.append(h('p', view.initialization.retry ? 'dwm-warning' : 'dwm-muted', view.initialization.message));
        if (view.initializationResume) panel.append(h('p', 'dwm-notice', `已有扫描进度：世界书 ${view.initializationResume.classifiedBatches}/${view.initializationResume.totalBatches} 批，历史 ${view.initializationResume.processedCount} 条。再次扫描会先核对资料，继续仍有效的进度。`));
        panel.append(row(button(view.initialization?.retry ? '手动扫描 / 重试初始化' : '建立此存档记忆', () => initialize(view), { primary: true, disabled: !view.save || Boolean(view.progress) || Boolean(view.activity) || Object.values(readiness).some(value => value === false) }),
            button('设置辅助模型', () => { settingsNav = 'model'; navigate('settings'); }, { navigation: true, ghost: true })));
        panel.append(h('p', 'dwm-muted dwm-hint', '聊天越长，扫描越久、调用次数越多，建议先导出一份聊天备份。预设可在“设置 → 预设应用”中选择或扫描推荐，不影响建立记忆。'));
        if (view.connectionMode === 'test') panel.append(h('p', 'dwm-muted', '本页使用模拟模型，不会调用真实 API。'));
        parent.append(panel);
    }

    /* ---------- 资料 ---------- */
    function sectionSwitch(view) {
        const bar = h('div', 'dwm-library-top');
        bar.append(segments([['entries', '世界书'], ['summary', '故事脉络'], ['inventory', '物品']], section, id => { section = id; mobileDetail = false; moreMenu = false; render(); },
            { key: 'section', label: '资料类别', small: true }));
        const more = button('⋯', () => { moreMenu = !moreMenu; tierMenu = null; render(); }, { navigation: true, ghost: true, key: 'more-menu', className: 'dwm-icon-button', title: '导出、导入' });
        more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', String(moreMenu)); more.setAttribute('aria-label', '导出、导入');
        const anchor = h('div', 'dwm-menu-anchor'); anchor.append(more);
        if (moreMenu) {
            const menu = h('div', 'dwm-menu'); menu.setAttribute('role', 'menu');
            const item = (title, text, action, disabled = false) => {
                const b = focusKey(h('button', 'dwm-menu-item'), `more-${title}`); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.disabled = disabled;
                b.append(h('strong', '', title), h('span', '', text)); b.addEventListener('click', () => { moreMenu = false; action(); }); return b;
            };
            const unavailable = Boolean(view.activity);
            if (typeof controller.exportMemory === 'function') menu.append(
                item('导出为世界书', '给新聊天接着用', () => { clearTransferDownload(); dialog = 'export'; render(); }, unavailable),
                item('导入旧总结', '从附加世界书或文件', () => { transferDraft = null; dialog = 'import'; render(); }, unavailable));
            menu.append(item('同步原世界书的更新', '卡作者更新了世界书时用', () => call(() => controller.syncSourceChanges(), '原书变化已同步'), unavailable || !view.sourceChanges?.changed && !view.sourceChanges?.pendingScan?.length));
            anchor.append(menu);
        }
        bar.append(anchor); return bar;
    }
    function matchingEntries(entries) {
        const query = search.toLocaleLowerCase();
        return entries.filter(e => (!tierFilter || tierOf(e) === tierFilter) && (!kindFilter || e.kind === kindFilter)
            && (!changedOnly || origin(e) !== 'same') && (!query || `${e.title} ${e.intro} ${textOf(e)}`.toLocaleLowerCase().includes(query)));
    }
    function marks(entry) {
        const out = [];
        if (entry.needsReview) out.push(Object.assign(h('span', 'dwm-mark dwm-mark-review', '待核对'), { title: '后台改动需要你看一眼' }));
        if (entry.scanBlocked) out.push(Object.assign(h('span', 'dwm-mark dwm-mark-review', '未扫描'), { title: '辅助接口的内容审核拒收了这条，暂按原世界书发送' }));
        const from = origin(entry);
        if (from === 'new') out.push(Object.assign(h('span', 'dwm-mark dwm-mark-new', '新'), { title: entry.origin === 'import' ? '你导入的旧总结' : '鱼忆根据剧情新建' }));
        if (from === 'changed') out.push(Object.assign(h('span', 'dwm-mark dwm-mark-changed', '改'), { title: '和原世界书不同：被剧情或你改过' }));
        const locked = protection(entry);
        if (locked !== 'none') out.push(Object.assign(h('span', `dwm-lock ${locked === 'part' ? 'dwm-lock-part' : ''}`), { title: locked === 'all' ? '正文受保护，后台不会改' : '部分正文受保护' }));
        return out;
    }
    function renderLibrary(parent, view) {
        if (section !== 'entries') {
            const page = h('div', 'dwm-content-scroll'); page.dataset.scroll = `section-${section}`; page.append(sectionSwitch(view));
            if (section === 'summary') renderSummary(page, view); else renderInventory(page, view);
            parent.append(page); return;
        }
        const entries = Object.values(view.save.data?.entries ?? {});
        const matching = matchingEntries(entries);
        for (const id of picked) if (!entries.some(e => e.id === id)) picked.delete(id);
        if (!matching.some(e => e.id === selected)) { selected = matching[0]?.id ?? null; editing = false; }
        const layout = h('div', `dwm-browser ${mobileDetail ? 'dwm-show-detail' : ''}`);
        const sidebar = h('aside', 'dwm-sidebar'); sidebar.setAttribute('aria-label', '动态条目列表');
        const tools = h('div', 'dwm-list-tools');
        tools.append(sectionSwitch(view));
        if (selectMode) {
            const head = h('div', 'dwm-select-head');
            head.append(h('strong', '', `已选 ${picked.size} 条`),
                button(`全选当前 ${Math.min(matching.length, 1000)} 条`, () => { matching.slice(0, 1000).forEach(e => picked.add(e.id)); render(); }, { navigation: true, ghost: true }),
                button('清空', () => { picked.clear(); render(); }, { navigation: true, ghost: true }),
                button('完成', () => { selectMode = false; picked.clear(); batchTier = null; render(); }, { navigation: true }));
            tools.append(head);
        } else {
            const search_ = field('搜索资料', search, value => { search = value; visibleCount = 120; mobileDetail = false; render(); }, { type: 'search', placeholder: '搜名称或正文', key: 'entry-search' });
            search_.wrap.classList.add('dwm-search');
            const kinds = selectField('类型', kindFilter, [['', '全部类型'], ...Object.entries(KIND_NAMES)], value => { kindFilter = value; visibleCount = 120; render(); }, 'kind-filter');
            kinds.wrap.classList.add('dwm-kind');
            tools.append(row(search_.wrap, kinds.wrap, button('多选', () => { selectMode = true; picked.clear(); tierMenu = null; render(); }, { navigation: true, title: '勾选多条，一次改档位' })));
        }
        const chips = h('div', 'dwm-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', '按档位筛选');
        const chip = (id, label, count, active, onClick, mark) => {
            const b = focusKey(h('button', 'dwm-chip'), `chip-${id}`); b.type = 'button'; b.setAttribute('aria-pressed', String(active));
            if (mark) b.append(mark);
            b.append(h('span', '', label), h('em', '', count)); b.addEventListener('click', onClick); return b;
        };
        chips.append(chip('all', '全部', entries.length, !tierFilter, () => { tierFilter = ''; render(); }));
        for (const [id, name] of TIERS) chips.append(chip(id, name, entries.filter(e => tierOf(e) === id).length, tierFilter === id, () => { tierFilter = tierFilter === id ? '' : id; render(); }, lamp(id)));
        chips.append(chip('changed', '有改动', entries.filter(e => origin(e) !== 'same').length, changedOnly, () => { changedOnly = !changedOnly; render(); }, h('span', 'dwm-mark dwm-mark-changed', '改')));
        tools.append(chips); sidebar.append(tools);
        const list = h('div', 'dwm-list'); list.dataset.scroll = 'library-list';
        list.setAttribute('role', 'listbox'); list.setAttribute('aria-multiselectable', String(selectMode)); list.setAttribute('aria-label', `资料 · ${matching.length} 条`);
        const ids = matching.map(e => e.id);
        for (const entry of matching.slice(0, visibleCount)) list.append(entryRow(entry, ids));
        if (matching.length > visibleCount) list.append(button(`再显示 ${Math.min(120, matching.length - visibleCount)} 条`, () => { visibleCount += 120; render(); }, { navigation: true, ghost: true }));
        if (!matching.length) list.append(h('p', 'dwm-empty', '没有符合条件的资料。'));
        sidebar.append(list);
        sidebar.append(selectMode ? batchBar(view, entries) : legend());
        if (listWidth) layout.style?.setProperty?.('--dwm-list-width', `${listWidth}px`);
        layout.append(sidebar, splitter(layout));
        const detail = h('article', 'dwm-detail'); detail.dataset.scroll = 'entry-detail';
        const entry = matching.find(e => e.id === selected);
        if (entry) renderEntry(detail, entry, view);
        else detail.append(h('p', 'dwm-empty', '选一条资料查看。'));
        layout.append(detail); parent.append(layout);
    }
    /** Drag to widen the list; the width is a per-browser convenience. */
    function splitter(layout) {
        const bar = h('div', 'dwm-splitter'); bar.setAttribute('role', 'separator'); bar.setAttribute('aria-orientation', 'vertical'); bar.title = '拖动调整列表宽度';
        bar.addEventListener('pointerdown', event => {
            const win = doc.defaultView, left = layout.getBoundingClientRect?.().left ?? 0, total = layout.clientWidth ?? 0;
            if (!win || !total) return;
            event.preventDefault();
            const move = next => {
                listWidth = Math.round(Math.min(Math.max(next.clientX - left, 240), total - 320));
                layout.style?.setProperty?.('--dwm-list-width', `${listWidth}px`);
            };
            const up = () => {
                win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up);
                try { storage?.setItem('dwm.list-width.v1', String(listWidth)); } catch { /* Width memory is optional. */ }
            };
            win.addEventListener('pointermove', move); win.addEventListener('pointerup', up);
        });
        return bar;
    }
    function entryRow(entry, ids) {
        const tier = tierOf(entry), isPicked = picked.has(entry.id);
        const wrap = h('div', `dwm-entry ${!selectMode && entry.id === selected ? 'dwm-selected' : ''} ${isPicked ? 'dwm-picked' : ''} ${tier === 'off' ? 'dwm-dim' : ''}`);
        wrap.setAttribute('role', 'option'); wrap.setAttribute('aria-selected', String(selectMode ? isPicked : entry.id === selected));
        if (selectMode) {
            const box = focusKey(h('input', 'dwm-check'), `pick-${entry.id}`); box.type = 'checkbox'; box.checked = isPicked; box.setAttribute('aria-label', `选择 ${entry.title}`);
            box.addEventListener('click', event => pick(entry.id, ids, event.shiftKey));
            wrap.append(box, lamp(tier));
        } else {
            const lampButton = focusKey(h('button', 'dwm-lamp-button'), `lamp-${entry.id}`); lampButton.type = 'button';
            lampButton.append(lamp(tier)); lampButton.title = `${TIER_NAMES[tier]}：点一下换档位`;
            lampButton.setAttribute('aria-label', `${entry.title}：${TIER_NAMES[tier]}，点击换档位`); lampButton.setAttribute('aria-haspopup', 'menu'); lampButton.setAttribute('aria-expanded', String(tierMenu === entry.id));
            lampButton.addEventListener('click', () => { tierMenu = tierMenu === entry.id ? null : entry.id; moreMenu = false; render(); });
            wrap.append(lampButton);
        }
        const open = button('', event => {
            if (selectMode) { pick(entry.id, ids, Boolean(event?.shiftKey)); return; }
            selected = entry.id; mobileDetail = true; editing = false; detailView = 'content'; tierMenu = null; render(); focusDetail();
        }, { navigation: true, key: `entry-${entry.id}`, className: 'dwm-entry-link' });
        open.setAttribute('aria-current', entry.id === selected ? 'true' : 'false');
        open.append(h('span', 'dwm-entry-title-text', entry.title || '未命名条目'), ...marks(entry), h('span', 'dwm-entry-kind', KIND_NAMES[entry.kind] ?? entry.kind));
        wrap.append(open);
        if (tierMenu === entry.id && !selectMode) wrap.append(tierMenuElement(entry));
        return wrap;
    }
    function pick(id, ids, range) {
        if (range && selectAnchor && ids.includes(selectAnchor)) {
            const [from, to] = [ids.indexOf(selectAnchor), ids.indexOf(id)].sort((a, b) => a - b);
            for (const item of ids.slice(from, to + 1)) if (picked.size < 1000) picked.add(item);
        } else {
            if (picked.has(id)) picked.delete(id); else if (picked.size < 1000) picked.add(id);
            selectAnchor = id;
        }
        render();
    }
    function tierMenuElement(entry) {
        const menu = h('div', 'dwm-menu dwm-tier-menu'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `${entry.title} 的档位`);
        const current = tierOf(entry);
        for (const [id, name, hint] of TIERS) {
            const b = focusKey(h('button', 'dwm-menu-item'), `tier-menu-${entry.id}-${id}`); b.type = 'button'; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(id === current));
            const copy = h('span', 'dwm-menu-copy'); copy.append(h('strong', '', name), h('span', '', hint));
            b.append(lamp(id), copy); if (id === current) b.append(h('span', 'dwm-menu-check', '✓'));
            b.disabled = busy;
            b.addEventListener('click', () => { tierMenu = null; if (id === current) { render(); return; } setTier(entry, id); });
            menu.append(b);
        }
        return menu;
    }
    function setTier(entry, tier) {
        const unscanned = entry.status === 'deferred' && tier !== 'off';
        call(() => controller.manual({ type: 'tier', id: entry.id, tier }), `「${entry.title}」已设为${TIER_NAMES[tier]}${unscanned ? '，已先扫描这一条' : ''}`);
    }
    function legend() {
        const el = h('div', 'dwm-legend'); el.setAttribute('aria-hidden', 'true');
        for (const [id, name] of TIERS) { const item = h('span'); item.append(lamp(id), h('span', '', name)); el.append(item); }
        for (const [className, mark, text] of [['dwm-mark dwm-mark-changed', '改', '和原书不同'], ['dwm-mark dwm-mark-new', '新', '鱼忆新建']]) { const item = h('span'); item.append(h('span', className, mark), h('span', '', text)); el.append(item); }
        const lock = h('span'); lock.append(h('span', 'dwm-lock'), h('span', '', '受保护')); el.append(lock);
        return el;
    }
    function batchBar(view, entries) {
        const bar = h('div', 'dwm-batchbar');
        const line = h('div', 'dwm-batch-line');
        line.append(h('span', '', `把选中的 ${picked.size} 条设为`), segments(TIERS, batchTier ?? '', tier => call(async () => {
            const result = await controller.setEntryTiers([...picked], tier); picked.clear(); selectMode = false; batchTier = null; return result;
        }), { key: 'batch', small: true, withLamps: true, disabled: !picked.size || Boolean(view.activity), label: '批量档位' }));
        bar.append(line);
        const unscanned = entries.filter(e => picked.has(e.id) && e.status === 'deferred').length;
        if (unscanned) bar.append(h('p', 'dwm-batch-note', `其中 ${unscanned} 条还没扫描过，设为常驻或按需时会先调用模型扫描。`));
        return bar;
    }

    function renderSummary(parent, view) {
        const page = h('div', 'dwm-page');
        page.append(heading('故事脉络', h('span', 'dwm-muted', '每轮常驻发送')));
        page.append(prose(view.save.data.summary, '还没有故事脉络，下一次整理后会显示在这里。'));
        for (const [scopeId, text] of Object.entries(view.save.data.scopeSummaries ?? {})) {
            const scope = details(`独立范围 · ${scopeId}`, `summary-${scopeId}`); scope.append(prose(text)); page.append(scope);
        }
        page.append(row(button('补记新剧情', () => call(() => controller.maintain(), '补记完成'), { disabled: Boolean(view.activity) }),
            h('span', 'dwm-muted dwm-hint', `写法：${(view.settings?.summaryMode ?? DEFAULT_SETTINGS.summaryMode) === 'rewrite' ? '整段重写' : '追加'}，可在设置里改。`)));
        parent.append(page);
    }
    function renderInventory(parent, view) {
        const page = h('div', 'dwm-page');
        const enabled = view.save.data.inventoryEnabled;
        page.append(heading('我的物品'), toggle('记录物品', enabled, '卡自带背包系统时可以关掉，已有记录会保留。', value => call(() => controller.manual({ type: 'inventory-toggle', enabled: value }))));
        if (!enabled) page.append(h('p', 'dwm-warning', '物品清单已暂停，下面是保留的记录。'));
        if (view.save.inventoryNeedsCatchUp) page.append(h('p', 'dwm-warning', '物品待补记，暂不发送。下面的旧清单不能当作当前持有物。'));
        const scopes = [['global', view.save.data.inventory], ...Object.entries(view.save.data.scopeInventories ?? {})];
        for (const [scopeId, items] of scopes) {
            if (scopeId !== 'global') page.append(h('h4', '', `独立范围 · ${scopeId}`));
            if (!items?.length) { if (scopeId === 'global') page.append(h('p', 'dwm-empty', '还没有记录物品。')); continue; }
            const list = h('ul', 'dwm-inventory');
            for (const item of items) { const li = h('li'); li.append(h('strong', '', item.name || '未命名物品'), h('span', 'dwm-muted', item.description || '暂无说明')); list.append(li); }
            page.append(list);
        }
        parent.append(page);
    }
    function newDraft(entry) {
        return { version: entry.version, title: entry.title, intro: entry.intro, retrieveWhen: entry.retrieveWhen, segments: (entry.segments ?? []).map(s => ({ ...s })) };
    }
    function renderEntry(parent, entry, view) {
        const tier = tierOf(entry), gatedImportant = tier !== entryTier(entry), from = origin(entry), locked = protection(entry);
        const head = h('div', 'dwm-detail-head');
        const titleRow = h('div', 'dwm-detail-title');
        titleRow.append(button('列表', () => { mobileDetail = false; editing = false; render(); container.querySelector('[data-focus="entry-search"]')?.focus({ preventScroll: true }); }, { navigation: true, ghost: true, className: 'dwm-mobile-back' }));
        const title = h('h3', 'dwm-entry-title', entry.title || '未命名条目'); title.tabIndex = -1; title.dataset.detailHeading = 'true'; titleRow.append(title);
        head.append(titleRow);
        const meta = [KIND_NAMES[entry.kind] ?? entry.kind, from === 'new' ? (entry.origin === 'import' ? '你导入的旧总结' : '鱼忆新建') : from === 'changed' ? '和原书不同' : '与原书一致',
            entry.scanBlocked ? '辅助接口拒收，未扫描' : entry.status === 'deferred' ? '还没扫描过' : '', entry.needsReview ? '待核对' : '', `${textOf(entry).length.toLocaleString('zh-CN')} 字`,
            entry.scopeId && entry.scopeId !== 'global' ? `范围 ${entry.scopeId}` : ''].filter(Boolean);
        head.append(h('p', 'dwm-detail-meta', meta.join(' · ')));
        let scanned = view.save?.scannedTiers?.[entry.id];
        if (gateIds.has(entry.id) && scanned === 'constant' && !entry.constant) scanned = 'onDemand';
        const controls = h('div', 'dwm-detail-controls');
        controls.append(h('span', 'dwm-control-label', '发送'), segments(TIERS, tier, id => setTier(entry, id), { key: `tier-${entry.id}`, label: '档位', withLamps: true }));
        if (entry.tier || (scanned && scanned !== tier)) {
            const note = h('span', 'dwm-scan-note', scanned && scanned !== tier ? `扫描时为${TIER_NAMES[scanned]}` : '已手动调整');
            note.append(button('恢复', () => call(() => controller.manual({ type: 'tier-reset', id: entry.id }), '已恢复扫描时的档位'), { ghost: true, className: 'dwm-link-button', key: `tier-reset-${entry.id}` }));
            controls.append(note);
        }
        const protect = h('span', 'dwm-protect');
        const sw = focusKey(h('button', 'dwm-switch'), `protect-${entry.id}`); sw.type = 'button'; sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', String(locked === 'all')); sw.setAttribute('aria-label', '保护正文');
        sw.disabled = busy || entry.kind === 'rule';
        if (entry.kind === 'rule') sw.title = '作者规则固定受保护';
        sw.addEventListener('click', () => {
            const writable = locked === 'all';
            call(() => controller.manual({ type: 'classify', id: entry.id, expectedVersion: entry.version, segments: entry.segments.map(s => ({ ...s, writable })) }),
                writable ? '已取消保护：后台可以更新这条' : '已保护正文：后台不会再改这条');
        });
        protect.append(sw, h('span', '', locked === 'part' ? '保护正文（部分）' : '保护正文'), helpButton('protect'));
        controls.append(protect);
        head.append(controls);
        if (help.has('protect')) head.append(h('p', 'dwm-helptext', '打开后，后台整理不会改这条正文；你自己仍然可以编辑。保护只管改不改，不管发不发：要每轮都发，请同时设为常驻。'));
        if (entry.scanBlocked) head.append(h('p', 'dwm-hint dwm-muted', '扫描时，辅助接口的内容审核拒收了这条。鱼忆没有接管它，酒馆仍按原世界书的设置发送。换用审核较宽松的辅助接口后，把它设为常驻或按需，就会重新扫描。'));
        else if (gatedImportant) head.append(h('p', 'dwm-hint dwm-muted', '扫描时鱼忆把这条判为重要，但作者规则要求它的关键词出现后才可选，所以按按需处理。要每轮都发，请手动设为常驻。'));
        else if (tier !== 'off' && entry.status === 'deferred') head.append(h('p', 'dwm-hint dwm-muted', '这条在扫描时是关闭的，还没扫描过。'));
        parent.append(head);
        const tabs = h('div', 'dwm-detail-tabs'); tabs.setAttribute('role', 'tablist');
        const records = [...(view.save.audit ?? [])].reverse().filter(record => record.entryId === entry.id);
        for (const [id, label] of [['content', '内容'], ['diff', '对比原书'], ['history', `改动记录${records.length ? ` ${records.length}` : ''}`]]) {
            const b = button(label, () => { detailView = id; editing = false; render(); }, { navigation: true, key: `detail-${id}`, className: `dwm-detail-tab ${detailView === id && !editing ? 'dwm-active-tab' : ''}` });
            b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(detailView === id && !editing)); tabs.append(b);
        }
        if (!editing) tabs.append(button('编辑', () => { editing = true; if (!entryDrafts.has(entry.id)) entryDrafts.set(entry.id, newDraft(entry)); render(); }, { navigation: true, ghost: true, className: 'dwm-detail-edit', key: `edit-${entry.id}` }));
        parent.append(tabs);
        const body = h('div', 'dwm-detail-body');
        if (editing) renderEdit(body, entry);
        else if (detailView === 'diff') renderDiff(body, entry);
        else if (detailView === 'history') renderHistory(body, entry, records, view);
        else {
            if (entry.needsReview) body.append(h('p', 'dwm-banner dwm-banner-warn', '后台这次改动可能和原文有冲突，看一眼是否需要改回。'));
            if (entry.intro) body.append(h('p', 'dwm-entry-description', entry.intro));
            body.append(prose(textOf(entry), '这条暂时没有正文。'));
            const usage = details('什么时候发这条', `guidance-${entry.id}`); usage.append(prose(entry.retrieveWhen, '扫描时还没给出。')); body.append(usage);
            if (entry.kind === 'npc' && !entry.important) body.append(row(button('晋升为重要人物', () => call(() => controller.manual({ type: 'promote', id: entry.id }), '已晋升为重要人物'), { ghost: true })));
            if (entry.kind === 'npc_pool') renderPool(body, entry);
        }
        parent.append(body);
    }
    function renderHistory(parent, entry, records, view) {
        if (entry.source) parent.append(h('p', 'dwm-muted dwm-hint', `原世界书：${entry.source.book ?? view.sourceBook} · 条目 ${entry.source.uid ?? '—'}`));
        if (!records.length) parent.append(h('p', 'dwm-empty', '这条还没有改动。'));
        for (const record of records.slice(0, 20)) parent.append(auditRecord(record, view, false));
        if (entry.evidence?.length) {
            const source = details('依据的消息', `evidence-${entry.id}`);
            source.append(h('p', 'dwm-muted', (entry.evidence ?? []).join('、')));
            if (entry.evidenceTrimmed) source.append(h('p', 'dwm-muted', '来源较多，只保留早期与近期引用。'));
            parent.append(source);
        }
        parent.append(h('p', 'dwm-muted dwm-hint', '改动记录只给你看，不会发给模型。'));
    }
    function renderDiff(parent, entry) {
        if (!entry.source) { parent.append(h('p', 'dwm-empty', entry.origin === 'import' ? '这条是你导入的旧总结，原世界书里没有。' : '这条是鱼忆根据剧情新建的，原世界书里没有。')); return; }
        const before = entry.source.original ?? '', after = textOf(entry);
        if (before === after) { parent.append(h('p', 'dwm-empty', '和原世界书一致。')); return; }
        const legendRow = h('div', 'dwm-diff-legend'); legendRow.append(h('span', 'dwm-diff-delete', '删去'), h('span', 'dwm-diff-add', '新增')); parent.append(legendRow);
        const inline = h('div', 'dwm-prose dwm-inline-diff');
        for (const part of diffText(before, after)) {
            const node = h(part.type === 'remove' ? 'del' : part.type === 'add' ? 'ins' : 'span', '', part.text);
            if (part.type !== 'equal') node.setAttribute('aria-label', `${part.type === 'remove' ? '删除' : '新增'}：${part.text}`);
            inline.append(node);
        } parent.append(inline);
        const original = details('完整原书内容', `original-${entry.id}`); original.append(prose(before)); parent.append(original);
    }
    function renderEdit(parent, entry) {
        const draft = entryDrafts.get(entry.id) ?? newDraft(entry); entryDrafts.set(entry.id, draft);
        const conflict = draft.version !== entry.version;
        if (conflict) {
            const warning = h('div', 'dwm-banner dwm-banner-warn'); warning.append(h('strong', '', '后台已有新版本，你的草稿已保留。'), h('p', '', `草稿基于版本 ${draft.version}，当前为版本 ${entry.version}。先复制草稿，再载入新版合并。`));
            warning.append(row(button('复制草稿', () => call(async () => {
                if (!doc.defaultView?.navigator?.clipboard?.writeText) throw new Error('当前环境无法复制，请手动复制编辑框里的草稿。');
                await doc.defaultView.navigator.clipboard.writeText(`${draft.title}\n${draft.intro}\n何时提取：${draft.retrieveWhen}\n\n${textOf(draft)}`);
            }, '草稿已复制')), button('载入最新版本', () => {
                if (!doc.defaultView?.confirm?.('载入新版会替换当前编辑框中的草稿。请先复制要保留的文字。确定继续吗？')) return;
                entryDrafts.set(entry.id, newDraft(entry)); render();
            })));
            parent.append(warning);
        }
        parent.append(field('名称', draft.title, value => { draft.title = value; }, { key: `title-${entry.id}` }).wrap,
            field('一句话介绍', draft.intro, value => { draft.intro = value; }, { area: true, key: `intro-${entry.id}` }).wrap,
            field('什么时候发这条', draft.retrieveWhen, value => { draft.retrieveWhen = value; }, { area: true, key: `guidance-${entry.id}` }).wrap);
        for (const segment of draft.segments) {
            const label = draft.segments.length > 1 ? `正文 · ${segment.id}${segment.writable ? '' : '（受保护）'}` : '正文';
            const f = field(label, segment.text, value => { segment.text = value; }, { area: true, key: `segment-${entry.id}-${segment.id}` });
            f.input.classList.add('dwm-body-editor'); parent.append(f.wrap);
        }
        const actions = row(button('取消', () => { editing = false; render(); }, { navigation: true, ghost: true }), button('保存修改', () => call(async () => {
            await controller.manual({ type: 'edit', id: entry.id, expectedVersion: draft.version, title: draft.title, intro: draft.intro, retrieveWhen: draft.retrieveWhen, segments: draft.segments });
            entryDrafts.delete(entry.id); editing = false;
        }, '动态资料已保存'), { primary: true, disabled: conflict }));
        actions.classList.add('dwm-edit-actions'); parent.append(actions);
        if (entry.source) {
            const more = details('恢复到初始版本', `edit-tools-${entry.id}`);
            more.append(h('p', 'dwm-muted', '只把这一条恢复成这个存档建立记忆时的内容。其他条目和故事脉络不受影响。'),
                button('恢复此条', () => {
                    if (!doc.defaultView?.confirm?.('只将这一条动态资料恢复为本档初始化时保存的原书基准。其他条目、故事脉络和事件不会联动恢复。确定继续吗？')) return;
                    call(async () => { await controller.manual({ type: 'reset', id: entry.id, confirmed: true }); entryDrafts.delete(entry.id); editing = false; }, '此条已恢复为初始化基准');
                }, { danger: true }));
            parent.append(more);
        }
    }
    function renderPool(parent, entry) {
        let person = poolDrafts.get(entry.id);
        if (!person) { person = { title: '', intro: '', text: '', retrieveWhen: '' }; poolDrafts.set(entry.id, person); }
        const form = details('从路人里单独建档', `pool-${entry.id}`);
        form.append(h('p', 'dwm-muted', '原路人合集保持不变，之后可以手动编辑去掉重复的部分。'));
        for (const [key, label] of [['title', '人物名称'], ['intro', '一句话介绍'], ['text', '人物正文'], ['retrieveWhen', '什么时候发这条']]) form.append(field(label, person[key], value => { person[key] = value; }, { area: key !== 'title', key: `pool-${entry.id}-${key}` }).wrap);
        form.append(button('单独建档', () => call(async () => { await controller.manual({ type: 'promote-from-pool', id: entry.id, ...person }); poolDrafts.delete(entry.id); }, '人物已独立建档'))); parent.append(form);
    }

    /* ---------- dialogs ---------- */
    function renderDialog(view) {
        const back = h('div', 'dwm-modal-back');
        const box = h('div', 'dwm-modal'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
        const close = () => { dialog = null; transferDraft = null; render(); };
        const unavailable = !view.save?.initialized || Boolean(view.activity);
        if (dialog === 'export') {
            box.setAttribute('aria-label', '导出为世界书');
            box.append(h('h3', '', '导出为世界书'), h('p', 'dwm-muted', '把鱼忆改过的世界书存成一本新的酒馆世界书，故事脉络和物品也在里面。导入酒馆，绑给新聊天就能接着用。'));
            const foot = h('div', 'dwm-modal-foot');
            if (transferDownload) {
                const link = h('a', 'dwm-button dwm-primary', '下载世界书文件'); link.href = transferDownload.url; link.download = `${view.sourceBook || '鱼忆'} · 鱼忆.json`;
                foot.append(button('关闭', close, { navigation: true, ghost: true }), link);
            } else foot.append(button('取消', close, { navigation: true, ghost: true }), button('生成文件', () => call(() => {
                const book = controller.exportMemory(); clearTransferDownload();
                const api = doc.defaultView?.URL ?? globalThis.URL, BlobType = doc.defaultView?.Blob ?? globalThis.Blob;
                transferDownload = { api, url: api.createObjectURL(new BlobType([JSON.stringify(book, null, 2)], { type: 'application/json' })) };
            }, '文件已生成，点“下载世界书文件”保存'), { primary: true, disabled: unavailable }));
            box.append(foot);
        } else {
            box.setAttribute('aria-label', '导入旧总结');
            box.append(h('h3', '', '导入旧总结'), h('p', 'dwm-muted', '把以前写的总结加进这个存档，作为常驻资料。不换世界书，也不调用模型。'));
            const names = controller.supplementaryBooks?.() ?? [];
            if (!names.length) transferSource = 'file';
            if (names.length) box.append(segments([['book', '附加世界书'], ['file', '本地文件']], transferSource, id => { transferSource = id; transferDraft = null; render(); }, { key: 'import-source', small: true }));
            const saveId = view.save?.id, scopeId = view.save?.data?.scopeContext?.activeScopeId ?? 'global';
            if (transferSource === 'book' && names.length) {
                if (!names.includes(transferBook)) transferBook = names[0];
                box.append(row(selectField('附加世界书', transferBook, names.map(name => [name, name]), value => { transferBook = value; transferDraft = null; }).wrap,
                    button('读取', () => call(async () => {
                        const name = transferBook, result = await controller.readSupplementaryBook(name);
                        if (controller.view().save?.id !== saveId) throw new Error('存档已切换，请重新选择');
                        transferDraft = { ...result, saveId, scopeId, name, chosen: new Set(result.entries.map((_, i) => i)) };
                    }, '已读取，勾选要导入的条目'), { disabled: unavailable })));
                box.append(h('p', 'dwm-muted dwm-hint', '导入后这本附加世界书仍会被酒馆照常发送；不想重复，可以在酒馆里解除它的绑定。'));
            } else {
                const input = field('选择世界书 JSON 或 TXT 文件', '', () => {}, { type: 'file', key: 'supplement-file' });
                input.input.accept = '.json,.txt'; input.input.disabled = unavailable;
                input.input.addEventListener('change', () => {
                    const file = input.input.files?.[0]; if (!file) return;
                    call(async () => {
                        if (file.size > 10000000) throw new Error('文件过大，请选择小于 10 MB 的总结文件');
                        const result = parseSupplementaryMemory(await file.text(), { name: file.name.replace(/\.(json|txt)$/i, ''), json: /\.json$/i.test(file.name) });
                        if (controller.view().save?.id !== saveId) throw new Error('存档已切换，请重新选择文件');
                        transferDraft = { ...result, saveId, scopeId, name: file.name, chosen: new Set(result.entries.map((_, i) => i)) };
                    }, '已读取，勾选要导入的条目');
                });
                box.append(input.wrap);
            }
            if (transferDraft) {
                const draft = transferDraft, list = h('div', 'dwm-import-list');
                draft.entries.forEach((entry, index) => {
                    const item = h('label', 'dwm-import-item'), check = focusKey(h('input'), `import-${index}`); check.type = 'checkbox'; check.checked = draft.chosen.has(index);
                    check.addEventListener('change', () => { if (check.checked) draft.chosen.add(index); else draft.chosen.delete(index); render(); });
                    const copy = h('span'); copy.append(h('strong', '', entry.title), h('span', 'dwm-muted', `${entry.content.length.toLocaleString('zh-CN')} 字 · ${entry.content.slice(0, 40)}`));
                    item.append(check, copy); list.append(item);
                });
                for (const entry of draft.skipped) { const item = h('div', 'dwm-import-item dwm-dim'); item.append(h('span', '', `跳过：${entry.title}（${entry.reason}）`)); list.append(item); }
                box.append(list);
            }
            const chosen = transferDraft ? transferDraft.entries.filter((_, i) => transferDraft.chosen.has(i)) : [];
            const foot = h('div', 'dwm-modal-foot');
            foot.append(button('取消', close, { navigation: true, ghost: true }), button(chosen.length ? `导入 ${chosen.length} 条` : '导入', () => call(async () => {
                const draft = transferDraft;
                await controller.importSupplementaryMemory(chosen, draft.saveId, draft.scopeId); transferDraft = null; dialog = null;
            }, '已导入，设为常驻并受保护；同名同正文的重复条目已跳过'), { primary: true, disabled: unavailable || !chosen.length }));
            box.append(foot);
        }
        back.append(box); return back;
    }

    /* ---------- 本轮 ---------- */
    function renderRound(parent, view) {
        const page = h('div', 'dwm-page');
        const plan = view.diagnostics?.lastPlan;
        page.append(heading(plan ? '上一次发送用了哪些资料' : '本轮', button('试选一次', () => call(async () => {
            const result = await controller.previewPlan(); localPreview = { ...result, at: new Date().toISOString(), mode: 'preview' };
        }, '试选已完成'), { title: '会调用一次模型，只看结果，不发送正文', disabled: Boolean(view.activity) })));
        if (!plan) page.append(h('p', 'dwm-empty', '还没有发送记录。发一条消息后，这里会列出鱼忆这一轮挑了哪些资料。'));
        else renderPlan(page, plan, view, false);
        const preview = view.diagnostics?.lastPreview ?? localPreview;
        if (preview) { const result = details(`试选结果 · ${timeOf(preview.at)}`, 'last-preview'); renderPlan(result, preview, view, true); page.append(result); }
        parent.append(page);
    }
    function renderPlan(parent, plan, view, preview) {
        const entries = view.save?.data?.entries ?? {};
        const facts = [timeOf(plan.at), `${(plan.selectedIds ?? []).length} 条资料`];
        if (plan.entryChars !== undefined) facts.push(`${countOf(plan.entryChars)} 字`);
        parent.append(h('p', 'dwm-muted', `${preview ? '试选，没有发送 · ' : ''}${facts.join(' · ')}`));
        if (Number(plan.pendingCount) > 0) parent.append(h('p', 'dwm-warning', `当时有 ${plan.pendingCount} 条消息还没整理进记忆，它们的原文照常发送。`));
        const mandatory = new Set(plan.mandatoryIds ?? (plan.entries ?? []).filter(e => e.constant || e.important).map(e => e.id));
        const triggered = new Set((plan.triggeredIds ?? []).filter(id => !mandatory.has(id)));
        const groups = [['常驻', '每轮都发', id => mandatory.has(id)], ['关键词触发', '卡作者规则：出现关键词必发', id => triggered.has(id)], ['这一轮选入', '鱼忆按剧情挑的', id => !mandatory.has(id) && !triggered.has(id)]];
        for (const [name, why, test] of groups) {
            const ids = (plan.selectedIds ?? []).filter(test);
            if (!ids.length) continue;
            parent.append(h('h4', 'dwm-group-title', `${name} · ${ids.length} — ${why}`));
            const list = h('div', 'dwm-group dwm-plan-list');
            for (const id of ids) {
                const entry = entries[id] ?? plan.entries?.find(e => e.id === id);
                const item = entries[id] ? button('', () => openEntry(id), { navigation: true, key: `plan-${preview ? 'preview' : 'send'}-${id}`, className: 'dwm-plan-item' }) : h('div', 'dwm-plan-item');
                item.append(lamp(entries[id] ? tierOf(entries[id]) : 'off'), h('span', 'dwm-entry-title-text', entry?.title || id));
                if (entries[id]) item.append(...marks(entries[id])); else item.append(h('span', 'dwm-muted', '当前已无此条'));
                list.append(item);
            }
            parent.append(list);
        }
        if (!(plan.selectedIds ?? []).length) parent.append(h('p', 'dwm-muted', '这次没有选入动态条目。'));
        if ((plan.gatedIds ?? []).length) {
            const gated = details(`关键词没出现 · ${plan.gatedIds.length} 条没进目录`, `${preview ? 'preview' : 'plan'}-gated`);
            gated.append(h('p', 'dwm-muted', '卡作者规则：这些条目要等关键词出现，才允许选入。'),
                h('p', '', plan.gatedIds.map(id => (entries[id] ?? plan.entries?.find(e => e.id === id))?.title || id).join('、')));
            parent.append(gated);
        }
        const extras = [['故事脉络', plan.summary, 'summary'], ['我的物品', plan.inventory, 'inventory'], ['补充资料', plan.details, 'details']].filter(([, value]) => value);
        if (extras.length) {
            parent.append(h('h4', 'dwm-group-title', '一起发送'));
            for (const [name, value, key] of extras) { const item = details(`${name} · ${countOf(display(value).length)} 字`, `${preview ? 'preview' : 'plan'}-${key}`); item.append(prose(display(value))); parent.append(item); }
        }
        if (plan.mvu) { const item = details('参考的 MVU 信息', `${preview ? 'preview' : 'plan'}-mvu`); renderMvuState(item, plan.mvu); parent.append(item); }
        if (!preview) parent.append(h('p', 'dwm-muted dwm-hint', Array.isArray(plan.observedIds)
            ? `酒馆这一轮记录到 ${plan.observedIds.length} 条世界书激活。完整请求可在“记录 → 收发”里看。`
            : '这是鱼忆交给酒馆的资料；模型实际收到的完整请求可在“记录 → 收发”里看。'));
    }

    /* ---------- 记录 ---------- */
    function renderLog(parent, view) {
        const page = h('div', 'dwm-page');
        page.append(heading('记录', segments([['memory', '记忆改动'], ['traces', '收发']], logView, id => { logView = id; render(); }, { key: 'log-view', small: true })));
        if (logView === 'traces') {
            page.append(segments([['actual', '实际记录'], ['preview', '发送前预览']], diagnosticsMode, id => { diagnosticsMode = id; render(); }, { key: 'diagnostics-mode', small: true }));
            page.append(diagnosticsMode === 'preview' ? promptPreview.element : traceViewer.element);
            const requests = details('辅助请求概况', 'requests');
            requests.append(h('p', 'dwm-muted', '本次打开页面后的请求。字数用来比较规模，不是计费 token。'));
            const recent = [...(view.diagnostics?.requests ?? [])].reverse().slice(0, 30);
            for (const request of recent) {
                const item = h('div', 'dwm-request');
                item.append(row(h('strong', '', TASK_NAMES[request.task ?? request.purpose] ?? request.task ?? request.purpose ?? '辅助任务'), badge(request.ok ? '完成' : request.outcome === 'yielded' ? '已让出' : request.outcome === 'stopped' ? '已停止' : '未完成', request.ok ? '' : 'dwm-review-badge')),
                    h('p', 'dwm-muted', `${timeOf(request.at)} · ${Number.isFinite(request.durationMs) ? `${(request.durationMs / 1000).toFixed(1)} 秒` : '耗时未知'} · 输入 ${countOf(request.inputChars)} 字 · 输出 ${countOf(request.outputChars)} 字`));
                if (request.error) item.append(h('p', 'dwm-error', request.error)); requests.append(item);
            }
            if (!recent.length) requests.append(h('p', 'dwm-muted', '还没有请求。')); page.append(requests);
            parent.append(page); return;
        }
        if (!view.save?.initialized) { page.append(h('p', 'dwm-empty', '建立记忆后，这里会列出每次改动。收发记录现在就能看。')); parent.append(page); return; }
        page.append(row(button('补记新剧情', () => call(() => controller.maintain(), '补记完成'), { disabled: Boolean(view.activity) }),
            button('整理事件记忆', () => call(() => controller.compact(), '整理完成'), { ghost: true, disabled: Boolean(view.activity) }),
            h('span', 'dwm-muted dwm-hint', '只给你看，不会发给模型')));
        const records = [...(view.save?.audit ?? [])].reverse();
        if (!records.length) page.append(h('p', 'dwm-empty', '还没有改动记录。'));
        // One line per batch: same time and same cause.
        const batches = [];
        for (const record of records) {
            const last = batches.at(-1);
            if (last && last.at === record.at && last.reason === record.reason) last.items.push(record);
            else batches.push({ at: record.at, reason: record.reason, items: [record] });
        }
        const list = h('ol', 'dwm-timeline');
        for (const batch of batches.slice(0, 50)) {
            const item = h('li'), body = h('div');
            body.append(h('span', 'dwm-muted dwm-timeline-who', REASONS[batch.reason] ?? batch.reason ?? '资料更新'));
            const line = h('p', '', `改了 ${batch.items.length} 条：`);
            batch.items.slice(0, 6).forEach((record, index) => {
                const name = view.save?.data?.entries?.[record.entryId]?.title;
                if (index) line.append('、');
                line.append(name ? button(name, () => openEntry(record.entryId), { navigation: true, ghost: true, className: 'dwm-link-button', key: `audit-link-${record.id}` }) : h('span', 'dwm-muted', '已移除的条目'));
            });
            if (batch.items.length > 6) line.append(`等 ${batch.items.length} 条`);
            body.append(line);
            // Tier and protection changes leave the text as it was; there is nothing to compare.
            const changed = batch.items.filter(record => display(record.before) !== display(record.after));
            if (changed.length) {
                const diffs = details('看改了什么', `audit-${batch.items[0].id ?? `${batch.at}-${batch.reason}`}`);
                for (const record of changed.slice(0, 6)) diffs.append(auditRecord(record, view, true));
                body.append(diffs);
            }
            item.append(h('time', 'dwm-muted', timeOf(batch.at)), body); list.append(item);
        }
        page.append(list);
        if (batches.length > 50) page.append(h('p', 'dwm-muted', `显示最近 50 次，共 ${batches.length} 次。`));
        if (view.warnings?.length) {
            const warnings = details('兼容提示', 'compatibility-warnings');
            for (const warning of view.warnings) warnings.append(h('p', 'dwm-muted', warning.message ?? String(warning)));
            page.append(warnings);
        }
        parent.append(page);
    }
    function auditRecord(record, view, withName) {
        const wrap = h('div', 'dwm-audit');
        const name = view.save?.data?.entries?.[record.entryId]?.title;
        if (withName && name) wrap.append(h('strong', '', name));
        else if (!withName) wrap.append(h('span', 'dwm-muted dwm-hint', `${timeOf(record.at)} · ${REASONS[record.reason] ?? record.reason ?? '资料更新'}`));
        const diff = h('div', 'dwm-prose dwm-inline-diff');
        for (const part of diffText(display(record.before), display(record.after))) diff.append(h(part.type === 'remove' ? 'del' : part.type === 'add' ? 'ins' : 'span', '', part.text));
        wrap.append(diff);
        if (record.evidence?.length) wrap.append(h('p', 'dwm-muted dwm-hint', `依据：${record.evidence.join('、')}`));
        return wrap;
    }

    /* ---------- 设置 ---------- */
    function renderSettings(parent, view) {
        const layout = h('div', 'dwm-settings');
        const nav = h('nav', 'dwm-settings-nav'); nav.setAttribute('aria-label', '设置分组');
        for (const [id, name] of [['basic', '常用'], ['model', '辅助模型'], ['preset', '预设应用'], ['advanced', '高级']]) {
            const b = button(name, () => { settingsNav = id; render(); }, { navigation: true, key: `settings-${id}`, className: settingsNav === id ? 'dwm-active-tab' : '' });
            b.setAttribute('aria-current', String(settingsNav === id)); nav.append(b);
        }
        const page = h('div', 'dwm-page'); page.dataset.scroll = `settings-${settingsNav}`;
        if (settingsNav === 'basic') renderBasicSettings(page, view);
        else if (settingsNav === 'model') renderConnection(page, view);
        else if (settingsNav === 'preset') renderPresetApplication(page, view);
        else renderAdvanced(page, view);
        layout.append(nav, page); parent.append(layout);
    }
    function renderBasicSettings(page, view) {
        const current = view.settings ?? {};
        page.append(group(
            toggle('鱼忆总开关', Boolean(current.enabled), '关闭后所有存档暂停，已有资料保留', value => call(() => controller.updateSettings({ enabled: value }))),
            view.save ? toggle('这个存档使用记忆', view.saveEnabled !== false, '只影响当前存档', value => call(() => controller.setSaveEnabled(value))) : null));
        const worldbookOnly = current.memoryMode === 'worldbook';
        const savedEvery = current.maintenanceEvery ?? DEFAULT_SETTINGS.maintenanceEvery;
        const cadenceMode = cadenceDraft?.mode ?? ([1, 3, 5].includes(Number(savedEvery)) ? String(savedEvery) : 'custom');
        const saveCadence = value => call(async () => {
            const every = Number(value);
            if (!Number.isInteger(every) || every < 1 || every > MAINTENANCE_EVERY_MAX) throw new Error(`整理间隔请填写 1–${MAINTENANCE_EVERY_MAX} 的整数（按 AI 回复计数）。`);
            await controller.updateSettings({ maintenanceEvery: every }); cadenceDraft = null;
        }, `已改为每 ${value} 次 AI 回复整理一次`);
        const cadenceControls = [segments([['1', '1'], ['3', '3'], ['5', '5'], ['custom', '自定义']], cadenceMode, id => {
            if (id === 'custom') { cadenceDraft = { mode: 'custom', value: savedEvery }; render(); } else saveCadence(id);
        }, { key: 'cadence', small: true, label: '整理间隔' })];
        if (cadenceMode === 'custom') {
            const custom = focusKey(h('input', 'dwm-number'), 'cadence-custom'); custom.type = 'number'; custom.min = '1'; custom.max = String(MAINTENANCE_EVERY_MAX); custom.value = cadenceDraft?.value ?? savedEvery;
            custom.setAttribute('aria-label', '自定义间隔'); custom.addEventListener('input', () => { cadenceDraft = { mode: 'custom', value: custom.value }; });
            cadenceControls.push(custom, button('保存', () => saveCadence(cadenceDraft?.value ?? custom.value)));
        }
        const keep = focusKey(h('input', 'dwm-number'), 'recent-turns'); keep.type = 'number'; keep.min = '1'; keep.max = '1000'; keep.value = recentTurnsDraft ?? current.recentTurns ?? 12;
        keep.setAttribute('aria-label', '保留最近几轮'); keep.addEventListener('input', () => { recentTurnsDraft = keep.value; });
        keep.addEventListener('change', () => call(async () => { await controller.updateSettings({ recentTurns: Number(keep.value) }); recentTurnsDraft = null; }, `已改为保留最近 ${keep.value} 轮`));
        const windowSwitch = toggle('省略已记住的旧原文', Boolean(current.windowEnabled), '', value => call(() => controller.updateSettings({ windowEnabled: value }))).switchControl;
        page.append(group(
            setting('记什么', segments([['full', '完整记忆'], ['worldbook', '仅世界书']], worldbookOnly ? 'worldbook' : 'full',
                value => call(() => controller.updateSettings({ memoryMode: value }), value === 'worldbook' ? '已切换为仅动态世界书' : '已切换为完整记忆'), { key: 'memory-mode', small: true }),
            { helpKey: 'scope', helpText: '“仅世界书”只更新已有条目并按需挑选，不写故事脉络、事件和物品，也不省略旧原文。已有资料保留，随时可以切回。' }),
            setting('多久整理一次', cadenceControls, { description: `每 ${savedEvery} 次 AI 回复`, helpKey: 'every',
                helpText: '按 AI 回复计数，你的发言不算。间隔越大越省，记忆更新越晚；待整理的文字太多时会提前整理。发送前挑资料仍然每轮都做。' }),
            worldbookOnly ? null : setting('故事脉络写法', segments([['append', '追加'], ['rewrite', '整段重写']], (current.summaryMode ?? DEFAULT_SETTINGS.summaryMode) === 'rewrite' ? 'rewrite' : 'append',
                value => call(() => controller.updateSettings({ summaryMode: value }), value === 'rewrite' ? '已改为整段重写，从下一次整理生效' : '已改为追加，从下一次整理生效'), { key: 'summary-mode', small: true }),
            { helpKey: 'summary', helpText: '追加：每次只写新增的一小段，更快更省，超过 8000 字时自动整理成连贯概述。整段重写：读起来始终连贯，但长聊天会明显变慢、更费 token。' }),
            setting('省略已记住的旧原文', [keep, h('span', 'dwm-muted dwm-hint', '轮'), windowSwitch],
                { description: `保留最近 ${current.recentTurns ?? 12} 轮完整对话${Number.isInteger(view.window?.omittedCount) ? ` · 上一轮省略了 ${view.window.omittedCount} 条` : ''}`, helpKey: 'window',
                    helpText: '只在发送时省掉已经整理进记忆的旧原文，聊天记录不删。和其他自动隐藏楼层的工具只开一个。' }),
            view.save?.initialized ? toggle('记录我的物品', view.save.data.inventoryEnabled, '卡自带背包系统时可以关掉', value => call(() => controller.manual({ type: 'inventory-toggle', enabled: value }))) : null));
        if (appearance) {
            const dock = appearance.dock();
            page.append(group(
                setting('收起后的气泡', [segments([['compact', '小图标'], ['full', '带文字']], dock.size, value => { appearance.setDock({ size: value }); render(); }, { key: 'bubble-size', small: true }),
                    segments([['left', '靠左'], ['right', '靠右']], dock.edge, value => { appearance.setDock({ edge: value }); render(); }, { key: 'bubble-edge', small: true })],
                { description: '也可以直接拖动气泡' })));
        }
    }
    function renderAdvanced(page, view) {
        const current = view.settings ?? {};
        page.append(group(
            setting('同时扫描几批', segments([['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['6', '6']], String(current.scanConcurrency ?? DEFAULT_SETTINGS.scanConcurrency),
                value => call(() => controller.updateSettings({ scanConcurrency: Number(value) }), '扫描速度已保存'), { key: 'concurrency', small: true }), { description: '遇到限流报错时调回 1' }),
            setting('辅助任务思考强度', segments([['low', '低'], ['medium', '中'], ['high', '高'], ['auto', '自动'], ['inherit', '跟酒馆']], current.auxReasoningEffort ?? DEFAULT_SETTINGS.auxReasoningEffort,
                value => call(() => controller.updateSettings({ auxReasoningEffort: value }), '思考强度已保存'), { key: 'effort', small: true }),
            { description: '只影响鱼忆的请求，思考越多越慢、越贵', helpKey: 'effort', helpText: '扫描、挑资料和整理用不着深度思考。模型不支持调节时此项不起作用。' }),
            timeoutSetting(current)));
        page.append(group(renderMvu(view), ruleTool(), worldbookTool(view)));
        const rescan = setting('重新扫描整个存档', button(view.save?.initialized ? '重新扫描…' : '初始化存档', () => initialize(view), { danger: true, disabled: !view.save || Boolean(view.activity) }),
            { description: '成功后替换全部动态资料，包括你改过的内容；失败则保留原来的结果。先备份。' });
        page.append(group(rescan));
    }
    function timeoutSetting(current) {
        const values = timeoutDraft ?? Object.fromEntries(['initializationTimeoutMs', 'timeoutMs'].map(key => [key, current[key] ?? DEFAULT_SETTINGS[key]]));
        const controls = [];
        for (const [key, label] of [['initializationTimeoutMs', '扫描与整理'], ['timeoutMs', '发送前挑资料']]) {
            const options = [1, 3, 5, 10, 15, 30, 60, 120, 360, 1440].map(minutes => [String(minutes * 60000), `${label} · ${minutes >= 60 ? `${minutes / 60} 小时` : `${minutes} 分钟`}`]);
            options.push(['0', `${label} · 不限时`]);
            if (!options.some(([value]) => Number(value) === values[key])) options.unshift([String(values[key]), `${label} · ${values[key] / 1000} 秒`]);
            const control = selectField(label, String(values[key]), options, value => { timeoutDraft = { ...values, ...timeoutDraft, [key]: Number(value) }; }, key);
            control.input.disabled = busy; control.wrap.classList.add('dwm-compact-field'); controls.push(control.wrap);
        }
        controls.push(button('保存', () => call(async () => { await controller.updateSettings(timeoutDraft ?? values); timeoutDraft = null; }, '等待时间已保存，从下一次辅助请求生效'), { ghost: true }));
        return setting('等待时间', controls, { helpKey: 'timeout', helpText: '每次请求单独计时，长聊天会分批处理。选不限时只关闭鱼忆自己的计时，酒馆、代理或模型服务仍可能提前结束请求。' });
    }
    function renderPresetApplication(page, view) {
        const preset = view.presetApplication ?? { entries: [] };
        const draft = preset.draft?.fingerprint === preset.fingerprint ? preset.draft : null;
        const key = `${view.chatId ?? ''}:${view.save?.id ?? ''}:${preset.fingerprint}:${draft?.id ?? 'saved'}`;
        if (applicationKey !== key) {
            applicationKey = key;
            applicationSelection = new Set(draft?.selectedIds ?? (preset.stale ? [] : preset.saved?.selectedIds) ?? []);
            applicationPositions = { ...(preset.stale ? {} : preset.saved?.positions ?? {}) };
        }
        const disabled = !view.save || Boolean(view.activity);
        page.append(heading('预设应用', h('span', 'dwm-muted', `${preset.name || '当前预设不可读取'} · 已应用 ${preset.stale ? 0 : preset.saved?.selectedIds?.length ?? 0} 条`)));
        page.append(h('p', 'dwm-muted', '挑几条预设内容，一起交给鱼忆的辅助请求，比如文风、术语。只影响这个存档里鱼忆的请求，不改酒馆正文的预设。'), helpButton('preset'));
        if (help.has('preset')) page.append(h('p', 'dwm-helptext', '“放前面”在鱼忆的任务之前，“放最后”在任务输入之后、整个请求的最后，默认沿用预设本身的位置。放最后的条目离输出最近，若要求写正文或改变输出格式，可能让辅助任务失败。条目越多，每次辅助请求越贵。'));
        if (preset.stale) page.append(h('p', 'dwm-warning', '原预设已变化，旧选择暂停应用。请重新检查并应用。'));
        if (!preset.saved && view.preset?.saved?.selected?.length) page.append(h('p', 'dwm-muted', '旧版已确认的语言偏好仍生效；应用这里的选择后会替换旧偏好。'));
        if (!preset.entries.length) { page.append(h('p', 'dwm-empty', '当前没有可读取的聊天补全预设文本条目。不影响使用鱼忆。')); return; }
        if (draft) page.append(h('p', 'dwm-notice', '已生成推荐，可以继续调整，点“应用”后生效。'));
        const list = h('div', 'dwm-group');
        for (const entry of preset.entries) {
            const on = applicationSelection.has(entry.id);
            const recommended = draft ? (draft.selectedIds.includes(entry.id) ? ' · 推荐开' : ' · 推荐关') : '';
            const position = applicationPositions[entry.id] ?? entry.position ?? 'head';
            const sw = toggle(entry.title, on, `原预设：${entry.enabled ? '开' : '关'}${recommended}`, value => { if (value) applicationSelection.add(entry.id); else applicationSelection.delete(entry.id); render(); }, disabled);
            const controlArea = h('div', 'dwm-setting-control');
            if (on) controlArea.append(segments([['head', '放前面'], ['tail', '放最后']], position, value => {
                if (value === entry.position) delete applicationPositions[entry.id]; else applicationPositions[entry.id] = value; render();
            }, { key: `preset-position-${entry.id}`, small: true }));
            controlArea.append(sw.switchControl); sw.append(controlArea);
            const source = details('原文', `preset-entry-${entry.id}`, 'dwm-disclosure dwm-inline-disclosure'); source.append(h('pre', 'dwm-preset-source', entry.content));
            sw.labelBox.append(source); list.append(sw);
        }
        page.append(list);
        page.append(row(button('沿用原预设开关', () => { applicationSelection = new Set(preset.entries.filter(e => e.enabled).map(e => e.id)); render(); }, { disabled, ghost: true }),
            button('全部关闭', () => { applicationSelection = new Set(); render(); }, { disabled, ghost: true }),
            button('让模型推荐', () => call(() => controller.scanPresetApplication()), { disabled, title: '会调用一次模型' }),
            button('应用', () => call(async () => {
                await controller.savePresetApplication([...applicationSelection], preset.fingerprint,
                    Object.fromEntries(Object.entries(applicationPositions).filter(([id]) => applicationSelection.has(id))));
                applicationKey = null;
            }, '已应用，可在“记录 → 收发”核对实际请求'), { primary: true, disabled })));
    }
    function renderConnection(page, view) {
        if (view.connectionMode === 'test') { page.append(h('p', 'dwm-notice', '演示模式：当前使用模拟模型，没有真实 API 请求。')); return; }
        const profiles = view.connectionProfiles ?? [], active = profiles.find(p => p.active);
        const live = view.connectionMode === 'compatible' ? (active ? `profile:${active.name}` : 'current') : 'raw';
        const choice = connectionChoice ?? live;
        const running = Boolean(view.activity);
        const options = [['raw', '沿用酒馆连接'], ...(live === 'current' ? [['current', `单独接口 · ${view.connection?.model || '未命名'}`]] : []),
            ...profiles.map(p => [`profile:${p.name}`, `${p.name} · ${p.model}`]), ['new', '＋ 新建单独接口…']];
        const picker = selectField('使用的连接', choice, options, value => {
            profileNameDraft = '';
            if (value === 'raw') { connectionChoice = null; call(() => controller.updateConnection({ mode: 'raw' }), '已改为沿用酒馆连接'); return; }
            if (value.startsWith('profile:')) { connectionChoice = null; call(() => controller.useConnectionProfile(value.slice(8))); return; }
            connectionChoice = value === live ? null : value; render();
        }, 'connection-choice');
        picker.input.disabled = busy || running; picker.input.setAttribute('aria-label', '使用的连接');
        page.append(group(setting('使用的连接', picker.input, { description: '扫描、挑资料和整理都走这里' })));
        if (running) page.append(h('p', 'dwm-muted', '任务正在运行，切换连接前请先停止或等它完成。'));
        if (choice === 'raw') { page.append(h('p', 'dwm-muted', '和酒馆正文用同一个连接，不用另外配置。想让鱼忆用更便宜的模型，就新建一个单独接口。')); return; }
        const editingName = choice.startsWith('profile:') ? choice.slice(8) : '';
        const creating = choice === 'new';
        // Refill the form whenever the connection it shows changes, never while typing
        // or on a background refresh. The profile name tells apart two profiles
        // with the same address and model, so one's unsaved key never reaches the other.
        const draftKey = creating ? 'new' : JSON.stringify([live, view.connection?.endpoint, view.connection?.model, view.connection?.maxOutputTokens]);
        if (draftKey !== connectionDraftKey) {
            connectionDraftKey = draftKey;
            Object.assign(connectionDraft, creating ? { endpoint: '', model: '', apiKey: '', maxOutputTokens: '' }
                : { endpoint: view.connection?.endpoint ?? '', model: view.connection?.model ?? '', apiKey: '', maxOutputTokens: view.connection?.maxOutputTokens ?? '' });
        }
        const form = h('div', 'dwm-group dwm-form');
        if (creating || choice === 'current') form.append(field('配置名称', profileNameDraft, value => { profileNameDraft = value; }, { placeholder: '例如：DS 便宜档', key: 'profile-name', hint: creating ? '起个名字，以后可以一键切换回来。' : '起个名字保存下来，以后可以一键切换。留空就只用这一次。' }).wrap);
        form.append(field('接口地址', connectionDraft.endpoint, value => { connectionDraft.endpoint = value; }, { placeholder: 'https://…/v1', hint: '鱼忆会在后面加上 /chat/completions。' }).wrap,
            field('密钥', connectionDraft.apiKey, value => { connectionDraft.apiKey = value; }, { type: 'password', hint: !creating && view.connection?.hasApiKey ? '已保存密钥；地址不变时留空就继续用。换地址要重新填。' : '只存在这个浏览器。' }).wrap);
        const model = field('模型', connectionDraft.model, value => { connectionDraft.model = value; }, { key: 'model-name' });
        const fetchButton = button('获取模型列表', () => call(() => controller.fetchModels({ endpoint: connectionDraft.endpoint, apiKey: connectionDraft.apiKey }), '已获取模型列表'), { ghost: true });
        model.wrap.append(fetchButton); form.append(model.wrap);
        const listed = view.modelList?.endpoint === connectionDraft.endpoint.trim().replace(/\/$/, '') ? view.modelList.models : [];
        if (listed.length) form.append(selectField('从列表选择', listed.includes(connectionDraft.model) ? connectionDraft.model : '',
            [['', `共 ${listed.length} 个模型，选一个填入`], ...listed.map(id => [id, id])], value => { if (value) { connectionDraft.model = value; render(); } }, 'model-list').wrap);
        form.append(field('输出上限（可留空）', connectionDraft.maxOutputTokens, value => { connectionDraft.maxOutputTokens = value; }, { type: 'number', placeholder: '留空 = 服务商默认', hint: '思考型模型被截断时可以调大，比如 32768。更大的额度可能更贵。' }).wrap);
        const actions = h('div', 'dwm-row dwm-form-actions');
        if (editingName) actions.append(button('删除这套', () => {
            if (doc.defaultView?.confirm && !doc.defaultView.confirm(`删除配置「${editingName}」？当前生效的连接不受影响，密钥需重新填写才能再用。`)) return;
            call(() => controller.deleteConnectionProfile(editingName));
        }, { danger: true, ghost: true, key: `profile-delete-${editingName}` }));
        actions.append(button(creating ? '保存并使用' : '应用连接', () => call(async () => {
            const name = (editingName || profileNameDraft).trim();
            await controller.updateConnection({ mode: 'compatible', endpoint: connectionDraft.endpoint.trim(), model: connectionDraft.model.trim(), apiKey: connectionDraft.apiKey, maxOutputTokens: connectionDraft.maxOutputTokens });
            if (name) await controller.saveConnectionProfile(name);
            connectionDraft.apiKey = ''; connectionChoice = null; profileNameDraft = '';
            return { executed: true, message: name ? `已保存并使用「${name}」` : '连接已应用；下一次辅助任务将使用此连接' };
        }), { primary: true, disabled: running }));
        form.append(actions); page.append(form);
        page.append(h('p', 'dwm-muted dwm-hint', '连接和密钥只存在这个浏览器，不进存档、不进问题报告。点“应用”不代表已经测通。'));
    }
    function renderMvuState(parent, state = {}) {
        parent.append(h('p', 'dwm-muted', state.reason || state.status || (state.available ? '已检测到可用接口' : '尚未检测到可用 MVU 信息')));
        if (state.messageId !== undefined && state.messageId !== null) parent.append(h('p', 'dwm-muted', `来源楼层 ${state.messageId} · 回复 ${state.swipeId ?? '—'}`));
        if (state.fields?.length) {
            const list = h('dl', 'dwm-variable-list');
            for (const item of state.fields) { list.append(h('dt', '', item.label || item.path), h('dd', '', display(item.value))); }
            parent.append(list);
        }
    }
    function renderMvu(view) {
        const current = view.settings ?? {}, state = view.mvu ?? {};
        const wrap = h('div', 'dwm-setting dwm-setting-stack');
        const line = toggle('MVU 变量', Boolean(current.mvuEnabled), '读取卡里的几个变量帮助挑资料，只读不改', value => call(() => controller.updateSettings({ mvuEnabled: value })));
        wrap.append(line);
        const fieldsPanel = details('选择读取的字段', 'mvu-fields');
        renderMvuState(fieldsPanel, state);
        fieldsPanel.append(h('p', 'dwm-muted', `路径从 stat_data 内部开始，用点号分隔，最多 16 个。保存后绑定到当前世界书「${view.sourceBook || '尚未选择'}」。`));
        const fields = mvuDraft ?? (current.mvuFields ?? []).map(item => ({ ...item }));
        const rows = h('div', 'dwm-mvu-fields');
        fields.forEach((item, index) => {
            const fieldRow = h('div', 'dwm-mvu-field');
            fieldRow.append(field(`字段 ${index + 1} · 含义`, item.label, value => { mvuDraft = fields; item.label = value; }, { key: `mvu-label-${index}`, placeholder: '例如：当前地点' }).wrap,
                field(`字段 ${index + 1} · 路径`, item.path, value => { mvuDraft = fields; item.path = value; }, { key: `mvu-path-${index}`, placeholder: '世界.当前地点' }).wrap,
                button('移除', () => { mvuDraft = fields.filter((_, i) => i !== index); render(); }, { navigation: true, ghost: true, key: `mvu-remove-${index}` })); rows.append(fieldRow);
        }); fieldsPanel.append(rows);
        fieldsPanel.append(row(button('添加字段', () => { mvuDraft = [...fields, { label: '', path: '' }]; render(); }, { navigation: true, ghost: true, disabled: fields.length >= 16 }), button('保存字段', () => call(async () => {
            await controller.updateSettings({ mvuFields: fields.map(item => ({ label: item.label.trim(), path: item.path.trim() })) }); mvuDraft = null;
        })), typeof controller.refreshMvu === 'function' ? button('重新读取', () => call(() => controller.refreshMvu(), '已重新检查 MVU 信息'), { ghost: true }) : null));
        wrap.append(fieldsPanel); return wrap;
    }
    function worldbookTool(view) {
        const wrap = h('div', 'dwm-setting dwm-setting-stack');
        const box = details('世界书检查', 'worldbook-check'); renderWorldbookCheck(box, view); wrap.append(box); return wrap;
    }
    function ruleTool() {
        const wrap = h('div', 'dwm-setting dwm-setting-stack');
        const parent = details('作者规则工具', 'author-tools');
        parent.append(h('p', 'dwm-muted', '给卡作者用：生成后复制到角色主世界书里标题为 [DWM Rules] 的条目。本工具不会改写原书。'));
        parent.append(field('自然语言要求', ruleNL, value => { ruleNL = value; }, { area: true, key: 'rule-nl' }).wrap,
            field('规则脚本', ruleScript, value => { ruleScript = value; }, { area: true, key: 'rule-script', placeholder: 'when title contains "变量" => lock;' }).wrap);
        const form = h('div', 'dwm-rule-form');
        form.append(selectField('匹配字段', ruleMatch.field, [['title', '条目名称'], ['id', '条目身份'], ['kind', '条目类型'], ['constant', '是否蓝灯'], ['sourceUID', '原书条目编号']], value => { ruleMatch.field = value; }).wrap,
            selectField('条件', ruleMatch.op, [['contains', '包含'], ['==', '等于'], ['!=', '不等于']], value => { ruleMatch.op = value; }).wrap,
            field('匹配值', ruleMatch.value, value => { ruleMatch.value = value; }, { key: 'rule-value' }).wrap,
            selectField('执行动作', ruleMatch.action, [['lock', '锁定维护'], ['maxChars', '限制长度'], ['always', '始终选入'], ['trigger', '关键词出现时必发'], ['gate', '关键词出现才可选']], value => { ruleMatch.action = value; render(); }).wrap);
        if (ruleMatch.action === 'maxChars') form.append(field('长度上限', ruleMatch.limit, value => { ruleMatch.limit = value; }, { type: 'number', key: 'rule-limit' }).wrap);
        parent.append(form, button('加入脚本', () => {
            try {
                if (ruleMatch.field === 'constant' && !['true', 'false'].includes(ruleMatch.value)) throw new Error('是否蓝灯请填写 true 或 false');
                const value = ruleMatch.field === 'constant' ? ruleMatch.value === 'true' : ruleMatch.value;
                ruleScript = [ruleScript.trim(), formToScript({ field: ruleMatch.field, operator: ruleMatch.op, value, action: ruleMatch.action, maxChars: Number(ruleMatch.limit) })].filter(Boolean).join('\n');
                localError = ''; notice = '已加入规则'; render();
            } catch (error) { localError = error.message; render(); }
        }, { ghost: true }));
        parent.append(row(button('校验并生成条目', () => {
            try { compileRules(ruleScript); ruleOutput = buildRuleDocument({ naturalLanguage: ruleNL, script: ruleScript }); localError = ''; notice = '规则格式有效'; render(); }
            catch (error) { localError = error.message; render(); }
        }), button('复制规则条目', () => call(async () => {
            compileRules(ruleScript);
            ruleOutput = buildRuleDocument({ naturalLanguage: ruleNL, script: ruleScript });
            if (!doc.defaultView?.navigator?.clipboard?.writeText) throw new Error('当前环境不能自动复制，请从下方手动复制。');
            await doc.defaultView.navigator.clipboard.writeText(ruleOutput);
        }, '规则已复制'), { ghost: true })));
        if (ruleOutput) { const output = field('生成的世界书规则条目', ruleOutput, () => {}, { area: true, key: 'rule-output' }); output.input.readOnly = true; parent.append(output.wrap); }
        wrap.append(parent); return wrap;
    }

    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => { composing = false; if (queuedRender) { queuedRender = false; render(); } };
    const onKeydown = event => {
        if (event.key !== 'Escape' || !(tierMenu || moreMenu || dialog)) return;
        event.preventDefault(); event.stopPropagation(); tierMenu = null; moreMenu = false; dialog = null; transferDraft = null; render();
    };
    container.addEventListener('compositionstart', onCompositionStart);
    container.addEventListener('compositionend', onCompositionEnd);
    container.addEventListener('keydown', onKeydown);
    const unsubscribe = controller.subscribe?.(() => render()) ?? (() => {});
    render();
    return { render, destroy() {
        if (destroyed) return;
        destroyed = true; clearTransferDownload(); unsubscribe(); traceViewer.destroy(); promptPreview.destroy(); activityIndicator.destroy();
        container.removeEventListener('compositionstart', onCompositionStart); container.removeEventListener('compositionend', onCompositionEnd); container.removeEventListener('keydown', onKeydown);
        container.replaceChildren(); statusSlot?.replaceChildren(); if (titleSlot) titleSlot.textContent = '';
    } };
}
