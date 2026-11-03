/** 超级懒人模式的文案。窗口、悬浮气泡和扩展设置共用，状态只来自 view.lazy。 */
const STAGES = { classify: '整理世界书条目', strategy: '统合记忆策略', history: '扫描已有剧情' };
const TASKS = { init: '建立记忆', maintain: '记录新剧情', sync: '同步原世界书', compact: '整理记忆' };
// What stays undone while a task is stopped or failed, by task.
const UNDONE = { init: '记忆尚未建立完成', maintain: '新剧情尚未记入记忆', sync: '原世界书的更新尚未同步', compact: '本次整理尚未完成，已有记忆不受影响' };
export const LAZY_CONFLICT_NOTE = '如需改用新原文，请切换到高级模式，在资料中打开该条目并点击“复原”。';
const floors = (from, to) => !Number.isFinite(from) ? '' : !Number.isFinite(to) || to === from ? `第 ${from} 楼` : `第 ${from}–${to} 楼`;
// Fixed times, not “刚刚” or “2 分钟前”: the window only re-renders when something changes, so relative times go stale.
const clock = (value, now = Date.now()) => {
    const date = new Date(value);
    if (!value || Number.isNaN(date.valueOf())) return '';
    return new Date(now).toDateString() === date.toDateString() ? hhmm(date) : `${date.getMonth() + 1}/${date.getDate()}`;
};
const hhmm = date => date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
export const lazyClock = clock;
const at = value => { const date = new Date(value); return !value || Number.isNaN(date.valueOf()) ? '' : hhmm(date); };
const updated = (value, now) => { const when = clock(value, now); return when ? `${when} 更新` : ''; };

/** Attention card copy; `context` carries what the card cannot read from `attention` itself. */
export function lazyAttention(attention, { connectionMode = 'raw', capacityPercent = null } = {}) {
    if (!attention) return null;
    const time = at(attention.at), tries = Number(attention.attempts) || 0, range = attention.floors ? floors(attention.floors.from, attention.floors.to) : '';
    const tavern = connectionMode !== 'compatible', error = attention.error ? `（${attention.error}）` : '';
    if (attention.reason === 'connection') return { sub: '无法连接模型', body: [
        `当前使用${tavern ? '酒馆的连接' : '单独设置的辅助模型'}。${tries ? `已自动重试 ${tries} 次，均未成功；` : ''}最近一次失败于 ${time}${error}。`,
        '剧情不受影响，期间按原世界书发送。连接恢复后，请点击“立即重试”补记这部分剧情。'],
    actions: ['retry', 'export'], retryLabel: '立即重试',
    fine: tavern ? '若酒馆本身也无法发送消息，请先检查酒馆的连接设置。' : '可切换到高级模式，在“设置 → 辅助模型”中检查该连接。' };
    if (attention.reason === 'output') return { sub: '模型返回内容不完整', body: [
        `${tries ? `已自动重试 ${tries} 次，` : ''}模型返回的内容不完整或格式不符，这部分剧情尚未记入记忆。`,
        '剧情不受影响，期间按原世界书发送。可点击“重试”；如仍失败，请导出本次问题反馈给作者，或更换辅助模型。'],
    actions: ['retry', 'export'], retryLabel: '重试' };
    if (attention.reason === 'quota') return { sub: '接口额度不足', body: [
        '接口返回“额度不足”。此类错误无法通过重试解决，自动重试已停止。',
        '剧情不受影响，期间按原世界书发送。充值或在酒馆更换连接后，请点击“重试”补记这部分剧情。'],
    actions: ['retry', 'export'], retryLabel: '重试' };
    if (attention.reason === 'moderation') return { sub: '部分剧情被接口拒收', body: range ? [
        `辅助接口的内容审核拒收了${range}的整理请求，这些楼层未记入记忆。处理完成前，后续剧情暂停记录，发送按原世界书进行。`,
        `在酒馆更换连接后，可点击“重试”补记这些楼层。${attention.canIgnore ? '也可点击“忽略”跳过这些楼层，后续剧情将恢复记录。' : ''}`] : [
        '辅助接口的内容审核拒收了一次整理请求，相关内容未记入记忆。处理完成前，发送按原世界书进行。',
        '在酒馆更换连接后，可点击“重试”。'],
    actions: attention.canIgnore ? ['retry', 'ignore'] : ['retry'], retryLabel: '重试' };
    if (attention.reason === 'storage') return { sub: '存档写入失败', body: [
        // attention.error is worded for model calls (“辅助接口 HTTP …”); the export keeps the storage detail.
        `鱼忆的保存请求未得到酒馆确认，最近一次失败于 ${time}。此前已保存的记忆不受影响，本次的新进度尚未确认保存，自动处理已暂停。`,
        '剧情不受影响，期间按原世界书发送。请确认酒馆仍在运行、当前聊天可以正常保存后，点击“重试”。如仍失败，请导出本次问题反馈给作者。'],
    actions: ['retry', 'export'], retryLabel: '重试',
    fine: '同一聊天在多个页面或设备上同时打开时，也可能导致保存失败。' };
    if (attention.reason === 'capacity') {
        const percent = Number.isFinite(attention.percent) ? attention.percent : capacityPercent;
        return { sub: '存档容量即将用尽', title: '需要处理', body: [
            `已自动整理一次，存档仍占用容量的${Number.isFinite(percent) ? ` ${Math.round(percent)}%` : '大部分'}。已有记忆仍可使用；容量用尽后，新的记忆将无法保存。`,
            '请先在酒馆导出本聊天的备份，再切换到高级模式删减不需要的条目。鱼忆不会自动删除资料。'],
        actions: ['to-manual'] };
    }
    // 'paused' and any reason this copy does not know yet: a failure without an automatic retry.
    const task = TASKS[attention.task];
    return { sub: '自动处理未能完成', body: [
        `${task ? `“${task}”` : '一项自动处理'}未能完成${time ? `，失败于 ${time}` : ''}${error}。此类错误不会自动重试，${UNDONE[attention.task] ?? '相关内容尚未处理'}。`,
        '剧情不受影响，期间按原世界书发送。可点击“重试”；如仍失败，请导出本次问题反馈给作者。'],
    actions: ['retry', 'export'], retryLabel: '重试' };
}

