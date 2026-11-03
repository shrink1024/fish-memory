import { createEntry, entryText, splitSourceText } from '../core/state.js';
import { invariant } from '../core/util.js';

/** Long source entries become stable work units; original identities stay intact. */
export function classificationPieces(entries, batchChars = 18000) {
    const size = Math.max(1000, Math.min(100000, batchChars));
    return entries.flatMap((entry, parentIndex) => {
        const text = entryText(entry);
        if (entry.scanPiece || text.length <= 100000) return [entry];
        const chunks = splitSourceText(text, size);
        const { baselineSegments: _baseline, ...origin } = entry.source ?? {};
        return chunks.map((segment, index) => createEntry({ ...entry,
            id: `scan:${parentIndex}:${index}`,
            scanPiece: { parentId: entry.id, index, total: chunks.length },
            // Checkpoint each fragment against its own slice, not N full copies of the long source.
            source: entry.source ? {...origin,original:segment.text,metadata:{...origin.metadata,content:segment.text}} : null,
            segments: [{ id: 'body', text: segment.text, writable: false }] }));
    });
}
export function joinClassifications(originals, classified) {
    const direct = new Map(classified.filter(e => !e.scanPiece).map(e => [e.id,e]));
    return originals.map(source => {
        if (direct.has(source.id)) return direct.get(source.id);
        const pieces = classified.filter(e=>e.scanPiece?.parentId===source.id).sort((a,b)=>a.scanPiece.index-b.scanPiece.index);
        invariant(pieces.length && pieces.length===pieces[0].scanPiece.total && pieces.every((e,i)=>e.scanPiece.index===i), '长条目分段未完整扫描');
        invariant(pieces.map(entryText).join('')===entryText(source),'长条目扫描必须完整保留原文');
        if (pieces.some(e=>e.scanBlocked)) return createEntry({...source,enabled:false,important:false,kind:'fact',status:'deferred',scanBlocked:true,
            segments:splitSourceText(entryText(source)),needsReview:false});
        // Keep boundaries where permissions differ; coalesce safe adjacent spans.
        const segments=[];
        for(const piece of pieces) for(const segment of piece.segments) {
            const last=segments.at(-1);
            if(last && last.writable===segment.writable && last.text.length+segment.text.length<=100000) last.text+=segment.text;
            else segments.push({id:`part-${segments.length}`,text:segment.text,writable:segment.writable});
        }
        // A rule fragment protects its own spans; it must not turn unrelated
        // writable fragments into a whole-entry rule merely because of a split.
        const first=pieces.find(e=>e.kind!=='rule')??pieces[0],kind=first.kind;
        const disagreement=pieces.some(e=>e.kind!==kind||e.important!==first.important);
        const tooMany=segments.length>4096;
        const intro=[...new Set(pieces.map(e=>e.intro).filter(Boolean))].join('\n');
        const guidance=[...new Set(pieces.map(e=>e.retrieveWhen).filter(Boolean))].join('\n');
        return createEntry({...source,kind,important:first.important,
            intro:intro.slice(0,2000),
            retrieveWhen:guidance.slice(0,4000),
            segments:tooMany?splitSourceText(entryText(source)):segments,
            needsReview:tooMany||disagreement||intro.length>2000||guidance.length>4000||pieces.some(e=>e.needsReview),scanBlocked:false});
    });
}
