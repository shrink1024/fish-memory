import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleSyntaxError, discoverRules, compileRules, evaluateRules, applyRules, buildRuleDocument, formToScript } from '../src/rules/index.js';

const entry = { id: 'source:book:17', title: '变量规则', kind: 'rule', constant: false, source: { uid: 17 }, segments: [{ id: 'body', text: '规则', writable: true }] };

test('discovers disabled native configuration as inert data, in stable order', () => {
    const a = buildRuleDocument({ naturalLanguage: '保留铁律', script: 'when title contains "变量" => lock;' });
    const b = buildRuleDocument({ naturalLanguage: '当前事实可更新', script: 'when sourceUID == "17" => maxChars 500;' });
    const found = discoverRules([{ uid: 3, comment: '[DWM Rules]', disable: true, content: a }, { uid: 4, comment: 'normal', content: '<%= evil() %>' }, { uid: 5, comment: '[DWM Rules]', content: b }]);
    assert.deepEqual(found.configEntryUids, [3, 5]);
    assert.equal(found.naturalLanguage, '保留铁律\n\n当前事实可更新');
    assert.equal(evaluateRules(compileRules(found.script), entry).maxChars, 500);
});

test('matching, precedence and multiple constraints merge monotonically', () => {
    const ast = compileRules('when (title contains "变量" and not constant == true) or kind == "npc" => lock;\nwhen id == "source:book:17" => maxChars 900;\nwhen sourceUID == "17" => maxChars 500;\nwhen kind == "rule" => always;');
    assert.deepEqual(evaluateRules(ast, entry), { locked: true, maxChars: 500, always: true });
    const applied = applyRules([entry], ast);
    assert.equal(applied.entries[0].segments[0].writable, false);
    assert.equal(entry.segments[0].writable, true);
    assert.equal(applied.constraints[entry.id].always, true);
    assert.equal(JSON.parse(JSON.stringify(ast)).statements.length, 4);
});

test('form helper creates valid constrained rule', () => {
    const script = formToScript({ field: 'entry.kind', value: 'npc', action: 'maxChars', maxChars: 250 });
    assert.equal(evaluateRules(compileRules(script), { kind: 'npc' }).maxChars, 250);
});

test('rejects arbitrary JavaScript, loops, unknown fields and unlock with line position', () => {
    for (const source of ['while(true) {}', 'when title == "x" => unlock;', 'when entry.constructor == "x" => lock;', 'when title == "x" => lock;\nfetch("https://evil")', 'when title == "x" => lock; process.exit(1);']) {
        assert.throws(() => compileRules(source), RuleSyntaxError);
    }
    assert.throws(() => compileRules('when title == "x" => lock;\nwhen foo == "x" => lock;'), error => error instanceof RuleSyntaxError && error.line === 2);
    assert.throws(() => discoverRules([{ uid: 1, comment: '[DWM Rules]', content: '{"format":"wrong","version":1,"naturalLanguage":"","script":""}' }]), /格式或版本冲突/);
    assert.throws(() => compileRules('when title == "x" => maxChars 0;'), /maxChars/);
});

test('enforces statement and nesting limits', () => {
    assert.throws(() => compileRules('when title == "x" => lock;'.repeat(101)), /语句过多/);
    assert.throws(() => compileRules(`when ${'('.repeat(18)}title == "x"${')'.repeat(18)} => lock;`), /嵌套过深/);
    assert.throws(() => compileRules('x'.repeat(10001)), /10000/);
});
