import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DIRECTORY_NAME, PLAYER_FILES, PROJECT_ROOT, RUNTIME_FILES, SOURCE_FILES, distributionFiles, stageDistribution } from '../scripts/build.mjs';
import { prepareRelease } from '../scripts/release.mjs';

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dwm-build-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const file of [...RUNTIME_FILES, ...PLAYER_FILES, ...SOURCE_FILES, 'test/synthetic.test.js']) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), `synthetic fixture: ${file}\n`);
    }
    for (const file of ['manifest.json', 'package.json']) await writeFile(path.join(root, file), JSON.stringify({ version: '0.1.0-alpha.1' }));
    return root;
}

async function names(root, prefix = '') {
    const result = [];
    for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) result.push(...await names(root, name)); else result.push(name);
    }
    return result.sort();
}

test('clean rebuild removes stale output and excludes unreviewed, private and research files', async t => {
    const root = await fixture(t);
    for (const file of ['src/private-notes.js', 'test/private.json', 'research/upstream.js', '.local/key.json', '.git/config', '.env']) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), 'do not distribute');
    }
    const first = await stageDistribution({ root, check: false });
    await writeFile(path.join(first.target, 'removed-module.js'), 'stale runtime');
    await mkdir(path.join(first.target, 'stale-dir'));
    await writeFile(path.join(first.target, 'stale-dir/secret.json'), 'stale secret');
    const second = await stageDistribution({ root, check: false });
    assert.deepEqual(await names(second.target), [...RUNTIME_FILES, ...PLAYER_FILES, 'RELEASE-MANIFEST.json'].sort());
    assert.equal(await readFile(path.join(root, 'research/upstream.js'), 'utf8'), 'do not distribute');
});

test('source distribution adds only build tooling, reviewed public docs and top-level unit tests', async t => {
    const root = await fixture(t);
    await mkdir(path.join(root, 'test/fixtures'), { recursive: true });
    await writeFile(path.join(root, 'test/fixtures/private.test.js'), 'private transcript');
    await writeFile(path.join(root, 'LICENSE'), 'Author-selected license fixture');
    const result = await stageDistribution({ root, kind: 'source', check: false });
    assert.deepEqual(await names(result.target), [...RUNTIME_FILES, ...PLAYER_FILES, ...SOURCE_FILES, 'test/synthetic.test.js', 'LICENSE', 'RELEASE-MANIFEST.json'].sort());
    assert.equal(result.licenseFileIncluded, true);
});

test('release file inventory hashes exact emitted content and does not expose local paths', async t => {
    const root = await fixture(t);
    const result = await stageDistribution({ root, check: false });
    const metadataText = await readFile(path.join(result.target, 'RELEASE-MANIFEST.json'), 'utf8');
    const metadata = JSON.parse(metadataText);
    assert.equal(metadata.version, '0.1.0-alpha.1');
    assert.equal(metadata.status, 'unpublished-candidate');
    assert.equal(metadata.licenseFileIncluded, false);
    assert.equal(metadataText.includes(root), false);
    for (const file of metadata.files) {
        const bytes = await readFile(path.join(result.target, file.path));
        assert.equal(file.bytes, bytes.length);
        assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
});

test('missing or mismatched sources fail before replacing a previous usable build', async t => {
    const root = await fixture(t);
    const first = await stageDistribution({ root, check: false });
    await writeFile(path.join(first.target, 'keep-on-failure'), 'prior build');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: 'different' }));
    await assert.rejects(stageDistribution({ root, check: false }), /versions differ/);
    assert.equal(await readFile(path.join(first.target, 'keep-on-failure'), 'utf8'), 'prior build');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0-alpha.1' }));
    await rm(path.join(root, 'index.js'));
    await assert.rejects(stageDistribution({ root, check: false }), /ENOENT/);
    assert.equal(await readFile(path.join(first.target, 'keep-on-failure'), 'utf8'), 'prior build');
});

test('build rejects a host target or symbolic-link parent and does not follow source links', async t => {
    const root = await fixture(t);
    const foreign = await mkdtemp(path.join(os.tmpdir(), 'dwm-protected-'));
    t.after(() => rm(foreign, { recursive: true, force: true }));
    await writeFile(path.join(foreign, 'preserved'), 'host data');
    await assert.rejects(stageDistribution({ root, target: foreign, check: false }), /inside this project/);
    await mkdir(path.join(root, '.local'));
    await symlink(foreign, path.join(root, '.local/build'), 'dir');
    await assert.rejects(stageDistribution({ root, check: false }), /symbolic link/);
    await rm(path.join(root, '.local/build'));
    await rm(path.join(root, 'index.js'));
    await symlink(path.join(foreign, 'preserved'), path.join(root, 'index.js'));
    await assert.rejects(stageDistribution({ root, check: false }), /regular project file|symbolic link/);
    assert.equal(await readFile(path.join(foreign, 'preserved'), 'utf8'), 'host data');
});

test('runtime inventory includes every local JS module and stylesheet dependency', async () => {
    const allowed = new Set(RUNTIME_FILES);
    for (const file of RUNTIME_FILES.filter(name => /\.(js|css)$/.test(name))) {
        const text = await readFile(path.join(PROJECT_ROOT, file), 'utf8');
        const references = [...text.matchAll(/(?:from\s*|import\s*\(?|url\(\s*)['"](\.[^'"]+)['"]/g)];
        for (const match of references) {
            const imported = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
            assert.ok(allowed.has(imported), `${file} dependency missing from runtime inventory: ${imported}`);
        }
    }
});

test('offline archives have one extension root, clean inventories and matching outer checksums', async t => {
    try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); execFileSync('unzip', ['-v'], { stdio: 'ignore' }); }
    catch { t.skip('zip and unzip are required for archive verification'); return; }
    const root = await fixture(t);
    const result = await prepareRelease({ root, check: false });
    const sums = await readFile(path.join(result.target, 'SHA256SUMS'), 'utf8');
    for (const item of result.distributions) {
        const archive = path.join(result.target, item.archive);
        const bytes = await readFile(archive);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
        assert.ok(sums.includes(`${item.sha256}  ${item.archive}\n`));
        const paths = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n').sort();
        assert.deepEqual(paths, [...await distributionFiles(root, item.kind), 'RELEASE-MANIFEST.json'].map(name => `${item.directory}/${name}`).sort());
        assert.ok(paths.includes(`${item.kind === 'install' ? DIRECTORY_NAME : `${DIRECTORY_NAME}-source`}/manifest.json`));
        execFileSync('unzip', ['-t', archive], { stdio: 'ignore' });
    }
    await writeFile(path.join(result.target, 'stale-private.txt'), 'stale');
    await prepareRelease({ root, check: false });
    assert.ok(!(await readdir(result.target)).includes('stale-private.txt'));
});
