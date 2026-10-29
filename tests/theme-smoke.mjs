/** Browser regression against locally installed Foundry/FBL CSS; no proprietary assets are bundled. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const arg=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const {chromium}=await import(arg('playwright')?pathToFileURL(path.resolve(arg('playwright'),'index.mjs')).href:'playwright');
const output=path.resolve(arg('out')??'theme-preview');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(arg('chrome')?{executablePath:arg('chrome')}:{})});
try {
  const page=await browser.newPage({viewport:{width:2200,height:1100},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(arg('url')??'http://127.0.0.1:4173/?foundry=1&system=1');
  assert.equal((await page.request.get(new URL('/core/css/foundry2.css',page.url()).href)).ok(),true,'Pass --foundry-public to the preview server');
  assert.equal((await page.request.get(new URL('/system/forbidden-lands.css',page.url()).href)).ok(),true,'Pass --system-public to the preview server');
  const requiredStyles=['/core/css/foundry2.css','/system/forbidden-lands.css'].map(p=>new URL(p,page.url()).href);
  const appliedStyles=await page.evaluate(urls=>urls.map(href=>{
    const sheet=[...document.styleSheets].find(sheet=>sheet.href===href);
    return {href,applied:!!sheet && !sheet.disabled && sheet.cssRules.length>0 &&
      (!sheet.media.length || matchMedia(sheet.media.mediaText).matches)};
  }),requiredStyles);
  for(const sheet of appliedStyles)assert.equal(sheet.applied,true,`The page must load and enable ${sheet.href}; use ?foundry=1&system=1`);
  await page.locator('#fbl-lightkeeper-panel [data-lk-clock]').waitFor();
  await page.evaluate(async()=>{
    await demo.api.library();await demo.api.configure(demo.actor.items.get('FLASH'));
    game.paused=true;await demo.fire('pauseGame',true);
    document.querySelector('[id^="fbl-lightkeeper-item-"]').style.left='1490px';
    const reference=document.createElement('section');reference.id='theme-reference';reference.className='application themed theme-dark';
    reference.style.cssText='position:absolute;left:28px;top:900px;width:490px;height:110px;';
    reference.innerHTML='<section class="window-content"><p>Обычное окно Foundry</p><input placeholder="Внешнее поле"><button type="button">Внешняя кнопка</button></section>';
    document.body.append(reference);
    const message=document.createElement('div');message.className='fbl-lk-message';message.style.cssText='position:absolute;left:550px;top:940px;width:900px;';
    message.innerHTML='<strong>Свет догорает</strong><p>Сообщение Lightkeeper сохраняет свою палитру.</p>';document.body.append(message);
  });
  await page.locator('#fbl-lightkeeper-panel .lk-session').filter({hasText:'Пауза'}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  const closeIcon=await page.locator('#fbl-lightkeeper-panel [data-action="close"]').evaluate(element=>({family:getComputedStyle(element).fontFamily,glyph:getComputedStyle(element,'::before').content}));
  assert.match(closeIcon.family,/Font Awesome/);assert.notEqual(closeIcon.glyph,'none');assert.notEqual(closeIcon.glyph,'""');
  await page.addStyleTag({content:'.fbl-lk-window,.fbl-lk-window *{transition-duration:0s!important;animation:none!important}'});

  const setTheme=async(body,windowTheme)=>page.evaluate(({body,windowTheme})=>{
    for(const value of ['dark','light'])document.body.classList.toggle(`theme-${value}`,value===body);
    for(const app of document.querySelectorAll('.application'))for(const value of ['dark','light'])app.classList.toggle(`theme-${value}`,value===windowTheme);
  },{body,windowTheme});
  const snapshot=async(selector='.fbl-lk-window,.fbl-lk-window *,.fbl-lk-message,.fbl-lk-message *')=>page.evaluate(selector=>{
    const properties=['color','backgroundColor','backgroundImage','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','outlineColor','textDecorationColor','textShadow','boxShadow','filter','colorScheme','caretColor','accentColor','webkitTextFillColor'];
    return [...document.querySelectorAll(selector)].flatMap((element,index)=>[null,'::before','::after','::marker',...(element.matches('input,textarea')?['::placeholder']:[])].map(pseudo=>{
      const style=getComputedStyle(element,pseudo),id=`${index}:${element.tagName}.${[...element.classList].filter(c=>!c.startsWith('theme-')).join('.')}${pseudo??''}`;
      return {id,values:Object.fromEntries(properties.map(property=>[property,style[property]]))};
    }));
  },selector);
  const compare=(expected,actual,label)=>{
    assert.equal(actual.length,expected.length,label+' changed the tested DOM');
    const changes=actual.flatMap((row,index)=>Object.entries(row.values).filter(([key,value])=>expected[index].values[key]!==value).map(([property,value])=>({element:row.id,property,dark:expected[index].values[property],light:value})));
    assert.equal(changes.length,0,label+' changed module colors:\n'+JSON.stringify(changes.slice(0,20),null,2));
  };

  await setTheme('dark','dark');const baseline=await snapshot();
  const referenceDark=await page.locator('#theme-reference').evaluate(element=>getComputedStyle(element).backgroundImage);
  for(const [body,windowTheme] of [['light','light'],['light','dark'],['dark','light']]) {
    await setTheme(body,windowTheme);compare(baseline,await snapshot(),`${body} body / ${windowTheme} window`);
  }
  await setTheme('light','light');
  const referenceLight=await page.locator('#theme-reference').evaluate(element=>getComputedStyle(element).backgroundImage);
  assert.notEqual(referenceDark,referenceLight,'The native theme did not actually change');

  // Native frame controls and states omitted by the original minimal preview.
  const states=[
    ['header hover','#fbl-lightkeeper-library [data-action="close"]','hover'],
    ['primary hover','#fbl-lightkeeper-library [data-action="new"]','hover'],
    ['input focus','#fbl-lightkeeper-library [name="label"]','focus'],
    ['disabled button','#fbl-lightkeeper-library [data-action="save"]','disabled'],
    ['readonly input','#fbl-lightkeeper-library [name="label"]','readOnly'],
    ['checked checkbox','[id^="fbl-lightkeeper-item-"] [name="enabled"]','checked'],
    ['unchecked checkbox','[id^="fbl-lightkeeper-item-"] [name="enabled"]','unchecked'],
    ['window menu','#fbl-lightkeeper-library .controls-dropdown','expanded']
  ];
  for(const [label,selector,state] of states) {
    const locator=page.locator(selector);
    if(state==='hover')await locator.hover();
    else if(state==='focus')await locator.focus();
    else await locator.evaluate((element,state)=>{if(state==='expanded')element.classList.add('expanded');else if(state==='unchecked')element.checked=false;else element[state]=true;},state);
    await setTheme('dark','dark');const expected=await snapshot(`${selector},${selector} *`);
    await setTheme('light','light');compare(expected,await snapshot(`${selector},${selector} *`),label);
    if(['disabled','readOnly'].includes(state))await locator.evaluate((element,state)=>element[state]=false,state);
    if(state==='expanded')await locator.evaluate(element=>element.classList.remove('expanded'));
    await page.mouse.move(0,0);await locator.evaluate(element=>element.blur());
  }
  const surfaces=await page.evaluate(()=>[...document.querySelectorAll('.fbl-lk-window,.fbl-lk-window :is(.window-header,.window-content,.controls-dropdown,form,.lk-panel,.lk-library,.lk-editor,.lk-library-list,.lk-library-editor)')].map(element=>({element:element.className,color:getComputedStyle(element).backgroundColor,image:getComputedStyle(element).backgroundImage})));
  for(const surface of surfaces){assert.match(surface.color,/^rgb\(/,`Opaque module surface missing: ${JSON.stringify(surface)}`);assert.equal(surface.image,'none',`Theme texture leaked: ${surface.element}`);}
  await fs.writeFile(path.join(output,'theme-colors.json'),JSON.stringify({elements:baseline.length,surfaces},null,2));
  await page.screenshot({path:path.join(output,'light-theme.png'),fullPage:true});
  await setTheme('dark','dark');await page.screenshot({path:path.join(output,'dark-theme.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log(`Theme checks passed: ${baseline.length} element/pseudo snapshots, 4 body/window theme combinations, 8 interactive states and opaque surfaces; native Foundry/FBL CSS loaded.`);
  await page.locator('#fbl-lightkeeper-panel [data-action="close"]').click();
  await page.locator('#fbl-lightkeeper-panel').waitFor({state:'hidden'});
}catch(error){const page=browser.contexts()[0]?.pages()[0];if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});throw error;}
finally{await browser.close();}
