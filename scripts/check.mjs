import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

async function walk(dir) {
    const out = [];
    for (const item of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, item.name);
        if (item.isDirectory()) out.push(...await walk(p)); else out.push(p);
    }
    return out;
}
const files = ['index.js', ...await walk('src'), ...await walk('scripts'), ...await walk('test')];
for (const file of files.filter(f => /\.(m?js)$/.test(f))) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
for (const file of [manifest.js, manifest.css]) await readFile(file);
console.log(`语法与入口检查通过：${files.length} 个文件。`);
