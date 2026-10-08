import { preferenceLabel } from '../agents/preset-preferences.js';
import { buildRuleDocument, compileRules, formToScript } from '../rules/index.js';
import { diffText } from './diff.js';
import { createTraceViewer } from './trace-viewer.js';
import { createPromptPreview } from './prompt-preview.js';
import { createActivityIndicator } from './activity.js';

const KIND_NAMES = { fact: '世界资料', rule: '规则', npc: '人物', npc_pool: '路人', event: '事件', inventory: '物品' };
const TASK_NAMES = { initialize: '扫描世界书', strategy: '统合记忆策略', maintain: '维护记忆', select: '本轮选材', compact: '整理事件' };
let panelSequence = 0;
const textOf = entry => (entry?.segments ?? []).map(segment => segment.text).join('');
const display = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
const timeOf = value => {
    if (!value) return '尚无时间记录';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
};
const countOf = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—';

export function mountPanel(container, controller, { exportProblem } = {}) {
    if (!container?.ownerDocument) throw new TypeError('需要可挂载的容器');
    const doc = container.ownerDocument;
    const traceViewer = createTraceViewer(doc, controller.traces, { exportProblem });
    const promptPreview = createPromptPreview(doc, controller);
    const activityIndicator = createActivityIndicator(doc, { onStop: id => cancelTask(id),
        onRecover: kind => call(() => kind === 'initialize' ? controller.initialize() : controller.maintain()) });
    let diagnosticsMode = 'actual';
    const panelId = `dwm-workspace-${++panelSequence}`;
    let selected = null, search = '', kindFilter = '', sectionFilter = 'entries', tab = 'library';
    let localError = '', notice = '', busy = false, destroyed = false, cancelRequested = false;
    let mobileDetail = false, entryMode = 'read', visibleCount = 80, composing = false, queuedRender = false;
    let ruleNL = '', ruleScript = '', ruleOutput = '', ruleMatch = { field: 'title', op: 'contains', value: '', action: 'lock', limit: '' };
    let recentTurnsDraft = null, mvuDraft = null, connectionModeDraft = null, lastSaveId = null;
    let localPreview = null, presetSelection = new Set(), presetDraftKey = null, scanPresetWithInitialization = true;
    const entryDrafts = new Map(), poolDrafts = new Map(), expanded = new Set(), scrollPositions = new Map();
    const connectionDraft = { endpoint: '', model: '', apiKey: '' };
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
    const button = (label, action, { primary = false, danger = false, disabled = false, navigation = false, key = label, className = '' } = {}) => {
        const b = focusKey(h('button', `dwm-button ${primary ? 'dwm-primary' : ''} ${danger ? 'dwm-danger' : ''} ${className}`, label), key);
        b.type = 'button'; b.disabled = disabled || (!navigation && busy);
        b.addEventListener('click', action);
        return b;
    };
    const row = (...children) => { const el = h('div', 'dwm-row'); el.append(...children); return el; };
    const card = (title, description = '') => {
        const el = h('section', 'dwm-card'); el.append(h('h3', '', title));
        if (description) el.append(h('p', 'dwm-muted', description));
        return el;
    };
    const prose = (text, empty = '暂无记录。') => h('div', 'dwm-prose', text || empty);
    const badge = (text, className = '') => h('span', `dwm-badge ${className}`, text);
    function details(title, key) {
        const el = h('details', 'dwm-disclosure');
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
    function toggle(label, checked, description, onChange, disabled = false) {
        const wrap = h('label', 'dwm-toggle');
        const input = focusKey(h('input'), label); input.type = 'checkbox'; input.checked = checked; input.disabled = disabled || busy;
        const content = h('span'); content.append(h('strong', '', label));
        if (description) content.append(h('span', 'dwm-muted', description));
        input.addEventListener('change', () => onChange(input.checked)); wrap.append(input, content); return wrap;
    }
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
        call(async () => {
            if (scanPresetWithInitialization && view.preset?.available && !view.preset?.saved) await controller.scanPreset();
            return controller.initialize();
        }, '存档扫描已完成');
    }
    function progressText(progress) {
        if (typeof progress === 'string') return progress;
        const stage = typeof progress?.stage === 'string' ? progress.stage : '正在处理';
        const done = Number(progress?.done), total = Number(progress?.total);
        return Number.isFinite(done) && Number.isFinite(total) && total > 0 ? `${stage} · ${Math.max(0, done)} / ${total}` : stage;
    }
    function navigate(nextTab) { tab = nextTab; localError = ''; notice = ''; render(); }
    function openEntry(id) {
        if (tab !== 'library' || sectionFilter !== 'entries') { search = ''; kindFilter = ''; visibleCount = 80; }
        selected = id; sectionFilter = 'entries'; mobileDetail = true; entryMode = 'read'; tab = 'library'; render(); focusDetail();
    }
    function focusDetail() { container.querySelector('[data-detail-heading]')?.focus({ preventScroll: true }); }
    function captureInteraction() {
        const active = container.contains(doc.activeElement) ? doc.activeElement : null;
        for (const el of container.querySelectorAll('[data-scroll]')) scrollPositions.set(el.dataset.scroll, [el.scrollTop, el.scrollLeft]);
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
    function render() {
        if (destroyed) return;
        if (composing) { queuedRender = true; return; }
        const interaction = captureInteraction();
        let view;
        try { view = controller.view(); }
        catch (error) { container.replaceChildren(h('p', 'dwm-error', error?.message || '无法读取当前状态')); return; }
        if (lastSaveId !== (view.save?.id ?? null)) {
            lastSaveId = view.save?.id ?? null; selected = null; mobileDetail = false; entryMode = 'read'; localPreview = null;
            entryDrafts.clear(); poolDrafts.clear(); scrollPositions.clear();
        }
        promptPreview.setContext(`${view.save?.id ?? ''}:${view.sourceBook ?? ''}`);
        const root = h('div', 'dwm-panel');
        const shell = h('div', 'dwm-shell');
        const heading = h('header', 'dwm-head');
        const brand = h('div', 'dwm-brand');
        const mark = h('span', 'dwm-brand-mark', '鱼'); mark.setAttribute('aria-hidden', 'true');
        const name = h('div'); name.append(h('h2', '', '鱼忆'), h('p', '', '动态世界书与记忆')); brand.append(mark, name);
        const identity = h('div', 'dwm-save-identity');
        identity.append(h('strong', '', view.sourceBook || '尚未打开角色存档'), h('span', 'dwm-muted', view.save ? `此存档独立保存 · 已记入 ${countOf(view.save.processedCount)} 条消息` : '从角色聊天开始'));
        heading.append(brand, identity); shell.append(heading);
        const state = h('div', 'dwm-statebar'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite'); state.setAttribute('aria-atomic', 'true');
        const pending = view.diagnostics?.pendingCount ?? view.diagnostics?.memory?.pendingCount;
        state.append(h('span', `dwm-status-dot ${view.error ? 'dwm-status-error' : ''}`), h('strong', '', view.status || (view.save?.initialized ? '已就绪' : '等待初始化')));
        if (view.progress) state.append(h('span', 'dwm-muted', progressText(view.progress)));
        else if (!view.settings?.enabled) state.append(h('span', 'dwm-warning', '插件总开关已关闭'), button('打开总开关', () => call(() => controller.updateSettings({ enabled: true }))));
        else if (view.save?.initialized && view.saveEnabled === false) state.append(h('span', 'dwm-warning', '此存档记忆已暂停'), button('启用此存档', () => call(() => controller.setSaveEnabled(true))));
        else if (Number(pending) > 0) state.append(h('span', 'dwm-muted', `${pending} 条消息${view.save?.initialized ? '待补记 · 原文仍保留' : '尚未建立记忆'}`));
        else if (view.save?.initialized) state.append(h('span', 'dwm-muted', '此存档记忆已启用'));
        if (view.autoPostPaused && !view.activity) state.append(h('span', 'dwm-muted', '自动整理暂歇，下一条回复后恢复'), button('立即补记', () => call(() => controller.maintain())));
        // All task cancellation comes from the runtime's actual activity. Do not
        // offer cancellation for a UI-only "busy" flag during an atomic save.
        activityIndicator.render(view);
        shell.append(state);
        if (view.activity) shell.append(activityIndicator.element);
        const nav = h('nav', 'dwm-tabs'); nav.setAttribute('aria-label', '鱼忆工作台'); nav.setAttribute('role', 'tablist');
        const tabs = [['library', '资料'], ['round', '本轮'], ['activity', '维护与记录'], ['settings', '设置'], ['traces', '收发']];
        tabs.forEach(([id, title], index) => {
            const b = button(title, () => navigate(id), { navigation: true, key: `tab-${id}`, className: tab === id ? 'dwm-active-tab' : '' });
            b.id = `${panelId}-tab-${id}`; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(tab === id)); b.setAttribute('aria-controls', `${panelId}-content`); b.tabIndex = tab === id ? 0 : -1;
            b.addEventListener('keydown', event => {
                const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
                if (next < 0) return;
                event.preventDefault(); navigate(tabs[next][0]); container.querySelector(`#${panelId}-tab-${tabs[next][0]}`)?.focus();
            }); nav.append(b);
        }); shell.append(nav);
        const feedback = h('div', 'dwm-feedback');
        if (localError) { const error = h('p', 'dwm-error', localError); error.setAttribute('role', 'alert'); feedback.append(error); }
        if (view.error) { const error = details('技术信息', 'task-error'); error.append(prose(view.error)); feedback.append(error); if (view.save?.initialized && /记忆待补齐|正在维护|补记/.test(view.status)) feedback.append(button('重试补记', () => call(() => controller.maintain()))); }
        if (notice) { const success = h('p', 'dwm-notice', notice); success.setAttribute('role', 'status'); feedback.append(success); }
        if (view.sourceChanges?.changed) {
            const changes = view.sourceChanges;
            const warning = h('p', 'dwm-warning', `主世界书已变化：新增 ${changes.added.length} 条、修改 ${changes.updated.length} 条、删除 ${changes.removed.length} 条。当前动态资料仍以本档初始化时的旧书为基准。请先用酒馆导出聊天 JSONL 备份，再到设置重新扫描；成功前保留旧资料，选材失败时可明确选择按原书发送。`);
            warning.setAttribute('role', 'status'); feedback.append(warning, button('查看重新扫描入口', () => navigate('settings'), { navigation: true }));
        }
        shell.append(feedback);
        const content = h('div', 'dwm-content'); content.id = `${panelId}-content`; content.setAttribute('role', 'tabpanel'); content.setAttribute('aria-labelledby', `${panelId}-tab-${tab}`);
        if (tab === 'library') renderLibrary(content, view);
        if (tab === 'round') renderRound(content, view);
        if (tab === 'activity') renderActivity(content, view);
        if (tab === 'settings') renderSettings(content, view);
        if (tab === 'traces') {
            const modes = h('div', 'dwm-segments dwm-diagnostics-modes');
            for (const [id, label] of [['actual', '实际记录'], ['preview', '发送前预览']]) {
                const b = button(label, () => { diagnosticsMode = id; render(); }, { navigation: true, className: diagnosticsMode === id ? 'dwm-selected' : '' });
                b.setAttribute('aria-pressed', String(diagnosticsMode === id)); modes.append(b);
            }
            content.append(modes, diagnosticsMode === 'preview' ? promptPreview.element : traceViewer.element);
        }
        shell.append(content); root.append(shell); container.replaceChildren(root); restoreInteraction(interaction);
        traceViewer.setActive(tab === 'traces' && diagnosticsMode === 'actual');
    }
    function renderFirstRun(parent, view) {
        const panel = h('section', 'dwm-welcome'); panel.append(h('span', 'dwm-eyebrow', '从这个存档开始'), h('h3', '', '让世界记住，已经发生的故事。'));
        panel.append(h('p', '', '鱼忆会阅读角色主世界书与此存档保留的剧情，建立独立的动态资料。原世界书会作为对照保留。'));
        const steps = h('ol', 'dwm-start-steps');
        for (const [title, text] of [['确认辅助模型', '默认沿用酒馆连接，也可以在设置中使用单独的兼容接口。'], ['新档自动建立', '插件与本档已启用时，开场资料就绪即自动扫描；已有剧情的旧档仍由你手动发起。'], ['随后自动维护', '扫描完成后本档参与选材与维护；停用、失败或停止不会在刷新时偷偷重扫。']]) {
            const item = h('li'); item.append(h('strong', '', title), h('span', 'dwm-muted', text)); steps.append(item);
        } panel.append(steps);
        const readiness = view.readiness ?? {};
        const checks = [['角色聊天', readiness.chat], ['角色绑定的主世界书', readiness.book], ['单角色聊天', readiness.single], ['ST-Prompt-Template 已启用', readiness.template]];
        const conditions = h('ul', 'dwm-readiness'); for (const [label, ready] of checks) conditions.append(h('li', ready ? 'dwm-muted' : 'dwm-warning', `${ready ? '✓' : '○'} ${label}`)); panel.append(conditions);
        if (readiness.template === false) panel.append(h('p', 'dwm-muted', '请在酒馆扩展中安装并启用 ST-Prompt-Template，再打开此存档。'));
        if (view.initialization?.message) panel.append(h('p', view.initialization.retry ? 'dwm-warning' : 'dwm-muted', view.initialization.message));
        if (view.preset?.available) panel.append(toggle('初始化时扫描预设偏好', scanPresetWithInitialization, '额外调用一次辅助模型；扫描后仍需在设置中选择并确认，才会采用。', value => { scanPresetWithInitialization = value; }));
        panel.append(row(button(view.initialization?.retry ? '手动扫描 / 重试初始化' : '建立此存档记忆', () => initialize(view), { primary: true, disabled: !view.save || Boolean(view.progress) || Boolean(view.activity) || Object.values(readiness).some(value => value === false) }), button('设置辅助模型', () => navigate('settings'), { navigation: true })));
        if (view.progress) panel.append(h('p', 'dwm-warning', '扫描中继续发送将走酒馆原生流程；新增剧情会在扫描后补记。'));
        if (view.connectionMode === 'test') panel.append(h('p', 'dwm-muted', '本页使用模拟模型，不会调用真实 API。'));
        parent.append(panel);
    }
    function renderLibrary(parent, view) {
        if (!view.save?.initialized) { renderFirstRun(parent, view); return; }
        const entries = Object.values(view.save.data?.entries ?? {});
        const top = h('div', 'dwm-library-top');
        const sections = h('div', 'dwm-segments'); sections.setAttribute('aria-label', '资料类别');
        for (const [id, title] of [['entries', `动态世界书 · ${entries.length}`], ['summary', '故事脉络'], ['inventory', '我的物品']]) {
            const b = button(title, () => { sectionFilter = id; mobileDetail = false; render(); }, { navigation: true, className: sectionFilter === id ? 'dwm-selected' : '' });
            b.setAttribute('aria-pressed', String(sectionFilter === id)); sections.append(b);
        }
        top.append(sections); parent.append(top);
        if (sectionFilter === 'summary') { renderSummary(parent, view); return; }
        if (sectionFilter === 'inventory') { renderInventory(parent, view); return; }
        const layout = h('div', `dwm-browser ${mobileDetail ? 'dwm-show-detail' : ''}`);
        const sidebar = h('aside', 'dwm-sidebar'); sidebar.setAttribute('aria-label', '动态条目列表');
        const searchControl = field('搜索资料', search, value => { search = value; visibleCount = 80; mobileDetail = false; render(); }, { type: 'search', placeholder: '名称、简介或正文', key: 'entry-search' });
        sidebar.append(searchControl.wrap, selectField('类型', kindFilter, [['', '全部类型'], ...Object.entries(KIND_NAMES)], value => { kindFilter = value; visibleCount = 80; render(); }, 'kind-filter').wrap);
        const query = search.toLocaleLowerCase();
        const matching = entries.filter(e => (!kindFilter || e.kind === kindFilter) && (!query || `${e.title} ${e.intro} ${textOf(e)}`.toLocaleLowerCase().includes(query)));
        if (!matching.some(e => e.id === selected)) { selected = matching[0]?.id ?? null; entryMode = 'read'; }
        sidebar.append(h('p', 'dwm-list-count dwm-muted', `找到 ${matching.length} 条资料`));
        const list = h('div', 'dwm-list'); list.dataset.scroll = 'library-list';
        for (const entry of matching.slice(0, visibleCount)) {
            const item = button('', () => openEntry(entry.id), { navigation: true, key: `entry-${entry.id}`, className: `dwm-entry-link ${entry.id === selected ? 'dwm-selected' : ''}` });
            item.setAttribute('aria-current', entry.id === selected ? 'true' : 'false');
            const meta = h('div', 'dwm-entry-meta'); meta.append(h('span', '', KIND_NAMES[entry.kind] ?? entry.kind));
            if (entry.needsReview) meta.append(h('span', 'dwm-review-label', '待核对'));
            else if (!entry.enabled) meta.append(h('span', '', '已停用'));
            else if (entry.constant || entry.important) meta.append(h('span', '', '常驻'));
            item.append(meta, h('strong', '', entry.title || '未命名条目'), h('span', 'dwm-entry-intro', entry.intro || '暂无简介')); list.append(item);
        }
        if (matching.length > visibleCount) list.append(button(`再显示 ${Math.min(80, matching.length - visibleCount)} 条`, () => { visibleCount += 80; render(); }, { navigation: true }));
        if (!matching.length) list.append(h('p', 'dwm-empty', '没有匹配的资料，试试其他词或类型。'));
        sidebar.append(list); layout.append(sidebar);
        const detail = h('article', 'dwm-detail'); detail.dataset.scroll = 'entry-detail';
        const entry = matching.find(e => e.id === selected);
        if (entry) renderEntry(detail, entry, view);
        else detail.append(h('p', 'dwm-empty', '选择一条资料，查看它在故事中的变化。'));
        layout.append(detail); parent.append(layout);
    }
    function renderSummary(parent, view) {
        const panel = card('常驻故事脉络', '帮助叙事理解一路发生了什么。补记成功后更新，按当前资料范围发送。');
        panel.append(prose(view.save.data.summary, '还没有故事脉络，下一次成功补记后会在这里显示。'));
        for (const [scopeId, text] of Object.entries(view.save.data.scopeSummaries ?? {})) {
            const scope = details(`独立范围 · ${scopeId}`, `summary-${scopeId}`); scope.append(prose(text)); panel.append(scope);
        }
        panel.append(row(button('补记新剧情', () => call(() => controller.maintain(), '补记完成')), button('查看本轮使用情况', () => navigate('round'), { navigation: true }))); parent.append(panel);
    }
    function renderInventory(parent, view) {
        const panel = card('我的物品', '只记录玩家持有的物品，供记忆与叙事使用。');
        const enabled = view.save.data.inventoryEnabled;
        panel.append(toggle('维护并发送物品清单', enabled, '关闭后保留清单，停止更新与发送；重新开启会补记停用期间的剧情。', value => call(() => controller.manual({ type: 'inventory-toggle', enabled: value }))));
        if (!enabled) panel.append(h('p', 'dwm-warning', '此清单已暂停，下方是保留资料。'));
        if (view.save.inventoryNeedsCatchUp) panel.append(h('p', 'dwm-warning', '物品待补记，暂不发送。下方旧清单不能视为当前持有物。'));
        const scopes = [['global', view.save.data.inventory], ...Object.entries(view.save.data.scopeInventories ?? {})];
        for (const [scopeId, items] of scopes) {
            if (scopeId !== 'global') panel.append(h('h4', '', `独立范围 · ${scopeId}`));
            if (!items?.length) { if (scopeId === 'global') panel.append(h('p', 'dwm-empty', '尚未记录物品。')); continue; }
            const list = h('ul', 'dwm-inventory');
            for (const item of items) { const li = h('li'); li.append(h('strong', '', item.name || '未命名物品'), h('span', '', item.description || '暂无说明')); list.append(li); }
            panel.append(list);
        }
        panel.append(h('p', 'dwm-muted', '角色卡已经使用 MVU 或其他物品机制时，可以关闭这份清单，避免重复维护。')); parent.append(panel);
    }
    function newDraft(entry) {
        return { version: entry.version, title: entry.title, intro: entry.intro, retrieveWhen: entry.retrieveWhen, segments: (entry.segments ?? []).map(s => ({ ...s })) };
    }
    function renderEntry(parent, entry, view) {
        const back = button('返回资料列表', () => { mobileDetail = false; render(); container.querySelector('[data-focus="entry-search"]')?.focus({ preventScroll: true }); }, { navigation: true, className: 'dwm-mobile-back' }); parent.append(back);
        const meta = h('div', 'dwm-entry-heading-meta'); meta.append(badge(KIND_NAMES[entry.kind] ?? entry.kind));
        meta.append(badge(entry.constant ? '蓝灯 · 常驻' : entry.important ? '重要人物 · 常驻' : '前置按需选材'));
        if (!entry.enabled) meta.append(badge('已停用'));
        if (entry.needsReview) meta.append(badge('待核对', 'dwm-review-badge'));
        parent.append(meta);
        const title = h('h3', 'dwm-entry-title', entry.title || '未命名条目'); title.tabIndex = -1; title.dataset.detailHeading = 'true'; parent.append(title);
        parent.append(h('p', 'dwm-entry-description', entry.intro || '尚无简介。'));
        const actions = h('div', 'dwm-entry-actions');
        for (const [id, label] of [['read', '当前内容'], ['diff', '原书差异'], ['evidence', '修改依据'], ['edit', '编辑']]) {
            const b = button(label, () => { entryMode = id; if (id === 'edit' && !entryDrafts.has(entry.id)) entryDrafts.set(entry.id, newDraft(entry)); render(); }, { navigation: true, className: entryMode === id ? 'dwm-selected' : '' }); b.setAttribute('aria-pressed', String(entryMode === id)); actions.append(b);
        } parent.append(actions);
        if (entryMode === 'edit') { renderEdit(parent, entry); return; }
        if (entryMode === 'diff') { renderDiff(parent, entry); return; }
        if (entryMode === 'evidence') {
            parent.append(h('h4', '', '当前资料来源'), h('p', 'dwm-muted', `保留来源：${(entry.evidence ?? []).join('、') || '未记录具体消息'}`));
            if (entry.lastEvidence?.length) parent.append(h('p', 'dwm-muted', `最近修改依据：${entry.lastEvidence.join('、')}`));
            if (entry.evidenceTrimmed) parent.append(h('p', 'dwm-muted', '来源数量较多，保留早期与近期引用；这不是全部历史引用。'));
            if (entry.source) parent.append(h('p', 'dwm-muted', `原世界书：${entry.source.book ?? view.sourceBook} · 条目 ${entry.source.uid ?? '—'}`));
            if (entry.lineage?.length) parent.append(h('p', 'dwm-muted', `合并来源：${entry.lineage.join('、')}`));
            const records = [...(view.save.audit ?? [])].reverse().filter(record => record.entryId === entry.id);
            if (!records.length) parent.append(h('p', 'dwm-empty', '此条目还没有修改记录。'));
            for (const record of records.slice(0, 20)) parent.append(auditRecord(record, view));
            parent.append(h('p', 'dwm-muted', '修改审计仅供玩家查看，不会送给任何 Agent。')); return;
        }
        const writable = entry.segments?.some(s => s.writable);
        const mixed = writable && entry.segments.some(s => !s.writable);
        parent.append(h('p', 'dwm-permission-note', mixed ? '部分内容受保护：后置只维护可更新片段。' : writable ? '可由后置维护 · 原书保留用于对照' : '已保护 · 后置不会读取或修改此条正文'));
        parent.append(prose(textOf(entry), '此条目暂时没有正文。'));
        const usage = details('何时提取这条资料', `guidance-${entry.id}`); usage.append(prose(entry.retrieveWhen, '初始化尚未给出提取指导。'), h('p', 'dwm-muted', `当前版本 ${entry.version} · ${textOf(entry).length.toLocaleString('zh-CN')} 字符${entry.scopeId && entry.scopeId !== 'global' ? ` · 范围 ${entry.scopeId}` : ''}`)); parent.append(usage);
        if (entry.kind === 'npc' && !entry.important) parent.append(row(button('晋升为重要人物', () => call(() => controller.manual({ type: 'promote', id: entry.id }), '已晋升为重要人物'))));
        if (entry.kind === 'npc_pool') renderPool(parent, entry);
    }
    function renderDiff(parent, entry) {
        if (!entry.source) { parent.append(h('p', 'dwm-empty', '这是鱼忆自建的资料，没有原世界书对应项。'), prose(textOf(entry))); return; }
        const before = entry.source.original ?? '', after = textOf(entry);
        const legend = h('div', 'dwm-diff-legend'); legend.append(h('span', 'dwm-diff-delete', '− 删除'), h('span', 'dwm-diff-add', '+ 新增')); parent.append(legend);
        if (before === after) parent.append(h('p', 'dwm-notice', '内容与原世界书一致。'));
        const inline = h('div', 'dwm-prose dwm-inline-diff');
        for (const part of diffText(before, after)) {
            const node = h(part.type === 'remove' ? 'del' : part.type === 'add' ? 'ins' : 'span', '', part.text);
            if (part.type !== 'equal') node.setAttribute('aria-label', `${part.type === 'remove' ? '删除' : '新增'}：${part.text}`);
            inline.append(node);
        } parent.append(inline);
        const original = details('完整原书内容', `original-${entry.id}`); original.append(prose(before)); parent.append(original);
        parent.append(h('p', 'dwm-muted', '差异只反映这份动态资料；原世界书没有被改写。'));
    }
    function renderEdit(parent, entry) {
        const draft = entryDrafts.get(entry.id) ?? newDraft(entry); entryDrafts.set(entry.id, draft);
        const conflict = draft.version !== entry.version;
        if (conflict) {
            const warning = h('div', 'dwm-warning'); warning.append(h('strong', '', '后台已有新版本，你的草稿已保留。'), h('p', '', `草稿基于版本 ${draft.version}，当前为版本 ${entry.version}。为避免覆盖新资料，请先复制草稿，再载入新版进行合并。`));
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
            field('何时提取', draft.retrieveWhen, value => { draft.retrieveWhen = value; }, { area: true, key: `guidance-${entry.id}` }).wrap);
        for (const segment of draft.segments) {
            const f = field(`正文片段 ${segment.id} · ${segment.writable ? '允许后置维护' : '后置受保护'}`, segment.text, value => { segment.text = value; }, { area: true, key: `segment-${entry.id}-${segment.id}` });
            f.input.classList.add('dwm-body-editor'); parent.append(f.wrap);
        }
        parent.append(h('p', 'dwm-muted', '此处是玩家手动修改。维护保护约束的是 Agent，不限制你编辑自己的动态资料。'));
        parent.append(row(button('保存修改', () => call(async () => {
            await controller.manual({ type: 'edit', id: entry.id, expectedVersion: draft.version, title: draft.title, intro: draft.intro, retrieveWhen: draft.retrieveWhen, segments: draft.segments });
            entryDrafts.delete(entry.id); entryMode = 'read';
        }, '动态资料已保存'), { primary: true, disabled: conflict }), button('退出编辑', () => { entryMode = 'read'; render(); }, { navigation: true })));
        const maintenance = details('维护权限与重置', `edit-tools-${entry.id}`);
        maintenance.append(h('p', 'dwm-muted', '修改维护权限会使用当前已保存正文；不会连带保存上方草稿。作者脚本锁定的条目不能解除保护。'));
        maintenance.append(row(button('允许后置维护', () => call(async () => {
            await controller.manual({ type: 'classify', id: entry.id, expectedVersion: entry.version, segments: entry.segments.map(s => ({ ...s, writable: true })) });
        }), { disabled: entry.kind === 'rule' }), button('保护全部正文', () => call(() => controller.manual({ type: 'classify', id: entry.id, expectedVersion: entry.version, segments: entry.segments.map(s => ({ ...s, writable: false })) })) )));
        if (entry.source) maintenance.append(button('用初始化基准重置此条', () => {
            if (!doc.defaultView?.confirm?.('只将这一条动态资料恢复为本档初始化时保存的原书基准。其他条目、故事脉络和事件不会联动恢复。确定继续吗？')) return;
            call(async () => { await controller.manual({ type: 'reset', id: entry.id, confirmed: true }); entryDrafts.delete(entry.id); entryMode = 'read'; }, '此条已恢复为初始化基准');
        }, { danger: true }));
        else maintenance.append(h('p', 'dwm-muted', '自建条目没有可恢复的原书基准。'));
        parent.append(maintenance);
    }
    function renderPool(parent, entry) {
        let person = poolDrafts.get(entry.id);
        if (!person) { person = { title: '', intro: '', text: '', retrieveWhen: '' }; poolDrafts.set(entry.id, person); }
        const form = details('从路人中建立重要人物档案', `pool-${entry.id}`);
        form.append(h('p', 'dwm-muted', '根据对叙事的影响晋升，不以出场次数判定。独立建档后，原路人合集保持不变，可手动编辑消除重复。'));
        for (const [key, label] of [['title', '人物名称'], ['intro', '一句话介绍'], ['text', '独立人物正文'], ['retrieveWhen', '何时提取']]) form.append(field(label, person[key], value => { person[key] = value; }, { area: key !== 'title', key: `pool-${entry.id}-${key}` }).wrap);
        form.append(button('独立为重要人物', () => call(async () => { await controller.manual({ type: 'promote-from-pool', id: entry.id, ...person }); poolDrafts.delete(entry.id); }, '人物已独立建档'))); parent.append(form);
    }
    function renderRound(parent, view) {
        const plan = view.diagnostics?.lastPlan;
        const panel = card('最近一次发送选材', '这里展示鱼忆准备给本轮的资料。其他插件和最终模型请求的全部内容不在此处推断。');
        if (!plan) panel.append(h('p', 'dwm-empty', view.save?.initialized ? '还没有实际发送的选材记录。继续一次正文生成后，可以在这里查看。' : '初始化并启用后，每轮选材会显示在这里。'));
        else renderPlan(panel, plan, view, false);
        parent.append(panel);
        const preview = view.diagnostics?.lastPreview ?? localPreview;
        const test = card('重新试选', '此操作会额外调用一次前置模型，只用于查看选择结果，不会发送正文。');
        test.append(button('试选一次（调用模型）', () => call(async () => {
            const result = await controller.previewPlan(); localPreview = { ...result, at: new Date().toISOString(), mode: 'preview' };
        }, '试选已完成'), { disabled: !view.save?.initialized }));
        if (preview) {
            const result = details(`查看试选结果 · ${timeOf(preview.at)}`, 'last-preview'); renderPlan(result, preview, view, true); test.append(result);
        } parent.append(test);
    }
    function renderPlan(parent, plan, view, preview) {
        parent.append(row(badge(preview ? '试选 · 未发送' : '发送选材记录'), h('span', 'dwm-muted', timeOf(plan.at))));
        if (plan.status) parent.append(h('p', 'dwm-muted', `状态：${plan.status}`));
        if (Number(plan.pendingCount) > 0) parent.append(h('p', 'dwm-warning', `选材时有 ${plan.pendingCount} 条剧情尚未记入；待补记原文仍保留。`));
        const entries = view.save?.data?.entries ?? {};
        const list = h('ul', 'dwm-plan-list');
        for (const id of plan.selectedIds ?? []) {
            const entry = plan.entries?.find(e => e.id === id) ?? entries[id];
            const item = h('li');
            item.append(entries[id] ? button(entry?.title || id, () => openEntry(id), { navigation: true, key: `plan-${preview ? 'preview' : 'send'}-${id}`, className: 'dwm-link-button' }) : h('span', '', entry?.title || id));
            if (entry) item.append(h('span', 'dwm-muted', !entries[id] ? '当前已无此条' : entry.constant || entry.important ? '常驻' : '按需选入'));
            list.append(item);
        }
        if (list.childNodes.length) parent.append(list); else parent.append(h('p', 'dwm-muted', '这次没有选入动态条目。'));
        if (!preview) parent.append(h('p', 'dwm-observation-note', Array.isArray(plan.observedIds)
            ? `宿主观察到 ${plan.observedIds.length} 条世界书激活记录；这不代表已核对整份最终请求。`
            : '未观察到宿主最终投递，不能将这份选材记录视为模型实际收到的完整提示词。'));
        if (plan.entryChars !== undefined) parent.append(h('p', 'dwm-muted', `选入条目 ${countOf(plan.entryChars)} 字符；字符数不等同于 token 数。`));
        for (const [name, value, key] of [['故事脉络', plan.summary, 'summary'], ['物品清单', plan.inventory, 'inventory'], ['补充资料', plan.details, 'details']]) {
            if (!value) continue;
            const item = details(name, `${preview ? 'preview' : 'plan'}-${key}`); item.append(prose(display(value))); parent.append(item);
        }
        if (plan.mvu) {
            const item = details('此次选材参考的 MVU 信息', `${preview ? 'preview' : 'plan'}-mvu`); renderMvuState(item, plan.mvu); parent.append(item);
        }
    }
    function auditRecord(record, view) {
        const name = view.save?.data?.entries?.[record.entryId]?.title;
        const el = details(`${timeOf(record.at)} · ${record.reason || '资料更新'}${name ? ` · ${name}` : ''}`, `audit-${record.id ?? `${record.at}-${record.entryId}-${record.reason}`}`);
        if (record.entryId && name) el.append(button(`查看 ${name}`, () => openEntry(record.entryId), { navigation: true, className: 'dwm-link-button' }));
        const diff = h('div', 'dwm-prose dwm-inline-diff');
        for (const part of diffText(display(record.before), display(record.after))) diff.append(h(part.type === 'remove' ? 'del' : part.type === 'add' ? 'ins' : 'span', '', part.text));
        el.append(diff, h('p', 'dwm-muted', `依据消息：${(record.evidence ?? []).join('、') || '此记录没有消息引用'}`)); return el;
    }
    function renderActivity(parent, view) {
        const tasks = card('维护与补记', '后台失败时保留缺口，已保存的资料仍然可读。');
        tasks.append(row(button('补记新剧情', () => call(() => controller.maintain(), '补记完成'), { primary: true, disabled: !view.save?.initialized }), button('整理事件记忆', () => call(() => controller.compact(), '整理完成'), { disabled: !view.save?.initialized })));
        if (view.progress) tasks.append(h('p', 'dwm-muted', progressText(view.progress)));
        parent.append(tasks);
        const logs = card('修改记录', '这份审计只给玩家查看，不进入正文或辅助模型。');
        const records = [...(view.save?.audit ?? [])].reverse();
        if (!records.length) logs.append(h('p', 'dwm-empty', '还没有修改记录。'));
        for (const record of records.slice(0, 50)) logs.append(auditRecord(record, view));
        if (records.length > 50) logs.append(h('p', 'dwm-muted', `显示最近 50 条，共 ${records.length} 条保留记录。`)); parent.append(logs);
        const requests = details('辅助模型请求记录', 'requests');
        requests.append(h('p', 'dwm-muted', '本次打开后的请求概况。字符数用来比较输入规模，不是模型计费 token 数。'));
        const recent = [...(view.diagnostics?.requests ?? [])].reverse().slice(0, 30);
        for (const request of recent) {
            const item = h('div', 'dwm-request');
            item.append(row(h('strong', '', TASK_NAMES[request.task ?? request.purpose] ?? request.task ?? request.purpose ?? '辅助任务'), badge(request.ok ? '完成' : request.outcome === 'yielded' ? '已让出' : request.outcome === 'stopped' ? '已停止' : '未完成', request.ok ? '' : 'dwm-review-badge')),
                h('p', 'dwm-muted', `${timeOf(request.at)} · ${Number.isFinite(request.durationMs) ? `${(request.durationMs / 1000).toFixed(1)} 秒` : '耗时未知'} · 输入 ${countOf(request.inputChars)} 字符 · 输出 ${countOf(request.outputChars)} 字符`));
            if (request.error) item.append(h('p', 'dwm-error', request.error)); requests.append(item);
        }
        if (!recent.length) requests.append(h('p', 'dwm-muted', '尚无请求记录。')); parent.append(requests);
    }
    function renderSettings(parent, view) {
        const current = view.settings ?? {};
        const usage = card('日常使用');
        usage.append(toggle('插件总开关（所有存档）', Boolean(current.enabled), '关闭时所有存档暂停选材与自动维护，已有资料保留。', value => call(() => controller.updateSettings({ enabled: value }))));
        if (view.save) usage.append(toggle('启用此存档的记忆', view.saveEnabled !== false, '仅影响当前存档。初始化完成且总开关开启后生效。', value => call(() => controller.setSaveEnabled(value))));
        usage.append(toggle('由鱼忆管理历史窗口', Boolean(current.windowEnabled), '只在当次发送中省略已记入且超出近期范围的原文，不写入持久隐藏。与其他自动隐藏工具请只启用一方。', value => call(() => controller.updateSettings({ windowEnabled: value }))));
        const rounds = field('保留最近几轮完整对话', recentTurnsDraft ?? current.recentTurns ?? 12, value => { recentTurnsDraft = value; }, { type: 'number' }); rounds.input.min = '1'; rounds.input.max = '1000';
        usage.append(row(rounds.wrap, button('保存轮数', () => call(async () => { await controller.updateSettings({ recentTurns: Number(rounds.input.value) }); recentTurnsDraft = null; }))));
        if (view.save?.initialized) usage.append(toggle('维护玩家物品清单', view.save.data.inventoryEnabled, '角色卡已有物品机制时可关闭；数据保留，停用期间不维护或发送。', value => call(() => controller.manual({ type: 'inventory-toggle', enabled: value }))));
        parent.append(usage);
        renderPreset(parent, view);
        renderConnection(parent, view);
        renderMvu(parent, view);
        const rescan = details('重新扫描此存档', 'rescan');
        rescan.append(h('p', 'dwm-muted', '扫描角色主世界书和当前保留的完整剧情。成功后替换动态资料，失败保留原有结果。扫描期间发送走原生流程。'));
        rescan.append(button(view.save?.initialized ? '重新扫描' : '初始化存档', () => initialize(view), { disabled: !view.save })); parent.append(rescan);
        const author = details('作者规则工具', 'author-tools'); renderRuleEditor(author); parent.append(author);
    }
    function renderPreset(parent, view) {
        const preset = view.preset ?? {}, panel = card('辅助 Agent 的预设偏好', '只采用语言、专名、术语和称谓。叙事、变量更新、输出协议、工具权限及绕过安全限制的条目不继承；原预设不会改动。');
        panel.append(h('p', 'dwm-muted', `当前预设：${preset.name || '尚不可读取'}`));
        if (preset.stale) panel.append(h('p', 'dwm-warning', '预设已经改变，旧偏好暂不使用；请重新扫描并确认。'));
        if (preset.saved?.selected?.length) {
            const saved = details('已确认的辅助偏好与来源', 'saved-preset');
            for (const item of preset.saved.selected) saved.append(h('p', '', `${preferenceLabel(item.preference)} · 来源：${item.source.title}`));
            panel.append(saved);
        }
        panel.append(button('扫描当前预设（调用模型）', () => call(() => controller.scanPreset()), { disabled: !view.save || !preset.available || Boolean(view.activity) }));
        if (!preset.available) panel.append(h('p', 'dwm-muted', '当前仅支持读取酒馆聊天补全预设中已启用的文本条目。没有可读条目时继续使用鱼忆自身提示词。'));
        const draft = preset.draft;
        if (draft) {
            const key = draft.id || `${draft.chatId}:${draft.fingerprint}:${draft.candidates.map(item => item.id).join(',')}`;
            if (presetDraftKey !== key) { presetDraftKey = key; presetSelection = new Set(); }
            panel.append(h('p', 'dwm-muted', '扫描结果尚未采用。勾选并确认后，仅保存到当前存档。'));
            for (const item of draft.candidates) {
                const candidate = h('div', 'dwm-preset-candidate');
                candidate.append(toggle(preferenceLabel(item.preference), presetSelection.has(item.id), `来源：${item.source.title}`, value => { if (value) presetSelection.add(item.id); else presetSelection.delete(item.id); })); panel.append(candidate);
            }
            if (!draft.candidates.length) panel.append(h('p', 'dwm-muted', '没有找到可直接复用的通用约定；不影响记忆功能。'));
            panel.append(button('确认所选偏好', () => call(() => controller.confirmPreset([...presetSelection])), { disabled: Boolean(view.activity) }));
        }
        parent.append(panel);
    }
    function renderConnection(parent, view) {
        const panel = card('辅助模型连接', '用于扫描、选材与维护。单独连接仅在本次页面有效；刷新后恢复沿用酒馆连接。');
        if (view.connectionMode === 'test') { panel.append(h('p', 'dwm-notice', '演示模式 · 当前使用模拟模型，没有真实 API 请求。')); parent.append(panel); return; }
        const mode = connectionModeDraft ?? view.connectionMode?.mode ?? view.connectionMode ?? 'raw';
        const modeField = selectField('连接方式', mode, [['raw', '沿用酒馆连接'], ['compatible', '单独的兼容接口']], value => { connectionModeDraft = value; render(); }); panel.append(modeField.wrap);
        if (mode === 'compatible') {
            panel.append(field('接口基础地址', connectionDraft.endpoint, value => { connectionDraft.endpoint = value; }, { placeholder: 'https://…/v1', hint: '鱼忆会在地址后添加 /chat/completions。' }).wrap,
                field('模型名称', connectionDraft.model, value => { connectionDraft.model = value; }).wrap,
                field('接口密钥', connectionDraft.apiKey, value => { connectionDraft.apiKey = value; }, { type: 'password', hint: '只用于本次连接，不写入存档。' }).wrap);
        }
        if (view.activity) panel.append(h('p', 'dwm-muted', '任务正在运行，请先停止或等待完成，再应用连接。'));
        panel.append(button('应用连接', () => call(async () => {
            await controller.updateConnection({ mode, endpoint: connectionDraft.endpoint.trim(), model: connectionDraft.model.trim(), apiKey: connectionDraft.apiKey }); connectionDraft.apiKey = '';
        }, '连接已应用；下一次辅助任务将使用此连接'), { disabled: Boolean(view.activity) })); parent.append(panel);
    }
    function renderMvuState(parent, state = {}) {
        parent.append(h('p', 'dwm-muted', state.reason || state.status || (state.available ? '已检测到可用接口' : '尚未检测到可用 MVU 信息')));
        if (state.messageId !== undefined && state.messageId !== null) parent.append(h('p', 'dwm-muted', `来源楼层 ${state.messageId} · 回复 ${state.swipeId ?? '—'}`));
        if (state.fields?.length) {
            const list = h('dl', 'dwm-variable-list');
            for (const item of state.fields) { list.append(h('dt', '', item.label || item.path), h('dd', '', display(item.value))); }
            parent.append(list);
        }
        parent.append(h('p', 'dwm-muted dwm-hint', '展示的是读取时观察到的值，不代表已经验证磁盘保存，也不代替剧情发生的证据。'));
    }
    function renderMvu(parent, view) {
        const current = view.settings ?? {}, state = view.mvu ?? {};
        const panel = card('MVU 只读协作', '让角色卡维护变量，鱼忆读取你选择的信息来帮助记忆与选材。普通卡无需安装 MVU。');
        panel.append(toggle('参考所选 MVU 信息', Boolean(current.mvuEnabled), '只读取下方字段；不会改值、更新旗标或另建一份变量账本。', value => call(() => controller.updateSettings({ mvuEnabled: value }))));
        renderMvuState(panel, state);
        const fieldsPanel = details('选择读取的字段', 'mvu-fields');
        fieldsPanel.append(h('p', 'dwm-muted', '仅选取对当前叙事有用、允许模型获知的字段。路径从 stat_data 内部开始，使用点号分隔；最多 16 个单值字段。'));
        fieldsPanel.append(h('p', 'dwm-muted', `保存后绑定到当前主世界书「${view.sourceBook || '尚未选择'}」。切换角色卡时不会自动套用其他卡的字段。`));
        const fields = mvuDraft ?? (current.mvuFields ?? []).map(item => ({ ...item }));
        const rows = h('div', 'dwm-mvu-fields');
        fields.forEach((item, index) => {
            const line = h('div', 'dwm-mvu-field');
            line.append(field(`字段 ${index + 1} · 含义`, item.label, value => { mvuDraft = fields; item.label = value; }, { key: `mvu-label-${index}`, placeholder: '例如：当前地点' }).wrap,
                field(`字段 ${index + 1} · 路径`, item.path, value => { mvuDraft = fields; item.path = value; }, { key: `mvu-path-${index}`, placeholder: '世界.当前地点' }).wrap,
                button('移除', () => { mvuDraft = fields.filter((_, i) => i !== index); render(); }, { navigation: true, key: `mvu-remove-${index}` })); rows.append(line);
        }); fieldsPanel.append(rows);
        fieldsPanel.append(row(button('添加字段', () => { mvuDraft = [...fields, { label: '', path: '' }]; render(); }, { navigation: true, disabled: fields.length >= 16 }), button('保存读取字段', () => call(async () => {
            await controller.updateSettings({ mvuFields: fields.map(item => ({ label: item.label.trim(), path: item.path.trim() })) }); mvuDraft = null;
        }))));
        panel.append(fieldsPanel);
        if (typeof controller.refreshMvu === 'function') panel.append(button('重新读取状态', () => call(() => controller.refreshMvu(), '已重新检查 MVU 信息')));
        parent.append(panel);
    }
    function renderRuleEditor(parent) {
        parent.append(h('p', 'dwm-muted', '生成后复制到角色主世界书中标题为 [DWM Rules] 的条目。本工具不会改写原书。'));
        parent.append(field('自然语言要求', ruleNL, value => { ruleNL = value; }, { area: true, key: 'rule-nl' }).wrap,
            field('规则脚本', ruleScript, value => { ruleScript = value; }, { area: true, key: 'rule-script', placeholder: 'when title contains "变量" => lock;' }).wrap);
        const form = h('div', 'dwm-rule-form');
        form.append(selectField('匹配字段', ruleMatch.field, [['title', '条目名称'], ['id', '条目身份'], ['kind', '条目类型'], ['constant', '是否蓝灯'], ['sourceUID', '原书条目编号']], value => { ruleMatch.field = value; }).wrap,
            selectField('条件', ruleMatch.op, [['contains', '包含'], ['==', '等于'], ['!=', '不等于']], value => { ruleMatch.op = value; }).wrap,
            field('匹配值', ruleMatch.value, value => { ruleMatch.value = value; }, { key: 'rule-value' }).wrap,
            selectField('执行动作', ruleMatch.action, [['lock', '锁定维护'], ['maxChars', '限制长度'], ['always', '始终选入']], value => { ruleMatch.action = value; render(); }).wrap);
        if (ruleMatch.action === 'maxChars') form.append(field('长度上限', ruleMatch.limit, value => { ruleMatch.limit = value; }, { type: 'number', key: 'rule-limit' }).wrap);
        parent.append(form, button('加入脚本', () => {
            try {
                if (ruleMatch.field === 'constant' && !['true', 'false'].includes(ruleMatch.value)) throw new Error('是否蓝灯请填写 true 或 false');
                const value = ruleMatch.field === 'constant' ? ruleMatch.value === 'true' : ruleMatch.value;
                ruleScript = [ruleScript.trim(), formToScript({ field: ruleMatch.field, operator: ruleMatch.op, value, action: ruleMatch.action, maxChars: Number(ruleMatch.limit) })].filter(Boolean).join('\n');
                localError = ''; notice = '已加入规则'; render();
            } catch (error) { localError = error.message; render(); }
        }));
        parent.append(row(button('校验并生成条目', () => {
            try { compileRules(ruleScript); ruleOutput = buildRuleDocument({ naturalLanguage: ruleNL, script: ruleScript }); localError = ''; notice = '规则格式有效'; render(); }
            catch (error) { localError = error.message; render(); }
        }), button('复制规则条目', () => call(async () => {
            compileRules(ruleScript);
            ruleOutput = buildRuleDocument({ naturalLanguage: ruleNL, script: ruleScript });
            if (!doc.defaultView?.navigator?.clipboard?.writeText) throw new Error('当前环境不能自动复制，请从下方手动复制。');
            await doc.defaultView.navigator.clipboard.writeText(ruleOutput);
        }, '规则已复制'))));
        if (ruleOutput) { const output = field('生成的世界书规则条目', ruleOutput, () => {}, { area: true, key: 'rule-output' }); output.input.readOnly = true; parent.append(output.wrap); }
    }
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => { composing = false; if (queuedRender) { queuedRender = false; render(); } };
    container.addEventListener('compositionstart', onCompositionStart);
    container.addEventListener('compositionend', onCompositionEnd);
    const unsubscribe = controller.subscribe?.(() => render()) ?? (() => {});
    render();
    return { render, destroy() {
        if (destroyed) return;
        destroyed = true; unsubscribe(); traceViewer.destroy(); promptPreview.destroy(); activityIndicator.destroy(); container.removeEventListener('compositionstart', onCompositionStart); container.removeEventListener('compositionend', onCompositionEnd); container.replaceChildren();
    } };
}
