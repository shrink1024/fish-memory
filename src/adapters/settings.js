function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}

/** The native writer may swallow HTTP errors or only queue a delayed save.
 * Confirm its saved Fish subtree before reporting success. Never write the
 * complete settings document or alter temporary generation parameters here.
 */
export function createSettingsPersistence({ extensionSettings, saveSettings, getRequestHeaders, fetch: request = globalThis.fetch }) {
    return async value => {
        const previous = extensionSettings.dwm, target = structuredClone(value);
        extensionSettings.dwm = target;
        try {
            await saveSettings();
            try {
                const response = await request('/api/settings/get', { method: 'POST', headers: getRequestHeaders(),
                    body: '{}', cache: 'no-cache', signal: AbortSignal.timeout(10000) });
                if (!response?.ok) throw new Error('Settings readback failed');
                // ST 1.19 returns the stored settings file as a JSON string.
                const result = await response.json();
                if (typeof result?.settings !== 'string') throw new Error('Invalid settings response');
                const saved = JSON.parse(result.settings)?.extension_settings?.dwm;
                if (extensionSettings.dwm !== target || JSON.stringify(canonical(saved)) !== JSON.stringify(canonical(target))) {
                    throw new Error('Settings were not confirmed');
                }
            } catch {
                throw new Error('鱼忆设置尚未确认保存。请检查酒馆连接，等待当前辅助生成结束后重试；确认前请勿刷新或退出。');
            }
        }
        catch (error) {
            // A queued native writer reads this restored value later. If another
            // operation replaced our subtree, preserve that newer live value.
            if (extensionSettings.dwm === target) extensionSettings.dwm = previous;
            throw error;
        }
    };
}
