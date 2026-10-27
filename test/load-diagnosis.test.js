import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { diagnoseLoad, reportLoadFailure } from '../index.js';
import { RUNTIME_FILES } from '../scripts/build.mjs';

const main = new URL('../main.js', import.meta.url);
// Serve the real files; `refuse` simulates a blocker, `missing` a broken install.
const serve = ({ refuse = '', missing = '' } = {}) => async url => {
    if (refuse && url.endsWith(refuse)) throw new TypeError('Failed to fetch');
    if (missing && url.endsWith(missing)) return new Response('', { status: 404 });
    return new Response(await readFile(fileURLToPath(url), 'utf8'));
};
const failed = new TypeError('Failed to fetch dynamically imported module');

test('FM-005: the loader walks the whole runtime import graph', async () => {
    const message = await diagnoseLoad(main, failed, { fetchImpl: serve(), userAgent: '' });
    const modules = RUNTIME_FILES.filter(file => file.endsWith('.js') && file !== 'index.js');
    assert.match(message, new RegExp(`鱼忆的 ${modules.length} 个文件都能读取`), 'every shipped module is reachable from main.js');
    assert.match(message, /ERR_BLOCKED_BY_CLIENT/);
});

test('FM-005: a refused or missing module is named with what to do', async () => {
    assert.match(await diagnoseLoad(main, failed, { fetchImpl: serve({ refuse: 'src/core/content-hash.js' }) }), /文件 src\/core\/content-hash\.js 无法读取：被浏览器或扩展拦截，或网络连不上.*白名单/);
    assert.match(await diagnoseLoad(main, failed, { fetchImpl: serve({ missing: 'src/ui/panel.js' }) }), /文件 src\/ui\/panel\.js 读取失败（HTTP 404）.*重新安装/);
    assert.match(await diagnoseLoad(main, failed, { fetchImpl: serve({ refuse: 'main.js' }) }), /文件 main\.js 无法读取/);
});

test('FM-005: a syntax error points at the browser, without fetching anything', async () => {
    let fetched = 0;
    const message = await diagnoseLoad(main, new SyntaxError("Unexpected token '#'"), { fetchImpl: async () => { fetched += 1; }, userAgent: 'OldWebView/1' });
    assert.match(message, /无法解析.*Unexpected token '#'.*版本过旧/s);
    assert.match(message, /浏览器：OldWebView\/1/);
    assert.equal(fetched, 0);
});

test('FM-005: a probe that hangs gives up quietly within its time limits', async () => {
    const signals = [];
    const hang = async (url, options) => { signals.push(options.signal); return new Promise(() => {}); };
    const started = Date.now();
    assert.equal(await diagnoseLoad(main, failed, { fetchImpl: hang, requestTimeoutMs: 30, totalTimeoutMs: 1000 }), '');
    assert.ok(Date.now() - started < 500);
    assert.ok(signals[0]?.aborted, 'the hung request is cancelled');
    const slowBody = async () => ({ ok: true, text: () => new Promise(() => {}) });
    assert.equal(await diagnoseLoad(main, failed, { fetchImpl: slowBody, requestTimeoutMs: 30 }), '', 'a hung body read is bounded too');
    const slow = async (url, options) => { await new Promise(resolve => setTimeout(resolve, 20)); return serve()(url, options); };
    assert.equal(await diagnoseLoad(main, failed, { fetchImpl: slow, requestTimeoutMs: 1000, totalTimeoutMs: 60 }), '', 'the whole walk has a deadline');
    assert.match(await diagnoseLoad(main, failed, { fetchImpl: async url => url.endsWith('state.js') ? new Response('', { status: 403 }) : serve()(url) }), /src\/core\/state\.js 读取失败（HTTP 403）/);
});

test('FM-005: the failure is shown before the diagnosis, then replaced by the cause', async () => {
    const shown = [], cleared = [];
    const notify = { error: (message, title) => { shown.push(message); return message; }, clear: item => cleared.push(item) };
    let finish;
    const pending = reportLoadFailure(failed, { notify, log: { error() {} }, diagnose: () => new Promise(resolve => { finish = resolve; }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shown.length, 1, 'visible while the diagnosis is still running');
    assert.match(shown[0], /模块没有加载成功：Failed to fetch dynamically imported module/);
    finish('文件 x.js 无法读取'); await pending;
    assert.deepEqual(shown.slice(1), ['文件 x.js 无法读取']); assert.deepEqual(cleared, [shown[0]]);
    const quiet = [];
    await reportLoadFailure(failed, { notify: { error: message => quiet.push(message) }, log: { error() {} }, diagnose: async () => '' });
    assert.equal(quiet.length, 1, 'a timed-out probe leaves the original error in place');
});
