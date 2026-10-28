import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig, lightData, tickRemaining, getQuantity, findNamedItem, displayTime} from '../scripts/logic.js';
test('normalization clamps and handles invalid fields', () => {
  const c = normalizeConfig({enabled:true, mode:'tank', capacitySeconds:30, remainingSeconds:99, dim:-7, bright:30, angle:400});
  assert.equal(c.remainingSeconds, 30); assert.equal(c.dim, 0); assert.equal(c.angle, 360);
  assert.equal(lightData(c).bright, 30); assert.equal(lightData(c).dim, 30);
});

test('fractional fuel survives normalization and repeated switches', () => {
  assert.equal(normalizeConfig({capacitySeconds:100,remainingSeconds:99.125}).remainingSeconds,99.125);
  assert.equal(normalizeConfig(null).capacitySeconds,1800);
});

test('animation names match Foundry v13 and migrate old flickering settings', () => {
  assert.equal(lightData({animation:'none'}).animation.type,null);
  assert.equal(lightData({animation:'flickering'}).animation.type,'flame');
  assert.equal(lightData({animationSpeed:2.7,animationIntensity:4.1}).animation.speed,3);
  assert.equal(lightData({animationSpeed:2.7,animationIntensity:4.1}).animation.intensity,4);
});

test('ignition and refill need a whole unit, skipping fractional and malformed stacks', () => {
  const items=[{id:'a',name:'Масло',system:{quantity:0.5}},
    {id:'b',name:null,system:{quantity:2}},{id:'c',name:'МАСЛО',system:{quantity:1}}];
  assert.equal(findNamedItem({items},' масло ').id,'c');
  assert.equal(findNamedItem({items},'масло','c'),null);
});
test('a paused light does not consume time', () => {
  assert.equal(tickRemaining(120,1000,31000,true),120);
  assert.equal(tickRemaining(120,1000,31000,false),90);
  assert.equal(tickRemaining(20,1000,31000,false),0);
});
test('item quantity and names', () => {
  const items=[{id:'a',name:'Спички',system:{quantity:2}},{id:'b',name:'масло',system:{quantity:0}}];
  assert.equal(findNamedItem({items},'спички').id,'a');
  assert.equal(findNamedItem({items},'масло'),null);
  assert.equal(getQuantity(items[0]),2);
  assert.equal(displayTime(3605),'1 ч 00 м');
});
