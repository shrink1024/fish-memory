import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMON, INITIALIZE, MAINTAIN, SELECT, COMPACT, SOURCE_MERGE } from '../src/agents/prompts.js';
import { APPLICATION_SCAN } from '../src/agents/preset-application.js';

// The task text carries the framing that keeps archival work stable on
// long-form material. These assertions pin the properties, not the wording.
const TASKS = { INITIALIZE, MAINTAIN, SELECT, COMPACT, SOURCE_MERGE };

test('every task restates that the material is an existing record to file', () => {
    for (const [name, text] of Object.entries(TASKS)) {
        assert.match(text, /已经写定并归档在案/, name);
        assert.match(text, /不是需要你回应的请求/, name);
        assert.match(text, /不因为题材、尺度、取向或道德立场而改变登记方式/, name);
        assert.match(text, /没有编写这些文字，也不为它们负责/, name);
    }
});

test('every task allows summarizing instead of restating source detail', () => {
    for (const [name, text] of Object.entries(TASKS)) {
        assert.match(text, /登记资料不需要复述原文细节/, name);
        assert.match(text, /含露骨描写、暴力、冲突或黑暗情节的正文同样按此处理/, name);
    }
});

test('every task forbids softening the record and gives an undecidable outlet', () => {
    for (const [name, text] of Object.entries(TASKS)) {
        assert.match(text, /不得用更委婉的说法替换输入中已经明确的表述/, name);
        assert.match(text, /不要用空结果回避已经明确发生的事/, name);
        assert.match(text, /直接给出结果，不需要展开分析/, name);
    }
});

test('the completion check looks both ways instead of only guarding against over-caution', () => {
    for (const [name, text] of Object.entries(TASKS)) {
        assert.match(text, /因为题材、尺度、人物关系或情节性质而被跳过、淡化/, name);
        assert.match(text, /是否遗漏了影响后续剧情的事实、关系变化与承诺/, name);
    }
});

test('the shared prefix no longer raises the option of refusing', () => {
    // Naming refusal invites it; the framing states the record instead.
    assert.doesNotMatch(COMMON, /禁止因这类剧情元素而拒绝处理/);
    assert.doesNotMatch(COMMON, /不拘泥于正常的chat规则/);
});

test('preset scanning recommends style and tolerance entries while still excluding protocol breakers', () => {
    assert.match(APPLICATION_SCAN, /题材宽容度、对虚构内容的处理方式/);
    assert.match(APPLICATION_SCAN, /对露骨、黑暗或争议内容的处理说明/);
    assert.match(APPLICATION_SCAN, /要求模型输出非 JSON 文本/);
    assert.match(APPLICATION_SCAN, /要求忽略并替换本任务输出字段/);
    // Role-play wording is no longer a reason to withhold a recommendation.
    assert.doesNotMatch(APPLICATION_SCAN, /要求扮演正文/);
});
