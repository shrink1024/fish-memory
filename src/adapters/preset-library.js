import { orderedPresetEntries } from '../agents/preset-application.js';

/** Read the ST/TT exported in-memory library; never select/apply/save a host
 * preset. Fixed presets use their saved order, current uses live UI toggles. */
export function createPresetLibrary(openai, getContext) {
    const names = () => Array.isArray(openai.openai_setting_names)
        ? openai.openai_setting_names : Object.keys(openai.openai_setting_names ?? {});
    const currentName = () => openai.oai_settings?.preset_settings_openai ?? '';
    return {
        listPresets: () => names().map(name => ({ name, current: name === currentName() })),
        readPreset(name = null) {
            if (name == null) {
                if (getContext().mainApi !== 'openai') return { name: '当前连接没有可读取的聊天补全预设', entries: [], unavailable: true };
                const manager = openai.promptManager;
                return { name: currentName(), entries: orderedPresetEntries(openai.oai_settings?.prompts ?? [],
                    manager?.getPromptOrderForCharacter?.(manager.activeCharacter) ?? []) };
            }
            if (!names().includes(name)) return { name, entries: [], missing: true };
            const map = openai.openai_setting_names;
            const index = Array.isArray(map) ? map.indexOf(name) : map[name];
            let saved = openai.openai_settings?.[index];
            if (typeof saved === 'string') { try { saved = JSON.parse(saved); } catch { return { name, entries: [], missing: true }; } }
            if (!saved || typeof saved !== 'object') return { name, entries: [], missing: true };
            if (saved.prompts!==undefined&&!Array.isArray(saved.prompts) || saved.prompt_order!==undefined&&!Array.isArray(saved.prompt_order)) return {name,entries:[],missing:true};
            const manager = openai.promptManager, config = manager?.configuration?.promptOrder;
            const target = config?.strategy === 'character' ? manager?.activeCharacter?.id : config?.dummyId ?? 100001;
            const order = (saved.prompt_order ?? []).find(row => String(row.character_id) === String(target))?.order
                ?? (saved.prompt_order ?? []).find(row => String(row.character_id) === '100001')?.order ?? [];
            if(!Array.isArray(order))return {name,entries:[],missing:true};
            return { name, entries: orderedPresetEntries(saved.prompts ?? [], order) };
        },
    };
}
