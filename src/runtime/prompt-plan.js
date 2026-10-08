import { clone } from '../core/util.js';
import { entryScope, scopeSummary, scopeInventory, normalizeScopeId, readableScopes, GLOBAL_SCOPE } from '../core/state.js';
import { frontRead } from '../core/views.js';
import { evaluateRules } from '../rules/index.js';

/** Shared by sending and inspection; only selected IDs require a model result. */
export function assemblePromptPlan(save, ids, { eligible, compiledRules, configEntryUids = [] }) {
    const scopes = readableScopes(save.data.scopeContext);
    const mandatory = Object.values(save.data.entries).filter(e => e.enabled && eligible(e)
        && (e.constant || e.important || evaluateRules(compiledRules, e).always)).map(e => e.id);
    const selectedIds = [...new Set([...mandatory, ...ids])];
    const inventoryScope = normalizeScopeId(save.data.scopeContext?.activeScopeId);
    const inventory = save.data.inventoryEnabled && save.inventoryDisabledAt === null ? scopeInventory(save.data, inventoryScope).map(i => `【${i.name}｜${i.description}】`).join('\n') : '';
    const inventoryLabel = inventory && (inventoryScope !== GLOBAL_SCOPE || save.data.scopeContext) ? `【物品来源范围 ${inventoryScope}】\n此清单仅记录该范围的物品，不表示已随玩家转移至其他范围。\n` : '';
    return {
        entries: Object.values(save.data.entries).map(entry => ({ ...clone(entry), enabled: entry.enabled && scopes.has(entryScope(entry)) })),
        selectedIds,
        details: frontRead(save, selectedIds.filter(id => !save.data.entries[id].source), eligible)
            .map(e => `【${e.title}｜${e.kind}${e.scopeId === GLOBAL_SCOPE ? '' : `｜范围 ${e.scopeId}`}】\n${e.content}`).join('\n\n'),
        summary: [...scopes].map(scopeId => { const text = scopeSummary(save.data, scopeId); return text ? (scopeId === GLOBAL_SCOPE ? text : `【范围 ${scopeId}】\n${text}`) : ''; }).filter(Boolean).join('\n\n'),
        inventory: inventoryLabel + inventory,
        configEntryUids: clone(configEntryUids),
    };
}

export function previewNarration(save, options) {
    const agent = { id: 'narration', title: '正文叙事 Agent',
        description: '由酒馆组装最终正文请求；这里仅展示鱼忆与已接入来源提供的片段，不含完整预设、聊天历史及其他来源。', identified: true };
    const uncertainty = ['前置 Agent 返回选中 ID 后，才知道额外详情和绿灯条目；这里没有猜测选材结果。',
        '原书条目仍受原生预算、概率、分组、模板和生成时条件影响；蓝灯/必选只表示计划纳入，不保证实际送达。',
        '角色卡流程、预设、外置世界书、聊天历史与第三方扩展由酒馆最终组装，本页不是完整最终请求。'];
    if (!save?.initialized) return { id: 'narration', title: '正文 · 鱼忆注入', agent, kind: 'injection', status: 'conditional', explanation: '初始化完成后才能准备动态记忆。', system: '', input: null, uncertainties: uncertainty };
    const plan = assemblePromptPlan(save, [], options);
    const crossScope = save.data.scopeContext?.deferPost && save.data.scopeContext.requestedScopeIds?.some(id => id !== save.data.scopeContext.activeScopeId);
    if (crossScope && plan.inventory) uncertainty.unshift('物品槽带有来源范围标签，取自当前 activeScope；转场准备不代表物品已随玩家跨范围携带。');
    return { id: 'narration', title: '正文 · 鱼忆注入', agent, kind: 'injection', status: 'conditional', explanation: '展示当前可确定的鱼忆片段，以及计划保留的原书候选。内容依照正常发送路径生成；未执行前置选材。', system: '',
        input: {
            slots: ['summary', 'inventory', 'details'].map(key => ({ name: `dwm:${key}`, role: 'system', position: 'in_chat', depth: 4,
                content: plan[key].replaceAll('<%', '<\u200b%'), condition: key === 'details' ? '仅含当前必选的自建资料；选材后可能追加' : '当前快照；为空则不注入' })),
            worldbookCandidates: plan.entries.filter(e => e.source && plan.selectedIds.includes(e.id)).map(e => ({ id: e.id, title: e.title,
                content: e.segments.map(s => s.text).join(''), condition: '仅候选；原书原位置。模板或其他扩展已处理的正文可能保留原生结果' })),
            disabledSourceEntries: plan.entries.filter(e => e.source && (e.source.metadata?.disable || !e.enabled)).map(e => ({ title: e.title, condition: '鱼忆不激活。若卡脚本自行读取原书投递，动态副本不会自动替换脚本材料。' })),
        }, uncertainties: uncertainty };
}
