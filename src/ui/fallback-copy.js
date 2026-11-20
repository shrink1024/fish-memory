// “本轮记忆选材未完成”弹窗的文案与可选操作。按失败原因给出说明；
// 重试也必然失败的原因（原书变化、换书）不提供“重新选材”，避免玩家反复卡在同一处。

/** @returns {{reason:string,title:string,body:string,actions:string[],primary:string}} */
export function fallbackCopy(error = {}) {
    const message = String(error?.message ?? '');
    const status = Number.isInteger(error?.httpStatus) ? `（HTTP ${error.httpStatus}）` : '';
    if (error?.dwmSourceRebound || error?.kind === 'source-rebound') return {
        reason: 'rebound', title: '主世界书已更换',
        body: '鱼忆的记忆建立在原来的世界书上，换书后需要先导出本聊天备份，再在鱼忆的“设置 → 高级”中重新扫描整个存档。这一轮可以先按原世界书发送，剧情不受影响。',
        actions: ['original', 'open', 'cancel'], primary: 'original' };
    if (/^原书已变化/.test(message)) return {
        reason: 'source', title: '原世界书有更新，需要先同步',
        body: '角色卡的世界书改过，鱼忆要先同步这些变化才能挑选资料。这一轮可以先按原世界书发送；也可以停止本轮，到鱼忆的“资料”页同步后再发送。',
        actions: ['original', 'sync', 'cancel'], primary: 'original' };
    if (error?.kind === 'quota') return {
        reason: 'quota', title: '辅助模型的额度不足',
        body: `挑选资料时，辅助接口提示订阅或额度不可用${status}。重新选材也会失败。这一轮可以先按原世界书发送，检查账户后再使用鱼忆。`,
        actions: ['original', 'open', 'cancel'], primary: 'original' };
    if (error?.dwmBlocked || error?.name === 'OutputBlockedError') return {
        reason: 'filter', title: '辅助接口拒收了这次请求',
        body: '服务方的内容审核拒收了挑选资料的请求，重新选材多半仍会被拒收。这一轮可以先按原世界书发送；如果经常出现，可以给鱼忆换一个辅助连接。',
        actions: ['original', 'retry', 'cancel'], primary: 'original' };
    if (error?.dwmResponseInvalid) return {
        reason: 'output', title: '辅助模型返回的内容不完整',
        body: '辅助模型返回的挑选结果格式不对或被截断，已经自动纠正过一次。可以重新选材，或者这一轮先按原世界书发送。',
        actions: ['retry', 'original', 'cancel'], primary: 'retry' };
    if (error?.kind === 'timeout' || error?.name === 'TimeoutError' || Number.isInteger(error?.httpStatus) || /连接|网络|超时|fetch|network|timed? ?out/i.test(message)) return {
        reason: 'connection', title: '没能连上辅助模型',
        body: `挑选资料时，辅助模型没有正常响应${status}。可以重新选材；如果持续失败，这一轮可以先按原世界书发送。`,
        actions: ['retry', 'original', 'cancel'], primary: 'retry' };
    return {
        reason: 'other', title: '本轮挑选资料没有完成',
        body: '可以重新选材，或者这一轮先按原世界书发送。如果反复出现，请在鱼忆窗口中点“导出本次问题”，把文件发给作者。',
        actions: ['retry', 'original', 'cancel'], primary: 'retry' };
}

export const FALLBACK_LABELS = {
    original: '本轮按原世界书发送', retry: '重新选材（调用模型）', cancel: '停止本轮',
    sync: '停止本轮，去同步', open: '打开鱼忆查看',
};
