// Player-only inspection. Nothing in this module is supplied to an agent or prompt.
const ROLES = { system: '系统消息', developer: '开发者消息', user: '用户消息', assistant: '模型消息', tool: '工具返回' };
const FIELDS = { content: '内容', text: '正文', title: '标题', name: '名称', comment: '条目名称', id: '编号', intro: '简介', description: '说明', summary: '故事脉络', inventory: '物品', entries: '条目', catalog: '资料目录', messages: '消息', memory: '记忆', strategy: '记忆策略', naturalLanguage: '自然语言规则', retrieveWhen: '提取时机', observedState: '读取的状态', operations: '修改操作', reason: '原因', evidence: '依据', reasoning: '模型返回的思考文本', reasoning_content: '模型返回的思考文本', tool_calls: '工具调用', tool_call_id: '工具调用编号', role: '消息角色', kind: '类型', scopeId: '资料范围', important: '重要', constant: '常驻', writable: '可修改', enabled: '启用', segments: '正文片段', before: '修改前', after: '修改后' };
const STATUSES = { pending: '等待响应', sending: '正在发送', receiving: '正在接收', streaming: '正在接收', complete: '已接收', completed: '已接收', success: '已接收', failed: '失败', error: '失败', aborted: '已取消', cancelled: '已取消', truncated: '记录已截断' };
const stringOf = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
const count = value => Number(value || 0).toLocaleString('zh-CN');
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
const fieldName = key => FIELDS[key] ?? String(key);
const processingLabel = record => ({ yielded: '已让出，结果不采用', stopped: '已停止采用结果', cancelled: '本轮已取消' })[record.processingOutcome] || '处理失败';
const statusOf = record => `${STATUSES[record.status] || record.status || '状态未知'}${record.processingError ? ` · ${processingLabel(record)}` : ''}`;
const isBoundary = record => ['test', 'agent-boundary', 'agent'].includes(record.transport);
const hasContent = value => value !== undefined && value !== null && (typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : typeof value === 'object' ? Object.keys(value).length > 0 : true);
const PROSE_FIELDS = ['content', 'text', 'body', 'intro', 'description', 'summary', 'retrieveWhen', 'reason', 'evidence', 'strategy', 'naturalLanguage'];
const ATTRIBUTE_FIELDS = new Set(['id', 'key', 'uid', 'uuid', 'version', 'expectedversion', 'revision', 'scopeid', 'sourceid', 'sourceuid', 'messageid', 'requestid', 'parentid', 'createdat', 'updatedat', 'timestamp', 'kind', 'constant', 'important', 'writable', 'enabled']);

