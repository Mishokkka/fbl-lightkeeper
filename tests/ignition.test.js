import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ignitionDistance,IgnitionReach,legacyIgniterAssignments} from '../scripts/ignition.js';
import {normalizeConfig,normalizeIgniter} from '../scripts/logic.js';
import {normalizeCatalog,PresetIndex} from '../scripts/presets.js';
import {renderLibrary,readIgniter} from '../scripts/views.js';
const NS='fbl-lightkeeper';
const scene=()=>({id:'S',grid:{size:100,distance:5},walls:{contents:[]}});
const token=(parent,extra={})=>({parent,x:0,y:0,width:1,height:1,elevation:0,...extra});
const item=(name,light,ignition)=>({name,id:name,type:'gear',flags:{[NS]:{light,ignition}},getFlag(ns,key){return this.flags[ns][key];}});

test('reach uses token bounds, scene scale and elevation; other scenes are never nearby',()=>{
  const s=scene(),a=token(s),b=token(s,{x:200});
  assert.equal(ignitionDistance(a,b),1);
  a.width=2;assert.equal(ignitionDistance(a,b),0);
  b.elevation=10;assert.equal(ignitionDistance(a,b),2);
  b.parent={...s,id:'OTHER'};assert.equal(ignitionDistance(a,b),Infinity);
  assert.equal(ignitionDistance(a,token(s,{x:undefined})),Infinity);
});

test('physical reach is circular and supports Foundry grid token rectangles',()=>{
  const s=scene();s.grid.getRect=(w,h)=>({width:w*120,height:h*80});
  const a=token(s),b=token(s,{x:220,y:180});
  assert.ok(Math.abs(ignitionDistance(a,b)-Math.SQRT2)<1e-8);
  assert.equal(new IgnitionReach().within(a,b,1),false);
  assert.equal(new IgnitionReach().within(a,b,1.5),true);
});

test('closed movement walls block fire in either direction and open doors allow it off canvas',()=>{
  const s=scene(),a=token(s),b=token(s,{x:100}),reach=new IgnitionReach();
  const wall={move:20,door:1,ds:0,c:[100,0,100,100]};s.walls.contents.push(wall);
  assert.equal(reach.within(a,b,1),false);assert.equal(reach.within(b,a,1),false);
  assert.equal(reach.within(a,b,1,{walls:false}),true);
  wall.ds=1;reach.invalidate(s);assert.equal(reach.within(a,b,1),true);
  wall.ds=0;wall.move=0;reach.invalidate(s);assert.equal(reach.within(a,b,1),true);
});

test('source normalization only keeps ignition requirement and fire-transfer capability',()=>{
  const legacy={ignitionMode:'consume',ignitionCost:'bonus',ignitionItem:'Спички'};
  const c=normalizeConfig(legacy);assert.ok(c.requiresIgnition);assert.ok(c.canIgnite);
  assert.equal(c.ignitionCost,undefined);assert.equal(c.ignitionMode,undefined);assert.equal(c.ignitionItem,undefined);
  assert.equal(normalizeConfig({...legacy,requiresIgnition:false,canIgnite:false}).requiresIgnition,false);
  assert.equal(normalizeConfig({...legacy,canIgnite:false}).canIgnite,false);
  assert.deepEqual(normalizeIgniter({mode:'bonus'}),{mode:'bonus'});
});

test('v1 library migration moves cost to the named resource without mutating the imported data',()=>{
  const raw={version:1,sources:[{id:'candle',config:{ignitionMode:'consume',ignitionCost:'bonus',ignitionResource:'box'}}],resources:[{id:'box',names:['Спички']}]};
  const normalized=normalizeCatalog(raw);
  assert.equal(normalized.version,2);assert.equal(normalized.resources[0].ignition.mode,'bonus');
  assert.equal(normalized.sources[0].config.ignitionCost,undefined);assert.equal(raw.version,1);
  assert.equal(raw.resources[0].ignition,undefined);
});

test('conflicting old source costs become a single reusable policy rather than spending surprise stock',()=>{
  const raw={version:1,sources:[{config:{ignitionMode:'consume',ignitionResource:'box'}},{config:{ignitionMode:'require',ignitionResource:'box'}}],resources:[{id:'box',names:['Спички']}]};
  assert.equal(normalizeCatalog(raw).resources[0].ignition.mode,'reusable');
  raw.version=2;raw.resources[0].ignition={mode:'bonus'};
  assert.equal(normalizeCatalog(raw).resources[0].ignition.mode,'bonus');
});

test('legacy Item policies migrate once to their actual ignition Items, respecting overrides',()=>{
  const sources=[item('Свеча',{ignitionMode:'consume',ignitionCost:'bonus',ignitionItem:'Коробок'}),item('Лампа',{ignitionMode:'consume',ignitionCost:'bonus',ignitionItem:'Коробок'})];
  const box=item('Коробок'),index=new PresetIndex({version:2,resources:[]});
  assert.deepEqual(legacyIgniterAssignments([...sources,box],index),[{item:box,config:{mode:'bonus'},conflict:false}]);
  sources[1].flags[NS].light.ignitionMode='require';
  assert.equal(legacyIgniterAssignments([...sources,box],index)[0].conflict,true);
  box.flags[NS].ignition={mode:'quantity'};assert.deepEqual(legacyIgniterAssignments([...sources,box],index),[]);
});

test('igniter overrides and renamed recognition are independent of source settings',()=>{
  const index=new PresetIndex({version:2,resources:[{id:'box',names:['Коробок'],ignition:{mode:'bonus'}}]});
  const box=item('Коробок');assert.equal(index.igniter(box).config.mode,'bonus');
  box.name='Другое';assert.equal(index.igniter(box).config.mode,'none');
  box.flags[NS].ignition={mode:'reusable'};assert.equal(index.igniter(box).config.mode,'reusable');
  box.flags[NS].ignition={mode:'none'};box.name='Коробок';assert.equal(index.igniter(box).config.mode,'none');
});

test('cost fields belong to resource forms and Item inheritance can be restored',()=>{
  const catalog=normalizeCatalog({version:2,sources:[{id:'s',config:{requiresIgnition:true}}],resources:[{id:'r',ignition:{mode:'bonus'}}]});
  const source=renderLibrary(catalog,'sources','s'),resource=renderLibrary(catalog,'resources','r');
  assert.ok(source.includes('name="requiresIgnition"'));assert.ok(source.includes('name="canIgnite"'));
  assert.ok(!source.includes('name="igniterMode"'));assert.ok(!source.includes('name="ignitionCost"'));
  assert.ok(resource.includes('name="igniterMode"'));assert.ok(!resource.includes('name="requiresIgnition"'));
  assert.equal(readIgniter({elements:{namedItem:()=>({value:'inherit'})}}),null);
});
