import test from 'node:test';
import assert from 'node:assert/strict';
import { combineSignals, timeoutSignal, throwIfAborted } from '../src/platform/abort.js';
import { AgentClient } from '../src/agents/client.js';
import { createSettingsPersistence } from '../src/adapters/settings.js';

async function legacy(run) {
    const descriptors = [[AbortSignal, 'any'], [AbortSignal, 'timeout'], [AbortSignal.prototype, 'throwIfAborted']]
        .map(([target, key]) => [target, key, Object.getOwnPropertyDescriptor(target, key)]);
    try {
        for (const [target, key] of descriptors) Object.defineProperty(target, key, { configurable: true, value: undefined });
        await run();
    } finally {
        for (const [target, key, descriptor] of descriptors) Object.defineProperty(target, key, descriptor);
    }
}

function tracked() {
    const controller = new AbortController(), listeners = new Set();
    const signal = controller.signal, add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, listener, options) => { if (type === 'abort') listeners.add(listener); add(type, listener, options); };
    signal.removeEventListener = (type, listener) => { listeners.delete(listener); remove(type, listener); };
    return { controller, signal, listeners };
}

test('fallback forwards the first cancellation reason and detaches every source', () => legacy(async () => {
    const a = tracked(), b = tracked(), reason = new Error('switched chat');
    const scope = combineSignals([a.signal, a.signal, b.signal]);
    assert.equal(a.listeners.size, 1);
    b.controller.abort(reason);
    assert.throws(() => throwIfAborted(scope.signal), error => error === reason);
    assert.equal(a.listeners.size, 0); assert.equal(b.listeners.size, 0);
    a.controller.abort(new Error('later'));
    assert.equal(scope.signal.reason, reason);
    scope.dispose();
}));

test('fallback respects already cancelled signals and cleans successful operations', () => legacy(async () => {
    const a = tracked(), b = tracked(); b.controller.abort('stopped');
    const aborted = combineSignals([a.signal, b.signal]);
    assert.equal(aborted.signal.reason, 'stopped'); assert.equal(a.listeners.size, 0);
    const scope = combineSignals([a.signal, new AbortController().signal]);
    scope.dispose(); scope.dispose(); assert.equal(a.listeners.size, 0);
    assert.equal(scope.signal.aborted, false);
}));

test('fallback deadlines cancel, can be disposed, and zero means unlimited', () => legacy(async () => {
    const elapsed = timeoutSignal(5), disposed = timeoutSignal(5), unlimited = timeoutSignal(0);
    disposed.dispose();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(elapsed.signal.reason.name, 'TimeoutError');
    assert.equal(disposed.signal.aborted, false); assert.equal(unlimited.signal, undefined);
    elapsed.dispose(); unlimited.dispose();
}));

test('legacy AgentClient detaches stopped callers from noncooperative generation', () => legacy(async () => {
    const a = tracked(), reason = new Error('user stop');
    let resolve, seen;
    const client = new AgentClient(request => { seen = request.signal; return new Promise(done => { resolve = done; }); }, { timeoutMs: 1000 });
    const pending = client.complete({ purpose: 'select', input: {}, signal: a.signal });
    a.controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(seen.aborted, true); assert.equal(a.listeners.size, 0);
    resolve('{}');
}));

test('legacy AgentClient deadline rejects late generation without retry', () => legacy(async () => {
    let calls = 0, resolve;
    const client = new AgentClient(() => { calls++; return new Promise(done => { resolve = done; }); }, { timeoutMs: 1000 });
    await assert.rejects(client.complete({ purpose: 'select', input: {} }), { name: 'TimeoutError' });
    assert.equal(calls, 1); resolve('{}');
}));

test('legacy success releases combined listeners and settings readback works', () => legacy(async () => {
    const a = tracked();
    const client = new AgentClient(async () => '{}', { timeoutMs: 1000 });
    assert.deepEqual(await client.complete({ purpose: 'select', input: {}, signal: a.signal }), {});
    assert.equal(a.listeners.size, 0);
    const settings = { dwm: { enabled: false } };
    const persist = createSettingsPersistence({ extensionSettings: settings, saveSettings: async () => {}, getRequestHeaders: () => ({}),
        fetch: async (_url, options) => { assert.equal(options.signal.aborted, false); return { ok: true, json: async () => ({ settings: JSON.stringify({ extension_settings: settings }) }) }; } });
    await persist({ enabled: true });
    assert.equal(settings.dwm.enabled, true);
}));
