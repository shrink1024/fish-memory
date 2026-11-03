import test from 'node:test';
import assert from 'node:assert/strict';
import { lazyAttention, lazyHeadline, lazyRecord, lazyShortStatus } from '../src/ui/lazy-copy.js';

// 1.0.1 failure recovery: storage, paused, stopped and ignored floors (docs/FAILURE-RECOVERY-FRONTEND-HANDOFF-2026-11-03.md).
const at = '2026-11-03T11:40:00';
const view = lazy => ({ settings: { enabled: true }, connectionMode: 'raw', lazy: { status: { state: 'ready', floor: 0 }, attention: null, ...lazy } });

test('a storage failure is not reported as a model connection or capacity problem', () => {
    const card = lazyAttention({ reason: 'storage', at, attempts: 0, error: '辅助接口 HTTP 403' });
    assert.equal(card.sub, '存档写入失败');
    assert.deepEqual(card.actions, ['retry', 'export']);
    const text = [...card.body, card.fine].join('');
    assert.doesNotMatch(text, /连接模型|API|密钥|容量|辅助接口/);
    assert.match(text, /此前已保存的记忆不受影响/);
    assert.equal(lazyShortStatus(view({ attention: { reason: 'storage', at } })), '记忆暂停更新：存档写入失败');
    assert.equal(lazyHeadline(view({ attention: { reason: 'storage', at } })).tone, 'attn');
});

test('capacity is recognised explicitly; paused and unknown reasons get a retryable failure card', () => {
    assert.equal(lazyAttention({ reason: 'capacity', at, percent: 95 }).sub, '存档容量即将用尽');
    for (const reason of ['paused', 'something-new']) {
        const card = lazyAttention({ reason, task: 'maintain', at, error: '辅助接口 HTTP 400' });
        assert.equal(card.sub, '自动处理未能完成');
        assert.deepEqual(card.actions, ['retry', 'export']);
        assert.doesNotMatch(card.body.join(''), /容量|无法连接/);
        assert.match(card.body[0], /“记录新剧情”未能完成.*HTTP 400.*不会自动重试/);
    }
    assert.match(lazyAttention({ reason: 'paused', task: 'compact', at }).body[0], /已有记忆不受影响/);
    assert.notEqual(lazyHeadline(view({ attention: { reason: 'paused', task: 'sync', at } })).title, '记忆正常');
});

test('a stopped task offers to continue and never claims it will start by itself', () => {
    for (const task of ['init', 'maintain', 'sync', 'compact', undefined]) {
        const v = view({ status: { state: 'stopped', stoppedTask: task, waitingReason: '等待辅助连接就绪' } });
        const head = lazyHeadline(v), short = lazyShortStatus(v);
        assert.equal(head.action, 'resume');
        assert.match(head.sub, /不会自动重新开始/);
        assert.doesNotMatch(head.title + head.sub + short, /记忆正常|将在空闲时自动开始/);
    }
    assert.equal(lazyHeadline(view({ status: { state: 'stopped', stoppedTask: 'init' } })).title, '已停止建立记忆');
    assert.equal(lazyShortStatus(view({ status: { state: 'stopped', stoppedTask: 'maintain' } })), '已停止记录新剧情');
    // Only the init copy talks about the saved scan checkpoint.
    assert.doesNotMatch(lazyHeadline(view({ status: { state: 'stopped', stoppedTask: 'sync' } })).sub, /扫描进度/);
});

test('ignored floors are not described as remembered', () => {
    assert.equal(lazyHeadline(view({ status: { state: 'ready', floor: 56, ignoredFloors: 2 } })).sub, '已记录至第 56 楼（其中 2 楼已忽略）');
    assert.equal(lazyHeadline(view({ status: { state: 'ready', floor: 56 } })).sub, '已记录至第 56 楼');
    assert.equal(lazyRecord({ type: 'init', floors: 40, rememberedFloors: 37, ignoredFloors: 3, entries: 12 }).text, '建立记忆：扫描已有剧情 40 楼（其中 3 楼已忽略），整理 12 条世界书条目');
    assert.equal(lazyRecord({ type: 'paused', reason: 'storage' }).text, '存档写入失败，自动处理已暂停');
});