/** Decode only a complete JSON value. Narrative, HTML and script remain literal text. */
export function readableValue(value) {
    if (typeof value !== 'string') return value;
    const candidate = value.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '').trim();
    if (!/^[\[{]/.test(candidate) || candidate.length > 1000000) return value;
    try { return JSON.parse(candidate); } catch { return value; }
}

/** Display-only XML-like JSON blocks. Every raw character remains recoverable. */
export function splitStructuredText(text) {
    if (typeof text !== 'string' || !text.includes('<')) return [{ kind: 'text', raw: text }];
    const blocks = []; let cursor = 0, matched = 0;
    const tags = /<([A-Za-z_][\w:.-]*)(?:\s+[^<>]*)?\s*>([\s\S]*?)<\/\1\s*>/g;
    for (const match of text.matchAll(tags)) {
        let value;
        try { value = JSON.parse(match[2].trim()); } catch { continue; }
        if (match.index > cursor) blocks.push({ kind: 'text', raw: text.slice(cursor, match.index) });
        blocks.push({ kind: 'json', title: match[1], raw: match[0], value }); cursor = match.index + match[0].length;
        if (++matched >= 100) break;
    }
    if (cursor < text.length || !blocks.length) blocks.push({ kind: 'text', raw: text.slice(cursor) });
    return blocks;
}

/** One level at a time; no recursive eager expansion of large worldbooks. */
export function valueChildren(value, offset = 0, limit = 30) {
    const actual = readableValue(value);
    const list = Array.isArray(actual);
    if (!actual || typeof actual !== 'object') return [];
    const keys = Object.keys(actual);
    if (!list) keys.sort((a, b) => {
        const rank = key => { const index = PROSE_FIELDS.indexOf(key); return index < 0 ? PROSE_FIELDS.length : index; };
        return rank(a) - rank(b);
    });
    return keys.slice(offset, offset + Math.min(50, Math.max(1, limit))).map(key => {
        const item = actual[key];
        const identity = item && typeof item === 'object' && !Array.isArray(item)
            ? ['title', 'name', 'comment', 'id'].map(name => item[name]).find(text => typeof text === 'string' && text.trim()) : null;
        return { key, label: list ? identity || `第 ${Number(key) + 1} 项` : fieldName(key), value: item };
    });
}

/** Exact, unambiguous substring provenance only. Concatenated blocks equal the source. */
export function splitTraceText(text, provenance = []) {
    if (typeof text !== 'string') return [{ text: stringOf(text), matched: false }];
    const matches = [];
    const seen = new Map();
    for (const item of (Array.isArray(provenance) ? provenance : []).slice(0, 200)) {
        if (!item || typeof item.text !== 'string' || !item.text) continue;
        const index = text.indexOf(item.text);
        if (index < 0) continue;
        const key = `${index}:${item.text.length}`;
        if (seen.has(key)) { seen.get(key).ambiguous = true; continue; }
        const match = { start: index, end: index + item.text.length, title: item.title || '条目', kind: item.kind, ambiguous: text.indexOf(item.text, index + 1) !== -1 };
        matches.push(match); seen.set(key, match);
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const blocks = []; let cursor = 0;
    for (const match of matches) {
        if (match.ambiguous || match.start < cursor || matches.some(other => other !== match && other.start < match.end && other.end > match.start)) continue;
        if (match.start > cursor) blocks.push({ text: text.slice(cursor, match.start), matched: false });
        blocks.push({ text: text.slice(match.start, match.end), title: match.title, kind: match.kind, matched: true }); cursor = match.end;
    }
    if (cursor < text.length || !blocks.length) blocks.push({ text: text.slice(cursor), matched: false });
    return blocks;
}

/** Preserve message order and roles; formatting never substitutes a reconstructed prompt. */
export function traceMessages(record, direction = 'input') {
    const body = direction === 'input' ? record.request : record.responseBody;
    if (body && Array.isArray(body.messages)) return body.messages.map((message, index) => message && typeof message === 'object'
        ? { ...message, index, role: message.role || 'unknown' } : { index, role: 'unknown', content: message });
    if (direction === 'input' && Array.isArray(body?.prompt) && body.prompt.every(item => item && typeof item === 'object' && 'content' in item)) return body.prompt.map((message, index) => ({ ...message, index, role: message.role || 'unknown' }));
    if (direction === 'output' && Array.isArray(body?.choices)) return body.choices.map((choice, index) => {
        if (!choice || typeof choice !== 'object') return { index, role: 'unknown', content: choice };
        const message = choice.message ?? choice.delta;
        return message ? { ...message, index, choiceIndex: choice.index ?? index, role: message.role || 'assistant' }
            : { index, choiceIndex: choice.index ?? index, role: 'assistant', content: choice.text ?? choice };
    });
    if (direction === 'output' && body?.content !== undefined) return [{ index: 0, role: body.role || 'assistant', content: body.content }];
    if (direction === 'output' && Array.isArray(body?.candidates)) return body.candidates.map((candidate, index) => ({ index, role: 'assistant', content: candidate?.content?.parts ?? candidate }));
    const content = direction === 'input' ? body?.prompt ?? body : body ?? record.responseRaw;
    return content !== undefined && content !== null && content !== '' ? [{ index: 0, role: 'unknown', content }] : [];
}

export function filterTraceRecords(records, source = '', search = '') {
    const query = search.trim().toLocaleLowerCase();
    return records.filter(record => (!source || (record.source || '来源未确认') === source) && (!query ||
        [record.label, record.source, record.id, record.context?.character, record.context?.chatId, stringOf(record.request), record.responseRaw, record.error]
            .some(value => String(value ?? '').toLocaleLowerCase().includes(query)))).slice().reverse();
}

/** Stable selection: incoming records never take over the record being read. */
export function selectedTraceId(records, selected) {
    if (selected && records.some(record => record.id === selected)) return selected;
    return records.at(-1)?.id ?? null;
}

export function createTraceViewer(doc, store, { exportProblem } = {}) {
    const h = (tag, className = '', text) => { const node = doc.createElement(tag); node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
    const button = (label, action, key) => { const node = h('button', 'dwm-button', label); node.type = 'button'; node.dataset.focus = `trace-${key || label}`; node.addEventListener('click', action); return node; };
    const element = h('section', 'dwm-traces'); element.setAttribute('aria-label', '实际收发记录');
    const heading = h('div', 'dwm-trace-heading'); heading.append(h('h3', '', '收发记录'), h('p', 'dwm-muted', '查看本页实际发生的模型请求。只在当前页面内存中保留，刷新后清空；这些记录不会送给模型。'));
    const capacity = h('p', 'dwm-muted dwm-hint');
    const actions = h('div', 'dwm-row');
    const feedback = h('p', 'dwm-hint'); feedback.setAttribute('role', 'status');
    const downloadArea = h('div', 'dwm-row'); downloadArea.hidden = true;
    const layout = h('div', 'dwm-trace-layout');
    const sidebar = h('aside', 'dwm-trace-sidebar'); sidebar.setAttribute('aria-label', '请求列表');
    const searchWrap = h('label', 'dwm-field'); searchWrap.append(h('span', 'dwm-label', '搜索收发内容'));
    const searchInput = h('input'); searchInput.type = 'search'; searchInput.placeholder = '任务、角色或正文'; searchInput.dataset.focus = 'trace-search'; searchWrap.append(searchInput);
    const sourceWrap = h('label', 'dwm-field'); sourceWrap.append(h('span', 'dwm-label', '来源'));
    const sourceInput = h('select'); sourceInput.dataset.focus = 'trace-source'; sourceWrap.append(sourceInput);
    const listCount = h('p', 'dwm-muted dwm-hint');
    const list = h('div', 'dwm-trace-list'); list.dataset.scroll = 'trace-list';
    const reader = h('article', 'dwm-trace-reader'); reader.dataset.scroll = 'trace-reader'; reader.setAttribute('aria-label', '选中请求');
    sidebar.append(searchWrap, sourceWrap, listCount, list); layout.append(sidebar, reader); element.append(heading, actions, capacity, feedback, downloadArea, layout);
    let active = false, destroyed = false, selected = null, direction = 'input', mode = 'read', search = '', source = '', composing = false, pending = false;
    let lastRecord = '', listLimit = 60, refreshTimer = null, preparedDownload = null;
    const expanded = new Map(), pages = new Map();
    const snapshot = () => store?.snapshot?.() ?? { records: [], droppedRecords: 0, totalChars: 0 };
    const current = () => snapshot().records.find(record => record.id === selected);
    function clearDownload() {
        if (preparedDownload) {
            preparedDownload.link?.remove();
            preparedDownload.urlApi.revokeObjectURL(preparedDownload.url);
            preparedDownload = null;
        }
        downloadArea.hidden = true;
    }
    function download(data, filename) {
        if (destroyed) return false;
        clearDownload();
        const urlApi = doc.defaultView?.URL ?? globalThis.URL;
        try {
            const BlobType = doc.defaultView?.Blob ?? globalThis.Blob;
            const url = urlApi.createObjectURL(new BlobType([JSON.stringify(data, null, 2)], { type: 'application/json' }));
            preparedDownload = { url, urlApi, link: null };
            const link = h('a', 'dwm-button', `下载文件：${filename}`); link.href = url; link.download = filename;
            preparedDownload.link = link;
            link.addEventListener('click', () => { feedback.textContent = '已发起下载，请确认浏览器保存结果。未保存时可再次点击下载文件；内容可能包含剧情与提示词。'; });
            downloadArea.append(link); downloadArea.hidden = false;
            // Keep a real link for a fresh user click if the browser silently
            // blocks the asynchronous automatic attempt. Reuse the same Blob.
            link.click();
            return true;
        } catch { clearDownload(); feedback.textContent = '当前环境无法下载记录。'; return false; }
    }
    const exportCurrent = button('导出这一条', () => { const record = current(); if (record) download(record, `鱼忆-收发-${String(record.id).replace(/[^\w-]/g, '_')}.json`); });
    if (typeof exportProblem === 'function') {
        const problemButton = button('导出本次问题', async () => {
            clearDownload();
            problemButton.disabled = true; feedback.textContent = '正在整理当前存档的诊断，文件包含相关剧情与提示词。';
            try { download(await exportProblem(), '鱼忆-本次问题.json'); }
            catch (error) { feedback.textContent = `导出未完成：${error.message}`; }
            finally { problemButton.disabled = false; }
        }); actions.append(problemButton);
    }
    actions.append(exportCurrent, button('导出全部', () => download(store?.exportData?.() ?? snapshot(), '鱼忆-收发记录.json')), button('清空记录', () => { clearDownload(); store?.clear?.(); selected = null; expanded.clear(); pages.clear(); lastRecord = ''; refresh(); feedback.textContent = '本页收发记录已清空。'; }));
    function rememberInteraction(root) {
        const focused = root.contains(doc.activeElement) ? doc.activeElement : null;
        return { key: focused?.dataset.focus, top: root.scrollTop, left: root.scrollLeft };
    }
    function restoreInteraction(root, state) {
        root.scrollTop = state.top; root.scrollLeft = state.left;
        if (state.key) [...root.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === state.key)?.focus({ preventScroll: true });
    }
    function disclosure(parent, title, key, defaultOpen, fill, hint = '') {
        const box = h('details', 'dwm-trace-block'); box.open = expanded.has(key) ? expanded.get(key) : defaultOpen;
        const summary = h('summary'); summary.dataset.focus = `trace-${key}`; summary.append(h('span', '', title));
        if (hint) summary.append(h('small', 'dwm-muted', hint));
        box.append(summary); let filled = false;
        const populate = () => { if (!filled && box.open) { filled = true; const body = h('div', 'dwm-trace-block-body'); box.append(body); fill(body); } };
        box.addEventListener('toggle', () => { expanded.set(key, box.open); populate(); }); parent.append(box); populate(); return box;
    }
    function renderValue(parent, original, key, depth = 0, budget = { nodes: 0 }, { heading = '', attributes = false } = {}) {
        if (++budget.nodes > 200 || depth > 16) { parent.append(h('p', 'dwm-muted', '此层内容较多，请切换原文或导出查看完整记录。')); return; }
        const value = readableValue(original);
        if (value === null || typeof value !== 'object') {
            const blocks = typeof value === 'string' ? splitStructuredText(value) : [{ kind: 'text', raw: value === null ? 'null' : String(value ?? '') }];
            for (const [index, block] of blocks.entries()) {
                if (block.kind === 'json') disclosure(parent, block.title, `${key}/json-tag${index}`, false, target => renderValue(target, block.value, `${key}/json-tag${index}`, depth + 1, budget), '结构化内容 · JSON');
                else parent.append(h('div', 'dwm-trace-prose', block.raw));
            }
            return;
        }
        const properties = [], fields = [];
        if (!Array.isArray(value) && !attributes) for (const [name, item] of Object.entries(value)) {
            const isIdentifier = ATTRIBUTE_FIELDS.has(name.replace(/[^a-z0-9]/gi, '').toLowerCase());
            const repeatedTitle = heading && ['title', 'name', 'comment'].includes(name) && item === heading;
            (isIdentifier || repeatedTitle ? properties : fields).push([name, item]);
        }
        const visible = Array.isArray(value) || attributes ? value : Object.fromEntries(fields);
        const total = Object.keys(visible).length;
        if (!total && !properties.length) { parent.append(h('p', 'dwm-muted', Array.isArray(value) ? '空列表' : '空对象')); return; }
        let offset = 0;
        const more = button('展开更多内容', () => { more.remove(); appendPage(); pages.set(key, offset); }, `more-${key}`);
        function appendPage() {
            const children = valueChildren(visible, offset); offset += children.length;
            for (const child of children) {
                const item = readableValue(child.value), nested = item !== null && typeof item === 'object';
                const name = child.label;
                if (nested) {
                    const preview = ['intro', 'description', 'summary', 'content', 'text'].map(field => item[field]).find(text => typeof text === 'string');
                    const hint = `${Array.isArray(item) ? '列表' : '字段'} · ${Object.keys(item).length} 项${preview ? ` · ${preview.slice(0, 90)}` : ''}`;
                    const firstChildren = offset <= 30 && children.indexOf(child) < 2;
                    disclosure(parent, name, `${key}/${child.key}`, depth < 1 && (total <= 5 || firstChildren), target => renderValue(target, item, `${key}/${child.key}`, depth + 1, { nodes: budget.nodes }, { heading: name }), hint);
                }
                else { const field = h('section', 'dwm-trace-field'); field.append(h('h4', '', name)); renderValue(field, item, `${key}/${child.key}`, depth + 1, budget); parent.append(field); }
            }
            if (offset < total) { more.textContent = `展开后续内容（还有 ${count(total - offset)} 项）`; parent.append(more); }
        }
        do { more.remove(); appendPage(); } while (offset < Math.min(pages.get(key) || 30, total));
        if (properties.length) disclosure(parent, '标识与属性', `${key}/attributes`, false,
            target => renderValue(target, Object.fromEntries(properties), `${key}/attributes`, depth + 1, { nodes: budget.nodes }, { attributes: true }), `${properties.length} 项`);
    }
    function renderRecord(record) {
        const interaction = rememberInteraction(reader); reader.replaceChildren();
        if (!record) { reader.append(h('p', 'dwm-empty', '还没有收发记录。正常游玩或调用辅助模型后，可在这里查看；打开此页不会生成请求。')); return; }
        const title = h('h3', '', record.label || '模型请求'); reader.append(title);
        const meta = h('p', 'dwm-muted dwm-hint', `${record.source || '来源未确认'} · ${statusOf(record)} · ${time(record.startedAt)}`); reader.append(meta);
        reader.append(h('p', 'dwm-muted dwm-hint', `${record.context?.character || '角色未记录'}${record.context?.chatId ? ` · ${record.context.chatId}` : ''}`));
        reader.append(h('p', 'dwm-muted dwm-hint', record.captureNote || (isBoundary(record) ? '辅助接口的提交与返回记录，不代表网络原始收发。' : '记录浏览器可观察到的发送与返回。酒馆服务端仍可能转换供应商协议。')));
        if (record.error) reader.append(h('p', 'dwm-error', record.error));
        if (record.processingError) { const error = h('p', 'dwm-error', `${processingLabel(record) === '处理失败' ? '返回内容处理失败' : processingLabel(record)}：${record.processingError}`); error.setAttribute('role', 'alert'); reader.append(error); }
        if (record.truncated || record.truncatedFields?.length) reader.append(h('p', 'dwm-warning', `记录因容量限制已截断，不能视为完整收发。${record.truncatedFields?.length ? `涉及：${record.truncatedFields.join('、')}` : ''}`));
        const controls = h('div', 'dwm-trace-controls');
        for (const [values, chosen, set] of [[['input', '输入', 'output', '输出'], direction, value => { direction = value; }], [['read', '阅读', 'raw', '原文'], mode, value => { mode = value; }]]) {
            const group = h('div', 'dwm-segments'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', values[0] === 'input' ? '查看方向' : '显示方式');
            for (let i = 0; i < values.length; i += 2) { const b = button(values[i + 1], () => { set(values[i]); lastRecord = ''; refresh(); }, values[i]); b.setAttribute('aria-pressed', String(chosen === values[i])); if (chosen === values[i]) b.classList.add('dwm-selected'); group.append(b); }
            controls.append(group);
        }
        reader.append(controls);
        const key = `${record.id}/${direction}/${mode}`;
        if (mode === 'raw') {
            reader.append(h('p', 'dwm-muted dwm-hint', isBoundary(record)
                ? `辅助接口${direction === 'input' ? '提交的输入' : '提供的返回'}；结构化数据仅做缩进显示，不是网络原始包。`
                : direction === 'input' ? '请求正文原文；结构化 JSON 仅做缩进显示。敏感凭证已在记录时遮盖。' : '模型返回的原始响应文本（包含流式事件时逐帧保留）。'));
            const raw = direction === 'input' ? record.requestRaw ?? stringOf(record.request) : record.responseRaw ?? stringOf(record.responseBody);
            reader.append(h('pre', 'dwm-trace-raw', raw || '尚未收到内容。'));
        } else {
            const messages = traceMessages(record, direction);
            if (!messages.length) reader.append(h('p', 'dwm-empty', '尚未收到内容。'));
            let shown = 0;
            const moreMessages = button('显示更多消息', () => { moreMessages.remove(); appendMessages(); pages.set(`${key}/messages`, shown); }, `more-messages-${key}`);
            function appendMessages() {
                const start = shown; shown = Math.min(messages.length, shown + 30);
                messages.slice(start, shown).forEach((message, localIndex) => {
                const index = start + localIndex;
                const role = ROLES[message.role] || '消息';
                disclosure(reader, `${index + 1} · ${role}${message.choiceIndex !== undefined ? ` · 候选 ${Number(message.choiceIndex) + 1}` : ''}`, `${key}/message${index}`, index < 3, target => {
                    const parts = typeof message.content === 'string' && direction === 'input' ? splitTraceText(message.content, record.provenance) : [{ text: message.content, matched: false }];
                    for (const [partIndex, part] of parts.entries()) {
                        if (part.matched) disclosure(target, part.title, `${key}/${index}/entry${partIndex}`, true, body => renderValue(body, part.text, `${key}/${index}/entry${partIndex}`), '原文匹配');
                        else renderValue(target, part.text, `${key}/${index}/part${partIndex}`);
                    }
                    for (const field of ['reasoning', 'reasoning_content', 'tool_calls', 'tool_call_id']) if (hasContent(message[field])) disclosure(target, fieldName(field), `${key}/${index}/${field}`, field === 'tool_calls', body => renderValue(body, message[field], `${key}/${index}/${field}`));
                }, direction === 'input' ? '按实际消息顺序 · 来源未确认的部分保留原文' : '实际返回');
                });
                if (shown < messages.length) { moreMessages.textContent = `显示后续消息（还有 ${count(messages.length - shown)} 条）`; reader.append(moreMessages); }
            }
            do { moreMessages.remove(); appendMessages(); } while (shown < Math.min(pages.get(`${key}/messages`) || 30, messages.length));
            if (direction === 'input' && record.request && typeof record.request === 'object') {
                const remaining = Object.fromEntries(Object.entries(record.request).filter(([name]) => !['messages', 'prompt'].includes(name)));
                if (Object.keys(remaining).length) disclosure(reader, '请求参数', `${key}/parameters`, false, body => renderValue(body, remaining, `${key}/parameters`));
            }
        }
        restoreInteraction(reader, interaction);
    }
    function refresh() {
        if (!active || destroyed) return;
        if (composing) { pending = true; return; }
        const state = snapshot();
        selected = selectedTraceId(state.records, selected);
        const available = [...new Set(state.records.map(record => record.source || '来源未确认'))];
        const sourceSignature = available.join('\0');
        if (sourceInput.dataset.sources !== sourceSignature) {
            sourceInput.replaceChildren();
            for (const item of ['', ...available]) { const option = h('option', '', item || '全部来源'); option.value = item; sourceInput.append(option); }
            if (source && !available.includes(source)) source = ''; sourceInput.value = source; sourceInput.dataset.sources = sourceSignature;
        }
        capacity.textContent = `本页保留 ${count(state.records.length)} 条 · ${count(state.totalChars)} 字符${state.maxRecords ? ` · 上限 ${count(state.maxRecords)} 条` : ''}${state.maxChars ? `／${count(state.maxChars)} 字符` : ''}${state.droppedRecords ? ` · 较早的 ${count(state.droppedRecords)} 条已移出` : ''}`;
        const filtered = filterTraceRecords(state.records, source, search);
        const interaction = rememberInteraction(list); list.replaceChildren();
        listCount.textContent = `${count(filtered.length)} 条匹配记录`;
        for (const record of filtered.slice(0, listLimit)) {
            const b = button('', () => { selected = record.id; lastRecord = ''; reader.scrollTop = 0; refresh(); }, `record-${record.id}`); b.className += ' dwm-trace-record'; b.setAttribute('aria-pressed', String(record.id === selected));
            b.append(h('strong', '', record.label || '模型请求'), h('span', 'dwm-muted', `${record.source || '来源未确认'} · ${statusOf(record)}`), h('small', 'dwm-muted', time(record.startedAt)));
            if (record.id === selected) b.classList.add('dwm-selected'); list.append(b);
        }
        if (filtered.length > listLimit) list.append(button('显示更多记录', () => { listLimit += 60; refresh(); }, 'more-records'));
        if (!filtered.length) list.append(h('p', 'dwm-empty', state.records.length ? '没有匹配记录。' : '等待实际请求'));
        restoreInteraction(list, interaction);
        const record = state.records.find(item => item.id === selected);
        exportCurrent.disabled = !record;
        const signature = JSON.stringify([record, direction, mode]);
        if (lastRecord !== signature) { lastRecord = signature; renderRecord(record); }
    }
    searchInput.addEventListener('input', () => { search = searchInput.value; listLimit = 60; refresh(); });
    sourceInput.addEventListener('change', () => { source = sourceInput.value; listLimit = 60; refresh(); });
    searchInput.addEventListener('compositionstart', () => { composing = true; });
    searchInput.addEventListener('compositionend', () => { composing = false; if (pending) { pending = false; refresh(); } });
    const unsubscribe = store?.subscribe?.(() => {
        if (!active || destroyed || refreshTimer !== null) return;
        refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 100);
    }) ?? (() => {});
    return { element, refresh, setActive(value) { active = value; if (active) refresh(); }, destroy() { destroyed = true; clearDownload(); clearTimeout(refreshTimer); unsubscribe(); element.remove(); } };
}
