import { invariant } from './util.js';

/** Calculate desired outgoing omissions. Existing external hides are never claimed. */
export function planWindow(messages, processedKeys, { enabled, recentTurns = 12, owner = 'dynamic-world-memory' }) {
    invariant(Number.isInteger(recentTurns) && recentTurns >= 1 && recentTurns <= 1000, '窗口轮数应为 1–1000');
    const userStarts = messages.flatMap((m, i) => m.role === 'user' ? [i] : []);
    const start = userStarts.length > recentTurns ? userStarts[userStarts.length - recentTurns] : 0;
    let covered = 0;
    while (covered < messages.length && messages[covered].key === processedKeys[covered]) covered++;
    const boundary = enabled ? Math.min(start, covered) : 0;
    return messages.map((m, index) => {
        const own = m.hiddenBy === owner;
        const shouldHide = enabled && index < boundary;
        if (shouldHide && !m.hidden) return { key: m.key, index, hidden: true, hiddenBy: owner };
        if (!shouldHide && own && m.hidden) return { key: m.key, index, hidden: false, hiddenBy: null };
        return null;
    }).filter(Boolean);
}
