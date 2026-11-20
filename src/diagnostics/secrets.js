// Session-only credentials. Never return the collection in any view/export.
const secrets = new Set();
export function registerDiagnosticSecrets(values) {
    for (const value of values) if (typeof value === 'string' && value) {
        secrets.add(value); secrets.add(JSON.stringify(value).slice(1,-1));
    }
}
export function redactDiagnosticSecrets(text) {
    for (const value of [...secrets].sort((a,b)=>b.length-a.length)) text = text.split(value).join('[REDACTED]');
    return text;
}
