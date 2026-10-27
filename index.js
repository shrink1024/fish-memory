// Entry kept free of static imports. If a later module is refused (an ad
// blocker, a missing file, unsupported syntax) this still runs and names the
// cause instead of ST's bare "[object Event]".
const MODULE_LIMIT = 200;
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[\w$*{}\s,]+\s*from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g;
const TIMED_OUT = Symbol('timed out');

// One probe request, bounded by its own timer and the whole diagnosis' deadline.
async function readFile(fetchImpl, url, timeoutMs, deadline) {
    const controller = new AbortController(), stop = () => controller.abort();
    const timer = setTimeout(stop, timeoutMs);
    deadline.addEventListener('abort', stop, { once: true });
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(TIMED_OUT), { once: true }));
    aborted.catch(() => {});
    try {
        const response = await Promise.race([fetchImpl(url, { cache: 'no-store', signal: controller.signal }), aborted]);
        if (!response.ok) return { status: response.status };
        return { text: await Promise.race([response.text(), aborted]) };
    } catch (error) {
        if (controller.signal.aborted) throw TIMED_OUT;
        return { refused: true };
    } finally { clearTimeout(timer); deadline.removeEventListener('abort', stop); }
}

/** Walk the relative import graph from `entry` and report the first file that cannot be read.
 * Returns '' when the probe itself times out; the original error has already been shown. */
export async function diagnoseLoad(entry, error, { fetchImpl = globalThis.fetch, base = entry, userAgent = globalThis.navigator?.userAgent ?? '',
    requestTimeoutMs = 4000, totalTimeoutMs = 10000 } = {}) {
    const shown = url => decodeURIComponent(new URL(url).pathname.slice(new URL('./', base).pathname.length) || url);
    if (error?.name === 'SyntaxError') return `浏览器无法解析鱼忆的代码（${error.message}），可能版本过旧。请升级浏览器或酒馆所用的 WebView 后刷新。${userAgent ? `\n浏览器：${userAgent}` : ''}`;
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), totalTimeoutMs);
    const queue = [String(entry)], seen = new Set(queue);
    try {
        while (queue.length) {
            const url = queue.shift(), result = await readFile(fetchImpl, url, requestTimeoutMs, deadline.signal);
            if (result.refused) return `文件 ${shown(url)} 无法读取：被浏览器或扩展拦截，或网络连不上。用了广告拦截插件的，请把酒馆网址加入白名单，或暂时停用后刷新。`;
            if (result.status) return `文件 ${shown(url)} 读取失败（HTTP ${result.status}），安装可能不完整。请在扩展管理里删除鱼忆，再用安装地址重新安装。`;
            for (const match of result.text.matchAll(STATIC_IMPORT)) {
                const next = new URL(match[1], url).href;
                if (!seen.has(next) && seen.size < MODULE_LIMIT) { seen.add(next); queue.push(next); }
            }
        }
    } catch (failure) {
        if (failure === TIMED_OUT) return '';
        throw failure;
    } finally { clearTimeout(timer); }
    return `鱼忆的 ${seen.size} 个文件都能读取，但没有加载成功：${error?.message ?? error}。如果控制台里有 ERR_BLOCKED_BY_CLIENT，仍是拦截插件所致；否则可能是浏览器版本过旧。${userAgent ? `\n浏览器：${userAgent}` : ''}`;
}

/** Show the failure at once, then add the cause when the probe finishes. */
export async function reportLoadFailure(error, { notify = globalThis.toastr, diagnose = () => '', log = console } = {}) {
    const sticky = { timeOut: 0, extendedTimeOut: 0 };
    log.error('[DynamicWorldMemory] 模块加载失败', error);
    const first = notify?.error?.(`模块没有加载成功：${error?.message ?? error}。正在检查原因……`, '鱼忆未能加载', sticky);
    let detail = '';
    try { detail = await diagnose(); } catch { /* The original error is already visible. */ }
    if (!detail) return '';
    log.error('[DynamicWorldMemory]', detail);
    if (first) notify?.clear?.(first);
    notify?.error?.(detail, '鱼忆未能加载', sticky);
    return detail;
}

if (typeof document !== 'undefined') {
    const main = new URL('./main.js', import.meta.url);
    import(main.href).catch(error => reportLoadFailure(error, { diagnose: () => diagnoseLoad(main, error) }));
}
