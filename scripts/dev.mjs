import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const port = Number(process.env.DWM_PORT ?? 4178);
http.createServer(async (req, res) => {
    try {
        const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const relative = name === '/' ? 'demo/index.html' : name.slice(1);
        const file = path.resolve(root, relative);
        if (!file.startsWith(root + path.sep) || relative.split('/').some(p => p.startsWith('.'))) { res.writeHead(403); res.end(); return; }
        const content = await readFile(file);
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'text/plain', 'Cache-Control': 'no-store' }); res.end(content);
    } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`仅本机开发预览：http://127.0.0.1:${port}`));
