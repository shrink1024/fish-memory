/** SillyTavern boundary. All persistent state belongs to the current chat. */
import { readMvuProjection } from './mvu.js';
const OWNER = 'dynamic-world-memory';
const META_KEY = 'dwm';
const LORE_BUCKETS = ['characterLore', 'globalLore', 'personaLore', 'chatLore'];
const SLOT_KEYS = Object.freeze({ summary: 'dwm:summary', inventory: 'dwm:inventory', details: 'dwm:details' });

function copy(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function sourceId(book, uid) {
    return `source:${encodeURIComponent(book)}:${uid}`;
}

function staticText(value) {
    // Prompt Template evaluates the assembled prompt as EJS. Break executable openers
    // in generated memory while retaining readable text in the model prompt.
    return String(value ?? '').replaceAll('<%', '<\u200b%');
}

function safeDynamicBody(entry) {
    const text = String(bodyOf(entry));
    const authored = String(entry?.source?.original ?? '');
    const allowed = new Set(authored.match(/<%[\s\S]*?%>/g) ?? []);
    let safe = staticText(text);
    // Existing author expressions may keep running unchanged. Newly generated
    // expressions are rendered as inert text, including in writable segments.
    for (const token of allowed) safe = safe.replaceAll(staticText(token), token);
    return safe;
}

function preserveNativeBody(dynamic, native) {
    const authored = dynamic?.source?.original;
    // Prompt Template can already have evaluated/preprocessed this candidate by
    // the time our WORLDINFO_ENTRIES_LOADED listener runs. Never overwrite that
    // result, or reintroduce an author EJS expression after its evaluation pass.
    return typeof authored === 'string' && (authored.includes('<%') || native.content !== authored);
}

function bodyOf(entry) {
    if (Array.isArray(entry?.segments)) return entry.segments.map(part => part.text ?? '').join('');
    return entry?.content ?? entry?.text ?? '';
}

function detailsText(value) {
    if (Array.isArray(value)) return value.map(item => bodyOf(item) || String(item ?? '')).filter(Boolean).join('\n\n');
    return typeof value === 'string' ? value : bodyOf(value);
}

function currentIdentity(ctx) {
    const group = ctx.groupId ?? ctx.selected_group ?? null;
    const file = ctx.chatId ?? ctx.getCurrentChatId?.();
    if (!file) return null;
    if (group) return `group:${group}:${file}`;
    const character = ctx.characters?.[ctx.characterId ?? ctx.this_chid];
    return `character:${character?.avatar ?? ctx.characterId ?? ctx.this_chid ?? 'unknown'}:${file}`;
}

function messageKey(message, index, readOnly = false) {
    // Preview uses the same identity rules without changing the live chat.
    if (readOnly) message = { ...message, extra: { ...message.extra },
        swipe_info: message.swipe_info?.map(info => ({ ...info, extra: { ...info?.extra } })) };
    message.extra ??= {};
    const fresh = () => globalThis.crypto?.randomUUID?.() ?? `dwm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    message.extra.dwmKey ??= readOnly ? `preview-message-${index}` : fresh();
    const selected = message.swipe_id ?? 0;
    const legacy = swipe => `${message.swipe_info?.[swipe]?.extra?.dwmKey ?? message.extra.dwmKey}:swipe:${swipe}`;
    if (message.is_user) return `${message.extra.dwmKey}:swipe:${selected}`;
    if (!Array.isArray(message.swipes)) return message.extra.dwmCandidateKey ??= legacy(selected);
    message.swipe_info ??= [];
    const reserved = new Set(message.swipe_info.map(info => info?.dwmCandidateKey).filter(Boolean));
    const used = new Set();
    for (let swipe = 0; swipe < message.swipes.length; swipe++) {
        if (message.swipes[swipe] === undefined) continue;
        const info = message.swipe_info[swipe] ??= {};
        const mirrored = info.extra?.dwmCandidateKey;
        let key = info.dwmCandidateKey ?? mirrored ?? legacy(swipe);
        // ST copies the selected extra to additional completions. A copied
        // mirror cannot claim an existing candidate's own persistent identity.
        if (used.has(key) || (!info.dwmCandidateKey && reserved.has(key))) {
            key = readOnly ? `preview-candidate-${index}-${swipe}` : `dwm-candidate-${fresh()}`;
        }
        used.add(key);
        info.dwmCandidateKey = key;
        if (info.extra?.dwmCandidateKey !== key) info.extra = { ...info.extra, dwmCandidateKey: key };
    }
    // An overswipe has no reply yet. Do not overwrite the previous extra while
    // ST still exposes it; receipt is checked again after saveReply finalizes.
    const key = message.swipe_info[selected]?.dwmCandidateKey;
    if (message.swipes[selected] === undefined || !key) return `${message.extra.dwmKey}:pending:${selected}`;
    if (message.mes === message.swipes[selected]) message.extra.dwmCandidateKey = key;
    return key;
}

/**
 * @param {object} deps Optional injected SillyTavern modules and functions for testing.
 * @returns {Promise<object>} Host facade with no module-level dependency on ST paths.
 */
export async function createSillyTavernHost(deps = {}) {
    const script = deps.script ?? await import('/script.js');
    const worldInfo = deps.worldInfo ?? await import('/scripts/world-info.js');
    const extensions = deps.extensions ?? await import('/scripts/extensions.js');
    const contextProvider = deps.getContext ?? (typeof deps.context === 'function' ? deps.context : () => deps.context ?? globalThis.SillyTavern?.getContext?.());
    const ctx = () => {
        const value = contextProvider();
        if (!value) throw new Error('SillyTavern context unavailable');
        return value;
    };
    const save = deps.save ?? (async expectedRevision => {
        const live = ctx();
        const savingChatId = currentIdentity(live);
        const expectedMemory = JSON.stringify(live.chatMetadata?.[META_KEY]);
        if (live.groupId ?? live.selected_group) throw new Error('Group chat saving is not supported by this adapter');
        const character = live.characters?.[live.characterId ?? live.this_chid];
        const fileName = live.chatId ?? live.getCurrentChatId?.();
        if (!character?.avatar || !character?.name || !fileName || !Array.isArray(live.chat) || !live.chatMetadata) {
            throw new Error('Current character chat cannot be saved safely');
        }
        const request = deps.fetch ?? globalThis.fetch;
        if (typeof request !== 'function') throw new Error('Fetch unavailable');
        const headers = live.getRequestHeaders?.() ?? script.getRequestHeaders?.();
        if (!headers) throw new Error('SillyTavern request headers unavailable');
        const remote = await request('/api/chats/get', {
            method: 'POST', headers, cache: 'no-cache',
            body: JSON.stringify({ ch_name: character.name, file_name: fileName, avatar_url: character.avatar }),
        });
        if (!remote?.ok) throw new Error(`Chat header read failed (${remote?.status ?? 'unknown'})`);
        const existing = await remote.json();
        const header = Array.isArray(existing) && existing[0] && typeof existing[0] === 'object' ? existing[0] : {};
        if (expectedRevision !== undefined && (header.chat_metadata?.[META_KEY]?.revision ?? 0) !== expectedRevision) {
            throw new Error('Remote chat memory revision changed');
        }
        if (currentIdentity(ctx()) !== savingChatId) throw new Error('存档已经切换');
        const readLive = () => {
            const current = ctx();
            if (currentIdentity(current) !== savingChatId) throw new Error('存档已经切换');
            if (JSON.stringify(current.chatMetadata?.[META_KEY]) !== expectedMemory) throw new Error('保存期间记忆版本已被其他操作替换，请重新载入核对');
            return JSON.stringify([{ ...header, chat_metadata: current.chatMetadata,
                user_name: header.user_name ?? 'unused', character_name: header.character_name ?? 'unused' }, ...current.chat]);
        };
        // Other extensions mutate the shared chat while our request is in flight.
        // Retry from the live object, never replay a captured variables snapshot.
        // This is bounded single-client reconciliation, not cross-client CAS.
        for (let attempt = 0; attempt < 3; attempt++) {
            const serialized = readLive(), chat = JSON.parse(serialized);
            const response = await request('/api/chats/save', {
                method: 'POST', headers, cache: 'no-cache',
                body: JSON.stringify({ ch_name: character.name, file_name: fileName, chat, avatar_url: character.avatar, force: false }),
            });
            if (!response?.ok) {
                const error = await response?.json?.().catch(() => null);
                throw new Error(error?.error === 'integrity' ? 'Chat integrity check rejected save' : `Chat save failed (${response?.status ?? 'unknown'})`);
            }
            const result = await response.json();
            if (result?.ok !== true) throw new Error('Chat save was not acknowledged');
            if (readLive() !== serialized) continue;
            const verify = await request('/api/chats/get', { method: 'POST', headers, cache: 'no-cache',
                body: JSON.stringify({ ch_name: character.name, file_name: fileName, avatar_url: character.avatar }) });
            if (!verify?.ok) throw new Error('保存后的聊天核验失败，记忆进度未确认');
            const saved = await verify.json();
            if (readLive() !== serialized) continue;
            if (!Array.isArray(saved) || JSON.stringify(saved[0]?.chat_metadata) !== JSON.stringify(chat[0].chat_metadata)
                || JSON.stringify(saved.slice(1)) !== JSON.stringify(chat.slice(1))) throw new Error('聊天保存结果与提交不符，请重新载入后核对');
            return;
        }
        throw new Error('其他工具仍在更新聊天，本次保存未能确认，请稍后重新载入核对');
    });
    const setPrompt = deps.setExtensionPrompt ?? script.setExtensionPrompt ?? ((...args) => ctx().setExtensionPrompt(...args));
    const promptTypes = script.extension_prompt_types ?? { IN_CHAT: 1 };
    const promptRoles = script.extension_prompt_roles ?? { SYSTEM: 0 };
    let plan = null;
    // Desired omissions are page-local. Native chat objects remain sendable when
    // this extension is disabled, uninstalled, or absent on another client.
    let windowChatId = null;
    const windowKeys = new Set();
    let nativeAudit = null;
    let generationType = null;
    let replacement = null;
    let nativeStopSerial = 0;
    let disposers = [];
    const messageTimers = new Set();
    const warnings = [];
    const eligibilityWarned = new Set();

    function warn(code, message, extra = {}) {
        const notice = { code, message, chatId: currentIdentity(ctx()), requestId: nativeAudit?.requestId ?? null, ...extra };
        warnings.push(notice);
        if (warnings.length > 100) warnings.shift();
        try {
            if (deps.onWarning) Promise.resolve(deps.onWarning(notice)).catch(console.error);
            else globalThis.toastr?.warning?.(message, '鱼忆');
        } catch (error) { console.error(error); }
    }

    function reportNativeOmissions(activated) {
        const audit = nativeAudit;
        if (!audit || audit.reported || currentIdentity(ctx()) !== audit.chatId || !audit.scanned) return;
        audit.reported = true;
        const activeIds = new Set(activated.map(entry => `${entry?.world}\0${entry?.uid}`));
        const missing = [...audit.blue.values()].filter(entry => !activeIds.has(`${audit.bookName}\0${entry.uid}`));
        if (missing.length) warn('native-blue-omitted', `${missing.length} 条蓝灯未进入本轮原生世界书：${missing.map(e => e.title).join("、")}。请检查原生预算、概率、分组及条目条件。`,
            { entries: missing, cause: 'unknown' });
    }

    function cancelMessageTimers() {
        for (const timer of messageTimers) clearTimeout(timer);
        messageTimers.clear();
    }

    function snapshot(readOnly = false) {
        const live = ctx();
        const character = live.characters?.[live.characterId ?? live.this_chid];
        const bookName = character?.data?.extensions?.world ?? null;
        const chatId = currentIdentity(live);
        const messages = (live.chat ?? []).map((message, index) => ({
            key: messageKey(message, index, readOnly),
            role: message.is_user ? 'user' : message.extra?.dwmHidden?.owner === OWNER ? 'assistant' : message.is_system ? 'system' : 'assistant',
            content: String(message.mes ?? ''),
            index,
            hidden: Boolean(message.is_system || (windowChatId === chatId && windowKeys.has(messageKey(message, index, readOnly)))),
            hiddenBy: message.extra?.dwmHidden?.owner === OWNER || (!message.is_system && windowChatId === chatId && windowKeys.has(messageKey(message, index, readOnly))) ? OWNER : null,
        }));
        const template = extensions.findExtension?.('ST-Prompt-Template');
        const templateApi = globalThis.EjsTemplate;
        return {
            chatId,
            bookName,
            messages,
            templateEnabled: Boolean(template?.enabled && templateApi?.getFeatures?.()?.enabled),
            group: live.groupId ?? live.selected_group ?? null,
            generating: Boolean(script.isGenerating?.()),
            userInput: String(deps.getUserInput?.() ?? globalThis.document?.querySelector?.('#send_textarea')?.value ?? ''),
        };
    }

    function captureReplacement(type) {
        const at = snapshot(), tail = at.messages.at(-1);
        if (!['regenerate', 'swipe'].includes(type) || tail?.role !== 'assistant') return null;
        return { type, chatId: at.chatId, sourceKeys: at.messages.map(m => m.key),
            prefixKeys: at.messages.slice(0, -1).map(m => m.key), deleted: false, received: false };
    }

    function pendingReplacement() {
        const at = snapshot(), keys = at.messages.map(m => m.key);
        const same = path => JSON.stringify(path) === JSON.stringify(keys);
        if (replacement?.chatId === at.chatId) {
            if (replacement.received) return null;
            if (replacement.cancelled && replacement.type === 'regenerate' && same(replacement.sourceKeys)) return null;
            if (same(replacement.sourceKeys) || same(replacement.prefixKeys)) return copy(replacement);
        }
        // ST announces an unfilled right-swipe before GENERATION_STARTED. Card
        // preparation can already save scope context at that point. Its mes is
        // still the previous answer and is not a selected new reply.
        const tail = ctx().chat?.at(-1);
        if (Array.isArray(tail?.swipes) && tail.swipe_id >= tail.swipes.length && !tail.is_user) {
            return { type: 'swipe', chatId: at.chatId, sourceKeys: keys, prefixKeys: keys.slice(0, -1) };
        }
        return null;
    }

    function generationSnapshot() {
        const at = snapshot(), pending = pendingReplacement();
        return pending ? { ...at, messages: at.messages.slice(0, pending.prefixKeys.length), userInput: '' } : at;
    }

    async function loadWorldbook(bookName = snapshot().bookName) {
        if (!bookName) return [];
        const loaded = await worldInfo.loadWorldInfo(bookName);
        if (!loaded || typeof loaded.entries !== 'object' || loaded.entries === null) throw new Error('角色绑定的主世界书尚未加载');
        return Object.values(copy(loaded?.entries ?? {}));
    }

    function auxiliaryReadiness() {
        const live = ctx();
        if (typeof (deps.rawGenerate ?? live.generateRaw) !== 'function') return { ready: false, reason: '酒馆辅助生成接口尚未就绪' };
        const status = live.onlineStatus ?? script.online_status;
        if (!status || status === 'no_connection' || status === 'Not connected') return { ready: false, reason: '辅助模型尚未连接；连接就绪后自动建立新档记忆' };
        return { ready: true };
    }

    function uncertainEligibility(entry, reason) {
        const native = entry?.source?.metadata ?? entry;
        const book = entry?.source?.book ?? snapshot().bookName ?? '';
        const uid = entry?.source?.uid ?? native?.uid ?? '?';
        const title = String(native?.comment?.trim?.() || entry?.title || uid);
        const key = `${currentIdentity(ctx())}\0${book}\0${uid}\0${reason}`;
        if (!eligibilityWarned.has(key)) {
            eligibilityWarned.add(key);
            warn('native-eligibility-unverified', `条目「${title}」本轮未进入动态绿灯选材：${reason}；本插件本轮不会激活该绿灯，原世界书未改动。`,
                { entry: { book, uid, title }, reason });
        }
        return false;
    }

    /** Conservative preselection gate. The native scan remains authoritative. */
    function eligible(entry, { silent = false, type = generationType } = {}) {
        const uncertain = reason => silent ? false : uncertainEligibility(entry, reason);
        const native = entry?.source?.metadata ?? entry;
        if (!native || native.disable === true) return false;
        if (Array.isArray(native.triggers) && native.triggers.length && (!type || !native.triggers.includes(type))) return false;
        const live = ctx();
        const character = live.characters?.[live.characterId ?? live.this_chid];
        const filter = native.characterFilter;
        if (filter?.names?.length) {
            const avatar = character?.avatar;
            if (!avatar) return uncertain('无法读取当前角色文件名');
            const filename = avatar.replace(/\.[^/.]+$/, '');
            const included = filter.names.includes(filename);
            if (filter.isExclude ? included : !included) return false;
        }
        if (filter?.tags?.length) {
            if (!character?.avatar || !live.tagMap || typeof live.tagMap !== 'object') {
                return uncertain('无法读取当前角色标签');
            }
            // ST creates an empty tag list when this avatar has no key yet.
            const currentTags = live.tagMap[character.avatar] ?? [];
            if (!Array.isArray(currentTags)) return uncertain('角色标签格式无法判定');
            const included = currentTags.some(tag => filter.tags.includes(tag));
            if (filter.isExclude ? included : !included) return false;
        }
        // ST counts the messages it will scan, excluding ordinary is_system
        // messages and removing the previous reply for swipe. We use the
        // visible-chat lower bound; interceptors may further reduce it.
        if (native.delay || native.cooldown || native.sticky) {
            if (!Array.isArray(live.chat)) return uncertain('无法读取原生时间条件');
            const visibleCount = Math.max(0, live.chat.filter(message => !message.is_system).length - (type === 'swipe' ? 1 : 0));
            if (native.delay && visibleCount < Number(native.delay)) return false;
            const book = entry?.source?.book ?? snapshot().bookName;
            const uid = entry?.source?.uid ?? native.uid;
            if (book && uid !== undefined && uid !== null) {
                const effects = live.chatMetadata?.timedWorldInfo;
                const key = `${book}.${uid}`;
                const active = kind => {
                    const effect = effects?.[kind]?.[key];
                    return Boolean(effect && Number.isFinite(Number(effect.end)) && visibleCount < Number(effect.end)
                        && (effect.protected || visibleCount > Number(effect.start)));
                };
                if (native.cooldown && active('cooldown') && !active('sticky')) return false;
            } else if (native.cooldown) return uncertain('无法定位冷却记录');
        }
        if (native.delayUntilRecursion) return uncertain('递归延迟条件尚不能安全预判');
        if (String(entry?.source?.original ?? native.content ?? '').includes('@@if')) {
            return uncertain('模板条件尚不能安全预判');
        }
        return true;
    }

    const storage = {
        async read(chatId) {
            if (currentIdentity(ctx()) !== chatId) throw new Error('存档已经切换');
            return copy(ctx().chatMetadata?.[META_KEY] ?? null);
        },
        async write(chatId, value, expectedRevision) {
            const live = ctx();
            if (currentIdentity(live) !== chatId) throw new Error('存档已经切换');
            const metadata = live.chatMetadata;
            if (!metadata || typeof metadata !== 'object') throw new Error('聊天 metadata 不可写');
            const previous = copy(metadata[META_KEY]);
            const actualRevision = previous?.revision ?? 0;
            if (actualRevision !== expectedRevision) throw new Error('存档版本已经变化');
            metadata[META_KEY] = copy(value);
            try {
                await save(expectedRevision);
                if (currentIdentity(ctx()) !== chatId) throw new Error('保存期间存档已经切换');
            } catch (error) {
                // Do not roll back over another writer's replacement.
                if (JSON.stringify(metadata[META_KEY]) === JSON.stringify(value)) {
                    if (previous === undefined) delete metadata[META_KEY];
                    else metadata[META_KEY] = previous;
                }
                throw error;
            }
        },
    };

    function putSlot(key, text, depth) {
        setPrompt(key, staticText(text), promptTypes.IN_CHAT, depth, false, promptRoles.SYSTEM);
    }

    function clearPlan() {
        plan = null;
        nativeAudit = null;
        for (const key of Object.values(SLOT_KEYS)) putSlot(key, '', 0);
    }

    function setPlan(next) {
        const id = currentIdentity(ctx());
        if (!next || next.chatId !== id) throw new Error('计划与当前存档不符');
        const bookName = next.bookName ?? snapshot().bookName;
        const raw = next.dynamicEntries ?? next.entries ?? [];
        const entries = raw instanceof Map ? [...raw.values()] : Array.isArray(raw) ? raw : Object.values(raw);
        const bySource = new Map();
        for (const entry of entries) {
            const book = entry?.source?.book;
            const uid = entry?.source?.uid;
            if (book !== bookName || uid === undefined || uid === null) continue;
            bySource.set(`${book}\0${uid}`, copy(entry));
        }
        plan = {
            chatId: id,
            bookName,
            requestId: next.requestId,
            entries: bySource,
            selected: new Set(next.selectedIds ?? []),
            configuration: new Set(next.configEntryUids ?? next.configurationUids ?? []),
        };
        nativeAudit = { chatId: id, bookName, requestId: next.requestId, blue: new Map(), scanned: false, reported: false };
        putSlot(SLOT_KEYS.summary, next.summary ?? '', 4);
        putSlot(SLOT_KEYS.inventory, next.inventory ?? '', 4);
        putSlot(SLOT_KEYS.details, detailsText(next.details), 4);
    }

    /** Mutates only arrays assembled for this World Info scan. Never writes a book. */
    function applyWorldInfoEntries(data) {
        const active = plan;
        if (!active || currentIdentity(ctx()) !== active.chatId) return;
        const live = ctx();
        const boundBook = live.characters?.[live.characterId ?? live.this_chid]?.data?.extensions?.world;
        if (boundBook !== active.bookName) return;
        const replacements = [];
        if (nativeAudit?.requestId === active.requestId) nativeAudit.scanned = true;
        for (const bucket of LORE_BUCKETS) {
            const items = data?.[bucket];
            if (!Array.isArray(items)) continue;
            const nextItems = [];
            for (let i = 0; i < items.length; i++) {
                const original = items[i];
                if (original?.world !== active.bookName) { nextItems.push(original); continue; }
                // Pure configuration belongs to the author/template runtime,
                // never to the model-facing World Info candidate set.
                if (active.configuration.has(original.uid) || active.configuration.has(sourceId(active.bookName, original.uid))) continue;
                const dynamic = active.entries.get(`${active.bookName}\0${original.uid}`);
                if (!dynamic) { nextItems.push(original); continue; } // Prior template removals are never re-added.
                const green = !original.constant;
                const selected = active.selected.has(dynamic.id) || active.selected.has(original.uid) || active.selected.has(sourceId(active.bookName, original.uid));
                if (!green && !original.disable && dynamic.enabled !== false) {
                    nativeAudit?.blue.set(String(original.uid), { uid: original.uid, title: String(original.comment?.trim() || dynamic.title || original.uid) });
                }
                const keepNative = preserveNativeBody(dynamic, original);
                if (keepNative && nativeAudit) nativeAudit.preserved ??= new Set();
                if (keepNative) nativeAudit?.preserved?.add(String(original.uid));
                nextItems.push({
                    ...original,
                    content: keepNative ? original.content : safeDynamicBody(dynamic),
                    // Preserve author disable and all other native gates. Unselected managed
                    // green entries must not enter through keywords or recursive scanning.
                    disable: Boolean(original.disable || dynamic.enabled === false || (green && !selected)),
                    constant: Boolean(original.constant || (green && selected)),
                });
            }
            replacements.push([items, nextItems]);
        }
        for (const [items, nextItems] of replacements) items.splice(0, items.length, ...nextItems);
        if (nativeAudit?.preserved?.size && !nativeAudit.preservationWarned) {
            nativeAudit.preservationWarned = true;
            warn('native-template-preserved', `${nativeAudit.preserved.size} 条含模板或已预处理的世界书正文保持原生结果，本轮动态修订未覆盖这些条目。`,
                { uids: [...nativeAudit.preserved] });
        }
    }

    async function restoreLegacyWindow() {
        const live = ctx(), chatId = currentIdentity(live), changes = [];
        for (const message of live.chat ?? []) {
            if (message.extra?.dwmHidden?.owner === OWNER) {
                changes.push({ object: message, isSystem: message.is_system, extra: copy(message.extra) });
                message.is_system = false;
                delete message.extra.dwmHidden;
            }
            for (const info of message.swipe_info ?? []) if (info?.extra?.dwmHidden?.owner === OWNER) {
                changes.push({ object: info, extra: copy(info.extra) });
                delete info.extra.dwmHidden;
            }
        }
        if (!changes.length) return 0;
        try {
            await save();
            if (currentIdentity(ctx()) !== chatId) throw new Error('保存期间存档已经切换');
        } catch (error) {
            for (const change of changes) {
                // Restore only our mutation; another extension may have updated
                // this shared object while the save was awaiting a response.
                if (!change.object.extra?.dwmHidden && (!('isSystem' in change) || change.object.is_system === false)) {
                    change.object.extra ??= {};
                    change.object.extra.dwmHidden = copy(change.extra.dwmHidden);
                    if ('isSystem' in change) change.object.is_system = change.isSystem;
                }
            }
            throw new Error(`旧版鱼忆隐藏状态恢复未保存，请重试或使用离线恢复工具：${error.message}`);
        }
        return changes.length;
    }

    async function applyWindow(actions) {
        await restoreLegacyWindow();
        const start = snapshot(), live = ctx();
        if (windowChatId !== start.chatId) { windowKeys.clear(); windowChatId = start.chatId; }
        for (const action of actions) {
            if (!live.chat?.[action.index] || start.messages[action.index]?.key !== action.key) throw new Error('聊天正文已变化');
        }
        let count = 0;
        for (const action of actions) {
            if (action.hidden && !live.chat[action.index].is_system) {
                if (!windowKeys.has(action.key)) { windowKeys.add(action.key); count++; }
            } else if (!action.hidden && windowKeys.delete(action.key)) count++;
        }
        return count;
    }

    // ST calls this on its assembled coreChat copies, before worldbook scanning.
    // Never mutate messages/extra: ST shallow-copies those objects.
    function filterOutgoingHistory(chat, _contextSize, _abort, type) {
        if (!Array.isArray(chat) || !plan || ['quiet', 'impersonate'].includes(type)
            || plan.chatId !== currentIdentity(ctx()) || windowChatId !== plan.chatId
            || plan.bookName !== snapshot(true).bookName) return;
        for (let index = chat.length - 1; index >= 0; index--) {
            if (windowKeys.has(messageKey(chat[index], index, true))) chat.splice(index, 1);
        }
    }

    /** Listener callbacks are awaited by ST, but ST itself swallows their errors. */
    function bindController(controller) {
        for (const dispose of disposers) dispose();
        disposers = [];
        const source = deps.eventSource ?? ctx().eventSource ?? script.eventSource;
        const types = deps.eventTypes ?? ctx().eventTypes ?? script.event_types;
        let active = true, currentRun = null, pendingStart = null;
        const preflights = new WeakMap();
        const foreground = (type, dryRun) => !dryRun && !['quiet', 'impersonate'].includes(type);
        const capturePreflight = (type, options, dryRun) => {
            if (!foreground(type, dryRun)) return null;
            const canBind = options !== null && typeof options === 'object';
            if (canBind && preflights.has(options)) return preflights.get(options);
            // A direct AFTER_COMMANDS caller (such as TH) need not emit START.
            const run = pendingStart ?? { cancelled: false, replacement: captureReplacement(type) };
            pendingStart = null;
            currentRun = run;
            replacement = run.replacement;
            if (canBind) preflights.set(options, run);
            return run;
        };
        const cancelRun = (retainReplacement = false) => {
            if (currentRun) currentRun.cancelled = true;
            // A card's cancellation cleanup may run before ST restores the old
            // candidate. Preserve its memory until that transient gap closes.
            replacement = retainReplacement && replacement && !replacement.received
                ? { ...replacement, cancelled: true } : null;
        };
        disposers.push(() => { active = false; cancelRun(); });
        const listen = (type, fn) => {
            if (!type) return;
            source.on(type, fn);
            disposers.push(() => source.removeListener(type, fn));
        };
        if (types.GENERATION_AFTER_COMMANDS && typeof source.makeFirst === 'function') {
            disposers.push(() => source.removeListener(types.GENERATION_AFTER_COMMANDS, capturePreflight));
        }
        listen(types.GENERATION_STARTED, (type, options, dryRun) => {
            if (!foreground(type, dryRun)) return;
            currentRun = pendingStart = { cancelled: false, replacement: captureReplacement(type) };
            replacement = currentRun.replacement;
            // Cards may install makeFirst after us. Capture this event's options
            // before an awaited card preflight can be stopped and later resume.
            // ST supplies no shared request ID between START and AFTER_COMMANDS.
            if (types.GENERATION_AFTER_COMMANDS && typeof source.makeFirst === 'function') {
                source.makeFirst(types.GENERATION_AFTER_COMMANDS, capturePreflight);
            }
        });
        listen(types.GENERATION_AFTER_COMMANDS, async (type, options, dryRun) => {
            if (dryRun) return;
            const run = capturePreflight(type, options, dryRun);
            const isCurrent = () => active && (!run || (run === currentRun && !run.cancelled));
            if (!isCurrent()) return;
            generationType = type;
            eligibilityWarned.clear();
            const stopBefore = nativeStopSerial;
            try {
                const result = await controller.generationBefore?.({ type, options, dryRun, isCurrent });
                if (run && isCurrent() && !result?.cancel) run.prepared = true;
                if (isCurrent() && result?.cancel && nativeStopSerial === stopBefore) stopGeneration();
            } catch (error) {
                if (!isCurrent()) return;
                clearPlan();
                // The ST emitter catches listener exceptions, so an exception alone
                // cannot stop the native request. Let the player choose fallback.
                let decision = 'cancel';
                try {
                    decision = await (deps.onPreflightFailure ?? controller.onPreflightFailure)?.(error) ?? 'cancel';
                } catch { decision = 'cancel'; }
                if (isCurrent() && decision !== 'fallback' && nativeStopSerial === stopBefore) stopGeneration();
            }
        });
        listen(types.WORLDINFO_ENTRIES_LOADED, data => applyWorldInfoEntries(data));
        listen(types.WORLD_INFO_ACTIVATED, entries => {
            if (Array.isArray(entries)) {
                reportNativeOmissions(entries);
                if (plan) controller.recordObservation?.({ requestId: plan.requestId,
                    observedIds: entries.filter(e => e.world === plan.bookName).map(e => sourceId(e.world, e.uid)),
                    status: '已观察原生世界书激活；常驻槽位及最终完整请求尚未核验' });
            }
        });
        listen(types.MESSAGE_RECEIVED, (index, type) => {
            if (ctx().streamingProcessor?.isStopped) return;
            const at = snapshot();
            const received = ctx().chat?.[index], swipe = received?.swipe_id ?? 0;
            if (!received || !['normal', 'regenerate', 'swipe', 'continue', 'append', 'appendFinal'].includes(type)) return;
            if (replacement && index === replacement.prefixKeys.length) replacement.received = true;
            // ST omits WORLD_INFO_ACTIVATED when zero entries activate. A real
            // received reply is the safe fallback point to report that case.
            if (nativeAudit && !nativeAudit.reported) reportNativeOmissions([]);
            // saveReply emits before swipe_info is finalized. A macrotask lets
            // its synchronous finalization finish without blocking ST's event.
            const timer = setTimeout(() => {
                messageTimers.delete(timer);
                const live = ctx();
                if (currentIdentity(live) !== at.chatId || live.streamingProcessor?.isStopped) return;
                if (live.chat?.[index] !== received || (received.swipe_id ?? 0) !== swipe || !String(received.mes ?? '').trim()) return;
                snapshot(); // Establish identities after native swipe_info copying.
                Promise.resolve(controller.messageReceived?.({ index, type })).catch(console.error);
            }, 0);
            messageTimers.add(timer);
        });
        listen(types.GENERATION_STOPPED, () => { cancelRun(true); cancelMessageTimers(); clearPlan(); generationType = null; controller.generationStopped?.(); });
        const checkReadiness = () => { if (active) Promise.resolve(controller.readinessChanged?.()).catch(console.error); };
        listen(types.GENERATION_ENDED, () => { cancelRun(true); pendingStart = null; clearPlan(); generationType = null; controller.generationEnded?.(); checkReadiness(); });
        listen(types.CHAT_CHANGED, async () => {
            cancelRun(); cancelMessageTimers(); clearPlan(); generationType = null; eligibilityWarned.clear();
            await controller.chatChanged?.(); checkReadiness();
        });
        // Readiness events only: no polling, retry loop, prompt-generation hook or
        // automatic rescan of an already attempted or inherited save.
        for (const type of new Set([types.APP_READY, types.CHAT_CREATED, types.ONLINE_STATUS_CHANGED,
            types.CONNECTION_PROFILE_LOADED, types.WORLDINFO_UPDATED, types.WORLDINFO_SETTINGS_UPDATED,
            types.EXTENSION_SETTINGS_LOADED, types.SETTINGS_UPDATED, types.CHARACTER_EDITED].filter(Boolean))) listen(type, checkReadiness);
        listen(types.CHARACTER_MESSAGE_RENDERED, (_index, type) => { if (type === 'first_message') checkReadiness(); });
        listen(types.MESSAGE_SWIPED, index => {
            const message = ctx().chat?.[index];
            if (message?.swipes?.[message.swipe_id ?? 0] === undefined) return;
            cancelRun();
            return controller.messageSwiped?.({ index });
        });
        listen(types.MESSAGE_DELETED, index => {
            const expected = currentRun?.replacement;
            if (currentRun?.prepared && !currentRun.cancelled && expected?.type === 'regenerate' && !expected.deleted
                && !expected.received && expected.chatId === currentIdentity(ctx()) && index === expected.prefixKeys.length
                && JSON.stringify(snapshot().messages.map(m => m.key)) === JSON.stringify(expected.prefixKeys)) {
                // Generate removes exactly this captured tail after preflight.
                // It is part of the same send, not a new user deletion.
                expected.deleted = true;
                return;
            }
            replacement = null;
            if (currentRun) { currentRun.replacement = null; currentRun.prepared = false; }
            return controller.messageDeleted?.({ index });
        });
        listen(types.MESSAGE_SWIPE_DELETED, data => {
            const message = ctx().chat?.[data?.messageId];
            const selectedKey = message?.swipe_info?.[message.swipe_id ?? 0]?.dwmCandidateKey;
            if (selectedKey && selectedKey !== message.extra?.dwmCandidateKey) {
                // deleteSwipe emits while mes/extra still contain the deleted
                // reply, and may await animation before selecting its successor.
                // MESSAGE_SWIPED performs maintenance once selection is final.
                cancelRun(); controller.cancel?.();
                return;
            }
            return controller.messageSwipeDeleted?.(data);
        });
        return () => { for (const dispose of disposers) dispose(); disposers = []; cancelMessageTimers(); clearPlan(); };
    }

    async function rawGenerate(params) {
        const generate = deps.rawGenerate ?? ctx().generateRaw;
        if (typeof generate !== 'function') throw new Error('SillyTavern generateRaw unavailable');
        params?.signal?.throwIfAborted?.();
        const result = await generate({ prompt: [
            { role: 'system', content: String(params.system ?? '') },
            { role: 'user', content: String(params.input ?? '') },
        ], trimNames: false });
        params?.signal?.throwIfAborted?.();
        return result;
    }

    function stopGeneration() {
        const stop = deps.stopGeneration ?? ctx().stopGeneration ?? script.stopGeneration;
        if (typeof stop !== 'function') throw new Error('SillyTavern stopGeneration unavailable');
        const result = stop();
        nativeStopSerial++;
        return result;
    }

    return { snapshot, generationSnapshot, pendingReplacement, previewSnapshot: () => snapshot(true), previewEligible: entry => eligible(entry, { silent: true, type: 'normal' }), loadWorldbook, eligible, storage, setPlan, clearPlan, applyWorldInfoEntries, applyWindow, restoreLegacyWindow, filterOutgoingHistory, bindController, rawGenerate, stopGeneration, auxiliaryReadiness,
        readMvu: settings => readMvuProjection({ context: ctx, settings, globals: deps.globals ?? globalThis }),
        getWarnings: () => copy(warnings) };
}
