import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clockTime,renderPanel,renderLibrary,readConfig,readIgniter} from '../scripts/views.js';
import {defaultCatalog} from '../scripts/presets.js';
import {normalizeConfig} from '../scripts/logic.js';

test('clock rounds up remaining milliseconds without losing an hour boundary',()=>{
  assert.equal(clockTime(59.2),'00:01:00'); assert.equal(clockTime(3600),'01:00:00');
  assert.equal(clockTime(null),'∞'); assert.equal(clockTime(-3),'00:00:00');
});
test('user names and library aliases remain text inside the rendered interface',()=>{
  const catalog=defaultCatalog();catalog.sources[0].label='<script>alert(1)</script>';
  const library=renderLibrary(catalog,'sources','candle');
  assert.ok(!library.includes('<script>')); assert.ok(library.includes('&lt;script&gt;'));
  const panel=renderPanel({tokenName:'<Bob>',sources:[],gm:false,paused:false,authority:true});
  assert.ok(panel.includes('&lt;Bob&gt;'));assert.ok(!panel.includes('data-action="adjust"'));
});

test('a resource draft without an ignition policy renders the unused default safely',()=>{
  const catalog=defaultCatalog(),resource=catalog.resources[0];delete resource.ignition;
  const html=renderLibrary(catalog,'resources',resource.id);
  assert.ok(html.includes('name="igniterMode"'));
  assert.ok(html.includes('value="none" selected'));
  assert.equal(resource.ignition,undefined);
});
test('form values use minutes but preserve fractional fuel and resource references',()=>{
  const values={mode:'tank',capacityMinutes:'40',remainingMinutes:'14.375',refillMinutes:'20',lowFuelMinutes:'2',shutter:true,enabled:true,
    refillResource:'oil',requiresIgnition:true,canIgnite:true,igniterMode:'bonus',soundOn:'sounds/on.ogg',soundOff:'sounds/off.ogg',soundVolumePercent:'35',soundFadeSeconds:'1.5'};
  const form={elements:{namedItem:name=>name in values?{value:String(values[name]),checked:values[name]===true}:null}};
  const config=readConfig(form,normalizeConfig(),{item:true});
  assert.equal(config.remainingSeconds,862.5);assert.equal(config.capacitySeconds,2400);
  assert.equal(config.refillResource,'oil');assert.equal(config.lowFuelSeconds,120);assert.ok(config.shutter);
  assert.ok(config.requiresIgnition);assert.ok(config.canIgnite);assert.deepEqual(readIgniter(form),{mode:'bonus'});
  assert.equal(config.ignitionCost,undefined);assert.equal(config.soundOn,'sounds/on.ogg');assert.equal(config.soundOff,'sounds/off.ogg');assert.equal(config.soundVolume,.35);assert.equal(config.soundFadeSeconds,1.5);
});

test('cleared numeric fields preserve the existing value instead of creating an empty one-second source',()=>{
  const base=normalizeConfig({capacitySeconds:2400,remainingSeconds:862.5,refillSeconds:1200,lowFuelSeconds:120,bright:4,dim:6});
  const form={elements:{namedItem:name=>({value:name==='enabled'?'true':'',checked:name==='enabled'})}};
  const result=readConfig(form,base,{item:true});
  for(const name of ['capacitySeconds','remainingSeconds','refillSeconds','lowFuelSeconds','bright','dim']) assert.equal(result[name],base[name]);
  assert.equal(readConfig(form,base).remainingSeconds,2400);
});

test('explicit zero still empties fuel or disables a threshold and a missing field falls back',()=>{
  const base=normalizeConfig({capacitySeconds:2400,remainingSeconds:500,lowFuelSeconds:120});
  const values={remainingMinutes:'0',lowFuelMinutes:'0'};
  const form={elements:{namedItem:name=>name in values?{value:values[name]}:null}};
  const config=readConfig(form,base,{item:true});
  assert.equal(config.remainingSeconds,0);assert.equal(config.lowFuelSeconds,0);assert.equal(config.capacitySeconds,2400);
});

test('disabled irrelevant settings preserve their saved values instead of hidden invalid drafts',()=>{
  const base=normalizeConfig({capacitySeconds:2400,remainingSeconds:500,refillSeconds:1200,lowFuelSeconds:120,shutter:true,requiresIgnition:true});
  const values={capacityMinutes:'-1',remainingMinutes:'-1',refillMinutes:'-1',lowFuelMinutes:'-1',shutter:false,requiresIgnition:false};
  const form={elements:{namedItem:name=>name==='enabled'?{checked:false}:name in values?{value:values[name],checked:false,disabled:true}:null}};
  const c=readConfig(form,base,{item:true});
  for(const field of ['capacitySeconds','remainingSeconds','refillSeconds','lowFuelSeconds','shutter','requiresIgnition'])assert.equal(c[field],base[field],field);
  assert.equal(c.enabled,false);
});

test('an unselected token is distinguished from an empty inventory or an extinguished source',()=>{
  const html=renderPanel({hasActor:false,sources:[],canOperate:false,authority:true,gm:true});
  assert.match(html,/Выберите на сцене токен персонажа/);assert.doesNotMatch(html,/Свет погашен|Добавьте свечу/);
});
