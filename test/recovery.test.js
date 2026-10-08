import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const html = await readFile(new URL('../recovery.html', import.meta.url), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('let urls =')[0];
const recover = vm.runInNewContext(code + ';recoverJsonl');
test('offline recovery restores owned hides only and keeps source file immutable', () => {
    const input = [{ chat_metadata: { dwm: { revision: 6 } } },
        { mes: 'own', is_system: true, extra: { dwmKey: 'stable', dwmHidden: { owner: 'dynamic-world-memory' } },
            swipe_info: [{ extra: { dwmHidden: { owner: 'dynamic-world-memory' } } }] },
        { mes: 'external', is_system: true, extra: { dwmHidden: { owner: 'other' } } }];
    const text = input.map(v => JSON.stringify(v)).join('\n') + '\n';
    const result = recover(text), records = result.text.trim().split('\n').map(JSON.parse);
    assert.equal(result.messages, 1); assert.equal(result.candidates, 1);
    assert.equal(records[1].is_system, false); assert.equal(records[1].extra.dwmKey, 'stable');
    assert.deepEqual(records[0], input[0]); assert.deepEqual(records[2], input[2]);
    assert.equal(input[1].is_system, true);
    assert.equal(recover(result.text).messages, 0);
});
test('offline recovery rejects malformed input before offering output', () => {
    assert.throws(() => recover('{}\n'), /文件头/);
    assert.throws(() => recover('{"chat_metadata":{}}\nbroken'), /第 2 行/);
});
