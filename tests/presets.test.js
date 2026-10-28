import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultCatalog,normalizeCatalog,identifySource,matchesItem,findResource,nameKey,PresetIndex} from '../scripts/presets.js';

const item=(name,extra={})=>({id:'X',name,type:'gear',system:{quantity:1},getFlag:()=>undefined,...extra});
test('default candle is recognized across case, whitespace and unicode variants',()=>{
  const result=identifySource(item('  СВЕЧА  '),defaultCatalog());
  assert.equal(result.origin,'recognized'); assert.equal(result.config.mode,'disposable');
  assert.equal(result.config.ignitionResource,'matches');
  assert.equal(nameKey('  Зелёный   ФОНАРЬ '),'зеленый фонарь');
});

test('compiled recognition agrees with rules and invalidates renamed or retyped items',()=>{
  const catalog=defaultCatalog(), index=new PresetIndex(catalog), doc=item('Свеча');
  assert.equal(index.identify(doc).preset.id,'candle');
  doc.name='Масляная лампа';assert.equal(index.identify(doc).preset.id,'oil-lamp');
  doc.name='Нет шаблона';assert.equal(index.identify(doc).origin,'none');
  doc._stats={duplicateSource:'Item.original'};
  const strict=new PresetIndex({sources:[{id:'strict',uuids:['Item.original'],itemTypes:['gear'],config:{}}]});
  assert.equal(strict.identify(doc).preset.id,'strict');doc.type='spell';assert.equal(strict.identify(doc).origin,'none');
  const fuel=item('Matches');assert.equal(index.findResource({items:[fuel]},'matches',''),fuel);
  fuel.system.quantity=0;assert.equal(index.findResource({items:[fuel]},'matches',''),null);
  fuel.name='Спички';fuel.system.quantity=1;assert.equal(index.findResource({items:[fuel]},'matches',''),fuel);
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

test('JSON source presets with missing numbers keep useful light, fuel and warning defaults',()=>{
  const raw=JSON.parse('{"version":1,"sources":[{"id":"imported","names":["Лампа врача"],"config":{"capacitySeconds":null,"refillSeconds":" ","bright":null,"dim":"","lowFuelSeconds":null}}],"resources":[]}');
  const catalog=normalizeCatalog(raw), source=new PresetIndex(catalog).identify(item('Лампа врача'));
  assert.equal(source.origin,'recognized');assert.equal(source.config.capacitySeconds,1800);
  assert.equal(source.config.remainingSeconds,1800);assert.equal(source.config.refillSeconds,900);
  assert.equal(source.config.bright,3);assert.equal(source.config.dim,6);assert.equal(source.config.lowFuelSeconds,60);
  assert.equal(raw.sources[0].config.capacitySeconds,null);
});
