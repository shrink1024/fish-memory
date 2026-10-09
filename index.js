import { createSillyTavernHost } from './src/adapters/sillytavern.js';
import { createSettingsPersistence } from './src/adapters/settings.js';
import { Controller } from './src/runtime/controller.js';
import { mountPanel } from './src/ui/panel.js';
import { createTraceStore } from './src/diagnostics/trace-store.js';
import { installCapture } from './src/diagnostics/capture.js';
import { createProblemExporter } from './src/diagnostics/problem-export.js';
import { createFloatingManager } from './src/ui/floating-manager.js';

async function boot() {
    if (!globalThis.SillyTavern?.getContext || document.getElementById('dynamic-world-memory')) return;
    const context = SillyTavern.getContext();
    const host = await createSillyTavernHost();
    const traces = createTraceStore();
    let worldEntries = [];
    const events = context.eventSource, types = context.eventTypes ?? context.event_types;
    const activated = entries => { worldEntries = Array.isArray(entries) ? entries : [...(entries ?? [])]; };
    const changed = () => { worldEntries = []; };
    if (types?.WORLD_INFO_ACTIVATED) events?.on(types.WORLD_INFO_ACTIVATED, activated);
    if (types?.CHAT_CHANGED) events?.on(types.CHAT_CHANGED, changed);
    const openai = await import('/scripts/openai.js').catch(() => ({}));
    host.traceCapture = installCapture({ store: traces,
        context: () => {
            const live = SillyTavern.getContext();
            return { chatId: live.getCurrentChatId?.() ?? live.chatId ?? '', character: live.name2 ?? '', memoryChatId: host.snapshot().chatId, messageCount: live.chat?.length ?? 0 };
        },
        provenance: () => {
            const live = SillyTavern.getContext();
            return [
                ...worldEntries.map(entry => ({ title: entry.comment || `世界书 #${entry.uid}`, text: entry.content, kind: '世界书' })),
                ...(openai.oai_settings?.prompts ?? []).map(prompt => ({ title: prompt.name || prompt.identifier, text: prompt.content, kind: '预设' })),
                ...Object.entries(live.extensionPrompts ?? {}).map(([name, prompt]) => ({ title: name, text: prompt.value, kind: '扩展注入' })),
            ].filter(entry => typeof entry.text === 'string' && entry.text.length > 8);
        },
    });
    host.readPreset = () => {
        if (SillyTavern.getContext().mainApi !== 'openai') return { name: '当前连接没有可读取的聊天补全预设', entries: [] };
        const manager = openai.promptManager;
        const order = manager?.getPromptOrderForCharacter?.(manager.activeCharacter) ?? [];
        const enabled = new Set(order.filter(item => item.enabled).map(item => item.identifier));
        return { name: openai.oai_settings?.preset_settings_openai ?? '',
            entries: (openai.oai_settings?.prompts ?? []).filter(prompt => !prompt.marker && enabled.has(prompt.identifier))
                .map(prompt => ({ id: prompt.identifier, title: prompt.name || prompt.identifier, content: prompt.content })) };
    };
    const extensionSettings = context.extensionSettings ?? (await import('/scripts/extensions.js')).extension_settings;
    const settings = extensionSettings.dwm ?? {};
    const controller = new Controller(host, {
        settings, traces,
        persistSettings: createSettingsPersistence({ extensionSettings,
            saveSettings: async () => (await import('/script.js')).saveSettings(),
            getRequestHeaders: () => SillyTavern.getContext().getRequestHeaders(),
            fetch: (...args) => globalThis.fetch(...args) }),
        chooseFallback: (error, { signal } = {}) => new Promise(resolve => {
            if (signal?.aborted) { resolve('cancel'); return; }
            const dialog = document.createElement('dialog');
            dialog.className = 'dwm-fallback';
            const title = document.createElement('h3'); title.textContent = '本轮记忆选材未完成';
            const detail = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '技术信息';
            const errorText = document.createElement('p'); errorText.textContent = error.message; detail.append(summary, errorText);
            const hint = document.createElement('p'); hint.textContent = '按原世界书发送会撤去本轮动态资料，保留酒馆和其他工具的正常内容。';
            dialog.append(title, detail, hint);
            let finished = false;
            const finish = value => {
                if (finished) return; finished = true;
                signal?.removeEventListener('abort', aborted);
                if (dialog.open) dialog.close(); dialog.remove(); resolve(value);
            };
            const aborted = () => finish('cancel');
            for (const [value, text] of [['original', '按原世界书发送'], ['retry', '重新选材（调用模型）'], ['cancel', '停止本轮']]) {
                const button = document.createElement('button'); button.textContent = text;
                if (value === 'cancel') button.autofocus = true;
                button.addEventListener('click', () => finish(value)); dialog.append(button);
            }
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish('cancel'); });
            signal?.addEventListener('abort', aborted, { once: true });
            document.body.append(dialog); dialog.showModal();
        }),
    });
    const mount = document.createElement('div'); mount.id = 'dynamic-world-memory';
    const drawer = document.createElement('details');
    const title = document.createElement('summary'); title.textContent = '鱼忆｜动态世界书与记忆';
    const openManager = document.createElement('button'); openManager.type = 'button'; openManager.textContent = '打开管理窗口';
    const manager = createFloatingManager(document);
    manager.body.append(mount);
    const showManager = event => manager.open(event);
    const bindManagerEntry = button => manager.bindEntry(button);
    let toolbarButton = null;
    bindManagerEntry(openManager);
    drawer.append(title, openManager);
    (document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings') ?? document.body).append(drawer);
    const toolbar = document.getElementById('top-settings-holder');
    if (toolbar && !document.getElementById('dwm-toolbar-entry')) {
        const entry = document.createElement('div'); entry.id = 'dwm-toolbar-entry'; entry.className = 'drawer';
        toolbarButton = document.createElement('button'); toolbarButton.id = 'dwm-toolbar-button'; toolbarButton.type = 'button';
        toolbarButton.className = 'dwm-toolbar-button drawer-icon fa-solid fa-fish fa-fw closedIcon';
        toolbarButton.title = '鱼忆｜动态世界书与记忆';
        toolbarButton.setAttribute('aria-label', '打开鱼忆管理窗口');
        bindManagerEntry(toolbarButton);
        // ST also synthesizes Enter clicks for .drawer-icon. Handle activation here
        // once so its global handler and the native button default cannot double-fire.
        toolbarButton.addEventListener('keydown', event => {
            if (!['Enter', ' '].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) toolbarButton.click();
        });
        entry.append(toolbarButton);
        const worldInfoEntry = toolbar.querySelector(':scope > #WI-SP-button');
        if (worldInfoEntry) worldInfoEntry.after(entry); else toolbar.append(entry);
    }
    const problems = createProblemExporter({ controller, context: () => {
        const live = SillyTavern.getContext();
        return { chatId: live.getCurrentChatId?.() ?? live.chatId ?? '', character: live.name2 ?? '', memoryChatId: host.snapshot().chatId,
            pluginVersion: '0.1.0-alpha.5', mainApi: live.mainApi, browser: navigator.userAgent };
    } });
    const panel = mountPanel(mount, controller, { exportProblem: () => problems.export() });
    const renderManagerStatus = () => manager.render(controller.uiStatus());
    const unsubscribeManager = controller.subscribe(renderManagerStatus);
    renderManagerStatus();
    globalThis.dwmFilterOutgoingHistory = (...args) => host.filterOutgoingHistory(...args);
    host.bindController(controller);
    await controller.start();
    // Public handle is for explicit local diagnostics. Agent views are built separately.
    globalThis.DynamicWorldMemory = Object.freeze({ version: '0.1.0-alpha.5', apiVersion: 1,
        setContext: input => controller.setContext(input), clearContext: owner => controller.clearContext(owner),
        readScope: scopeId => controller.readScope(scopeId), whenIdle: () => controller.whenIdle(), whenCommitted: () => controller.whenCommitted(),
        ui: Object.freeze({ status: () => controller.uiStatus(), subscribe: fn => controller.subscribe(() => fn(controller.uiStatus())),
            stop: id => controller.requestStop(id), open: () => showManager(), claimActivity: input => controller.claimActivity(input) }),
        // Optional source annotation: exact request matching, never an ambient "current agent".
        trace: Object.freeze({ begin: metadata => host.traceCapture.register(metadata), exportCurrent: () => problems.currentTraces() }),
        diagnostics: Object.freeze({ register: source => problems.register(source), export: () => problems.export() }),
        preview: Object.freeze({ register: source => controller.registerPreviewSource(source) }),
        controller });
    globalThis.dispatchEvent(new CustomEvent('dwm:ready'));
    // Publish the optional card API before background new-save initialization.
    controller.readinessChanged();
    globalThis.addEventListener('pagehide', event => {
        if (event.persisted) return;
        controller.cancel('页面已关闭，辅助等待已结束');
        unsubscribeManager();
        panel.destroy();
        manager.destroy();
        host.traceCapture.dispose();
        if (types?.WORLD_INFO_ACTIVATED) events?.removeListener(types.WORLD_INFO_ACTIVATED, activated);
        if (types?.CHAT_CHANGED) events?.removeListener(types.CHAT_CHANGED, changed);
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot().catch(showError), { once: true });
    else boot().catch(showError);
}
function showError(error) {
    console.error('[DynamicWorldMemory]', error);
    globalThis.toastr?.error?.(`鱼忆未启动：${error.message}`);
}