/** Whole-scan progress (0–1) across classify, strategy and history steps; null outside a scan. */
export function scanProgress(status) {
    const stage = status?.stage, batch = status?.batch;
    if (!stage?.total) return null;
    return Math.max(0.02, Math.min(1, ((stage.index - 1) + (batch?.total ? (Number(batch.done) || 0) / batch.total : 0)) / stage.total));
}

/** The hero line: { tone: ok|busy|quiet|attn, title, sub, progress (0–1 | null) }. */
export function lazyHeadline(view, now = Date.now()) {
    const lazy = view.lazy ?? {}, status = lazy.status ?? {}, attention = lazyAttention(lazy.attention, { connectionMode: view.connectionMode, capacityPercent: lazy.capacityPercent });
    if (!view.settings?.enabled) return { tone: 'quiet', title: '鱼忆已关闭', sub: '已有资料保留，重新打开后自动继续。', action: 'enable' };
    if (view.save?.initialized && view.saveEnabled === false) return { tone: 'quiet', title: '本存档记忆已暂停', sub: '已有资料保留，启用后自动继续。', action: 'save-enable' };
    if (attention) return { tone: 'attn', title: attention.title ?? '记忆暂停更新', sub: attention.sub };
    if (status.state === 'stopped') {
        const task = status.stoppedTask;
        if (task === 'init') return { tone: 'quiet', title: '已停止建立记忆', sub: '鱼忆不会自动重新开始，已保存的扫描进度将保留。点击“继续”后从中断处接着建立；建立完成前按原世界书发送。', action: 'resume' };
        return { tone: 'quiet', title: TASKS[task] ? `已停止${TASKS[task]}` : '自动处理已停止', sub: `${UNDONE[task] ?? '未完成的处理已暂停'}。鱼忆不会自动重新开始，点击“继续”完成这项处理。`, action: 'resume' };
    }
    const active = Boolean(view.activity || view.progress);
    if (status.state === 'building' && active) {
        const stage = status.stage, batch = status.batch;
        const part = batch?.total ? `${STAGES[stage?.label] ?? '建立记忆'}：第 ${Math.min(batch.total, (Number(batch.done) || 0) + 1)} 批，共 ${batch.total} 批` : STAGES[stage?.label] ?? '准备中';
        const step = stage?.total ? ` · 第 ${stage.index} 步，共 ${stage.total} 步` : '';
        return { tone: 'busy', title: '正在建立记忆', sub: part + step, progress: scanProgress(status) ?? 0.02 };
    }
    if (status.state === 'building' || status.waitingReason) return { tone: 'quiet', title: view.save?.initialized ? '等待中' : '等待建立记忆', sub: status.waitingReason ?? '鱼忆将在空闲时自动开始。' };
    if (status.state === 'maintaining') {
        const pending = Number(view.diagnostics?.pendingCount) || 0, from = (Number(status.floor) || 0) + 1;
        return { tone: 'busy', title: '正在记录新剧情', sub: pending ? floors(from, from + pending - 1) : '核对新剧情' };
    }
    if (status.state === 'syncing') {
        const c = view.sourceChanges, count = c?.changed ? c.added.length + c.updated.length + c.removed.length : 0;
        return { tone: 'busy', title: '正在同步原世界书', sub: count ? `原世界书有 ${count} 条条目变更` : '核对原世界书的变更' };
    }
    if (status.state === 'compacting') return { tone: 'busy', title: '正在整理记忆', sub: '合并重复条目，精简故事脉络' };
    if (status.state === 'retrying') return { tone: 'busy', title: '正在重试', sub: status.retryReason === 'connection' ? '重新连接模型' : '重新执行未完成的整理' };
    if (status.state === 'waiting-retry') {
        const next = at(status.nextRetryAt);
        return { tone: 'quiet', title: status.retryReason === 'connection' ? '连接暂时中断' : '等待自动重试',
            sub: `${status.retryReason === 'connection' ? '' : '上次整理未完成，'}${next ? `将于 ${next} 自动重试` : '将在下次发送消息后重试'}，剧情不受影响。` };
    }
    // status.floor is the processing cursor: ignored floors are inside it but were never remembered.
    const ignored = Number(status.ignoredFloors) || 0;
    return { tone: 'ok', title: '记忆正常', sub: [`已记录至第 ${Number(status.floor) || 0} 楼${ignored ? `（其中 ${ignored} 楼已忽略）` : ''}`, updated(status.updatedAt, now)].filter(Boolean).join('，') };
}

