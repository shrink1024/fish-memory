// Author rules are data, never JavaScript or EJS. This module has no host access.
const MARKER = '[DWM Rules]';
const FIELDS = new Set(['id', 'title', 'kind', 'constant', 'sourceUID']);
const OPS = new Set(['lock', 'maxChars', 'always']);
const MAX_SCRIPT = 10000;
const MAX_STATEMENTS = 100;
const MAX_TOKENS = 2000;
const MAX_DEPTH = 16;
const MAX_NODES = 1000;

export class RuleSyntaxError extends Error {
    constructor(message, line = 1, column = 1) {
        super(`规则第 ${line} 行第 ${column} 列：${message}`);
        this.name = 'RuleSyntaxError';
        this.line = line;
        this.column = column;
    }
}

function tokenize(source) {
    const tokens = [];
    let i = 0, line = 1, column = 1;
    const push = (type, value, atLine = line, atColumn = column) => {
        tokens.push({ type, value, line: atLine, column: atColumn });
        if (tokens.length > MAX_TOKENS) throw new RuleSyntaxError('词元过多', atLine, atColumn);
    };
    const step = () => { if (source[i++] === '\n') { line++; column = 1; } else column++; };
    while (i < source.length) {
        const ch = source[i];
        if (/\s/.test(ch)) { step(); continue; }
        const atLine = line, atColumn = column;
        if (ch === '"') {
            let raw = '';
            step();
            let closed = false;
            while (i < source.length) {
                if (source[i] === '"') { step(); closed = true; break; }
                if (source[i] === '\\') {
                    raw += source[i]; step();
                    if (i >= source.length) break;
                    raw += source[i]; step();
                } else { raw += source[i]; step(); }
            }
            if (!closed) throw new RuleSyntaxError('字符串未闭合', atLine, atColumn);
            let value;
            try { value = JSON.parse(`"${raw}"`); }
            catch { throw new RuleSyntaxError('无效字符串转义', atLine, atColumn); }
            if (value.length > 1000) throw new RuleSyntaxError('字符串过长', atLine, atColumn);
            push('string', value, atLine, atColumn);
            continue;
        }
        const two = source.slice(i, i + 2);
        if (['=>', '==', '!='].includes(two)) {
            step(); step(); push(two, two, atLine, atColumn); continue;
        }
        if ('();'.includes(ch)) { step(); push(ch, ch, atLine, atColumn); continue; }
        if (/[0-9]/.test(ch)) {
            let word = '';
            while (i < source.length && /[0-9]/.test(source[i])) { word += source[i]; step(); }
            push('number', Number(word), atLine, atColumn); continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            let word = '';
            while (i < source.length && /[A-Za-z0-9_.]/.test(source[i])) { word += source[i]; step(); }
            push('word', word, atLine, atColumn); continue;
        }
        throw new RuleSyntaxError(`不允许的字符 ${JSON.stringify(ch)}`, atLine, atColumn);
    }
    push('EOF', '', line, column);
    return tokens;
}

export function compileRules(script = '') {
    if (typeof script !== 'string' || script.length > MAX_SCRIPT) throw new RuleSyntaxError('脚本必须是最多 10000 字符的文本');
    const tokens = tokenize(script);
    let cursor = 0, nodes = 0;
    const peek = () => tokens[cursor];
    const fail = (message, token = peek()) => { throw new RuleSyntaxError(message, token.line, token.column); };
    const take = (type, value) => {
        const token = peek();
        if (token.type !== type || (value !== undefined && token.value !== value)) fail(`需要 ${value ?? type}`, token);
        cursor++; return token;
    };
    const word = value => peek().type === 'word' && peek().value === value;
    const node = value => { if (++nodes > MAX_NODES) fail('表达式过于复杂'); return value; };
    function literal() {
        const t = peek();
        if (t.type === 'string' || t.type === 'number') { cursor++; return t.value; }
        if (word('true') || word('false')) { cursor++; return t.value === 'true'; }
        fail('需要字符串、整数或布尔值');
    }
    function atom(depth) {
        if (depth > MAX_DEPTH) fail('括号嵌套过深');
        if (peek().type === '(') { take('('); const expr = orExpr(depth + 1); take(')'); return expr; }
        const fieldToken = take('word');
        const field = fieldToken.value.startsWith('entry.') ? fieldToken.value.slice(6) : fieldToken.value;
        if (!FIELDS.has(field)) fail(`未知字段 ${fieldToken.value}`, fieldToken);
        const operator = peek();
        if (operator.type === 'word' && operator.value === 'contains') cursor++;
        else if (operator.type === '==' || operator.type === '!=') cursor++;
        else fail('需要 ==、!= 或 contains');
        const value = literal();
        if (operator.value === 'contains' && (typeof value !== 'string' || !['id', 'title', 'kind', 'sourceUID'].includes(field))) fail('contains 仅适用于文本字段及字符串', operator);
        if (field === 'constant' && typeof value !== 'boolean') fail('constant 必须比较布尔值', fieldToken);
        if (field !== 'constant' && typeof value !== 'string') fail(`${field} 必须比较字符串`, fieldToken);
        return node({ type: 'compare', field, operator: operator.value, value });
    }
    function notExpr(depth) { return word('not') ? (take('word', 'not'), node({ type: 'not', value: notExpr(depth + 1) })) : atom(depth); }
    function andExpr(depth) {
        let left = notExpr(depth);
        while (word('and')) { take('word', 'and'); left = node({ type: 'and', left, right: notExpr(depth) }); }
        return left;
    }
    function orExpr(depth) {
        let left = andExpr(depth);
        while (word('or')) { take('word', 'or'); left = node({ type: 'or', left, right: andExpr(depth) }); }
        return left;
    }
    const statements = [];
    while (peek().type !== 'EOF') {
        if (statements.length >= MAX_STATEMENTS) fail('语句过多');
        const start = take('word', 'when');
        const condition = orExpr(0);
        take('=>');
        const actionToken = take('word');
        if (!OPS.has(actionToken.value)) fail(`未知操作 ${actionToken.value}`, actionToken);
        let value = null;
        if (actionToken.value === 'maxChars') {
            value = take('number').value;
            if (!Number.isSafeInteger(value) || value < 1 || value > 100000) fail('maxChars 必须为 1–100000 的整数', actionToken);
        }
        take(';');
        statements.push({ condition, action: actionToken.value, value, line: start.line });
    }
    return { format: 'dwm-rule-ast', version: 1, statements };
}

