// Native Generate('swipe') also serves automatic swipes and carries no swipe
// source in ST 1.19. Only a recent player action on this chat/tail can ask.
export function trackRerollIntent(doc, getChat, getChatId, isGenerating) {
    let pending = null;
    let touch = null;
    const listeners = [];
    function listen(type, fn) {
        doc?.addEventListener?.(type, fn, true);
        listeners.push([type, fn]);
    }
    function remember(type) {
        const tail = getChat()?.at(-1);
        if (!tail || isGenerating?.() || (type === 'swipe' &&
            (tail.is_user || (tail.swipe_id ?? 0) + 1 < (tail.swipes?.length ?? 1)))) return;
        pending = {type, chatId: getChatId(), tail, at: Date.now()};
    }
    listen('click', event => {
        if (!event.isTrusted) return;
        pending = null;
        if (event.target?.closest?.('#option_regenerate')) remember('regenerate');
        else if (event.target?.closest?.('.last_mes .swipe_right')) remember('swipe');
    });
    listen('keydown', event => {
        if (!event.isTrusted || event.isComposing) return;
        pending = null;
        if (event.key === 'ArrowRight' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
            !event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) remember('swipe');
        if (event.key === 'Enter' && event.ctrlKey && !doc.querySelector?.('#send_textarea')?.value) remember('regenerate');
    });
    // ST converts a touchend into a synthetic swiped-left event and a jQuery
    // click. Pair that gesture with the real touch on the same message area.
    listen('touchend', event => {
        touch = event.isTrusted && event.target?.closest?.('#sheld') ? {target:event.target, at:Date.now()} : null;
    });
    listen('swiped-left', event => {
        if (touch && touch.target === event.target && Date.now() - touch.at < 300) remember('swipe');
        touch = null;
    });
    return {
        consume(type, options) {
            const action = pending;
            pending = null;
            return Boolean(action && !options?.automatic_trigger && action.type === type &&
                action.chatId === getChatId() && action.tail === getChat()?.at(-1) && Date.now() - action.at < 5000);
        },
        clear() { pending = null; touch = null; },
        dispose() { for (const [type, fn] of listeners) doc?.removeEventListener?.(type, fn, true); },
    };
}
