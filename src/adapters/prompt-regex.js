// History has no outgoing depth window. Strip closed reasoning blocks before
// and after host cleaning. Like a host regex that finds no closing tag, an
// unclosed block keeps the rest of the floor: reading too much beats losing it.
function cleanHistoryThinking(text) {
    const tags = /<\s*(\/?)\s*(think|thinking)(?=\s|\/?>)[^<>]*>/gi;
    const stack = []; let result = '', cursor = 0, openAt = 0;
    for (const match of text.matchAll(tags)) {
        if (!stack.length) { result += text.slice(cursor, match.index); openAt = match.index; }
        const name = match[2].toLowerCase();
        if (match[1]) {
            const index = stack.lastIndexOf(name);
            if (index >= 0) stack.splice(index);
        } else if (!/\/\s*>$/.test(match[0])) stack.push(name);
        cursor = match.index + match[0].length;
    }
    return result + text.slice(stack.length ? openAt : cursor);
}

// minDepth 0/-1 covers every ordinary history row. A positive minimum or a
// finite maximum is a sending-depth rule, not an archival cleaning rule.
const hasDepthWindow = script => script.minDepth != null && Number.isFinite(Number(script.minDepth)) && Number(script.minDepth) > 0
    || script.maxDepth != null && Number.isFinite(Number(script.maxDepth)) && Number(script.maxDepth) >= 0;

/** Read-only projection using the host's own prompt-only rules and permissions. */
export function createPromptRegex({ engine, disabled = () => false, macroContext = () => null, warn = () => {} } = {}) {
    let cache = new Map(), lastSignature = '', configuration;
    const signature = () => {
        try {
            const off = disabled();
            const keys = ['id','findRegex','replaceString','trimStrings','disabled','placement','minDepth','maxDepth','runOnEdit','substituteRegex','promptOnly','markdownOnly','pluginOnly'];
            const scripts = off ? [] : (engine?.getRegexScripts?.({ allowedOnly: true }) ?? []).filter(s => s?.promptOnly)
                .map(s => Object.fromEntries(keys.filter(k => Object.hasOwn(s,k)).map(k => [k,s[k]])));
            const text=JSON.stringify(scripts), macros=[...text.matchAll(/\{\{([^{}]+)\}\}/g)].map(m=>m[1].trim().toLowerCase());
            const context=macros.length?macroContext():null;
            configuration={available:typeof engine?.getRegexedString==='function',historyAvailable:typeof engine?.runRegexScript==='function',off,scripts,
                cacheable:!macros.length || context!==null && macros.every(name=>['char','user'].includes(name))};
            return JSON.stringify({available:configuration.available,historyAvailable:configuration.historyAvailable,disabled:off,scripts,context});
        } catch { configuration={available:false,off:false,scripts:[],cacheable:false};cache.clear();return ''; }
    };
    function project(chat, { type = 'normal', end = chat.length } = {}) {
        const sig=signature(),config=configuration;
        if(!sig||sig!==lastSignature){cache.clear();lastSignature=sig;}
        const unchanged=m=>({content:String(m.mes??''),regexSkipped:false});
        if(!config.available){warn('prompt-regex-unavailable','宿主正则接口不可用，鱼忆暂时读取原始聊天正文。');return chat.map(unchanged);}
        if(config.off||!config.scripts.length)return chat.map(unchanged);
        const candidates=chat.slice(0,end).filter(m=>!m.is_system||m.extra?.dwmHidden?.owner==='dynamic-world-memory');
        const positions=new Map(candidates.map((m,i)=>[m,candidates.length-i-(type==='continue'?2:1)]));
        return chat.map((m,index)=>{
            const raw=String(m.mes??''),depth=positions.get(m);
            if(depth===undefined)return unchanged(m);
            const placement=m.is_user?(engine.regex_placement?.USER_INPUT??1):(engine.regex_placement?.AI_OUTPUT??2);
            // Cache by applicable depth bands, not absolute depth. Adding one
            // message only invalidates rows that actually cross a rule boundary.
            const active=config.scripts.flatMap((s,i)=>{
                if(s.disabled||Array.isArray(s.placement)&&!s.placement.includes(placement))return [];
                if(s.minDepth!=null&&!isNaN(s.minDepth)&&s.minDepth>=-1&&depth<s.minDepth)return [];
                if(s.maxDepth!=null&&!isNaN(s.maxDepth)&&s.maxDepth>=0&&depth>s.maxDepth)return [];
                return [i];
            });
            const key=`${index}:${placement}:${active.join(',')}`,cached=config.cacheable&&cache.get(key);
            if(cached?.raw===raw)return cached.result;
            let content=raw;
            try{
                content=engine.getRegexedString(raw,placement,{isPrompt:true,depth});
                if(typeof content!=='string')throw new TypeError('Invalid regex result');
            }catch{warn('prompt-regex-failed','宿主正则处理失败，相关消息暂时读取原文。');return unchanged(m);}
            const result={content,regexSkipped:!content.trim()};
            if(cache.size>=20000)cache.clear();if(config.cacheable)cache.set(key,{raw,result});
            return result;
        });
    }
    function projectHistory(chat) {
        const sig=signature(),config=configuration;
        if(!sig||sig!==lastSignature){cache.clear();lastSignature=sig;}
        return chat.map((message,index)=>{
            const raw=String(message.mes??''),placement=message.is_user?(engine?.regex_placement?.USER_INPUT??1):(engine?.regex_placement?.AI_OUTPUT??2);
            const key=`history:${index}:${placement}`,cached=config.cacheable&&cache.get(key);
            if(cached?.raw===raw)return cached.result;
            let content=cleanHistoryThinking(raw);
            // Use only allowed, enabled, prompt-only content cleaners. Running
            // the whole getRegexedString pipeline would reapply the send window.
            // Hosts lacking the per-rule API still get the built-in cleaner.
            if(config.historyAvailable&&!config.off) for(const script of config.scripts) {
                if(script.disabled||hasDepthWindow(script)||!script.placement?.includes(placement))continue;
                content=engine.runRegexScript(script,content);
                if(typeof content!=='string')throw new TypeError('Invalid history regex result');
            }
            content=cleanHistoryThinking(content);
            const result={content,regexSkipped:!content.trim()};
            if(cache.size>=20000)cache.clear();if(config.cacheable)cache.set(key,{raw,result});
            return result;
        });
    }
    return {project,projectHistory,signature};
}
