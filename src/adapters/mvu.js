/** Optional, read-only projection of explicitly selected MVU state. No update hooks. */
const OWNER = 'dynamic-world-memory';
const MAX_FIELDS = 16;
const MAX_PATH_CHARS = 256;
const MAX_VALUE_CHARS = 300;
const MAX_TOTAL_VALUE_CHARS = 3000;
const READ_TIMEOUT_MS = 1500;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor', '$internal', '$meta', '$arrayMeta']);

function ownValue(object, key) {
    if (object === null || typeof object !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    // Do not execute accessors, traverse prototypes, or enumerate unselected fields.
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function selectedFields(settings) {
    const configured = Array.isArray(settings.mvuFields) ? settings.mvuFields : [];
    const fields = [], seen = new Set();
    let omitted = Math.max(0, configured.length - MAX_FIELDS);
    for (const item of configured.slice(0, MAX_FIELDS)) {
        const raw = typeof item === 'string' ? item : item?.path;
        if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_PATH_CHARS) { omitted++; continue; }
        const path = raw.trim(), parts = path.split('.');
        if (parts[0] === 'stat_data') parts.shift();
        if (!parts.length || parts.length > 16 || parts.some(part => !part || part.trim() !== part
            || BLOCKED_KEYS.has(part) || /[\u0000-\u001f\u007f\[\]*\\]/u.test(part))) { omitted++; continue; }
        const canonical = `stat_data.${parts.join('.')}`;
        if (canonical.length > MAX_PATH_CHARS) { omitted++; continue; }
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const label = typeof item?.label === 'string' && item.label.trim() ? item.label.trim() : parts.join('.');
        fields.push({ path: canonical, label: label.slice(0, 80), parts });
    }
    return { fields, omitted, configured: configured.length };
}

function readerFrom(globals) {
    if (typeof globals?.Mvu?.getMvuData === 'function') {
        return { owner: globals.Mvu, read: globals.Mvu.getMvuData, source: 'Mvu.getMvuData' };
    }
    if (typeof globals?.TavernHelper?.getVariables === 'function') {
        return { owner: globals.TavernHelper, read: globals.TavernHelper.getVariables, source: 'TavernHelper.getVariables' };
    }
    return null;
}

function observe(context) {
    const live = context();
    if (!live || !Array.isArray(live.chat)) return { status: 'unavailable', reason: '无法核对当前聊天。' };
    const group = live.groupId ?? live.selected_group;
    if (group !== undefined && group !== null && group !== '') return { status: 'unavailable', reason: '暂不支持群聊的 MVU 只读协作。' };
    const file = live.chatId ?? live.getCurrentChatId?.();
    const characterId = live.characterId ?? live.this_chid;
    const character = live.characters?.[characterId];
    const characterKey = character?.avatar ?? characterId;
    if (!file || characterKey === undefined || characterKey === null) return { status: 'unavailable', reason: '无法核对当前角色和存档身份。' };
    const chatId = `character:${characterKey}:${file}`;
    const messageId = live.chat.length - 1, message = live.chat[messageId];
    if (!message) return { status: 'missing', reason: '当前聊天还没有可读取的回复。' };
    if (message.is_user || message.role === 'user') return { status: 'pending', reason: '末楼是玩家消息；本轮回复未完成，不回退读取上一条回复的状态。' };
    if (message.is_system && message.extra?.dwmHidden?.owner !== OWNER && message.role !== 'assistant') {
        return { status: 'pending', reason: '末楼是系统消息或无法确认归属的隐藏消息，暂不读取更早状态。' };
    }
    if (message.role === 'system') return { status: 'pending', reason: '末楼不是角色回复，暂不读取更早状态。' };
    const swipeId = message.swipe_id ?? 0;
    if (!Number.isInteger(swipeId) || swipeId < 0 || (Array.isArray(message.swipes) && swipeId >= message.swipes.length)) {
        return { status: 'pending', reason: '当前回复候选尚未稳定。' };
    }
    return { chatId, chat: live.chat, message, messageId, swipeId, messageCount: live.chat.length,
        text: message.mes ?? message.content,
        messageKey: typeof message.extra?.dwmKey === 'string' ? `${message.extra.dwmKey}:swipe:${swipeId}` : null };
}

function sameObservation(before, after) {
    return !after.status && before.chatId === after.chatId && before.chat === after.chat
        && before.message === after.message && before.messageId === after.messageId
        && before.swipeId === after.swipeId && before.messageCount === after.messageCount
        && before.text === after.text && before.messageKey === after.messageKey;
}

async function boundedRead(reader, messageId) {
    // Invoke before yielding so the numeric ID is read in the just-observed active chat.
    const pending = reader.read.call(reader.owner, { type: 'message', message_id: messageId });
    let timer;
    try {
        return await Promise.race([
            Promise.resolve(pending).then(data => ({ data })),
            new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), READ_TIMEOUT_MS); }),
        ]);
    } finally { clearTimeout(timer); }
}

