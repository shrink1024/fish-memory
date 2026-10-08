import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsPersistence } from '../src/adapters/settings.js';

function fixture({ mode = 'success', read = 'success' } = {}) {
    const previous = { enabled: true, recentTurns: 12 }, next = { enabled: false, recentTurns: 6 };
    const extensionSettings = { dwm: previous, anotherExtension: { untouched: true } };
    const unrelated = structuredClone(extensionSettings.anotherExtension);
    let disk = structuredClone(previous), nativeRequests = 0, queuedSave = null;
    const reads = [];
    const persist = createSettingsPersistence({ extensionSettings,
        saveSettings: async () => {
            if (mode === 'deferred') {
                // Native TempResponseLength/settingsReady returns after scheduling
                // the debounced writer. It has not submitted any settings yet.
                queuedSave = () => { nativeRequests++; disk = structuredClone(extensionSettings.dwm); };
                return;
            }
            nativeRequests++;
            if (mode === 'swallowed-500') return; // Native catch displays a toast and resolves.
            if (mode === 'throws') throw new Error('native failure');
            disk = structuredClone(extensionSettings.dwm);
        },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'synthetic-test-token' }),
        fetch: async (url, options) => {
            reads.push({ url, options });
            if (read === 'network-failure') throw new Error('synthetic readback network failure');
            if (read === 'http-failure') return { ok: false, status: 500 };
            if (read === 'invalid') return { ok: true, json: async () => ({ settings: '{}' }) };
            return { ok: true, json: async () => ({ settings: JSON.stringify({ extension_settings: { dwm: disk, anotherExtension: unrelated } }) }) };
        },
    });
    return { persist, previous, next, extensionSettings, reads, disk: () => structuredClone(disk),
        requests: () => nativeRequests, flushNative: () => queuedSave?.() };
}

test('normal native save is read back before an immediate exit is certified', async () => {
    const f = fixture();
    await f.persist(f.next);
    assert.deepEqual(f.disk(), f.next);
    assert.deepEqual(f.extensionSettings.dwm, f.next);
    assert.equal(f.requests(), 1);
    assert.equal(f.reads.length, 1);
    assert.equal(f.reads[0].url, '/api/settings/get');
    assert.equal(f.reads[0].options.cache, 'no-cache');
    assert.equal(f.reads[0].options.body, '{}', 'the plugin never posts a replacement settings document');
    assert.deepEqual(f.extensionSettings.anotherExtension, { untouched: true });
});

test('native save swallowing HTTP 500 is not reported as successful persistence', async () => {
    const f = fixture({ mode: 'swallowed-500' });
    await assert.rejects(f.persist(f.next), /设置.*保存|保存.*设置/);
    assert.deepEqual(f.disk(), f.previous);
    assert.strictEqual(f.extensionSettings.dwm, f.previous);
});

test('temporary generation settings queue cannot certify a zero-request save and later uses rolled-back values', async () => {
    const f = fixture({ mode: 'deferred' });
    await assert.rejects(f.persist(f.next), /设置.*保存|保存.*设置/);
    assert.equal(f.requests(), 0);
    assert.strictEqual(f.extensionSettings.dwm, f.previous);
    f.flushNative();
    assert.deepEqual(f.disk(), f.previous, 'the native queued callback reads the restored settings, not the rejected toggle');
});

for (const read of ['network-failure', 'http-failure', 'invalid']) test(`unconfirmed settings readback (${read}) reports failure and restores only Fish settings`, async () => {
    const f = fixture({ read });
    await assert.rejects(f.persist(f.next), /设置.*保存|保存.*设置/);
    assert.strictEqual(f.extensionSettings.dwm, f.previous);
    assert.deepEqual(f.extensionSettings.anotherExtension, { untouched: true });
});

test('a native thrown failure retains the previous settings and avoids readback', async () => {
    const f = fixture({ mode: 'throws' });
    await assert.rejects(f.persist(f.next), /native failure/);
    assert.strictEqual(f.extensionSettings.dwm, f.previous);
    assert.equal(f.reads.length, 0);
});
