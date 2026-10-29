import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig, lightData, tickRemaining, getQuantity, findNamedItem, displayTime,igniterStatus,refillAmount,refillHint} from '../scripts/logic.js';
test('normalization clamps and handles invalid fields', () => {
  const c = normalizeConfig({enabled:true, mode:'tank', capacitySeconds:30, remainingSeconds:99, dim:-7, bright:30, angle:400});
  assert.equal(c.remainingSeconds, 30); assert.equal(c.dim, 0); assert.equal(c.angle, 360);
  assert.equal(lightData(c).bright, 30); assert.equal(lightData(c).dim, 30);
});

for(const [name,value] of [['null',null],['undefined',undefined],['empty string',''],['whitespace',' \t\n ']]) {
  test(`missing numeric settings (${name}) keep source defaults`,()=>{
    const fields=['capacitySeconds','remainingSeconds','refillSeconds','lowFuelSeconds','bright','dim','angle','alpha','animationSpeed','animationIntensity'];
    assert.deepEqual(normalizeConfig(Object.fromEntries(fields.map(field=>[field,value]))),normalizeConfig());
  });
}

test('explicit numeric zero and numeric strings retain their intended meaning',()=>{
  for(const zero of [0,'0']) {
    const c=normalizeConfig({capacitySeconds:zero,remainingSeconds:zero,refillSeconds:zero,lowFuelSeconds:zero,bright:zero,dim:zero,angle:zero,alpha:zero,animationSpeed:zero,animationIntensity:zero});
    for(const field of ['remainingSeconds','lowFuelSeconds','bright','dim','alpha']) assert.equal(c[field],0,field);
    for(const field of ['capacitySeconds','refillSeconds','angle','animationSpeed','animationIntensity']) assert.equal(c[field],1,field);
  }
  const c=normalizeConfig({capacitySeconds:'120',remainingSeconds:'30.125',bright:'2.5'});
  assert.equal(c.capacitySeconds,120);assert.equal(c.remainingSeconds,30.125);assert.equal(c.bright,2.5);
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

test('Bonus stock remains readable when empty, and refill hints report discarded fuel',()=>{
  const box={name:'Коробок',system:{quantity:1,bonus:{value:0,max:8}}};
  const status=igniterStatus(box,'bonus');assert.equal(status.available,false);assert.match(status.stock,/0 \/ 8/);assert.match(status.reason,/Нет зарядов/);
  const c=normalizeConfig({capacitySeconds:100,refillSeconds:40});
  assert.deepEqual(refillAmount(c,90),{gain:10,waste:30});assert.match(refillHint(c,90,'Масло'),/\+0 м 10 с; избыток 0 м 30 с потеряется/);
});
