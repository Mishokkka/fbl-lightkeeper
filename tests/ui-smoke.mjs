/** Optional browser checks. Start preview-server.mjs first; Playwright is a dev-only dependency. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const {chromium}=await import(arg('playwright')?pathToFileURL(path.resolve(arg('playwright'),'index.mjs')).href:'playwright');
const output=path.resolve(arg('out') ?? 'ui-preview'); await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(arg('chrome')?{executablePath:arg('chrome')}: {})});
try {
  const page=await browser.newPage({viewport:{width:1540,height:1000},deviceScaleFactor:1});
  page.setDefaultTimeout(8000);
  const errors=[]; page.on('pageerror',error=>{errors.push(error.message);console.error('Browser:',error.message);});
  await page.goto('http://127.0.0.1:4173');
  const panel=page.locator('#fbl-lightkeeper-panel');
  await panel.getByRole('heading',{name:'Элиас Блэквуд'}).waitFor();
  await panel.getByRole('button',{name:'Закрыть шторки',exact:true}).click();
  await panel.getByText('ШТОРКИ ЗАКРЫТЫ',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>demo.token.getFlag('fbl-lightkeeper','active').shutterClosed),true);
  assert.equal(await page.evaluate(()=>demo.token.light.bright),0);
  await panel.getByRole('button',{name:'Открыть шторки',exact:true}).click();
  await page.getByRole('button',{name:'Пауза мира',exact:true}).click();
  await panel.locator('.lk-session').filter({hasText:'Пауза'}).waitFor();
  const clock=await panel.locator('[data-lk-clock]').textContent();
  await page.waitForTimeout(1200);
  assert.equal(await panel.locator('[data-lk-clock]').textContent(),clock);
  await panel.screenshot({path:path.join(output,'lightkeeper-panel.png')});
  await page.getByRole('button',{name:'Пауза мира',exact:true}).click();
  const candle=panel.locator('.lk-source-row').filter({has:page.getByRole('heading',{name:'Свеча',exact:true})});
  await candle.getByRole('button',{name:'Заменить',exact:true}).click();
  await panel.locator('.lk-burn-copy h3').filter({hasText:'Свеча'}).waitFor();
  assert.equal(await page.evaluate(()=>demo.actor.items.get('CANDLE').system.quantity),2);
  await panel.getByRole('button',{name:'Шаблоны',exact:true}).click();
  const library=page.locator('#fbl-lightkeeper-library');
  await library.locator('[name="label"]').waitFor();
  await library.locator('[name="label"]').fill('Свеча палаты');
  await library.locator('[name="names"]').fill('Свеча\nCandle\nВосковая свеча');
  await library.locator('[name="capacityMinutes"]').fill('45');
  await library.getByRole('button',{name:'Сохранить библиотеку',exact:true}).click();
  await page.waitForFunction(()=>demo.api.getCatalog().sources[0].label==='Свеча палаты');
  assert.equal(await page.evaluate(()=>demo.api.getCatalog().sources[0].config.capacitySeconds),2700);
  assert.equal(await page.evaluate(()=>demo.token.getFlag('fbl-lightkeeper','active').config.capacitySeconds),1800);
  await library.screenshot({path:path.join(output,'lightkeeper-library.png')});
  const colors=()=>page.evaluate(()=>[...document.querySelectorAll('.fbl-lk-window .window-content,.fbl-lk-window h2,.fbl-lk-window input,.fbl-lk-window textarea,.fbl-lk-window button')].map(el=>{
    const c=getComputedStyle(el);return [c.color,c.backgroundColor,c.borderTopColor];
  }));
  await page.mouse.move(0,950); await page.waitForTimeout(200);
  const dark=await colors();
  await page.getByRole('button',{name:'Светлая тема Foundry',exact:true}).click();
  await page.mouse.move(0,950); await page.waitForTimeout(200);
  assert.deepEqual(await colors(),dark,'Foundry theme changed Lightkeeper colors');
  await page.screenshot({path:path.join(output,'lightkeeper-light-theme.png'),fullPage:true});
  await library.getByRole('button',{name:'Розжиг и топливо',exact:true}).click();
  await library.locator('[name="names"]').fill('Спички\nКоробок спичек\nMatches');
  await library.getByRole('button',{name:'Сохранить библиотеку',exact:true}).click();
  await page.waitForFunction(()=>demo.api.getCatalog().resources[0].names.includes('Коробок спичек'));
  const download=page.waitForEvent('download');
  await library.getByRole('button',{name:'Экспорт',exact:true}).click();
  const exported=await download; const data=JSON.parse(await fs.readFile(await exported.path(),'utf8'));
  assert.equal(data.version,1); assert.ok(data.resources[0].names.includes('Коробок спичек'));
  await library.locator('[data-lk-import]').setInputFiles({name:'test.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,sources:[{id:'imported',label:'Тестовый фонарь',names:['Фонарь врача'],config:{enabled:true}}],resources:[]}))});
  await library.getByText(/Импортировано: 1 источников/).waitFor();
  await library.getByRole('button',{name:'Сохранить библиотеку',exact:true}).click();
  await page.waitForFunction(()=>demo.api.getCatalog().sources.some(s=>s.id==='imported'));
  // Apply a preset in the actual item editor and save it back to the simulated Item.
  await panel.locator('.lk-source-row').filter({has:page.getByRole('heading',{name:'Карманный фонарик',exact:true})}).getByRole('button',{name:'Настроить',exact:true}).click();
  const editor=page.locator('[id="fbl-lightkeeper-item-Actor.A1.Item.FLASH"]');
  await editor.locator('[name="templateChoice"]').selectOption('hooded-lantern');
  await editor.getByRole('button',{name:'Применить',exact:true}).click();
  await editor.locator('[name="shutter"]:checked').waitFor();
  await editor.locator('[name="ignitionMode"]').selectOption('require');
  assert.equal(await editor.locator('[name="ignitionCost"]').isVisible(),false);
  await editor.locator('[name="ignitionMode"]').selectOption('consume');
  await editor.locator('[name="ignitionCost"]').selectOption('bonus');
  assert.equal(await editor.locator('[name="ignitionItem"]').isVisible(),false);
  await editor.locator('details:has([name="soundOn"])').evaluate(element=>element.open=true);
  await page.evaluate(()=>{
    foundry.applications.apps={FilePicker:{implementation:class {
      constructor(options){this.options=options;}
      render(){this.options.callback('sounds/ignite.ogg');}
    }}};
  });
  await editor.locator('[data-action="browse-audio"][data-id="soundOn"]').click();
  await editor.locator('[name="soundOff"]').fill('sounds/extinguish.ogg');
  await editor.locator('[name="soundVolumePercent"]').fill('35');
  await editor.locator('[name="soundFadeSeconds"]').fill('0.4');
  await editor.screenshot({path:path.join(output,'lightkeeper-item-editor.png')});
  await editor.getByRole('button',{name:'Сохранить предмет',exact:true}).click();
  await page.waitForFunction(()=>demo.actor.items.get('FLASH').getFlag('fbl-lightkeeper','light')?.shutter===true);
  const saved=await page.evaluate(()=>demo.actor.items.get('FLASH').getFlag('fbl-lightkeeper','light'));
  assert.equal(saved.ignitionCost,'bonus');assert.equal(saved.soundOn,'sounds/ignite.ogg');assert.equal(saved.soundOff,'sounds/extinguish.ogg');assert.equal(saved.soundVolume,.35);assert.equal(saved.soundFadeSeconds,.4);
  // CodeRabbit regression: optional blank numeric fields must preserve their prior values.
  await editor.waitFor({state:'hidden'});
  await panel.locator('.lk-source-row').filter({has:page.getByRole('heading',{name:'Карманный фонарик',exact:true})}).getByRole('button',{name:'Настроить',exact:true}).click();
  for(const name of ['capacityMinutes','remainingMinutes','refillMinutes','lowFuelMinutes']) await editor.locator(`[name="${name}"]`).fill('');
  await editor.getByRole('button',{name:'Сохранить предмет',exact:true}).click();await editor.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>demo.actor.items.get('FLASH').getFlag('fbl-lightkeeper','light').capacitySeconds),2400);
  assert.equal(await page.evaluate(()=>demo.actor.items.get('FLASH').getFlag('fbl-lightkeeper','light').remainingSeconds),2400);
  // An open settings form must not restore fuel consumed/changed since it was opened.
  await panel.locator('.lk-source-row').filter({has:page.getByRole('heading',{name:'Карманный фонарик',exact:true})}).getByRole('button',{name:'Настроить',exact:true}).click();
  await editor.locator('[name="remainingMinutes"]').waitFor();
  await page.evaluate(()=>demo.actor.items.get('FLASH').update({'flags.fbl-lightkeeper.light.remainingSeconds':2123}));
  await editor.locator('details:has([name="color"])').evaluate(element=>element.open=true);
  await editor.locator('[name="color"]').fill('#aaccee');
  await editor.getByRole('button',{name:'Сохранить предмет',exact:true}).click();await editor.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>demo.actor.items.get('FLASH').getFlag('fbl-lightkeeper','light').remainingSeconds),2123);
  // An explicit fuel edit still works, including an empty tank.
  await panel.locator('.lk-source-row').filter({has:page.getByRole('heading',{name:'Карманный фонарик',exact:true})}).getByRole('button',{name:'Настроить',exact:true}).click();
  await editor.locator('[name="remainingMinutes"]').fill('0');
  await editor.getByRole('button',{name:'Сохранить предмет',exact:true}).click();await editor.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>demo.actor.items.get('FLASH').getFlag('fbl-lightkeeper','light').remainingSeconds),0);
  // CodeRabbit regression: import into an empty section selects a form and saves successfully.
  await library.getByRole('button',{name:'Розжиг и топливо',exact:true}).click();
  let count=await library.locator('.lk-template-choice').count();
  while(count) {
    await library.getByRole('button',{name:'Удалить',exact:true}).click();
    await page.waitForFunction(expected=>document.querySelectorAll('#fbl-lightkeeper-library .lk-template-choice').length===expected,--count);
  }
  await library.getByRole('button',{name:'Сохранить библиотеку',exact:true}).click();
  await page.waitForFunction(()=>demo.api.getCatalog().resources.length===0);
  await library.locator('[data-lk-import]').setInputFiles({name:'resource.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,sources:[],resources:[{id:'new-stock',label:'Новый запас',names:['Новый запас']}]}))});
  await library.getByRole('heading',{name:'Новый запас',exact:true}).waitFor();
  await library.getByRole('button',{name:'Сохранить библиотеку',exact:true}).click();
  await page.waitForFunction(()=>demo.api.getCatalog().resources[0]?.id==='new-stock');
  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: panel, shutters, pause, switching, templates, resources, theme isolation, JSON import/export, item editor, empty-field, empty-import and stale-fuel regressions.');
  console.log('Screenshots: '+output);
} catch(error) {
  const page=browser.contexts()[0]?.pages()[0];
  if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
  throw error;
} finally { await browser.close(); }
