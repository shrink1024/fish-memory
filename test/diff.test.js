import test from 'node:test';
import assert from 'node:assert/strict';
import { diffText } from '../src/ui/diff.js';
test('worldbook diff highlights a current-state change without treating common prose as replaced', () => {
    assert.deepEqual(diffText('她住在港口。', '她住在北城。'), [
        { type: 'equal', text: '她住在' }, { type: 'remove', text: '港口' },
        { type: 'add', text: '北城' }, { type: 'equal', text: '。' },
    ]);
});
test('difference preserves Unicode, literal markup, empty and large text in both reconstructions', () => {
    for (const [before, after] of [['甲🐟\n乙', '甲🐠\n丙'], ['', '<script>不是代码</script>'], ['删除', ''], ['甲'.repeat(1000), '乙'.repeat(1000)]]) {
        const parts = diffText(before, after);
        assert.equal(parts.filter(p => p.type !== 'add').map(p => p.text).join(''), before);
        assert.equal(parts.filter(p => p.type !== 'remove').map(p => p.text).join(''), after);
    }
});
