import { readableValue, valueChildren } from './trace-viewer.js';

const STATUS = { ready: '当前可确定', conditional: '部分待定', skipped: '此时不调用', inactive: '当前不适用', unavailable: '尚不可用' };
const LABELS = { current: '当前卡状态', directory: '世界档案目录', ruleDirectory: '作者规则目录', userInput: '玩家输入草稿', recent: '近期正文', priorWorlds: '此前世界参考', player: '玩家角色', character: '建角资料', scopeContext: '当前与预取资料范围', selectionLimit: '选材数量上限', selectionChars: '选材字符预算', slots: '记忆注入位置', worldbookCandidates: '原书候选条目', disabledSourceEntries: '鱼忆不会激活的原书条目', position: '插入位置', depth: '深度', condition: '适用说明', nextDueAt: '下次到期时间' };

function agentGroups(stages = []) {
    const groups = new Map();
    for (const stage of stages) {
        const agent = stage.agent?.id && stage.agent?.title ? stage.agent
            : { id: `unassigned:${stage.provider?.id ?? 'unknown'}`, title: `${stage.provider?.title ?? '来源'} · 未标注 Agent`, identified: false,
                description: '该来源尚未提供 Agent 归属；保留各阶段原文，不推测角色。' };
        if (!groups.has(agent.id)) groups.set(agent.id, { ...agent, stages: [] });
        groups.get(agent.id).stages.push(stage);
    }
    // Injection fragments belong to the narration recipient, not extra auxiliary agents.
    return [...groups.values()].sort((a, b) => Number(a.stages.every(s => s.kind === 'injection')) - Number(b.stages.every(s => s.kind === 'injection')));
}

