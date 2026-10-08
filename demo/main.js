import { Controller } from '../src/runtime/controller.js';
import { mountPanel } from '../src/ui/panel.js';
import { createFloatingManager } from '../src/ui/floating-manager.js';

// Handwritten, deterministic fixtures. No real model or player save is connected.
const rawEntries = [
    { uid: 0, comment: '莉娜·诺安', content: '莉娜是修复旧地图的抄绘师，目前住在港口。\n她对陌生人谨慎，却总会为认真求助的人留一盏灯。她希望有一天能进入北城图书馆，查清母亲留下的航海笔记。', constant: true, disable: false, key: ['莉娜', '抄绘师'] },
    { uid: 1, comment: '叙事边界', content: '保留人物自主性，不替玩家作出行动或情感判断。\n人物只知道亲历、被告知或合理推断的信息；不要将传闻直接写成世界事实。', constant: true, disable: false },
    { uid: 2, comment: '北城图书馆', content: '北城图书馆坐落在高处的石阶尽头，收藏地方史与近百年的航海记录。\n公共阅览室日落前开放；内档室需要馆员的许可。许多旧地图只有残页，不能保证找到完整答案。', constant: false, disable: false, key: ['图书馆', '航海记录'] },
    { uid: 3, comment: '潮汐与渡轮', content: '渡轮连接旧港与北城，每天在涨潮前后各开一班。\n浓雾时船班可能延误，是否停航以码头公告为准。', constant: false, disable: false, key: ['渡轮', '码头'] },
    { uid: 4, comment: '旧港的传闻', content: '港口有人说，废弃灯塔藏着能指向失落航线的铜制罗盘。这个说法没有经过证实。', constant: false, disable: false, key: ['灯塔', '罗盘'] },
];
const initialMessages = [
    { key: 'm0', role: 'user', content: '我第一次来到旧港，带着一封没有署名的介绍信，向莉娜打听北城图书馆。', index: 0 },
    { key: 'm1', role: 'assistant', content: '莉娜向你介绍了港口与北城图书馆。摆渡人阿岚说，明天涨潮时可以带你们过去。你收到了一张旧港渡轮票。', index: 1 },
];
const messages = structuredClone(initialMessages);
let saved = null, failNext = false;
const host = {
    snapshot: () => ({ chatId: 'fish-isolated-demo', bookName: '旧港来信 · 合成样例', templateEnabled: true, messages: structuredClone(messages) }),
    loadWorldbook: async () => structuredClone(rawEntries),
    storage: { read: async () => saved, write: async (_, data) => { saved = structuredClone(data); } },
    clearPlan() {}, setPlan: plan => { document.querySelector('#plan').textContent = `模拟选材完成：${plan.selectedIds.length} 条资料。请在「本轮」查看。`; },
    eligible: e => e.enabled, applyWindow: async () => {},
};
const model = { complete: async ({ purpose, input, signal }) => {
    await new Promise(resolve => setTimeout(resolve, 400));
    signal?.throwIfAborted();
    if (failNext) { failNext = false; throw new Error('合成故障：此次辅助模型请求未完成。已保存资料保持不变，可再次尝试。'); }
    if (purpose === 'initialize') return { strategy: '围绕玩家与莉娜的关系、地点变化、真实发生的事件和仍未完成的约定维护记忆；传闻保持未证实状态。', entries: input.entries.map(e => ({ id: e.id,
        kind: e.title.includes('边界') ? 'rule' : e.title.includes('莉娜') ? 'npc' : 'fact',
        intro: { '莉娜·诺安': '居住旧港的地图抄绘师，希望查明母亲留下的航海笔记。', '北城图书馆': '收藏地方史与航海记录，内档室需要馆员许可。', '叙事边界': '保留玩家选择与人物认知边界。', '潮汐与渡轮': '旧港和北城之间的交通受潮汐与天气影响。', '旧港的传闻': '灯塔罗盘只是流传的说法，尚未得到证实。' }[e.title] ?? e.title,
        retrieveWhen: e.title.includes('图书馆') ? '前往北城、调查航海记录或提及馆员许可时。' : e.title.includes('传闻') ? '提及废弃灯塔、失落航线或铜罗盘时；注意其未证实状态。' : '涉及相关人物、地点或规则时。',
        segments: [{ id: 'body', text: e.content, writable: !e.title.includes('边界') }] })) };
    if (purpose === 'strategy') return { strategy: input.strategies.join('\n') };
    if (purpose === 'select') return { ids: input.catalog.filter(e => e.title.includes('图书馆') || e.kind === 'event').slice(0, input.selectionLimit).map(e => e.id) };
    if (purpose === 'compact') return { operations: [] };
    const moved = input.messages.find(m => m.content.includes('迁居北城'));
    const home = input.memory.entries.find(e => e.title === '莉娜·诺安');
    const operations = [{ type: 'summary', text: moved
        ? '你带着匿名介绍信抵达旧港，与抄绘师莉娜相识。她寻找母亲航海笔记的线索，你们约定去北城图书馆调查。后来莉娜迁居北城；她仍在等待你来信，共同调查的约定尚未完成。'
        : input.memory.summary || '你带着匿名介绍信抵达旧港，与抄绘师莉娜相识。莉娜希望进入北城图书馆查阅母亲的航海笔记。摆渡人阿岚答应在涨潮时带你们前往北城，你获得了一张渡轮票。' }];
    if (input.memory.inventory) operations.push({ type: 'inventory', items: [{ name: '匿名介绍信', description: '没有署名的旧信，指引你向莉娜打听北城图书馆。' }, { name: '旧港渡轮票', description: '可用于涨潮时前往北城的一次航程，尚未使用。' }] });
    if (moved && home && !home.segments.some(segment => segment.text.includes('已经迁居北城'))) operations.push({ type: 'update', id: home.id, expectedVersion: home.version,
        segments: [{ id: 'body', text: '莉娜是修复旧地图的抄绘师，目前已经迁居北城，住在图书馆附近。\n她对陌生人谨慎，却总会为认真求助的人留一盏灯。她希望能查清母亲留下的航海笔记。与你共同调查的约定仍未完成；她托阿岚留话，等你来信。' }],
        intro: '已迁居北城的地图抄绘师，仍在等待与你共同调查航海笔记。', retrieveWhen: '莉娜出场、前往北城图书馆、讨论母亲的笔记或履行调查约定时。', evidence: [moved.key] });
    if (moved && !input.memory.entries.some(entry => entry.title === '迁居北城与未完成的约定')) operations.push({ type: 'create', title: '迁居北城与未完成的约定', kind: 'event',
        intro: '莉娜迁居北城，托人留话等待玩家来信；共同调查的约定仍然有效。', retrieveWhen: '返回北城、与莉娜重逢或讨论调查进展时。',
        text: '莉娜已从旧港迁居北城图书馆附近。她通过摆渡人阿岚传话，等你来信后继续共同调查。迁居改变了她的住址，没有取消此前的约定。', evidence: [moved.key] });
    if (!input.memory.entries.some(e => e.kind === 'npc_pool')) operations.push({ type: 'create', title: '旧港路人', kind: 'npc_pool', intro: '曾在旧港遇见、暂不需要独立维护的人物。', retrieveWhen: '再次遇见这些路人时，提取此前交集。', text: '阿岚｜往返旧港与北城的摆渡人，答应在涨潮时载你与莉娜去北城。关系：初次认识。', evidence: [input.messages[0].key] });
    return { operations };
} };
const controller = new Controller(host, { model, settings: { enabled: true } });
const manager = createFloatingManager(document);
document.body.append(manager.element);
manager.body.append(document.querySelector('#app'));
mountPanel(document.querySelector('#app'), controller);
manager.bindEntry(document.querySelector('#open-memory'));
controller.subscribe(() => manager.render(controller.uiStatus()));
manager.render(controller.uiStatus());
await controller.start();
const renderMessages = () => { document.querySelector('#messages').textContent = messages.map(m => `${m.role === 'user' ? '玩家' : '正文'}：${m.content}`).join('\n\n'); };
renderMessages();
const run = async (event, operation) => {
    const b = event.currentTarget; b.disabled = true;
    try { await operation(); document.querySelector('#demo-error').textContent = ''; }
    catch (error) { document.querySelector('#demo-error').textContent = error.message; }
    finally { b.disabled = false; }
};
document.querySelector('#example').onclick = event => run(event, async () => {
    if (!controller.view().save?.initialized) await controller.initialize();
    if (!messages.some(m => m.content.includes('迁居北城'))) {
        messages.push({ key: `m${messages.length}`, role: 'assistant', content: '莉娜已经迁居北城，在图书馆附近租好了住所。她托摆渡人阿岚留话，说会等待你来信后继续调查母亲的笔记。', index: messages.length }); renderMessages();
        await controller.maintain();
    }
});
document.querySelector('#advance').onclick = event => run(event, async () => {
    if (!controller.view().save?.initialized) throw new Error('请先初始化，或载入完整演示样例。');
    messages.push({ key: `m${messages.length}`, role: 'assistant', content: '莉娜已经迁居北城，在图书馆附近租好了住所。她托摆渡人阿岚留话，说会等待你来信后继续调查母亲的笔记。', index: messages.length }); renderMessages();
    await controller.maintain();
});
document.querySelector('#send').onclick = event => run(event, () => controller.generationBefore({ type: 'normal' }));
document.querySelector('#fail').onclick = () => { failNext = true; document.querySelector('#plan').textContent = '下一次辅助任务将模拟失败。'; };
document.querySelector('#theme').onclick = () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; };
globalThis.demoMemory = controller;
