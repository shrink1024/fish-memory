/** Local compatibility only: never replace the host's AbortSignal globals. */
export function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Release fallback listeners when an operation finishes without cancellation. */
export function combineSignals(signals) {
    const sources = [...new Set(signals.filter(Boolean))];
    if (sources.length === 1) return { signal: sources[0], dispose() {} };
    if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(sources), dispose() {} };
    const controller = new AbortController(), listeners = [];
    const dispose = () => {
        for (const [source, listener] of listeners) source.removeEventListener('abort', listener);
        listeners.length = 0;
    };
    const forward = source => {
        controller.abort(source.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        dispose();
    };
    for (const source of sources) {
        if (source.aborted) { forward(source); break; }
        const listener = () => forward(source);
        listeners.push([source, listener]);
        source.addEventListener('abort', listener, { once: true });
    }
    return { signal: controller.signal, dispose };
}

/** Zero disables the deadline. Native active-time semantics remain unchanged. */
export function timeoutSignal(milliseconds) {
    if (milliseconds === 0) return { signal: undefined, dispose() {} };
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2147483647) throw new RangeError('Invalid timeout');
    if (typeof AbortSignal.timeout === 'function') return { signal: AbortSignal.timeout(milliseconds), dispose() {} };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), milliseconds);
    return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
