/** Optional browser checks for draft preservation, validation and live inventory feedback. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const {chromium}=await import(arg('playwright')?pathToFileURL(path.resolve(arg('playwright'),'index.mjs')).href:'playwright');
const output=path.resolve(arg('out')??'ux-preview');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(arg('chrome')?{executablePath:arg('chrome')}:{})});
try {
  const page=await browser.newPage({viewport:{width:1560,height:1000}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(arg('url')??'http://127.0.0.1:4173');
  await page.locator('#fbl-lightkeeper-panel [data-lk-clock]').waitFor();
  await page.getByRole('button',{name:'Пауза мира',exact:true}).click();
  await page.evaluate(()=>demo.api.library());const library=page.locator('#fbl-lightkeeper-library');
  await library.locator('[name="label"]').fill('Черновик палаты');
  await page.evaluate(()=>demo.api.library());
  assert.equal(await library.locator('[name="label"]').inputValue(),'Черновик палаты');
  assert.equal(await page.evaluate(()=>demo.api.getCatalog().sources[0].label),'Свеча');

  await library.locator('[name="capacityMinutes"]').fill('-1');
  await library.getByRole('button',{name:'Розжиг и топливо',exact:true}).click();
  assert.equal(await library.locator('.lk-tab-active').getAttribute('data-id'),'sources');
  assert.equal(await library.locator('[name="capacityMinutes"]').inputValue(),'-1');
  await library.locator('[name="capacityMinutes"]').fill('45');
  const light=library.locator('details:has([name="alpha"])');await light.evaluate(el=>el.open=true);
  await library.locator('[name="alpha"]').fill('2');await light.evaluate(el=>el.open=false);
  await library.getByRole('button',{name:'Сохранить библиотеку',exact:true}).click();
  assert.equal(await light.evaluate(el=>el.open),true);
  assert.equal(await page.evaluate(()=>demo.api.getCatalog().sources[0].label),'Свеча');
  await library.locator('[name="alpha"]').fill('0.5');
  await library.getByRole('button',{name:'Сохранить библиотеку',exact:true}).click();
  await page.waitForFunction(()=>demo.api.getCatalog().sources[0].label==='Черновик палаты');
  await library.locator('[name="names"]').fill('');
  assert.equal(await library.locator('[data-lk-recognition]').isVisible(),true);
  await library.locator('[name="names"]').fill('Свеча\nCandle');
  assert.equal(await library.locator('[data-lk-recognition]').isVisible(),false);

  await page.evaluate(()=>demo.api.configure(demo.actor.items.get('FLASH')));
  const editor=page.locator('[id="fbl-lightkeeper-item-Actor.A1.Item.FLASH"]');
  await editor.locator('details:has([name="bright"])').evaluate(el=>el.open=true);
  await editor.locator('[name="bright"]').fill('9');await editor.locator('[name="quantity"]').fill('');
  assert.equal(await editor.locator('[name="quantity"]').inputValue(),'');
  await editor.locator('[name="quantity"]').fill('7');
  await page.evaluate(()=>demo.api.configure(demo.actor.items.get('FLASH')));
  assert.equal(await editor.locator('[name="bright"]').inputValue(),'9');
  assert.equal(await editor.locator('[name="quantity"]').inputValue(),'7');
  await editor.locator('[name="templateChoice"]').selectOption('hooded-lantern');
  await editor.getByRole('button',{name:'Заполнить',exact:true}).click();
  assert.equal(await editor.locator('[name="quantity"]').inputValue(),'7');
  assert.equal(await editor.locator('[data-lk-stack-warning]').isVisible(),true);
  await editor.getByRole('button',{name:'Сохранить предмет',exact:true}).click();await editor.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>demo.actor.items.get('FLASH').system.quantity),7);

  await page.evaluate(()=>demo.api.configure(demo.actor.items.get('FLASH')));
  await editor.locator('[name="remainingMinutes"]').fill('-1');
  await page.evaluate(()=>demo.actor.items.get('FLASH').update({'system.quantity':3,'flags.fbl-lightkeeper.light.remainingSeconds':2123}));
  assert.equal(await editor.locator('[name="quantity"]').inputValue(),'3');
  await editor.locator('[name="enabled"]').uncheck();
  assert.equal(await editor.locator('[name="remainingMinutes"]').isDisabled(),true);
  await editor.getByRole('button',{name:'Сохранить предмет',exact:true}).click();await editor.waitFor({state:'hidden'});
  const saved=await page.evaluate(()=>demo.actor.items.get('FLASH').getFlag('fbl-lightkeeper','light'));
  assert.equal(saved.remainingSeconds,2123);assert.equal(saved.enabled,false);
  assert.equal(await page.evaluate(()=>demo.actor.items.get('FLASH').system.quantity),3);

  await page.evaluate(async()=>{
    const item=demo.actor.items.get('MATCH');
    await item.update({'system.bonus':{value:0,max:8},'flags.fbl-lightkeeper.ignition':{mode:'bonus'}});
    item.sheet={render(force){demo.nativeSheetOpened=force;}};
    await demo.api.configure(item);
  });
  const tool=page.locator('[id="fbl-lightkeeper-item-Actor.A1.Item.MATCH"]');
  assert.equal(await tool.locator('[name="templateChoice"]').isVisible(),false);
  assert.match(await tool.locator('[data-lk-igniter-stock]').textContent(),/Bonus 0 \/ 8/);
  await tool.getByRole('button',{name:'Лист предмета',exact:true}).click();
  assert.equal(await page.evaluate(()=>demo.nativeSheetOpened),true);
  await page.evaluate(()=>demo.actor.items.get('MATCH').update({'system.bonus.value':4}));
  await page.waitForFunction(()=>document.querySelector('[data-lk-igniter-stock]')?.textContent.includes('Bonus 4 / 8'));
  await tool.getByRole('button',{name:'Сохранить предмет',exact:true}).click();await tool.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>demo.actor.items.get('MATCH').system.bonus.value),4);

  const panel=page.locator('#fbl-lightkeeper-panel');
  await page.evaluate(()=>demo.token.update({'flags.fbl-lightkeeper.active.remainingSeconds':2390}));
  assert.match(await panel.locator('[data-lk-current-refill]').getAttribute('title'),/\+0 м 10 с; избыток 19 м 50 с потеряется/);
  await panel.locator('[data-lk-current-refill]').click();
  await page.waitForFunction(()=>demo.token.getFlag('fbl-lightkeeper','active').remainingSeconds===2400);
  assert.equal(await page.evaluate(()=>demo.actor.items.get('OIL').system.quantity),1);
  await page.evaluate(async()=>{
    const player={id:'PLAYER',isGM:false,active:true};game.users.push(player);game.user=player;
    await game.settings.set('fbl-lightkeeper','allowPlayers',false);await demo.api.open(demo.token);
  });
  assert.match(await panel.locator('.lk-notice').textContent(),/ГМ отключил управление светом/);
  assert.equal(await panel.locator('.lk-burning [data-action="off"]').isDisabled(),true);
  await page.evaluate(()=>game.settings.set('fbl-lightkeeper','allowPlayers',true));
  await panel.locator('.lk-notice').waitFor({state:'hidden'});
  assert.equal(await panel.locator('.lk-burning [data-action="off"]').isDisabled(),false);
  await page.evaluate(async()=>{game.user=game.users.get('GM');canvas.tokens.controlled=[];await demo.api.open();});
  assert.match(await panel.locator('.lk-empty').first().textContent(),/Выберите на сцене токен персонажа/);
  assert.equal(await panel.locator('.lk-burning').count(),0);
  await page.evaluate(()=>demo.api.open(demo.token));
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'ux-audit.png'),fullPage:true});
  console.log('UX checks passed: draft preservation, validation/navigation, hidden settings, recognition, quantity/live stock, native sheet, Bonus, refill loss, permission changes and no selected token.');
} catch(error) {
  const page=browser.contexts()[0]?.pages()[0];if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});throw error;
} finally {await browser.close();}
