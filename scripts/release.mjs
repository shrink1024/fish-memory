import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanOutput, DIRECTORY_NAME, PROJECT_ROOT, stageDistribution } from './build.mjs';

async function listFiles(root, prefix = '') {
    const files = [];
    for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) files.push(...await listFiles(root, name)); else files.push(name);
    }
    return files.sort();
}

export async function prepareRelease({ root = PROJECT_ROOT, check = true } = {}) {
    root = path.resolve(root);
    if (check) {
        execFileSync(process.execPath, ['--test', ...((await readdir(path.join(root, 'test'))).filter(name => name.endsWith('.test.js')).map(name => `test/${name}`))], { cwd: root, stdio: 'inherit' });
        execFileSync(process.execPath, ['scripts/check.mjs'], { cwd: root, stdio: 'inherit' });
    }
    // Zip is only needed for offline release archives, not for npm run build.
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    if (!/^[\w.+-]+$/.test(manifest.version)) throw new Error('Unsafe release version');
    const target = await cleanOutput(root, path.join(root, '.local/release', manifest.version));
    const distributions = [];
    for (const kind of ['install', 'source']) {
        const directory = kind === 'install' ? DIRECTORY_NAME : `${DIRECTORY_NAME}-source`;
        const result = await stageDistribution({ root, target: path.join(target, directory), kind, check: false });
        const archive = `${DIRECTORY_NAME}-${manifest.version}-${kind}.zip`;
        // Pass a reviewed file inventory instead of recursively archiving a working tree.
        execFileSync('zip', ['-q', '-X', path.join(target, archive), ...((await listFiles(result.target)).map(file => `${directory}/${file}`))], { cwd: target });
        const bytes = await readFile(path.join(target, archive));
        distributions.push({ kind, directory, archive, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), files: result.files.length + 1 });
    }
    await writeFile(path.join(target, 'SHA256SUMS'), distributions.map(item => `${item.sha256}  ${item.archive}\n`).join(''));
    await writeFile(path.join(target, 'release.json'), JSON.stringify({ version: manifest.version, status: 'unpublished-candidate', distributions }, null, 2) + '\n');
    return { target, distributions };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await prepareRelease();
    console.log(`源码与离线安装候选已生成：${result.target}。公开账号／许可证／发布确认仍须由作者决定；本命令不会创建仓库或上传。`);
}
