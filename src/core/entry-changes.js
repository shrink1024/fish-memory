import { summaryUndoState } from './summary-edits.js';
import { clone, uid } from './util.js';
import { createEntry, entryScope, entryTier, entryText } from './state.js';

export const entryChangeIssue = code => Object.assign(new Error(`entry-change:${code}`), { dwmEntryChangeIssue: code });
const check = (condition, code) => { if (!condition) throw entryChangeIssue(code); };
export const canDeleteEntry = entry => Boolean(entry && !entry.source);
export const canChangeEntry = entry => canDeleteEntry(entry) && entry.kind !== 'rule' && entry.segments.some(segment => segment.writable);
export function selectedEntries(data, ids, editable = false) {
    check(Array.isArray(ids) && ids.length > 0 && ids.length <= 1000 && new Set(ids).size === ids.length, 'selection');
    check(ids.every(id=>typeof id==='string' && Object.hasOwn(data.entries,id)),'selection');
    const entries = ids.map(id => data.entries[id]);
    check(entries.every(editable ? canChangeEntry : canDeleteEntry), editable ? 'protected' : 'source');
    return entries;
}
// Only width forms get compatibility folding. Do not equate arbitrary symbols
// such as circled numbers with ordinary names. Stored titles stay untouched.
export const titleKey = value => String(value).replace(/[\uFF00-\uFFEF]+/gu,part=>part.normalize('NFKC'))
    .normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
