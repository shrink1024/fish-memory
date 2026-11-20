import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetLibrary } from '../src/adapters/preset-library.js';
import { Controller } from '../src/runtime/controller.js';

function fixture() {
    const saved={prompts:[{identifier:'head',content:'固定前置'},{identifier:'chatHistory',marker:true},{identifier:'tail',content:'固定后置',role:'user'}],
        prompt_order:[{character_id:100001,order:[{identifier:'head',enabled:true},{identifier:'chatHistory',enabled:true},{identifier:'tail',enabled:false}]}]};
    const openai={oai_settings:{preset_settings_openai:'正文A',prompts:[{identifier:'live',content:'当前正文预设'}]},
        openai_setting_names:{'正文A':0,'辅助B':1},openai_settings:[saved,structuredClone(saved)],
        promptManager:{configuration:{promptOrder:{strategy:'global',dummyId:100001}},activeCharacter:{id:100001},getPromptOrderForCharacter:()=>[{identifier:'live',enabled:true}]}};
    const library=createPresetLibrary(openai,()=>({mainApi:'openai'}));return {openai,library};
}
test('saved preset reads its own switches and order; live preset remains unchanged',()=>{
    const {openai,library}=fixture(),before=JSON.stringify(openai);
    assert.deepEqual(library.listPresets(),[{name:'正文A',current:true},{name:'辅助B',current:false}]);
    assert.equal(library.readPreset().entries[0].content,'当前正文预设');
    assert.deepEqual(library.readPreset('辅助B').entries.map(e=>[e.id,e.enabled,e.position]),[['head',true,'head'],['tail',false,'tail']]);
    assert.equal(JSON.stringify(openai),before);assert.equal(library.readPreset('missing').missing,true);
    openai.openai_settings[1]=JSON.stringify(openai.openai_settings[1]);assert.equal(library.readPreset('辅助B').entries.length,2);
    openai.openai_settings[1]={prompts:{invalid:true}};assert.equal(library.readPreset('辅助B').missing,true);
});
test('fixed source persists per save, survives story preset switching, and becomes stale on saved edits',async()=>{
    const {openai,library}=fixture();let disk;
    const host={...library,snapshot:()=>({chatId:'c',bookName:'b',templateEnabled:true,messages:[]}),loadWorldbook:async()=>[],
        clearPlan(){},applyWindow:async()=>{},storage:{read:async()=>structuredClone(disk),write:async(_,v)=>{disk=structuredClone(v)}}};
    const c=new Controller(host,{model:{complete:async()=>assert.fail('selection of a preset must be free')}});await c.start();
    await c.setPresetSource('辅助B');let view=c.view();assert.equal(view.presetApplication.followsCurrent,false);
    await c.savePresetApplication(['tail'],view.presetApplication.fingerprint);
    openai.oai_settings.preset_settings_openai='另一套正文';openai.oai_settings.prompts=[];
    assert.equal(c.view().presetApplication.stale,false);assert.equal(c.view().presetApplication.name,'辅助B');
    const reload=new Controller(host,{model:{complete:async()=>({})}});await reload.start();assert.equal(reload.view().presetApplication.followsCurrent,false);
    openai.openai_settings[1].prompts[2].role='assistant';assert.equal(c.view().presetApplication.stale,true);
    openai.openai_settings[1].prompts[2].role='user';assert.equal(c.view().presetApplication.stale,false);
    openai.openai_settings[1].prompts[2].content+=' changed';assert.equal(c.view().presetApplication.stale,true);
    delete openai.openai_setting_names['辅助B'];assert.equal(c.view().presetApplication.sourceMissing,true);
    await assert.rejects(c.setPresetSource('辅助B'),e=>e.dwmPresetSourceIssue==='missing');
    await c.setPresetSource(null);assert.equal(c.view().presetApplication.followsCurrent,true);assert.equal(c.view().presetApplication.saved,null);
});
