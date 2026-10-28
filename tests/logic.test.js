import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig, lightData, tickRemaining, getQuantity, findNamedItem, displayTime} from '../scripts/logic.js';
test('normalization clamps and handles invalid fields', () => {
  const c = normalizeConfig({enabled:true, mode:'tank', capacitySeconds:30, remainingSeconds:99, dim:-7, bright:30, angle:400});
  assert.equal(c.remainingSeconds, 30); assert.equal(c.dim, 0); assert.equal(c.angle, 360);
  assert.equal(lightData(c).bright, 0); assert.equal(lightData(c).dim, 30);
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