export function identityNames(entries){
    const names=new Map();for(const entry of entries)for(const name of [entry.title,...(entry.identityNames??[])])if(typeof name==='string'&&titleKey(name)&&!names.has(titleKey(name)))names.set(titleKey(name),name);
    return [...names.values()];
}
export const removalIdentity = entry => ({ id: entry.id, title: entry.title, names:identityNames([entry]), kind: entry.kind, scopeId: entryScope(entry), lineage: clone(entry.lineage ?? []) });
export const activeRemovals = save => {
    const present=new Set(Object.values(save.data.entries).flatMap(entry=>[entry.id,...(entry.lineage??[])]));
    return Object.values(save.entryChanges?.removed ?? {}).filter(item=>!item.targetId || present.has(item.targetId));
};
export function isRemovedEntry(entry, removals) {
    if (entry.source) return false;
    return removals.some(item => entry.id !== item.targetId && !entry.lineage?.includes(item.targetId) && (entry.id === item.id || entry.lineage?.includes(item.id) || item.lineage?.includes(entry.id)
        || entryScope(entry) === item.scopeId && entry.kind === item.kind && (item.names??[item.title]).some(name=>titleKey(entry.title)===titleKey(name))));
}
export function enforceRemovals(save) {
    const removals = activeRemovals(save);
    for (const [id, entry] of Object.entries(save.data.entries)) if (isRemovedEntry(entry, removals)) delete save.data.entries[id];
    return save;
}
export function entryUndoState(save) {
    const undo = save?.entryChanges?.undo ?? save?.entryChanges?.automaticUndo;
    if (!undo) return summaryUndoState(save);
    const path = undo.storyKeys ?? [];
    const canUndo = path.every((key,index) => save.storyKeys[index] === key)
        && Object.entries(undo.after).every(([id, entry]) => JSON.stringify(save.data.entries[id] ?? null) === JSON.stringify(entry));
    return { id: undo.id, kind: undo.kind, titles: clone(undo.titles), canUndo, saveId: save.id, revision: save.revision, ...(undo.automatic?{automatic:true}:{}) };
}
/** Player confirmation only; the model never calls this mutation. */
export function applyEntryChange(save, action, sourceKeys) {
    check(action.expectedSaveId === save.id && action.expectedRevision === save.revision, 'changed');
    check(action.confirmed === true, 'confirmation');
    const next = clone(save); next.entryChanges ??= { removed: {} };
    const ledger = next.entryChanges; ledger.removed ??= {};
    if (action.type === 'entry-change-undo') {
        const undo = ledger.undo ?? ledger.automaticUndo;
        check(undo && undo.id === action.undoId && entryUndoState(save)?.canUndo, 'undo-changed');
        for (const [id, entry] of Object.entries(undo.before)) {
            if (entry) next.data.entries[id] = createEntry(entry); else delete next.data.entries[id];
        }
        for (const [id, item] of Object.entries(undo.removedBefore)) {
            if (item) ledger.removed[id] = item; else delete ledger.removed[id];
        }
        delete ledger.undo;
        delete ledger.automaticUndo;
        return { next, kind: 'undo', sourceIds: Object.keys(undo.before), ...(undo.automatic?{undoMergeId:undo.commitId}:{}) };
    }
    const originals = selectedEntries(next.data, action.ids, action.type !== 'delete-entries');
    delete ledger.automaticUndo;
    const ids = originals.map(e => e.id), before = Object.fromEntries(originals.map(e => [e.id, clone(e)])), removedBefore = {};
    delete ledger.summaryUndo;
    const kind = action.type === 'delete-entries' ? 'delete' : action.mode;
    check(['delete','merge','condense'].includes(kind), 'mode');
    if (kind === 'delete' || kind === 'merge') for (const entry of originals) {
        removedBefore[entry.id] = clone(ledger.removed[entry.id] ?? null);
        ledger.removed[entry.id] = { ...removalIdentity(entry), ...(kind === 'merge' ? { targetId: action.entries?.[0]?.id } : {}) };
        delete next.data.entries[entry.id];
    }
    if(kind==='delete')for(const item of Object.values(ledger.removed))if(item.targetId && originals.some(entry=>entry.id===item.targetId || entry.lineage?.includes(item.targetId))){
        removedBefore[item.id] ??= clone(item); delete item.targetId;
    }
    if (kind !== 'delete') {
        check(Array.isArray(action.entries) && action.entries.length === (kind === 'merge' ? 1 : originals.length), 'result');
        for (const input of action.entries) {
            check(!input.source, 'source');
            if (kind === 'merge') check(!save.data.entries[input.id], 'changed');
            else check(ids.includes(input.id), 'result');
            before[input.id] ??= null;
            next.data.entries[input.id] = createEntry(input);
        }
        const protectedText=originals.flatMap(e=>e.segments.filter(s=>!s.writable).map(s=>s.text));
        const retained=action.entries.flatMap(e=>e.segments.filter(s=>!s.writable).map(s=>s.text));
        for(const text of protectedText){const index=retained.indexOf(text);check(index>=0,'protected');retained.splice(index,1);}
        if(kind==='condense')for(const prior of originals){
            const current=next.data.entries[prior.id];
            check(current && entryScope(current)===entryScope(prior),'scope');
            for(const segment of prior.segments.filter(s=>!s.writable))check(current.segments.some(s=>s.id===segment.id&&!s.writable&&s.text===segment.text),'protected');
        }
    }
    const affected = Object.keys(before), after = Object.fromEntries(affected.map(id => [id, clone(next.data.entries[id] ?? null)]));
    ledger.undo = { id: uid('entry-undo'), kind, titles: originals.map(e=>e.title), before, after, removedBefore, storyKeys: clone(sourceKeys) };
    return { next, kind, sourceIds: ids };
}

/** Proposal templates include locked text for the player's comparison only.
 * The model projection contains writable segments, never locked bodies. */
