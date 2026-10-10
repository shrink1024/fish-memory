import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIRECTORY_NAME = 'st-dynamic-world-memory';
// Explicit runtime inventory: new runtime modules must be reviewed and added here.
export const RUNTIME_FILES = [
    'index.js', 'style.css', 'manifest.json', 'recovery.html',
    'src/adapters/auxiliary-transport.js', 'src/adapters/luker.js', 'src/adapters/mvu.js', 'src/adapters/settings.js', 'src/adapters/sillytavern.js', 'src/adapters/tauritavern.js',
    'src/agents/client.js', 'src/agents/preset-preferences.js', 'src/agents/prompts.js', 'src/agents/requests.js', 'src/agents/source-segments.js', 'src/agents/tasks.js',
    'src/core/fingerprint.js', 'src/core/operations.js', 'src/core/source-book.js', 'src/core/state.js', 'src/core/storage-codec.js', 'src/core/store.js', 'src/core/util.js', 'src/core/views.js', 'src/core/window.js',
    'src/diagnostics/capture.js', 'src/diagnostics/problem-export.js', 'src/diagnostics/prompt-preview.js', 'src/diagnostics/trace-store.js',
    'src/platform/abort.js',
    'src/rules/index.js', 'src/rules/README.md', 'src/runtime/controller.js', 'src/runtime/prompt-plan.js',
    'src/ui/activity.js', 'src/ui/diff.js', 'src/ui/floating-manager.js', 'src/ui/panel.js', 'src/ui/prompt-preview.js', 'src/ui/style.css', 'src/ui/trace-viewer.js',
];
export const PLAYER_FILES = ['README.md', 'INSTALL.md', 'COMPATIBILITY.md', 'docs/public/CHANGELOG.md', 'docs/public/FEEDBACK.md'];
export const SOURCE_FILES = [
    'package.json', 'scripts/build.mjs', 'scripts/release.mjs', 'scripts/check.mjs', 'scripts/dev.mjs',
    'demo/index.html', 'demo/main.js', 'docs/public/SOURCE-BUILD.md',
];

export async function distributionFiles(root = PROJECT_ROOT, kind = 'install') {
    if (!['install', 'source'].includes(kind)) throw new Error('Unknown distribution kind');
    const files = [...RUNTIME_FILES, ...PLAYER_FILES];
    if (kind === 'source') {
        files.push(...SOURCE_FILES);
        // Only executable unit tests; fixtures, model transcripts and evidence are excluded.
        for (const file of await readdir(path.join(root, 'test'))) if (/^[\w-]+\.test\.js$/.test(file)) files.push(`test/${file}`);
    }
    try { await lstat(path.join(root, 'LICENSE')); files.push('LICENSE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return files.sort();
}

export async function cleanOutput(root, target) {
    const local = path.resolve(root, '.local');
    const output = path.resolve(target);
    if (!output.startsWith(local + path.sep)) throw new Error('Build output must be inside this project’s .local directory');
    // Do not follow a symlink from the output parent into a host install or user data.
    let current = root;
    for (const part of path.relative(root, path.dirname(output)).split(path.sep)) {
        current = path.join(current, part);
        try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Output parent is a symbolic link: ${part}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    return output;
}

export async function stageDistribution({ root = PROJECT_ROOT, target = path.join(root, '.local/build', DIRECTORY_NAME), kind = 'install', check = true } = {}) {
    root = path.resolve(root);
    if (check) execFileSync(process.execPath, ['scripts/check.mjs'], { cwd: root, stdio: 'inherit' });
    const files = await distributionFiles(root, kind);
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (manifest.version !== pkg.version) throw new Error('manifest.json and package.json versions differ');
    if (!/^[\w.+-]+$/.test(manifest.version)) throw new Error('Unsafe release version');
    const resolvedRoot = await realpath(root);
    // Validate every source before replacing an existing output.
    for (const file of files) {
        const source = path.join(root, file);
        const stat = await lstat(source);
        if (!stat.isFile() || !(await realpath(source)).startsWith(resolvedRoot + path.sep)) throw new Error(`Distribution source is not a regular project file: ${file}`);
        if (stat.isSymbolicLink()) throw new Error(`Distribution source is a symbolic link: ${file}`);
    }
    const output = await cleanOutput(root, target);
    const inventory = [];
    for (const file of files) {
        const destination = path.join(output, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(root, file), destination);
        const bytes = await readFile(destination);
        inventory.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const release = { product: '鱼忆｜动态世界书与记忆', version: manifest.version, kind, status: 'unpublished-candidate',
        licenseFileIncluded: files.includes('LICENSE'), files: inventory };
    await writeFile(path.join(output, 'RELEASE-MANIFEST.json'), JSON.stringify(release, null, 2) + '\n');
    return { target: output, ...release };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await stageDistribution();
    console.log(`候选安装构建 ${result.version}：${result.target}（${result.files.length + 1} 文件；未部署／未发布）`);
}
