import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultCatalog,normalizeCatalog,identifySource,matchesItem,findResource,nameKey} from '../scripts/presets.js';

const item=(name,extra={})=>({id:'X',name,type:'gear',system:{quantity:1},getFlag:()=>undefined,...extra});
test('default candle is recognized across case, whitespace and unicode variants',()=>{
  const result=identifySource(item('  СВЕЧА  '),defaultCatalog());
  assert.equal(result.origin,'recognized'); assert.equal(result.config.mode,'disposable');
  assert.equal(result.config.ignitionResource,'matches');
  assert.equal(nameKey('  Зелёный   ФОНАРЬ '),'зеленый фонарь');
});
test('exact recognition does not consume unrelated named inventory',()=>{
  assert.equal(identifySource(item('Подсвечник для свечи'),defaultCatalog()).origin,'none');
  assert.equal(identifySource(item('Свеча'),defaultCatalog(),false).origin,'none');
});
test('explicit per-item configuration, including disabled sources, takes precedence',()=>{
  const doc=item('Свеча',{getFlag:()=>({enabled:false,mode:'infinite'})});
  const result=identifySource(doc,defaultCatalog());
  assert.equal(result.origin,'item'); assert.equal(result.config.enabled,false);
  assert.equal(result.config.mode,'infinite');
});
test('UUID recognition survives renaming and supports compendium origins',()=>{
  const rule={names:[],uuids:['Compendium.world.lights.Item.A'],itemTypes:['gear'],matchMode:'exact'};
  assert.ok(matchesItem(item('Совсем другое название',{_stats:{compendiumSource:rule.uuids[0]}}),rule));
  assert.ok(matchesItem(item('Переименованная копия',{_stats:{duplicateSource:rule.uuids[0]}}),rule));
  assert.equal(matchesItem(item('Другое',{type:'weapon',uuid:rule.uuids[0]}),rule),false);
});
test('contains recognition is explicit and ordered rules have predictable priority',()=>{
  const catalog=normalizeCatalog({sources:[
    {id:'specific',label:'Врачебная свеча',names:['Свеча врача'],config:{bright:2}},
    {id:'broad',label:'Любая свеча',names:['свеча'],matchMode:'contains',config:{bright:1}}
  ]});
  assert.equal(identifySource(item('Свеча врача'),catalog).preset.id,'specific');
  assert.equal(identifySource(item('Восковая свеча'),catalog).preset.id,'broad');
});
test('resource aliases find whole stock and exclude the source itself',()=>{
  const items=[item('Спички',{id:'SOURCE'}),item('Matches',{id:'HALF',system:{quantity:.5}}),item('СПИЧКА',{id:'FULL',system:{quantity:2}})];
  assert.equal(findResource({items},'matches','',defaultCatalog(),'SOURCE').id,'FULL');
  assert.equal(findResource({items},'deleted','Спички',defaultCatalog()),null);
  assert.equal(findResource({items},'',' СПИЧКА ',defaultCatalog()).id,'FULL');
});
test('catalog normalization does not mutate its source and rejects duplicate IDs',()=>{
  const raw={sources:[{id:'one',label:'A',names:['Свеча','Свеча'],config:{remainingSeconds:1.125}}]};
  const catalog=normalizeCatalog(raw);
  assert.deepEqual(catalog.sources[0].names,['Свеча']);
  assert.equal(catalog.sources[0].config.remainingSeconds,1.125);
  assert.equal(raw.sources[0].config.templateId,undefined);
  assert.throws(()=>normalizeCatalog({sources:[{id:'same'},{id:'same'}]}),/Повторяется ID/);
});
