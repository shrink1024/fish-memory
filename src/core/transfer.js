import { clone, invariant, plainText } from './util.js';
import { entryText, entryTier, entryScope, readableScopes, scopeSummary, scopeInventory } from './state.js';

/** Portable ST worldbook, not a save dump: no journal, credentials or message IDs. */
export function exportMemoryWorldbook(save) {
    invariant(save?.initialized, '请先完成初始化');
    const scopes = readableScopes(save.data.scopeContext), entries = {};
    const append = (metadata, title, content, { constant = true, disable = false } = {}) => {
        const uid = Object.keys(entries).length;
        entries[uid] = { key: [], keysecondary: [], selective: false, order: 100, position: 0, depth: 4,
            probability: 100, useProbability: false, ...clone(metadata ?? {}), uid, comment: title, content, constant, disable };
    };
    for (const e of Object.values(save.data.entries)) {
        if (!scopes.has(entryScope(e))) continue;
        const tier = entryTier(e), metadata = clone(e.source?.metadata ?? {});
        // Fish-made entries have no native keys; on demand they would never fire in a plain chat.
        if (tier === 'onDemand' && !(Array.isArray(metadata.key) && metadata.key.some(key => String(key).trim()))) metadata.key = [e.title];
        append(metadata, e.title, entryText(e), { constant: tier === 'constant', disable: tier === 'off' });
    }
    for (const scope of scopes) {
        const summary = scopeSummary(save.data, scope);
        if (summary?.trim()) append({}, `鱼忆 · 已发生的剧情（${scope}）`, summary);
        const inventory = scopeInventory(save.data, scope);
        if (save.data.inventoryEnabled && inventory?.length) append({}, `鱼忆 · 玩家物品（${scope}）`, inventory.map(item => `${item.name}：${item.description}`).join('\n'));
    }
    return { entries, fishMemoryExport: { format: 'fish-memory-worldbook', version: 1,
        note: '动态条目、当前可读范围的故事脉络与物品。可导入酒馆世界书；不恢复旧聊天楼层、diff 或鱼忆处理进度。' } };
}

/** Selected supplemental text is read as supplied history, never executed. */
export function parseSupplementaryMemory(text, { name = '补充记忆', json = false } = {}) {
    invariant(typeof text === 'string' && text.length <= 10000000, '文件过大，最多 1000 万字符');
    let rows;
    if (json) {
        let book; try { book = JSON.parse(text); } catch { throw new Error('文件不是有效的世界书 JSON'); }
        invariant(book?.entries && typeof book.entries === 'object', '请选择酒馆世界书 JSON，收发记录和完整聊天不支持在这里导入');
        rows = Object.values(book.entries);
    } else rows = [{ comment: name, content: text }];
    invariant(rows.length <= 1000, '一次最多导入 1000 个条目');
    const entries = [], skipped = [];
    for (const row of rows) {
        invariant(row && typeof row === 'object' && typeof row.content === 'string', '世界书条目缺少文本正文');
        const title = String(row.comment || row.name || '补充记忆');
        if (row.disable || row.enabled === false || !row.content.trim()) { skipped.push({ title, reason: '关闭或空条目' }); continue; }
        if (/\[DWM Rules\]/i.test(title) || /<%|^[ \t]*@@/m.test(row.content)) { skipped.push({ title, reason: '规则或模板脚本，需要原世界书运行环境' }); continue; }
        entries.push({ title: plainText(title, '条目名称', 500), content: plainText(row.content, '补充正文', 100000) });
    }
    invariant(entries.length, '没有可导入的启用文本条目；规则、脚本与空条目不会作为补充记忆导入');
    return { entries, skipped };
}
