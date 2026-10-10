/** SillyTavern boundary. All persistent state belongs to the current chat. */
import { tauriPersistence } from './tauritavern.js';
import { lukerPersistence } from './luker.js';
import { readMvuProjection } from './mvu.js';
import { generateAuxiliary } from './auxiliary-transport.js';
import { encodeSave, decodeSave } from '../core/storage-codec.js';
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

function primaryBookName(character) {
    const name = character?.data?.extensions?.world;
    return typeof name === 'string' && name.trim() ? name : null;
}

function messageKey(message, index, readOnly = false) {
    // Preview uses the same identity rules without changing the live chat.
    if (readOnly) message = { ...message, extra: { ...message.extra },
        swipe_info: message.swipe_info?.map(info => info == null ? info : ({ ...info, extra: { ...info.extra } })) };
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
        if (message.swipes[swipe] == null || (message.tt_swipe_cold && message.swipe_info[swipe] === null)) continue;
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
    if (message.swipes[selected] == null || !key) return `${message.extra.dwmKey}:pending:${selected}`;
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
    const powerUser = deps.powerUser ?? (deps.script ? null : await import('/scripts/power-user.js'));
    const contextProvider = deps.getContext ?? (typeof deps.context === 'function' ? deps.context : () => deps.context ?? globalThis.SillyTavern?.getContext?.());
    const ctx = () => {
        const value = contextProvider();
        if (!value) throw new Error('SillyTavern context unavailable');
        return value;
    };
    const persistence = await tauriPersistence(deps, script) ?? lukerPersistence(deps, script);
    const enqueueSave = task => persistence ? persistence.enqueue(task) : task();
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
        const target = { is_group: false, avatar_url: character.avatar, file_name: fileName, char_name: character.name };
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
            let serialized = readLive();
            const chat = JSON.parse(serialized);
            const expectedMessages = persistence ? await persistence.expectedMessages(chat.slice(1)) : chat.slice(1);
            if (readLive() !== serialized) continue;
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
            if (persistence?.acknowledge) {
                persistence.acknowledge(result, chat, target);
                serialized = JSON.stringify(chat);
            }
            if (readLive() !== serialized) continue;
            const verify = await request('/api/chats/get', { method: 'POST', headers, cache: 'no-cache',
                body: JSON.stringify({ ch_name: character.name, file_name: fileName, avatar_url: character.avatar }) });
            if (!verify?.ok) throw new Error('保存后的聊天核验失败，记忆进度未确认');
            const saved = await verify.json();
            if (readLive() !== serialized) continue;
            const equal = persistence?.equal ?? ((left, right) => JSON.stringify(left) === JSON.stringify(right));
            if (!Array.isArray(saved) || !equal(saved[0]?.chat_metadata, chat[0].chat_metadata)
                || !equal(saved.slice(1), expectedMessages)) throw new Error('聊天保存结果与提交不符，请重新载入后核对');
            persistence?.verified?.(saved, target);
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
    let outgoingWindow = { omittedCount: 0, reason: '本轮尚未裁剪历史' };
    let nativeAudit = null;
    let generationType = null;
    let replacement = null;
    let nativeStopSerial = 0;
    let disposers = [];
    const messageTimers = new Set();
    const warnings = [];
    const eligibilityWarned = new Set();
    const warningKeys = new Set();
    let checkedWorldbook = null;
    let worldbookCheckSerial = 0;

    function warn(code, message, extra = {}) {
        const notice = { code, message, chatId: currentIdentity(ctx()), requestId: nativeAudit?.requestId ?? null, ...extra };
        const key = `${notice.chatId}\0${code}\0${message}`;
        if (warningKeys.has(key)) return;
        warningKeys.add(key);
        if (warningKeys.size > 300) warningKeys.delete(warningKeys.values().next().value);
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
        const bookName = primaryBookName(character);
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

    const worldbookMessages = {
        'no-chat': '请先打开单角色聊天',
        group: '鱼忆目前只接管单角色聊天的主世界书',
        'character-unavailable': '当前角色资料尚未加载，请稍后重新检测',
        unbound: '当前角色没有主世界书绑定；内嵌资料、附加书和聊天书不会自动作为主书接管',
        bound: '已识别主世界书绑定，尚未核验是否可读取',
        ready: '主世界书可读取',
        empty: '主世界书存在，但目前没有条目',
        missing: '当前角色绑定的主世界书文件不存在，请在酒馆导入对应世界书或核对主绑定',
        'read-failed': '角色绑定的主世界书尚未加载，读取失败；请检查酒馆连接或世界书文件后重试',
        'check-failed': '无法确认主世界书是否存在，请检查酒馆连接后重新检测',
    };

    function worldbookContext() {
        const live = ctx(), chatId = currentIdentity(live);
        const character = live.characters?.[live.characterId ?? live.this_chid];
        const primaryName = primaryBookName(character);
        const file = typeof character?.avatar === 'string' ? character.avatar.replace(/\.[^/.]+$/, '') : null;
        const additional = file ? worldInfo.world_info?.charLore?.find(item => item.name === file)?.extraBooks : null;
        const state = !chatId ? 'no-chat' : (live.groupId ?? live.selected_group) ? 'group'
            : !character?.data ? 'character-unavailable' : !primaryName ? 'unbound' : 'bound';
        return { chatId, primaryName, state, message: worldbookMessages[state],
            embeddedBook: Boolean(character?.data?.character_book),
            additionalBookCount: Array.isArray(additional) ? additional.filter(name => typeof name === 'string' && name.trim()).length : 0,
            chatBook: Boolean(live.chatMetadata?.[worldInfo.METADATA_KEY ?? 'world_info']),
            listed: primaryName && Array.isArray(worldInfo.world_names) ? worldInfo.world_names.includes(primaryName) : null,
            entryCount: null, checkedAt: null };
    }

    function sameWorldbook(a, b) {
        return a.chatId === b.chatId && a.primaryName === b.primaryName;
    }

    function worldbookStatus() {
        const current = worldbookContext();
        return current.state === 'bound' && checkedWorldbook && sameWorldbook(current, checkedWorldbook)
            ? { ...current, state: checkedWorldbook.state, message: checkedWorldbook.message,
                listed: checkedWorldbook.listed, entryCount: checkedWorldbook.entryCount, checkedAt: checkedWorldbook.checkedAt }
            : current;
    }

    function assertWorldbookCurrent(target, serial) {
        if (!sameWorldbook(target, worldbookContext()) || (serial !== undefined && serial !== worldbookCheckSerial)) {
            const error = new Error('聊天或主世界书已切换，请重新检测');
            error.name = 'AbortError';
            throw error;
        }
    }

    function recordWorldbook(target, state, detail = {}, serial) {
        assertWorldbookCurrent(target, serial);
        checkedWorldbook = { ...target, state, message: worldbookMessages[state], checkedAt: new Date().toISOString(), ...detail };
        return worldbookStatus();
    }

    async function primaryFileExists(target, serial) {
        assertWorldbookCurrent(target, serial);
        // Injected hosts must supply their own HTTP boundary. This also keeps
        // existing offline fixtures from accidentally using Node's global fetch.
        const request = deps.fetch ?? (deps.script ? null : globalThis.fetch);
        const live = ctx(), headers = live.getRequestHeaders?.() ?? script.getRequestHeaders?.();
        if (typeof request !== 'function' || !headers) {
            if (deps.script) return null;
            throw new Error(worldbookMessages['check-failed']);
        }
        const response = await request('/api/settings/get', { method: 'POST', headers, cache: 'no-cache', body: '{}',
            signal: globalThis.AbortSignal?.timeout?.(15000) });
        assertWorldbookCurrent(target, serial);
        if (!response?.ok) throw new Error(worldbookMessages['check-failed']);
        // Only retain membership. Settings may contain credentials and must not
        // enter a status object, diagnostic export, log, or model request.
        const settings = await response.json();
        assertWorldbookCurrent(target, serial);
        if (!Array.isArray(settings?.world_names) || settings.world_names.some(name => typeof name !== 'string')) throw new Error(worldbookMessages['check-failed']);
        return settings.world_names.includes(target.primaryName);
    }

    async function readBookEntries(bookName, target, serial) {
        const loaded = await worldInfo.loadWorldInfo(bookName);
        assertWorldbookCurrent(target, serial);
        if (!loaded || typeof loaded.entries !== 'object' || loaded.entries === null) throw new Error(worldbookMessages['read-failed']);
        return Object.values(copy(loaded.entries));
    }

    async function withinWorldbookDeadline(promise, deadline) {
        let timer;
        try {
            return await Promise.race([promise, new Promise((_resolve, reject) => {
                timer = setTimeout(() => {
                    const error = new Error('主世界书检查超时，请稍后重试');
                    error.name = 'TimeoutError';
                    reject(error);
                }, Math.max(1, deadline - Date.now()));
            })]);
        } finally { clearTimeout(timer); }
    }

    async function checkWorldbook() {
        const target = worldbookContext(), serial = ++worldbookCheckSerial;
        if (target.state !== 'bound') return target;
        const deadline = Date.now() + 15000;
        let listed = null, stage = 'check-failed';
        try {
            listed = await withinWorldbookDeadline(primaryFileExists(target, serial), deadline);
            assertWorldbookCurrent(target, serial);
            if (listed === null) return recordWorldbook(target, 'check-failed', { listed: null }, serial);
            // ST caches its 200/empty placeholder for a missing file. Refresh
            // just this primary book so a later import can be observed.
            worldInfo.worldInfoCache?.delete?.(target.primaryName);
            if (!listed) return recordWorldbook(target, 'missing', { listed: false }, serial);
            stage = 'read-failed';
            const entries = await withinWorldbookDeadline(readBookEntries(target.primaryName, target, serial), deadline);
            assertWorldbookCurrent(target, serial);
            return recordWorldbook(target, entries.length ? 'ready' : 'empty', { listed: true, entryCount: entries.length }, serial);
        } catch (error) {
            assertWorldbookCurrent(target, serial);
            return recordWorldbook(target, stage, { listed,
                ...(error?.name === 'TimeoutError' ? { message: '主世界书检查超时，请稍后重试' } : {}) }, serial);
        }
    }

    async function loadWorldbook(bookName = worldbookContext().primaryName) {
        if (!bookName) return [];
        const target = worldbookContext(), serial = worldbookCheckSerial;
        const primary = target.state === 'bound' && target.primaryName === bookName;
        let entries;
        try { entries = await readBookEntries(bookName, target); }
        catch (error) {
            assertWorldbookCurrent(target);
            if (primary && serial === worldbookCheckSerial) recordWorldbook(target, 'read-failed');
            throw new Error(worldbookMessages['read-failed']);
        }
        if (primary && !entries.length) {
            let listed;
            try { listed = await primaryFileExists(target); }
            catch (error) {
                assertWorldbookCurrent(target);
                if (serial === worldbookCheckSerial) recordWorldbook(target, 'check-failed', { listed: null });
                throw new Error(worldbookMessages['check-failed']);
            }
            assertWorldbookCurrent(target);
            if (listed === null) {
                // Legacy injected hosts may expose only loadWorldInfo. Do not
                // invent a missing-file diagnosis or perform an unmocked fetch.
                if (serial === worldbookCheckSerial) recordWorldbook(target, 'check-failed', { listed: null });
                return entries;
            }
            if (!listed) {
                if (serial === worldbookCheckSerial) recordWorldbook(target, 'missing', { listed: false });
                throw new Error(worldbookMessages.missing);
            }
            worldInfo.worldInfoCache?.delete?.(bookName);
            try { entries = await readBookEntries(bookName, target); }
            catch (error) {
                assertWorldbookCurrent(target);
                if (serial === worldbookCheckSerial) recordWorldbook(target, 'read-failed', { listed: true });
                throw new Error(worldbookMessages['read-failed']);
            }
            if (serial === worldbookCheckSerial) recordWorldbook(target, entries.length ? 'ready' : 'empty', { listed: true, entryCount: entries.length });
        } else if (primary && serial === worldbookCheckSerial) recordWorldbook(target, 'ready', { entryCount: entries.length });
        return entries;
    }

    function auxiliaryReadiness() {
        const live = ctx();
        if (!deps.rawGenerate && !['openai', 'textgenerationwebui'].includes(live.mainApi ?? script.main_api)) return { ready: false, reason: '此酒馆后端请配置单独辅助连接（沿用连接支持聊天补全与文本补全）' };
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
            const stored = ctx().chatMetadata?.[META_KEY] ?? null;
            if (stored?.schema === 2) {
                // Saves persisted as schema 2 come from alpha.4 or earlier, which
                // sent every processed message to maintenance unfiltered: their
                // processed prefix was actually read. Schema 3 stays conservative.
                const save = decodeSave(stored);
                if (save && save.rememberedKeys === undefined && Array.isArray(save.processed)) save.rememberedKeys = [...save.processed];
                return save;
            }
            return stored?.schema === 3 ? decodeSave(stored) : copy(stored);
        },
        async write(chatId, value, expectedRevision) {
            return enqueueSave(async () => {
                const live = ctx();
                if (currentIdentity(live) !== chatId) throw new Error('存档已经切换');
                const metadata = live.chatMetadata;
                if (!metadata || typeof metadata !== 'object') throw new Error('聊天 metadata 不可写');
                const previous = copy(metadata[META_KEY]);
                const actualRevision = previous?.revision ?? 0;
                if (actualRevision !== expectedRevision) throw new Error('存档版本已经变化');
                const written = value?.schema === 2 ? encodeSave(value) : copy(value);
                metadata[META_KEY] = written;
                try {
                    await save(expectedRevision);
                    if (currentIdentity(ctx()) !== chatId) throw new Error('保存期间存档已经切换');
                } catch (error) {
                    // Do not roll back over another writer's replacement.
                    if (JSON.stringify(metadata[META_KEY]) === JSON.stringify(written)) {
                        if (previous === undefined) delete metadata[META_KEY];
                        else metadata[META_KEY] = previous;
                    }
                    throw error;
                }
            });
        },
    };

    function putSlot(key, text, depth) {
        setPrompt(key, staticText(text), promptTypes.IN_CHAT, depth, false, promptRoles.SYSTEM);
    }

    function clearPlan() {
        plan = null;
        nativeAudit = null;
        outgoingWindow = { omittedCount: 0, reason: '本轮尚未裁剪历史' };
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
                // ST hashes every native field for sticky/cooldown continuity.
                // Even changing constant/disable for semantic selection breaks
                // that identity. Timed entries retain the entire native record.
                if (original.sticky || original.cooldown || original.delay) {
                    nextItems.push(original);
                    warn('native-timed-entry-preserved', '带粘性、冷却或延迟条件的条目保持原生正文和触发方式，鱼忆本轮不覆盖，以维持原生计时。');
                    continue;
                }
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
        const target = currentIdentity(ctx());
        return enqueueSave(async () => {
            if (currentIdentity(ctx()) !== target) throw new Error('存档已经切换');
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
        });
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
    async function filterOutgoingHistory(chat, _contextSize, _abort, type) {
        if (!['quiet', 'impersonate'].includes(type)) outgoingWindow = { omittedCount: 0, reason: '本轮保留完整历史' };
        if (!Array.isArray(chat) || !plan || !windowKeys.size || ['quiet', 'impersonate'].includes(type)
            || plan.chatId !== currentIdentity(ctx()) || windowChatId !== plan.chatId
            || plan.bookName !== snapshot(true).bookName) return;
        const expected = plan;
        // Native timed effects use this exact chat length. Read raw books only:
        // getSortedEntries would execute template hooks twice in the same turn.
        const live = ctx(), character = live.characters?.[live.characterId ?? live.this_chid];
        const file = character?.avatar?.replace(/\.[^/.]+$/, '');
        const extra = worldInfo.world_info?.charLore?.find(item => item.name === file)?.extraBooks ?? [];
        const books = new Set([snapshot(true).bookName, ...extra, ...(worldInfo.selected_world_info ?? []),
            live.chatMetadata?.[worldInfo.METADATA_KEY ?? 'world_info'],
            (live.powerUserSettings ?? powerUser?.power_user)?.persona_description_lorebook].filter(Boolean));
        try {
            const loaded = await Promise.all([...books].map(name => worldInfo.loadWorldInfo(name)));
            if (plan !== expected || plan.chatId !== currentIdentity(ctx())) return;
            if (loaded.some(book => !book?.entries || Object.values(book.entries).some(entry => !entry.disable && (entry.sticky || entry.cooldown || entry.delay)))) {
                outgoingWindow = { omittedCount: 0, reason: '原生世界书含时间条件或未完整加载，保留完整历史' };
                warn('native-timed-window-preserved', '本轮世界书包含粘性、冷却或延迟条件（或尚未完整加载），鱼忆保留完整原文，以维持原生世界书计时。');
                return;
            }
        } catch {
            if (plan !== expected || plan.chatId !== currentIdentity(ctx())) return;
            outgoingWindow = { omittedCount: 0, reason: '世界书时间条件核验失败，保留完整历史' };
            warn('native-timed-window-preserved', '本轮无法核验世界书时间条件，鱼忆暂时保留完整原文。');
            return;
        }
        if (plan !== expected || plan.chatId !== currentIdentity(ctx())) return;
        for (let index = chat.length - 1; index >= 0; index--) {
            if (windowKeys.has(messageKey(chat[index], index, true))) { chat.splice(index, 1); outgoingWindow.omittedCount++; }
        }
        outgoingWindow.reason = outgoingWindow.omittedCount ? '本轮已省略有记忆覆盖的旧原文' : '本轮无需省略原文';
    }

    /** Listener callbacks are awaited by ST, but ST itself swallows their errors. */
    function bindController(controller) {
        for (const dispose of disposers) dispose();
        disposers = [];
        const source = deps.eventSource ?? ctx().eventSource ?? script.eventSource;
        const types = deps.eventTypes ?? ctx().eventTypes ?? script.event_types;
        let active = true, currentRun = null, pendingStart = null;
        let lockedRun = null;
        const preflights = new WeakMap();
        const foreground = (type, dryRun) => !dryRun && !['quiet', 'impersonate'].includes(type);
        // ST 1.19 copies these same fields into two distinct event payloads.
        // TH 4.11 emits AFTER_COMMANDS with {} and no START. Merely seeing an
        // earlier START would let TH steal it while native slash commands await.
        const nativeFields = ['automatic_trigger', 'force_name2', 'quiet_prompt', 'quietToLoud', 'skipWIAN', 'force_chid', 'signal', 'quietImage'];
        const nativeOptions = options => options && nativeFields.every(key => Object.hasOwn(options, key));
        const normalInput = run => run && [undefined, 'normal'].includes(run.type);
        const removeInputGuard = run => {
            if (run?.inputGuard) run.inputElement?.removeEventListener?.('input', run.inputGuard, true);
            if (run) run.inputGuard = null;
        };
        const releaseInput = run => {
            if (run?.inputElement?.readOnly === true) run.inputElement.readOnly = run.inputWasReadOnly;
        };
        const guardReleasedInput = run => {
            if (!normalInput(run) || run.inputConsumed || run.inputGuard) return;
            run.inputGuard = event => {
                if (run !== currentRun || run.cancelled || run.inputConsumed || run.inputFallback) return;
                const value = snapshot().userInput;
                // Native ST dispatches a synthetic input event when it clears
                // the consumed textarea, before MESSAGE_SENT. A real user
                // deletion remains observable through its trusted input event.
                if (value === run.input || (event.isTrusted === false && value === '')) return;
                run.inputFallback = true;
                clearPlan();
                warn('native-input-changed', '选材后输入发生变化，本轮改按原世界书和完整历史发送；请核对本轮输入。');
            };
            run.inputElement?.addEventListener?.('input', run.inputGuard, true);
        };
        const enforceLock = run => {
            if (run !== lockedRun || run.cancelled) return;
            script.setSendButtonState?.(true);
            script.deactivateSendButtons?.();
        };
        const releaseLock = (run, cancelled = false) => {
            if (lockedRun !== run) return;
            lockedRun = null;
            removeInputGuard(run);
            releaseInput(run);
            if (cancelled) {
                script.setSendButtonState?.(false);
                script.activateSendButtons?.();
            }
        };
        const acquireLock = run => {
            if (!run || lockedRun === run) return;
            if (lockedRun) releaseLock(lockedRun, true);
            run.chatId = currentIdentity(ctx());
            const at = snapshot();
            run.input = at.userInput;
            run.sentIndex = at.messages.length;
            run.replyIndex = run.replacement?.prefixKeys.length ?? (['continue', 'append', 'appendFinal'].includes(run.type)
                ? Math.max(0, at.messages.length - 1) : at.messages.length);
            run.inputElement = globalThis.document?.querySelector?.('#send_textarea');
            run.inputWasReadOnly = run.inputElement?.readOnly ?? false;
            if (run.inputElement) run.inputElement.readOnly = true;
            lockedRun = run;
            enforceLock(run);
        };
        const capturePreflight = (type, options, dryRun) => {
            if (!foreground(type, dryRun)) return null;
            const canBind = options !== null && typeof options === 'object';
            if (canBind && preflights.has(options)) return preflights.get(options);
            // Never claim a foreign event, even while a native START is pending.
            const run = pendingStart;
            if (!run || run.type !== type || !nativeOptions(options)
                || !nativeFields.every(key => Object.is(options[key], run.options[key]))) return null;
            pendingStart = null;
            run.phase = 'preflight';
            currentRun = run;
            replacement = run.replacement;
            if (canBind) preflights.set(options, run);
            return run;
        };
        const cancelRun = (retainReplacement = false) => {
            if (currentRun) {
                currentRun.cancelled = true; currentRun.abort.abort();
                removeInputGuard(currentRun);
                // Only preflight UI belongs to Fish. Once ST resumed Generate,
                // its own completion/error/stop path owns the send buttons.
                releaseLock(currentRun, currentRun.phase === 'preflight');
            }
            // A card's cancellation cleanup may run before ST restores the old
            // candidate. Preserve its memory until that transient gap closes.
            replacement = retainReplacement && replacement && !replacement.received
                ? { ...replacement, cancelled: true } : null;
        };
        const beginRun = (type, options, dryRun) => {
            if (!foreground(type, dryRun) || !nativeOptions(options)) return;
            cancelRun(true);
            clearPlan();
            currentRun = pendingStart = { type, options: { ...options }, phase: 'pending', cancelled: false,
                abort: new AbortController(), replacement: captureReplacement(type) };
            replacement = currentRun.replacement;
        };
        const checkReadiness = () => { if (active) Promise.resolve(controller.readinessChanged?.()).catch(console.error); };
        const observeEnd = (run, phase) => {
            if (!active || !run || run !== currentRun || run.cancelled) return;
            // ENDED is global (quiet / TH / previous turn / even our own unlock).
            // It is not evidence that this awaited preflight was cancelled.
            if (run.phase === 'preflight') { if (phase === 'preflight') enforceLock(run); return; }
            if (phase !== 'native' || run.phase !== 'native') return;
            // A native ping/error can exit before MESSAGE_SENT. Return only our
            // textarea restriction so that path stays recoverable; preserve the
            // possibly in-flight prompt and never alter native button state.
            guardReleasedInput(run);
            releaseInput(run);
        };
        const consumeInput = index => {
            const run = currentRun, message = ctx().chat?.[index];
            if (!run || run.phase !== 'native' || run.cancelled || run.chatId !== currentIdentity(ctx())
                || index !== run.sentIndex || !message?.is_user) return;
            run.inputConsumed = true; run.replyIndex = index + 1;
            removeInputGuard(run);
            releaseInput(run);
        };
        const retireUsedPlan = (index, type, message) => {
            const run = currentRun;
            if (!run || run.phase !== 'native' || run.cancelled || run.chatId !== currentIdentity(ctx())
                || index !== run.replyIndex || message?.is_user || !String(message?.mes ?? '').trim()) return;
            const matchingType = ['continue', 'append', 'appendFinal'].includes(run.type)
                ? ['continue', 'append', 'appendFinal'].includes(type)
                : run.type === 'swipe' ? type === 'swipe' : ['normal', 'regenerate'].includes(type);
            if (!matchingType) return;
            run.phase = 'complete'; removeInputGuard(run); releaseLock(run);
            currentRun = null; pendingStart = null; generationType = null;
            clearPlan();
            Promise.resolve(controller.generationEnded?.()).catch(console.error);
        };
        const stopRun = (...args) => {
            // ST's own stopGeneration emits without arguments. TavernHelper
            // stopGenerationById/stopAllGeneration pass its generation id; those
            // stops belong to that tool's request, not to the player's send.
            if (args.length && args[0] !== undefined) return;
            cancelRun(true); pendingStart = null; cancelMessageTimers(); clearPlan();
            generationType = null; controller.generationStopped?.();
        };
        disposers.push(() => { active = false; cancelRun(); });
        // ST's event emitter catches listener failures and resumes Generate.
        // Guard the awaited emit boundary itself: a stale preflight must reject
        // before native Generate reads/clears input or mutates the current chat.
        // The check is request-scoped; it never calls the global stop function.
        if (typeof source.emit === 'function' && types.GENERATION_AFTER_COMMANDS) {
            const originalEmit = source.emit;
            const guardedEmit = async function (event, ...args) {
                if (!active) return originalEmit.call(this, event, ...args);
                if (event === types.GENERATION_STARTED) beginRun(...args);
                if (event === types.GENERATION_STOPPED) stopRun(...args);
                // Input is already in chat here. Disarm before awaited card
                // listeners can start composing the next draft.
                if (event === types.MESSAGE_SENT) consumeInput(args[0]);
                if (event === types.GENERATION_ENDED) {
                    // Capture before the first awaited listener: a delayed old
                    // event must never acquire ownership of a newer send.
                    const endedRun = currentRun, phase = endedRun?.phase;
                    if (phase === 'preflight') enforceLock(endedRun);
                    const result = await originalEmit.call(this, event, ...args);
                    observeEnd(endedRun, phase);
                    checkReadiness();
                    return result;
                }
                if (event !== types.GENERATION_AFTER_COMMANDS || !foreground(args[0], args[2])) return originalEmit.call(this, event, ...args);
                const run = capturePreflight(...args);
                if (!run) return originalEmit.call(this, event, ...args);
                acquireLock(run);
                try {
                    const result = await originalEmit.call(this, event, ...args);
                    const changedInput = run.input !== snapshot().userInput;
                    const disconnected = (ctx().onlineStatus ?? script.online_status) === 'no_connection';
                    if (!active || run.cancelled || run !== currentRun || run.chatId !== currentIdentity(ctx()) || changedInput || disconnected) {
                        if (changedInput && run === currentRun && !run.cancelled) warn('preflight-input-changed', '选材期间输入发生变化，本次发送已取消；请核对输入后重新发送。');
                        releaseLock(run, true);
                        throw new DOMException(disconnected ? '酒馆正文连接尚未就绪，本次发送已取消。' : '鱼忆已取消本次发送；聊天或输入已变化。', 'AbortError');
                    }
                    run.phase = 'native';
                    // ST takes over the send button after this boundary. Typing
                    // during regenerate/swipe/continue is safe again now.
                    if (!normalInput(run)) releaseInput(run);
                    return result;
                } catch (error) {
                    run.cancelled = true; run.abort.abort();
                    releaseLock(run, true);
                    throw error;
                }
            };
            source.emit = guardedEmit;
            disposers.push(() => { if (source.emit === guardedEmit) source.emit = originalEmit; });
        }
        const listen = (type, fn) => {
            if (!type) return;
            source.on(type, fn);
            disposers.push(() => source.removeListener(type, fn));
        };
        // A fallback for injected minimal event sources. Production ST uses
        // guardedEmit above so capture precedes all awaited card listeners.
        if (typeof source.emit !== 'function') {
            listen(types.GENERATION_STARTED, beginRun);
            listen(types.GENERATION_ENDED, () => { observeEnd(currentRun, currentRun?.phase); checkReadiness(); });
            listen(types.GENERATION_STOPPED, stopRun);
        }
        listen(types.GENERATION_AFTER_COMMANDS, async (type, options, dryRun) => {
            if (!foreground(type, dryRun)) return;
            const run = capturePreflight(type, options, dryRun);
            if (!run) return;
            const isCurrent = () => active && run === currentRun && !run.cancelled;
            if (!isCurrent()) return;
            generationType = type;
            const stopBefore = nativeStopSerial;
            try {
                const result = await controller.generationBefore?.({ type, options, dryRun, isCurrent, signal: run.abort.signal });
                if (run && isCurrent() && !result?.cancel) run.prepared = true;
                if (isCurrent() && result?.cancel) {
                    if (run) run.cancelled = true;
                    if (nativeStopSerial === stopBefore) stopGeneration();
                }
            } catch (error) {
                if (!isCurrent()) return;
                clearPlan();
                warn('preflight-error', '鱼忆前置处理未完成，请查看辅助模型连接和收发记录；未选择原书回退时，本次发送会取消。');
                // The ST emitter catches listener exceptions, so an exception alone
                // cannot stop the native request. Let the player choose fallback.
                let decision = 'cancel';
                try {
                    decision = await (deps.onPreflightFailure ?? controller.onPreflightFailure)?.(error) ?? 'cancel';
                } catch { decision = 'cancel'; }
                if (isCurrent() && decision !== 'fallback') {
                    if (run) run.cancelled = true;
                    if (nativeStopSerial === stopBefore) stopGeneration();
                }
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
            retireUsedPlan(index, type, received);
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
        listen(types.MESSAGE_SENT, consumeInput);
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
            Promise.resolve(controller.messageSwiped?.({ index })).catch(console.error);
        });
        listen(types.MESSAGE_DELETED, index => {
            const expected = currentRun?.replacement;
            if (currentRun?.prepared && !currentRun.cancelled && script.isGenerating?.() !== false && expected?.type === 'regenerate' && !expected.deleted
                && !expected.received && expected.chatId === currentIdentity(ctx()) && index === expected.prefixKeys.length
                && JSON.stringify(snapshot().messages.map(m => m.key)) === JSON.stringify(expected.prefixKeys)) {
                // Generate removes this captured tail while its native send
                // state is active. Once ST is idle, the same-position user
                // deletion must be reconciled even if a prior run failed.
                expected.deleted = true;
                return;
            }
            replacement = null;
            if (currentRun) { currentRun.replacement = null; currentRun.prepared = false; }
            Promise.resolve(controller.messageDeleted?.({ index })).catch(console.error);
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
            Promise.resolve(controller.messageSwipeDeleted?.(data)).catch(console.error);
        });
        return () => { for (const dispose of disposers) dispose(); disposers = []; cancelMessageTimers(); clearPlan(); };
    }

    async function rawGenerate(params) {
        // Explicit dependency injection is kept for deterministic adapter tests.
        // Production never enters ST generateRaw's template/cleanup pipeline.
        const generate = deps.rawGenerate;
        params?.signal?.throwIfAborted?.();
        if (typeof generate !== 'function') {
            const api = ctx().mainApi ?? script.main_api;
            return generateAuxiliary({ params, context: ctx(), script,
                openai: api === 'openai' ? deps.openai ?? await import('/scripts/openai.js') : null,
                textgen: api === 'textgenerationwebui' ? deps.textgen ?? await import('/scripts/textgen-settings.js') : null,
                instruct: api === 'textgenerationwebui' ? deps.instruct ?? await import('/scripts/instruct-mode.js') : null,
                fetchImpl: deps.fetch ?? globalThis.fetch });
        }
        const result = await generate({ prompt: [
            { role: 'system', content: String(params.system ?? '') },
            { role: 'user', content: String(params.input ?? '') },
        ], trimNames: false, responseLength: params.responseLength });
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

    return { snapshot, generationSnapshot, pendingReplacement, previewSnapshot: () => snapshot(true), previewEligible: entry => eligible(entry, { silent: true, type: 'normal' }), loadWorldbook, worldbookStatus, checkWorldbook, eligible, storage, setPlan, clearPlan, applyWorldInfoEntries, applyWindow, restoreLegacyWindow, filterOutgoingHistory, bindController, rawGenerate, stopGeneration, auxiliaryReadiness,
        readMvu: settings => readMvuProjection({ context: ctx, settings, globals: deps.globals ?? globalThis }),
        getWarnings: () => copy(warnings), windowStatus: () => copy(outgoingWindow) };
}
