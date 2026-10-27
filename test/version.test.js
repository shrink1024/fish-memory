import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('reported plugin version, manifest and package stay in step', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const entry = await readFile(new URL('../main.js', import.meta.url), 'utf8');
    assert.equal(pkg.version, manifest.version);
    assert.equal(entry.match(/const PLUGIN_VERSION = '([^']+)'/)?.[1], manifest.version);
    assert.doesNotMatch(entry, /pluginVersion: '|version: '0\./, 'problem exports and the public handle use the shared constant');
});
