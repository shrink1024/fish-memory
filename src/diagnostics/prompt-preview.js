import { clone, isPrefix } from '../core/util.js';
import { DEFAULT_SETTINGS, makeSourceEntry, entryText, normalizeScopeId, readableScopes, entryScope } from '../core/state.js';
import { applyRules, compileRules, discoverRules } from '../rules/index.js';
import { INITIALIZE, ALIGN_STRATEGY, MAINTAIN, SELECT, COMPACT } from '../agents/prompts.js';
import { initializeRequest, selectRequest, maintainRequest, compactRequest, requestBatches, selectionMessages } from '../agents/requests.js';

const AGENTS = {
    initialize: { id: 'fish-initialize', title: '鱼忆 · 初始化 Agent', description: '扫描主世界书、分类资料并统合记忆策略；分批扫描与策略统合属于同一职责。', identified: true },
    select: { id: 'fish-select', title: '鱼忆 · 前置 Agent', description: '发送正文前，依据当前输入、近期剧情和动态目录选择需要补充的记忆资料。', identified: true },
    maintain: { id: 'fish-maintain', title: '鱼忆 · 后置 Agent', description: '在正文保存后补记已发生的事实，维护允许更新的资料，并按需整理脉络与事件。', identified: true },
};

function stage(agent, id, title, status, explanation, request, uncertainties = []) {
    return { id, title, agent: { ...agent }, kind: 'request', status, explanation, system: request.system, input: request.input ?? null, uncertainties };
}
function guarded(save, compiledRules) {
    const copy = clone(save);
    copy.data.entries = Object.fromEntries(applyRules(Object.values(copy.data.entries), compiledRules).entries.map(entry => [entry.id, entry]));
    return copy;
}
function observationFor(observedState, snapshot, messages, settings) {
    const latest = snapshot.messages.at(-1);
    if (!settings.mvuEnabled || settings.mvuBookName !== snapshot.bookName || !latest
        || observedState?.messageKey !== latest.key || !messages.some(message => message.key === latest.key)) return null;
    // The controller supplies its existing freshness-checked, allow-listed MVU
    // projection. Do not accept a whole MVU object as an alternate data source.
    if (observedState.source !== 'MVU read-only observation' || !observedState.fields?.length) return null;
    return { source: observedState.source, messageKey: latest.key, persistence: 'unverified', fields: clone(observedState.fields) };
}
function pendingBatches(snapshot, save, settings) {
    const scopes = save.data.messageScopes ?? {};
    const activeScopeId = normalizeScopeId(save.data.scopeContext?.activeScopeId);
    const runs = [];
    for (const message of snapshot.messages.slice(save.processed.length)) {
        const scoped = { ...message, scopeId: normalizeScopeId(scopes[message.key] ?? message.scopeId ?? activeScopeId) };
        if (runs.at(-1)?.[0].scopeId === scoped.scopeId) runs.at(-1).push(scoped);
        else runs.push([scoped]);
    }
    return runs.flatMap(run => requestBatches(run, settings.batchChars));
}

/** Read-only request assembly. Does not select entries, refresh variables, mutate
 * a save, call a model, or include player diagnostics in a model projection.
 * Conditional stages may contain only the fields already known; omitted fields
 * are described in uncertainties, never replaced with pretend model outputs.
 */
