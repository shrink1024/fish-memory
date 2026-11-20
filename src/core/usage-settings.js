import { summaryThreshold } from './summary-edits.js';
import { DEFAULT_SETTINGS } from './state.js';

// Persist explicit membership as well as the switch: a future bundle can add
// fields without inferring opt-in from coincidentally matching numbers.
export const ECONOMY_BUNDLE = Object.freeze({maintenanceEvery:5,selectionRecentTurns:4,batchChars:40000,selectionChars:16000,selectionLimit:12});
export const ECONOMY_BUNDLE_VERSION = 1;
const valid = value => Number.isInteger(value) && value > 0;
const limits={maintenanceEvery:[1,1000],selectionRecentTurns:[1,1000],batchChars:[1,200000],selectionChars:[100,200000],selectionLimit:[1,200]};
const validField=(key,value,bundle)=>limits[key]
    ? Number.isInteger(value)&&value>=limits[key][0]&&value<=limits[key][1]
    : typeof value===typeof bundle[key]&&(['boolean','string'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value));
export function normalizeUsageSettings(saved = {}, bundle = ECONOMY_BUNDLE) {
    const settings = {...DEFAULT_SETTINGS,...saved};
    settings.summaryLength = summaryThreshold(settings.summaryLength);
    delete settings.economyEvery; delete settings.economyKeepRecent;
    const sourceBudget=saved.sourceBatchChars ?? saved.economyRestore?.batchChars ?? saved.batchChars;
    settings.sourceBatchChars=Number.isInteger(sourceBudget)&&sourceBudget>=1&&sourceBudget<=200000?sourceBudget:DEFAULT_SETTINGS.sourceBatchChars;
    settings.maintenanceKeepRecent = Number.isInteger(saved.maintenanceKeepRecent) && saved.maintenanceKeepRecent>=0 && saved.maintenanceKeepRecent<=20 ? saved.maintenanceKeepRecent : 1;
    settings.selectionRecentTurns = valid(saved.selectionRecentTurns) && saved.selectionRecentTurns<=1000 ? saved.selectionRecentTurns
        : valid(saved.recentTurns) && saved.recentTurns<=1000 ? saved.recentTurns : DEFAULT_SETTINGS.selectionRecentTurns;
    settings.economyMode = saved.economyMode === true;
    if(settings.economyMode){
        const hasRestore=Boolean(saved.economyRestore && typeof saved.economyRestore==='object' && !Array.isArray(saved.economyRestore));
        const before=hasRestore?saved.economyRestore:{};
        const previousKeys=Array.isArray(saved.economyBundleKeys)?saved.economyBundleKeys:[];
        settings.economyRestore=Object.fromEntries(Object.keys(bundle).map(key=>{
            const added=hasRestore&&!Object.hasOwn(before,key)&&!previousKeys.includes(key);
            const original=validField(key,before[key],bundle)?before[key]:added&&validField(key,settings[key],bundle)?settings[key]:DEFAULT_SETTINGS[key];
            return [key,original];
        }));
        Object.assign(settings,bundle);
        settings.economyBundleVersion=ECONOMY_BUNDLE_VERSION;
        settings.economyBundleKeys=Object.keys(bundle);
    }else{delete settings.economyRestore;delete settings.economyBundleKeys;delete settings.economyBundleVersion;}
    return settings;
}
export function updateUsageSettings(current, patch, bundle=ECONOMY_BUNDLE) {
    let next={...current,...patch},change=null;
    const changedKeys=Object.keys(bundle).filter(key=>Object.hasOwn(patch,key)&&patch[key]!==current[key]);
    if(patch.economyMode===true&&!current.economyMode){
        next.economyRestore=Object.fromEntries(Object.keys(bundle).map(key=>[key,current[key]??DEFAULT_SETTINGS[key]]));
        Object.assign(next,bundle);next.economyMode=true;next.economyBundleKeys=Object.keys(bundle);next.economyBundleVersion=ECONOMY_BUNDLE_VERSION;change='enabled';
    }else if(patch.economyMode===false&&current.economyMode){
        for(const key of Object.keys(bundle))next[key]=Object.hasOwn(patch,key)&&patch[key]!==current[key]?patch[key]:(validField(key,current.economyRestore?.[key],bundle)?current.economyRestore[key]:DEFAULT_SETTINGS[key]);
        change='disabled';
    }else if(current.economyMode&&changedKeys.length){next.economyMode=false;change='manual-override';}
    if(!next.economyMode){delete next.economyRestore;delete next.economyBundleKeys;delete next.economyBundleVersion;}
    delete next.economyEvery;delete next.economyKeepRecent;
    return {settings:next,change,changedKeys};
}