/**
 * context should be a synchronous getter of the live ST context, not a saved snapshot.
 * settings: { mvuEnabled: true, mvuFields: [{ path: '角色.位置', label: '位置' }] }.
 * Paths are relative to stat_data (the explicit stat_data. prefix is also accepted).
 * Only scalar leaves are returned. ready means a consistent observation, not a persisted
 * or final MVU update. Consumers must bind freshness to their own story/save boundary.
 */
export async function readMvuProjection({ context, settings = {}, globals = globalThis } = {}) {
    const enabled = settings.mvuEnabled === true;
    const base = { enabled, available: false, status: 'disabled', fields: [], messageId: null, swipeId: null,
        reason: 'MVU 只读协作未开启。', source: null, freshness: null };
    if (!enabled) return base;
    let reader;
    try { reader = readerFrom(globals); } catch { return { ...base, status: 'unavailable', reason: 'MVU 读取接口不可用。' }; }
    if (!reader) return { ...base, status: 'unavailable', reason: '未发现可用的 MVU 或酒馆助手读取接口。' };
    const available = { ...base, available: true, source: reader.source };
    const configured = selectedFields(settings);
    if (!configured.fields.length) return { ...available, status: configured.configured ? 'invalid-settings' : 'unconfigured',
        reason: configured.configured ? '所选字段路径无效；仅允许 stat_data 下的明确叶子路径。' : '尚未选择允许读取的字段。' };
    const getContext = typeof context === 'function' ? context
        : typeof globals?.SillyTavern?.getContext === 'function' ? () => globals.SillyTavern.getContext() : null;
    if (!getContext) return { ...available, status: 'unavailable', reason: '需要可重新读取活动聊天的上下文，不能使用静态聊天副本。' };
    let before;
    try {
        before = observe(getContext);
        if (before.status) return { ...available, status: before.status, reason: before.reason };
        const targeted = { ...available, messageId: before.messageId, swipeId: before.swipeId };
        if (typeof globals?.Mvu?.isDuringExtraAnalysis === 'function' && globals.Mvu.isDuringExtraAnalysis() === true) {
            return { ...targeted, status: 'pending', reason: 'MVU 仍在额外分析，暂不读取本条状态。' };
        }
        const result = await boundedRead(reader, before.messageId);
        if (!sameObservation(before, observe(getContext)) || readerFrom(globals)?.owner !== reader.owner
            || readerFrom(globals)?.read !== reader.read) {
            return { ...targeted, status: 'changed', reason: '读取期间聊天、正文或选中回复已变化，本次结果已丢弃。' };
        }
        if (result.timeout) return { ...targeted, status: 'pending', reason: '读取 MVU 状态超时，本轮暂不使用；没有回退到旧状态。' };
        if (typeof globals?.Mvu?.isDuringExtraAnalysis === 'function' && globals.Mvu.isDuringExtraAnalysis() === true) {
            return { ...targeted, status: 'pending', reason: '读取期间 MVU 开始额外分析，本次结果暂不使用。' };
        }
        const data = ownValue(result.data, 'stat_data');
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return { ...targeted, status: 'missing', reason: '当前选中回复尚无可用的 MVU 状态；没有读取更早楼层。' };
        }
        const fields = [];
        let omitted = configured.omitted, total = 0;
        for (const field of configured.fields) {
            let value = data;
            for (const part of field.parts) value = ownValue(value, part);
            const scalar = value === null || typeof value === 'string' || typeof value === 'boolean'
                || (typeof value === 'number' && Number.isFinite(value));
            const size = scalar ? String(value).length : Infinity;
            if (!scalar || size > MAX_VALUE_CHARS || total + size > MAX_TOTAL_VALUE_CHARS) { omitted++; continue; }
            fields.push({ path: field.path, label: field.label, value }); total += size;
        }
        return { ...targeted, fields, status: fields.length ? (omitted ? 'partial' : 'ready') : 'missing',
            reason: fields.length
                ? `${omitted ? '部分所选字段缺失、非叶子或超出上限，已省略。' : ''}仅为当前选中回复的内存快照，未核验保存成功或 MVU 最终完成。`
                : '所选字段缺失、不是标量叶子或超出上限，暂不提供状态。',
            freshness: { chatId: before.chatId, messageKey: before.messageKey, messageCount: before.messageCount,
                observedAt: new Date().toISOString(), persistence: 'unverified' } };
    } catch {
        // Upstream errors may contain unselected values, endpoints or other private data.
        return { ...available, messageId: before?.messageId ?? null, swipeId: before?.swipeId ?? null,
            status: 'error', reason: 'MVU 状态读取失败，本轮暂不使用；未修改变量或回退读取旧状态。' };
    }
}
