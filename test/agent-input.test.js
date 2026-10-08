import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient, serializeAgentInput } from '../src/agents/client.js';
import { Controller } from '../src/runtime/controller.js';
import { installCapture } from '../src/diagnostics/capture.js';
import { createTraceStore } from '../src/diagnostics/trace-store.js';

const material = { entries: [{ id: 'names', title: '称谓', content: '称 {{user}} 为旅人；{{char}}；{{getvar::{{char}}}}；{{{{；字面量 \\u007b' }], nested: { plain: '中文', number: 2 } };

test('agent input serialization keeps source macros inert and roundtrips source strings without substitution', async () => {
    assert.equal(serializeAgentInput(undefined), undefined);
    const encoded = serializeAgentInput(material);
    assert.doesNotMatch(encoded, /\{\{/);
    assert.match(encoded, /\\u007b\\u007buser/);
    assert.deepEqual(JSON.parse(encoded), material);
    let received;
    const client = new AgentClient(async request => { received = request.input; return '{"ok":true}'; });
    assert.deepEqual(await client.complete({ purpose: 'preferences', system: '固定任务', input: material }), { ok: true });
    assert.equal(received, encoded);
});

test('preset scan raw generation and exact trace matching share encoded input, preserving unexecuted source macros', async () => {
    const store = createTraceStore(), target = { location: { href: 'http://localhost:4203/' },
        fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"preferences":[]}' } }] })) };
    const capture = installCapture({ target, store });
    const state = { chatId: 'macro-chat', bookName: 'book', templateEnabled: true, messages: [] };
    let generatedInput, substituted = 0;
    const host = { snapshot: () => structuredClone(state), readPreset: () => ({ name: '宏预设', entries: material.entries }),
        loadWorldbook: async () => [], storage: { read: async () => null, write: async () => {} }, clearPlan() {}, applyWindow: async () => {},
        traceCapture: capture,
        rawGenerate: async request => {
            generatedInput = request.input;
            const content = request.input.replace(/\{\{[\s\S]*?\}\}/g, () => { substituted++; return '不应发生的宏展开'; });
            const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({
                messages: [{ role: 'system', content: request.system }, { role: 'user', content }], stream: false }) });
            return (await response.json()).choices[0].message.content;
        } };
    const controller = new Controller(host, { traces: store });
    try {
        await controller.start(); await controller.scanPreset();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(substituted, 0);
        assert.doesNotMatch(generatedInput, /\{\{/);
        assert.equal(JSON.parse(generatedInput).entries[0].content, material.entries[0].content);
        const record = store.snapshot().records[0];
        assert.equal(record.source, '鱼忆');
        assert.equal(record.label, '扫描预设偏好');
        assert.equal(record.request.messages[1].content, generatedInput);
        assert.equal(record.processingError, undefined);
    } finally { capture.dispose(); }
});

test('object trace registration uses the same serializer as raw agent calls', async () => {
    const store = createTraceStore(), target = { fetch: async () => new Response('{}') };
    const capture = installCapture({ target, store });
    try {
        const trace = capture.register({ source: '鱼忆', purpose: 'select', system: '同一任务', input: material });
        await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ messages: [
            { role: 'system', content: '同一任务' }, { role: 'user', content: serializeAgentInput(material) }], stream: false }) });
        trace.end(); await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(store.snapshot().records[0].label, '前置选材');
    } finally { capture.dispose(); }
});
