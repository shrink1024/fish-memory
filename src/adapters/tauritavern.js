/** TT-specific persistence contract. Standard ST never imports host TT modules. */
export async function tauriPersistence(deps, script) {
    const host = deps.tauriHost ?? globalThis.__TAURITAVERN__;
    if (!host) return null;
    if (host.abiVersion !== 1 || typeof script.enqueueChatSave !== 'function') {
        throw new Error('当前 TT 缺少鱼忆所需的保存队列接口，请使用受支持的 TT 版本');
    }
    const transport = deps.tauriTransport ?? await import('/scripts/chat-payload-transport.js');
    if (typeof transport.readColdSwipeRecord !== 'function') throw new Error('当前 TT 缺少冷候选读取接口');
    return {
        enqueue: task => script.enqueueChatSave(task),
        async expectedMessages(messages) {
            const expected = structuredClone(messages);
            // Read the held source record, not the current disk file: TT keeps
            // the original source alive across atomic replacements and reorders.
            for (const message of expected) {
                const reference = message.tt_swipe_cold;
                if (!reference) continue;
                if (!Number.isInteger(reference.sourceId) || reference.sourceId < 0
                    || !Number.isInteger(reference.record) || reference.record < 1) throw new Error('TT 冷候选来源无效');
                const source = await transport.readColdSwipeRecord({ sourceId: reference.sourceId, record: reference.record });
                for (const field of ['swipes', 'swipe_info']) {
                    if (!Array.isArray(source?.[field]) || !Array.isArray(message[field]) || message[field].length < source[field].length) {
                        throw new Error('TT 冷候选尚未加载完整，不能确认保存；请重新载入候选后重试');
                    }
                    for (let i = 0; i < source[field].length; i++) {
                        if (message[field][i] == null) message[field][i] = structuredClone(source[field][i]);
                    }
                }
                delete message.tt_swipe_cold;
            }
            return expected;
        },
        equal: (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)),
    };
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
