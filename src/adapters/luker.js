/** Luker rotates integrity on every write and caches baselines for native patches. */
export function lukerPersistence(deps, script) {
    if (!(deps.lukerHost ?? globalThis.Luker)) return null;
    for (const name of ['runSerializedChatWrite', 'applyIntegrityFromWritePayloadToTarget',
        'seedChatMetadataSnapshot', 'seedChatMessageSnapshot', 'invalidateChatWriteSnapshot']) {
        if (typeof script[name] !== 'function') throw new Error('当前 Luker 缺少鱼忆所需的保存接口，请使用受支持的 Luker 版本');
    }
    return {
        enqueue: task => script.runSerializedChatWrite(task),
        expectedMessages: async messages => structuredClone(messages),
        acknowledge(result, submitted, target) {
            // The acknowledged write changed the server even if verification or
            // a subsequent read fails. Never retain pre-write patch baselines.
            script.invalidateChatWriteSnapshot(target);
            if (typeof result.integrity !== 'string' || !result.integrity.trim()) {
                throw new Error('Luker 保存未返回有效的校验标识，请重新载入后核对');
            }
            submitted[0].chat_metadata.integrity = result.integrity;
            script.applyIntegrityFromWritePayloadToTarget(result, target);
        },
        verified(saved, target) {
            script.seedChatMetadataSnapshot(target, saved[0].chat_metadata);
            script.seedChatMessageSnapshot(target, saved.slice(1));
        },
    };
}