function match(expr, entry) {
    switch (expr.type) {
        case 'and': return match(expr.left, entry) && match(expr.right, entry);
        case 'or': return match(expr.left, entry) || match(expr.right, entry);
        case 'not': return !match(expr.value, entry);
        case 'compare': {
            const actual = expr.field === 'sourceUID' ? entry.source?.uid : entry[expr.field];
            if (actual === undefined || actual === null) return expr.operator === '!=';
            if (expr.operator === 'contains') return String(actual).includes(expr.value);
            return expr.operator === '==' ? String(actual) === String(expr.value) : String(actual) !== String(expr.value);
        }
        default: throw new TypeError('无效规则 AST');
    }
}

export function evaluateRules(compiled, entry) {
    if (compiled?.format !== 'dwm-rule-ast' || compiled.version !== 1 || !Array.isArray(compiled.statements)) throw new TypeError('无效规则 AST');
    const result = { locked: false, maxChars: null, always: false };
    for (const statement of compiled.statements) {
        if (!match(statement.condition, entry)) continue;
        if (statement.action === 'lock') result.locked = true;
        else if (statement.action === 'maxChars') result.maxChars = Math.min(result.maxChars ?? Infinity, statement.value);
        else if (statement.action === 'always') result.always = true;
        else throw new TypeError('无效规则操作');
    }
    return result;
}

// `always` is selection guidance; it never overrides native disable, role or progress restrictions.
export function applyRules(entries, compiled) {
    if (!Array.isArray(entries)) throw new TypeError('entries 必须是数组');
    const constraints = {};
    const updated = entries.map(entry => {
        const rule = evaluateRules(compiled, entry);
        constraints[entry.id] = rule;
        if (!rule.locked) return structuredClone(entry);
        const copy = structuredClone(entry);
        copy.segments = (copy.segments ?? []).map(segment => ({ ...segment, writable: false }));
        return copy;
    });
    return { entries: updated, constraints };
}

export function discoverRules(rawEntries) {
    if (!Array.isArray(rawEntries)) throw new TypeError('rawEntries 必须是主绑定原书条目数组');
    const configEntryUids = [];
    const seen = new Set();
    const natural = [], scripts = [];
    for (const raw of rawEntries) {
        if (String(raw?.comment ?? '').trim() !== MARKER) continue;
        const uid = String(raw.uid);
        if (seen.has(uid)) throw new Error(`重复规则条目 UID：${uid}`);
        seen.add(uid); configEntryUids.push(raw.uid);
        let doc;
        try { doc = JSON.parse(raw.content); }
        catch { throw new Error(`规则条目 ${uid} 不是有效 JSON`); }
        if (!doc || doc.format !== 'dwm-rules' || doc.version !== 1 || typeof doc.naturalLanguage !== 'string' || typeof doc.script !== 'string') {
            throw new Error(`规则条目 ${uid} 格式或版本冲突`);
        }
        if (doc.naturalLanguage.length > 10000 || doc.script.length > MAX_SCRIPT) throw new Error(`规则条目 ${uid} 内容过长`);
        if (doc.naturalLanguage.trim()) natural.push(doc.naturalLanguage.trim());
        if (doc.script.trim()) scripts.push(doc.script.trim());
    }
    const script = scripts.join('\n');
    compileRules(script); // Fail discovery early, before initialization reads the rules.
    return { naturalLanguage: natural.join('\n\n'), script, configEntryUids };
}

export function buildRuleDocument({ naturalLanguage = '', script = '' } = {}) {
    if (typeof naturalLanguage !== 'string' || naturalLanguage.length > 10000) throw new TypeError('自然语言规则过长或格式错误');
    compileRules(script);
    return JSON.stringify({ format: 'dwm-rules', version: 1, naturalLanguage, script }, null, 2);
}

export function formToScript({ field, operator = '==', value, action, maxChars } = {}) {
    const canonical = String(field).startsWith('entry.') ? String(field).slice(6) : field;
    if (!FIELDS.has(canonical)) throw new TypeError('未知规则字段');
    if (!['==', '!=', 'contains'].includes(operator)) throw new TypeError('未知比较操作');
    if (!OPS.has(action)) throw new TypeError('未知规则操作');
    const literal = typeof value === 'boolean' ? String(value) : JSON.stringify(value);
    if (literal === undefined) throw new TypeError('缺少比较值');
    const suffix = action === 'maxChars' ? ` ${maxChars}` : '';
    const script = `when ${canonical} ${operator} ${literal} => ${action}${suffix};`;
    compileRules(script);
    return script;
}
