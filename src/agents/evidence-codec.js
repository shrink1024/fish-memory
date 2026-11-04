import { invariant } from '../core/util.js';

// Only a request-local capability knows real message identities. Neither the
// prompt nor persisted memory receives an alias dictionary.
const identities = new WeakMap();
const evidenceError = '修改依据必须来自本批输入正文';

export function encodeMaintenanceEvidence(input) {
    const reserved = new Set(input.messages.map(message => message.key));
    const toWire = new Map(), toSource = new Map();
    const messages = input.messages.map((message, index) => {
        invariant(typeof message.key === 'string' && message.key && !toWire.has(message.key), evidenceError);
        let key = message.key;
        // Already short keys remain readable and retain compatibility with
        // host-provided identities. Long UUID/swipe keys never need copying.
        if (key.length > 24) {
            key = `m${index + 1}`;
            while (reserved.has(key) || toSource.has(key)) key = `_${key}`;
        }
        toWire.set(message.key, key); toSource.set(key, message.key);
        return { ...message, key };
    });
    const wire = { ...input, messages };
    // Preserve the protected-text capability on input.memory: do not clone it.
    if (input.observedState && toWire.has(input.observedState.messageKey)) {
        wire.observedState = { ...input.observedState, messageKey: toWire.get(input.observedState.messageKey) };
    }
    identities.set(wire, toSource);
    return wire;
}

export function decodeMaintenanceEvidence(input, result, applies = () => true) {
    const map = identities.get(input);
    invariant(map, evidenceError);
    return { ...result, operations: result.operations.map(operation => {
        if (!operation || !applies(operation) || !Object.hasOwn(operation, 'evidence')) return operation;
        invariant(Array.isArray(operation.evidence) && operation.evidence.every(key => typeof key === 'string' && map.has(key)), evidenceError);
        return { ...operation, evidence: operation.evidence.map(key => map.get(key)) };
    }) };
}