export function entryChangePlan(entries, mode) {
    check(['merge','condense'].includes(mode), 'mode');
    check(mode !== 'merge' || entries.length >= 2, 'selection');
    check(mode!=='merge' || new Set(entries.map(entryScope)).size === 1, 'scope');
    const input = entries.map(entry => ({ id: entry.id, title: entry.title, kind: entry.kind, scopeId: entryScope(entry),
        intro: entry.segments.every(s=>s.writable) ? entry.intro : '',
        segments: entry.segments.filter(s=>s.writable).map(({id,text})=>({id,text})) }));
    let templates = clone(entries);
    if (mode === 'merge') {
        let body = false;
        const segments = entries.flatMap((entry,index) => entry.segments.flatMap(segment => {
            if (!segment.writable) return [{...segment,id:`locked-${index}-${segment.id}`}];
            if (body) return []; body = true; return [{id:'body',text:'',writable:true}];
        }));
        const tiers=['off','onDemand','constant'], tier=tiers[Math.max(...entries.map(e=>tiers.indexOf(entryTier(e))))];
        templates = [createEntry({ id:uid('entry'), title:entries[0].title, kind:new Set(entries.map(e=>e.kind)).size===1?entries[0].kind:'fact',
            intro:'', segments, scopeId:entryScope(entries[0]), tier, enabled:tier!=='off', important:entries.some(e=>e.important),importanceIndependent:true,
            evidence:[...new Set(entries.flatMap(e=>e.evidence))], lineage:[...new Set(entries.flatMap(e=>[e.id,...(e.lineage??[])]))], identityNames:identityNames(entries) })];
    }
    return { input, templates };
}
export function completeEntryProposal(templates, result) {
    check(Array.isArray(result) && result.length === templates.length, 'result');
    return templates.map((entry,index) => {
        const row=result[index];check(row && row.id===entry.id,'result');
        let changes=row.segments;
        if (row.text !== undefined) { check(entry.segments.every(s=>s.writable) && entry.segments.length===1,'protected'); changes=[{id:entry.segments[0].id,text:row.text}]; }
        check(Array.isArray(changes) && new Set(changes.map(s=>s.id)).size===changes.length,'result');
        for (const s of changes) {
            const prior=entry.segments.find(e=>e.id===s.id);check(prior,'result');
            check(prior.writable || s.text===prior.text,'protected');
        }
        const segments=entry.segments.map(s=>{
            if (!s.writable) return s;
            const replacement=changes.find(e=>e.id===s.id);check(replacement && typeof replacement.text==='string','result');
            return {...s,text:replacement.text};
        });
        const next=createEntry({...entry,title:row.title??entry.title,intro:row.intro??entry.intro,retrieveWhen:row.retrieveWhen??entry.retrieveWhen,segments,version:entry.version+1});
        check(next.title.trim() && entryText(next).trim(),'result');return next;
    });
}

/** Only request-local short ids are copied by the model. Archive ids and
 * permissions/evidence are restored by the program before validation. */
export function entryChangeWire(input, templates, mode, restoreRows=rows=>rows) {
    const targets=templates.map((entry,index)=>({id:`t${index+1}`,segments:entry.segments.filter(s=>s.writable).map((s,i)=>`p${i+1}`)}));
    const entries=input.map((entry,index)=>({...entry,id:`s${index+1}`,...(mode==='condense'?{targetId:targets[index].id}:{}),
        segments:entry.segments.map((segment,i)=>({...segment,id:`p${i+1}`}))}));
    return { input:{mode,entries,targets}, accept(value){
        check(Array.isArray(value?.entries) && value.entries.length===targets.length && new Set(value.entries.map(e=>e.id)).size===targets.length,'result');
        const rows=targets.map((target,index)=>{
            const row=value.entries.find(e=>e.id===target.id);check(row&&Array.isArray(row.segments),'result');
            const writable=templates[index].segments.filter(s=>s.writable);
            return {...row,id:templates[index].id,segments:row.segments.map(segment=>{
                const position=target.segments.indexOf(segment.id);check(position>=0,'result');return {...segment,id:writable[position].id};
            })};
        });
        return {entries:completeEntryProposal(templates,restoreRows(rows)),note:typeof value.note==='string'?value.note.slice(0,1000):''};
    }};
}