/** A disposable, player-only snapshot. Never participates in prompt injection. */
export function createPromptPreview(doc, controller) {
    const h = (tag, cls = '', text) => { const el = doc.createElement(tag); el.className = cls; if (text !== undefined) el.textContent = String(text); return el; };
    const button = (label, fn, key) => { const el = h('button', 'dwm-button', label); el.type = 'button'; el.dataset.focus = `preview-${key ?? label}`; el.addEventListener('click', fn); return el; };
    const element = h('section', 'dwm-preview'); element.setAttribute('aria-label', '发送前提示词预览');
    const controls = h('div', 'dwm-row');
    const meta = h('p', 'dwm-muted dwm-hint'); meta.setAttribute('role', 'status');
    const warnings = h('details', 'dwm-disclosure');
    const warningTitle = h('summary', '', '预览范围与限制'); warnings.append(warningTitle);
    const warningBody = h('div'); warnings.append(warningBody);
    const layout = h('div', 'dwm-trace-layout dwm-preview-layout');
    const sidebar = h('aside', 'dwm-trace-sidebar'); sidebar.setAttribute('aria-label', 'Agent 列表');
    const list = h('div', 'dwm-trace-list'); list.dataset.scroll = 'preview-list';
    const reader = h('article', 'dwm-trace-reader'); reader.dataset.scroll = 'preview-reader'; reader.setAttribute('aria-label', '阶段提示词');
    sidebar.append(h('h4', 'dwm-preview-list-title', '选择 Agent'), list); layout.append(sidebar, reader);
    element.append(h('h3', '', '发送前预览'), h('p', 'dwm-muted', '先选 Agent，再看它各阶段的提示词。按当前存档和输入草稿只读预览，待定部分会单独说明。Agent 按职责区分，可共用同一模型。'), controls, meta, warnings, layout);
    let data = null, selected = null, mode = 'read', serial = 0, identity = null, destroyed = false;
    const remembered = new Map();
    const focusKey = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
    function choose(stage, agent, focus) {
        selected = stage.id; remembered.set(agent.id, selected);
        render(); reader.scrollTop = 0;
        element.querySelector(`[data-focus="preview-${focus}"]`)?.focus({ preventScroll: true });
    }
    function section(parent, title, fill, open = false) {
        const box = h('details', 'dwm-trace-block'); box.open = open;
        const summary = h('summary', '', title); summary.dataset.focus = `preview-section-${title}`; box.append(summary);
        let populated = false;
        const populate = () => { if (!populated && box.open) { populated = true; const body = h('div', 'dwm-trace-block-body'); box.append(body); fill(body); } };
        box.addEventListener('toggle', populate); parent.append(box); populate();
    }
    function value(parent, original, depth = 0) {
        const item = readableValue(original);
        if (item === null || typeof item !== 'object') { parent.append(h('div', 'dwm-trace-prose', item === null ? 'null' : String(item ?? ''))); return; }
        if (depth > 12) { parent.append(h('pre', 'dwm-trace-raw', JSON.stringify(item, null, 2))); return; }
        let offset = 0;
        const total = Array.isArray(item) ? item.length : Object.keys(item).length;
        if (!total) { parent.append(h('p', 'dwm-muted', Array.isArray(item) ? '空列表 []' : '空对象 {}')); return; }
        const more = button('显示更多条目', () => { more.remove(); page(); });
        function page() {
            const children = valueChildren(item, offset, 30); offset += children.length;
            for (const child of children) section(parent, LABELS[child.key] ?? child.label, body => value(body, child.value, depth + 1));
            if (offset < total) parent.append(more);
        }
        page();
    }
    function renderReader() {
        reader.replaceChildren();
        const stage = data?.stages.find(stage => stage.id === selected);
        if (!stage) { reader.append(h('p', 'dwm-empty', '点击“刷新预览”读取当前资料。')); return; }
        const agent = agentGroups(data.stages).find(group => group.stages.some(item => item.id === selected));
        reader.append(h('h3', '', agent.title), h('p', 'dwm-muted dwm-preview-purpose', agent.description));
        const stages = h('nav', 'dwm-preview-stages'); stages.setAttribute('aria-label', `${agent.title} 的阶段`);
        for (const item of agent.stages) {
            const key = `stage-${focusKey(item.id)}`;
            const b = button(item.title, () => choose(item, agent, key), key);
            b.setAttribute('aria-pressed', String(item.id === selected)); stages.append(b);
        }
        reader.append(stages, h('h4', 'dwm-preview-stage-title', stage.title));
        const badges = h('div', 'dwm-row');
        badges.append(h('span', 'dwm-badge', stage.kind === 'injection' ? '正文注入片段 · 非完整请求' : stage.kind === 'request' ? '辅助模型请求' : '请求类型未标注'),
            h('span', 'dwm-badge', STATUS[stage.status] ?? stage.status));
        reader.append(badges, h('p', 'dwm-muted', stage.explanation));
        if (stage.uncertainties?.length) {
            const notes = h('div', 'dwm-warning'); notes.append(h('strong', '', '还不能确定的部分'));
            const ul = h('ul'); for (const note of stage.uncertainties) ul.append(h('li', '', note)); notes.append(ul); reader.append(notes);
        }
        const modes = h('div', 'dwm-row');
        for (const [id, label] of [['read', '分栏阅读'], ['raw', '原文']]) { const b = button(label, () => { mode = id; renderReader(); reader.querySelector(`[data-focus="preview-mode-${id}"]`)?.focus({ preventScroll: true }); }, `mode-${id}`); b.setAttribute('aria-pressed', String(mode === id)); modes.append(b); }
        reader.append(modes);
        if (mode === 'raw') {
            reader.append(h('p', 'dwm-hint dwm-muted', 'system 与 input 对应辅助请求；input 在发送时序列化为 user 消息。待定字段省略，未伪造完整请求。正文阶段展示注入片段。'),
                h('pre', 'dwm-trace-raw', JSON.stringify({ system: stage.system, input: stage.input }, null, 2))); return;
        }
        if (stage.system) section(reader, '系统提示词 · system', body => body.append(h('div', 'dwm-trace-prose', stage.system)));
        if (stage.input === null || stage.input === undefined) reader.append(h('p', 'dwm-muted', '输入尚未确定；原因见上方说明。'));
        else section(reader, '当前已知输入 · input', body => value(body, stage.input), true);
    }
    function render() {
        const listScroll = list.scrollTop;
        list.replaceChildren(); warningBody.replaceChildren();
        warnings.hidden = !data;
        for (const note of data?.warnings ?? []) warningBody.append(h('p', 'dwm-hint', note));
        const groups = agentGroups(data?.stages);
        for (const agent of groups) {
            const active = agent.stages.some(stage => stage.id === selected), key = `agent-${focusKey(agent.id)}`;
            const b = button('', () => choose(agent.stages.find(stage => stage.id === remembered.get(agent.id)) ?? agent.stages[0], agent, key), key);
            b.className += ` dwm-preview-stage ${active ? 'dwm-selected' : ''}`; b.setAttribute('aria-pressed', String(active));
            b.append(h('strong', '', agent.title), h('span', 'dwm-muted dwm-hint', `${agent.stages.length} 个${agent.stages.every(stage => stage.kind === 'injection') ? '注入片段' : '提示词阶段'}`)); list.append(b);
        }
        list.scrollTop = listScroll;
        renderReader();
    }
    const refresh = button('刷新预览', async () => {
        const ticket = ++serial; refresh.disabled = true; meta.textContent = '正在读取当前资料…';
        try {
            const next = await controller.previewPrompts();
            if (destroyed || ticket !== serial) return;
            data = next; if (!data.stages.some(stage => stage.id === selected)) selected = data.stages.find(stage => stage.id === 'select')?.id ?? data.stages[0]?.id;
            const groups = agentGroups(data.stages), known = groups.filter(agent => agent.identified !== false).length, unknown = groups.length - known;
            meta.textContent = `${new Date(data.at).toLocaleString('zh-CN', { hour12: false })} · 资料版本 ${data.revision ?? '未初始化'} · ${known} 个 Agent${unknown ? ` / ${unknown} 个来源待标注` : ''} · ${data.stages.length} 个阶段。输入或资料变化后请刷新。`;
            render();
        } catch (error) { if (!destroyed && ticket === serial) { data = null; meta.textContent = `预览未完成：${error.message}`; render(); } }
        finally { if (!destroyed && ticket === serial) refresh.disabled = false; }
    });
    controls.append(refresh); render();
    return { element,
        setContext(next) { if (identity === next) return; identity = next; serial++; data = null; selected = null; remembered.clear(); meta.textContent = ''; refresh.disabled = false; render(); },
        destroy() { destroyed = true; serial++; data = null; remembered.clear(); },
    };
}