/** Short form for the bubble and the extension drawer. Reads `controller.uiStatus()` as well as a full view. */
export function lazyShortStatus(view) {
    const lazy = view.lazy ?? {}, status = lazy.status ?? {};
    if (view.enabled === false || view.settings?.enabled === false) return '记忆已暂停';
    if (lazy.attention) return lazy.attention.reason === 'capacity' ? '存档容量即将用尽' : `记忆暂停更新：${lazyAttention(lazy.attention).sub}`;
    if (status.state === 'stopped') return TASKS[status.stoppedTask] ? `已停止${TASKS[status.stoppedTask]}` : '自动处理已停止';
    if (status.state === 'building') return view.activity ? '正在建立记忆' : '等待建立记忆';
    const busy = { maintaining: '正在记录新剧情', syncing: '正在同步原世界书', compacting: '正在整理记忆', retrying: '正在重试' }[status.state];
    if (busy) return busy;
    if (status.state === 'waiting-retry') return status.retryReason === 'connection' ? '连接暂时中断，等待自动重试' : '等待自动重试';
    return status.waitingReason ? '等待中' : '记忆正常';
}

const PAUSED = { connection: '连接中断，等待自动重试', output: '模型返回内容不完整，等待自动重试', quota: '接口额度不足，自动重试已停止',
    capacity: '整理后存档仍接近容量上限', storage: '存档写入失败，自动处理已暂停', cancelled: '自动处理已停止', 'branch-changed': '剧情分支已变更，跳过本次补记' };
/** One “最近自动处理” row: { text, note }. */
export function lazyRecord(record) {
    const r = record ?? {};
    if (r.type === 'init') {
        const ignored = Number(r.ignoredFloors) || 0;
        return { text: Number(r.floors) > 1 ? `建立记忆：扫描已有剧情 ${r.floors} 楼${ignored ? `（其中 ${ignored} 楼已忽略）` : ''}，整理 ${r.entries ?? 0} 条世界书条目` : `建立记忆：整理 ${r.entries ?? 0} 条世界书条目，记录开场` };
    }
    if (r.type === 'maintain') return { text: Number(r.to) >= Number(r.from) ? `记录${floors(r.from, r.to)}` : '核对新剧情，无需记录' };
    if (r.type === 'sync') return { text: `同步原世界书的更新：${r.count ?? 0} 条` };
    if (r.type === 'held-kept') return { text: `「${r.title || '未命名条目'}」原书有新版本，与剧情中的改动冲突，已保留当前版本`, note: LAZY_CONFLICT_NOTE };
    if (r.type === 'compact') {
        const parts = [Number(r.merged) > 0 && `合并 ${r.merged} 条重复条目`, Number(r.condensed) > 0 && `精简 ${r.condensed} 处`].filter(Boolean);
        return { text: parts.length ? `整理记忆：${parts.join('，')}` : '整理记忆：无需合并' };
    }
    if (r.type === 'retry') {
        const range = r.floors ? floors(r.floors.from, r.floors.to) : '';
        // A successful retry is one record; non-story work keeps its own result in `completion`.
        if (r.ok && r.completion && r.completion.type !== 'maintain') return { text: `${lazyRecord(r.completion).text}（重试成功）` };
        if (r.ok) return { text: `重试成功${range ? `，已补记${range}` : ''}` };
        return { text: `第 ${r.attempt} 次重试失败${r.attempt >= 4 ? '，自动重试已停止' : r.attempt === 3 ? '，将在下次发送消息后重试' : ''}` };
    }
    if (r.type === 'moderation') return { text: Number.isFinite(r.from) ? `${floors(r.from, r.to)}的整理请求被内容审核拒收` : '一次整理请求被内容审核拒收' };
    if (r.type === 'ignored') return { text: `已忽略${floors(r.from, r.to)}，不再重试` };
    if (r.type === 'paused') return { text: PAUSED[r.reason] ?? '自动处理未完成，已暂停' };
    return { text: '自动处理' };
}
