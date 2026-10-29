import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';

for(const empty of [false,true])test(`a new resource in ${empty?'an empty':'a populated'} library renders, saves and reopens independently`,async()=>{
  const env=await harness({active:0,inactive:0});
  try {
    if(empty)await game.settings.set('fbl-lightkeeper','catalog',{...env.api.getCatalog(),resources:[]});
    const library=await env.api.library();
    await library.perform('kind','resources');
    const previous=structuredClone(library.draft.resources);
    await library.perform('new');
    const resource=library.draft.resources.find(entry=>entry.id===library.selectedId);
    assert.equal(resource.label,'Новый запас');assert.deepEqual(resource.ignition,{mode:'none'});
    assert.equal(resource.config,undefined);assert.ok(library.html.includes('name="igniterMode"'));
    assert.ok(library.html.includes('value="Новый запас"'));
    Object.assign(resource,{label:'Коробок врача',names:['Коробок врача'],ignition:{mode:'bonus'}});
    if(previous.length)await library.perform('select',previous[0].id);
    await library.perform('save');
    const saved=env.api.getCatalog().resources;
    assert.deepEqual(saved.filter(entry=>entry.id!==resource.id),previous);
    assert.equal(saved.find(entry=>entry.id===resource.id).ignition.mode,'bonus');
    await library.close();const reopened=await env.api.library();
    await reopened.perform('kind','resources');await reopened.perform('select',resource.id);
    assert.ok(reopened.html.includes('value="Коробок врача"'));
    assert.ok(reopened.html.includes('value="bonus" selected'));
  } finally {await env.close();}
});
