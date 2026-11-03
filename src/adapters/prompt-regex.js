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
            configuration={available:typeof engine?.getRegexedString==='function',off,scripts,
                cacheable:!macros.length || context!==null && macros.every(name=>['char','user'].includes(name))};
            return JSON.stringify({available:configuration.available,disabled:off,scripts,context});
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
    return {project,signature};
}
