import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clockTime,renderPanel,renderLibrary,readConfig} from '../scripts/views.js';
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
test('form values use minutes but preserve fractional fuel and resource references',()=>{
  const values={mode:'tank',capacityMinutes:'40',remainingMinutes:'14.375',refillMinutes:'20',lowFuelMinutes:'2',shutter:true,enabled:true,
    refillResource:'oil',ignitionResource:'matches'};
  const form={elements:{namedItem:name=>name in values?{value:String(values[name]),checked:values[name]===true}:null}};
  const config=readConfig(form,normalizeConfig(),{item:true});
  assert.equal(config.remainingSeconds,862.5);assert.equal(config.capacitySeconds,2400);
  assert.equal(config.refillResource,'oil');assert.equal(config.lowFuelSeconds,120);assert.ok(config.shutter);
});