export function buildPromptPreview({ snapshot, save = null, settings: suppliedSettings = {}, rules: suppliedRules,
    compiledRules: suppliedCompiledRules, connectionMode = 'raw', observedState = null, busy = {},
    rawEntries = null, eligible = entry => entry.enabled, at = new Date().toISOString() } = {}) {
    const settings = { ...DEFAULT_SETTINGS, ...suppliedSettings };
    const rules = suppliedRules ?? (rawEntries ? discoverRules(rawEntries) : { naturalLanguage: '', script: '', configEntryUids: [] });
    const compiledRules = suppliedCompiledRules ?? compileRules(rules.script);
    const warnings = [], stages = [];
    const context = snapshot ?? { messages: [], chatId: null, bookName: '' };
    const sameSave = Boolean(save && save.chatId === context.chatId && save.bookName === context.bookName);
    const initialized = sameSave && save.initialized;
    const pathMatches = initialized && isPrefix(save.processed, context.messages.map(message => message.key));
    if (!settings.enabled) warnings.push('动态记忆当前关闭；普通发送不会调用前置或自动后置。这里展示启用后的组装方式。');
    if (context.group) warnings.push('群聊暂不受支持，下面的请求不会自动执行。');
    if (!context.templateEnabled) warnings.push('尚未确认 ST-Prompt-Template 已启用；初始化和接管原生世界书需要此依赖。');
    if (save && !sameSave) warnings.push('存档与当前聊天或主世界书不匹配；未展示其他存档的资料。');
    if (initialized && !pathMatches) warnings.push('当前所选剧情与已保存记忆不一致；实际发送会先回放存档，本页没有执行回放。');
    if (busy.initializing) warnings.push('初始化正在运行；此时继续发送会走酒馆原生流程。初始化完成后请重新预览。');
    if (busy.maintaining || busy.compacting) warnings.push('后台正在更新记忆；本页按当前已保存版本展示，完成后需刷新预览。');
    if (['raw', 'tavern'].includes(connectionMode)) warnings.push('显示鱼忆交给酒馆辅助生成接口的 system 与 input；酒馆或其他插件仍可能在传输前加工。');
    warnings.push('这是发送前的只读组装预览，不会产生模型请求。最终收发请在“收发”页核对。');

    let groups = null;
    if (Array.isArray(rawEntries) && context.bookName) {
        const entries = rawEntries.filter(entry => !rules.configEntryUids.includes(entry.uid)).map(entry => makeSourceEntry(context.bookName, entry));
        groups = requestBatches(entries, settings.batchChars, entryText);
        if (!groups.length) stages.push(stage(AGENTS.initialize, 'initialize', '扫描世界书', 'skipped', '主书没有需要分类的条目，本步不调用模型。', { system: INITIALIZE }));
        for (const [index, batch] of groups.entries()) stages.push(stage(AGENTS.initialize, `initialize-${index + 1}`, `扫描世界书 · ${index + 1}/${groups.length}`,
            initialized || busy.initializing ? 'conditional' : 'ready',
            initialized ? '仅在玩家重新初始化时执行；当前正常发送不会重新扫描原书。' : '初始化时按原书顺序分批分类；规则配置条目不进入本批。',
            initializeRequest(batch, rules.naturalLanguage), ['分类、简介与各批记忆策略需等待本批模型输出；本页不执行分类。']));
    } else stages.push(stage(AGENTS.initialize, 'initialize', '扫描世界书', 'unavailable', '尚未取得当前主绑定世界书，无法确定扫描批次。', { system: INITIALIZE }, ['原书条目与分批内容尚未取得。']));
    if (groups && groups.length <= 1) stages.push(stage(AGENTS.initialize, 'strategy', '统合记忆策略', 'skipped', '至多一批扫描结果，不调用统合模型；直接采用该批策略或空策略。', { system: ALIGN_STRATEGY }));
    else stages.push(stage(AGENTS.initialize, 'strategy', '统合记忆策略', 'conditional', '只有扫描得到至少两种不同且非空的策略才调用本模型；相同策略直接复用。', { system: ALIGN_STRATEGY },
        ['strategies 取决于初始化各批返回值，目前未知。', 'catalog 使用初始化分类并应用作者脚本后的 id、title、kind、intro；目前未知。']));

    const unavailableReason = !initialized ? '当前存档尚未初始化；需先得到动态条目与记忆策略。'
        : !pathMatches ? '需先依据当前所选剧情回放存档，当前版本不能当作本轮输入。' : '';
    if (unavailableReason) {
        stages.push(stage(AGENTS.select, 'select', '前置选材', 'unavailable', unavailableReason, { system: SELECT }, ['动态目录、常驻脉络和选材输入待存档就绪后确定。']));
        stages.push(stage(AGENTS.maintain, 'maintain', '后置维护', 'unavailable', unavailableReason, { system: MAINTAIN }, ['初始化后的记忆以及待维护剧情批次尚未确定。']));
        stages.push(stage(AGENTS.maintain, 'compact', '整理事件', 'unavailable', unavailableReason, { system: COMPACT }, ['当前范围脉络和可整理事件尚未确定。']));
        return { at, chatId: context.chatId ?? null, revision: sameSave ? save.revision : null, warnings, stages };
    }

    const recent = selectionMessages(context, save, settings.recentTurns);
    const scopes = readableScopes(save.data.scopeContext);
    const eligibleHere = entry => scopes.has(entryScope(entry)) && eligible(entry);
    const selectObservation = observationFor(observedState, context, recent, settings);
    const selectUncertainties = ['前置返回的 ids 尚未产生；绿灯资料是否进入正文要等选材结果及酒馆最终条件检查。',
        '这里按当前输入框草稿与最近保留正文组装；真正发送、重生成或续写时，正文与草稿可能变化。'];
    if (busy.maintaining) selectUncertainties.push('实际前置会让后台模型整理暂歇，只等待正在提交的保存；这里展示已提交的记忆版本。');
    if (settings.mvuEnabled) selectUncertainties.push(selectObservation ? 'MVU 为当前已读取的指定字段，实际发送前会重新读取并核对所属楼层。'
        : '本次没有可用且属于最新楼层的 MVU 字段；实际发送前会重读，可能追加 observedState。');
    stages.push(stage(AGENTS.select, 'select', '前置选材', !settings.enabled || busy.initializing || busy.maintaining ? 'conditional' : 'ready',
        '展示前置模型的选材请求。待补记的正文会保留，输入框草稿以 current-input 追加。',
        selectRequest(save, recent, { eligible: eligibleHere, selectionLimit: settings.selectionLimit, selectionChars: settings.selectionChars, observedState: selectObservation }), selectUncertainties));

    const safeSave = guarded(save, compiledRules), pending = pendingBatches(context, save, settings);
    const deferred = Boolean(save.data.scopeContext?.deferPost);
    const maintenanceNotes = deferred ? ['角色卡尚未提交本轮资料范围，后置暂停。解除暂停后的归属范围仍可能变化。'] : [];
    if (pending.length) {
        for (const [index, batch] of pending.entries()) {
            const observation = observationFor(observedState, context, batch, settings);
            const request = maintainRequest(safeSave, batch, batch[0].scopeId, observation);
            const unknown = [...maintenanceNotes];
            if (index) {
                delete request.input.memory;
                unknown.push('memory 需使用前面批次成功保存后的结果，尚不可知；此处只展示确定的剧情与范围。');
            }
            if (busy.maintaining) unknown.push('已有维护请求运行；当前待处理范围可能包含正在处理的批次，实际下一请求需等它结束。');
            if (settings.mvuEnabled && batch.at(-1)?.key === context.messages.at(-1)?.key) unknown.push('仅最新剧情所在批次可能读取 MVU；发送前会重新校验 observedState。');
            stages.push(stage(AGENTS.maintain, `maintain-${index + 1}`, `后置维护 · ${index + 1}/${pending.length}`,
                index || deferred || !settings.enabled || busy.maintaining || busy.initializing ? 'conditional' : 'ready',
                `按当前积压剧情展示；本批 ${batch.length} 条消息，归属 ${batch[0].scopeId}。后置只看到允许维护的正文片段。`, request, unknown));
        }
    } else {
        const request = maintainRequest(safeSave, [], normalizeScopeId(save.data.scopeContext?.activeScopeId));
        delete request.input.messages;
        stages.push(stage(AGENTS.maintain, 'maintain', '后置维护', 'conditional', '当前没有待补记正文；显示现有记忆投影，下一次实际请求需等新回复保存。', request,
            [...maintenanceNotes, 'messages 尚不存在；当前输入框草稿不是已经发生的剧情，不会在这里冒充正文。', 'memory 与资料范围会以新回复保存后的状态为准。']));
    }
    const compactNotes = [`自动整理在回复保存、维护完成后判断：距上次整理 ${settings.compactEvery} 次维护，或当前范围脉络与事件达到 ${settings.compactChars} 字符且较上次明显增长；失败后还会限制重试频率。`,
        '是否触发取决于本轮维护结果、上次整理标记及失败次数，本页不触发整理。'];
    if (pending.length || busy.maintaining) compactNotes.push('下方 memory 是当前版本；维护完成后的脉络与事件可能变化。');
    if (deferred) compactNotes.push('角色卡提交范围前不会启动整理。');
    stages.push(stage(AGENTS.maintain, 'compact', '整理事件', 'conditional', '展示当前活动范围的脉络与可读事件；玩家主动整理时也使用此请求结构。',
        compactRequest(safeSave, normalizeScopeId(save.data.scopeContext?.activeScopeId)), compactNotes));
    return { at, chatId: context.chatId ?? null, revision: save.revision, warnings, stages };
}
