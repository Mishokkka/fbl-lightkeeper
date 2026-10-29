import {displayTime,normalizeConfig,normalizeIgniter} from './logic.js';
import {ICONS} from './presets.js';

/** Escape user-controlled text for HTML text and attribute positions. */
export const esc = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** Render only a known icon class from the module icon registry. */
export const icon = name => `<i class="fa-solid ${ICONS[name] ?? ICONS.lantern}" aria-hidden="true"></i>`;
/** Translate normalized source modes for the Russian interface. */
export const modeName = mode => ({tank:'Бак / заряд',disposable:'Свеча / факел',infinite:'Без расхода'}[mode] ?? 'Источник');
/** Display a tabular clock, rounding milliseconds up and treating null as infinity. */
export function clockTime(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return '∞';
  const s = Math.ceil(Math.max(0,seconds));
  return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n => String(n).padStart(2,'0')).join(':');
}
/** Render an accessible action button with escaped labels and data attributes. */
export function button(action,label,{id='',iconName='',css='',disabled=false,title='',data={}} = {}) {
  const attrs=Object.entries(data).map(([key,value])=>`data-${esc(key)}="${esc(value)}"`).join(' ');
  return `<button type="button" class="lk-button ${esc(css)}" data-action="${esc(action)}" data-id="${esc(id)}" ${attrs} ${disabled?'disabled':''} title="${esc(title || label)}">${iconName?icon(iconName):''}<span>${esc(label)}</span></button>`;
}
/** Render a compact escaped heading. */
export const masthead = title => `<header class="lk-masthead"><h2>${esc(title)}</h2></header>`;
/** Render the structural light panel; ticking clocks subsequently update individual DOM nodes. */
export function renderPanel(model) {
  const {active,sources,gm,paused,authority,tokenName,canOperate=true,igniters=[],ignitionId='auto',items=[]} = model;
  const condition = !authority ? 'Нужен ГМ' : paused ? 'Пауза' : '';
  const remaining = active?.remainingSeconds;
  const ratio = active?.config.mode === 'infinite' ? 100 : Math.max(0,Math.min(100,100*(remaining ?? 0)/(active?.config.capacitySeconds || 1)));
  const low = active && remaining !== null && remaining <= active.config.lowFuelSeconds;
  const hero = active ? `<section class="lk-burning ${low?'lk-low':''}">
    ${active.shutterClosed?'<div class="lk-burning-top"><span class="lk-kicker">ШТОРКИ ЗАКРЫТЫ</span></div>':''}
    <div class="lk-burn-body"><div class="lk-source-glyph">${icon(active.icon)}</div><div class="lk-burn-copy"><h3>${esc(active.itemName)}</h3><p>${active.shutterClosed?'Топливо продолжает расходоваться':esc(modeName(active.config.mode))}</p></div></div>
    <div class="lk-clock-row"><strong data-lk-clock>${clockTime(remaining)}</strong></div>
    <div class="lk-meter" role="meter" aria-label="Запас топлива" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio)}"><span data-lk-meter style="width:${ratio}%"></span></div>
    <div class="lk-actions">${active.config.shutter?button('shutter',active.shutterClosed?'Открыть шторки':'Закрыть шторки',{iconName:'lantern',disabled:!canOperate}):''}${button('off','Погасить',{iconName:'candle',css:'lk-quiet',disabled:!canOperate})}</div>
  </section>` : '<section class="lk-unlit"><h3>Свет погашен</h3></section>';
  const rows = sources.map(s => `<article class="lk-source-row ${s.active?'lk-selected':''}" data-lk-name="${esc(s.name.toLocaleLowerCase())}">
    <div class="lk-row-icon">${icon(s.icon)}</div><div class="lk-row-copy"><h4>${esc(s.name)}</h4><p>${s.active?`<span data-lk-current-detail>${esc(s.timeLabel ?? s.detail)}</span>${esc(s.stockLabel ?? '')}`:esc(s.detail)}</p></div>
    <div class="lk-row-actions">${button(s.active?'off':'ignite',s.active?'Погасить':active?'Заменить':'Зажечь',{id:s.id,css:s.active?'lk-quiet':'lk-primary',disabled:!canOperate || !!s.blocked,title:s.blocked || ''})}
    ${s.refillable?button('refill','Заправить',{id:s.id,css:'lk-small lk-quiet',disabled:!canOperate || !!s.refillBlocked,title:s.refillBlocked || s.refillHint,
      data:s.active && canOperate?{'lk-current-refill':'','has-fuel':!s.fuelMissing,'refill-hint':s.refillHint}: {}}):''}
    ${gm && s.configurable!==false?button('configure','Настроить',{id:s.id,css:'lk-small lk-link lk-icon-button',iconName:'settings'}):''}</div></article>`).join('');
  return `<div class="lk-panel">
    ${masthead(tokenName || 'Выберите токен')}
    ${condition?`<div class="lk-session"><span class="lk-dot lk-paused"></span>${esc(condition)}</div>`:''}
    ${!canOperate?'<p class="lk-notice">Этот персонаж недоступен для управления. Выберите свой токен.</p>':''}
    ${hero}
    <div class="lk-ignition-choice">${select('ignitionChoice','Розжиг',ignitionId,[['auto','Авто · '+(igniters[0]?.label??'нет доступного')],...igniters.map(i=>[i.id,i.label]),...(!['auto',...igniters.map(i=>i.id)].includes(ignitionId)?[[ignitionId,'Выбранный розжиг недоступен']]:[])])}</div>
    <div class="lk-section-heading">${gm?button('library','Шаблоны',{css:'lk-small lk-link',iconName:'magic'}):''}</div>
    <label class="lk-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-lk-search placeholder="Найти источник…" aria-label="Найти источник" value="${esc(model.search ?? '')}"></label>
    <div class="lk-sources">${rows || '<div class="lk-empty">Источников пока нет.<br>Добавьте свечу или лампу в инвентарь — настроенные названия распознаются автоматически.</div>'}<p class="lk-empty" data-lk-no-results hidden>Совпадений нет.</p></div>
    ${gm && active && active.config.mode!=='infinite'?`<div class="lk-gm-tools">${button('adjust','−5 мин',{id:'-300',css:'lk-small lk-quiet'})}${button('adjust','+5 мин',{id:'300',css:'lk-small lk-quiet'})}</div>`:''}
    ${gm && items.length?`<details class="lk-details lk-inventory-config"><summary>Настроить предмет</summary><div class="lk-actions">${select('configureItem','Предмет',items[0].id,items.map(i=>[i.id,i.name]))}${button('configure-selected','Открыть',{css:'lk-small',iconName:'settings'})}</div></details>`:''}
  </div>`;
}

/** Render a labelled input using only module-owned styling. */
function field(name,label,value,{type='text',hint='',min='',max='',step='',list=''} = {}) {
  return `<label class="lk-field"><span>${esc(label)}</span><input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${min!==''?`min="${min}"`:''} ${max!==''?`max="${max}"`:''} ${step?`step="${step}"`:''} ${list?`list="${esc(list)}"`:''}>${hint?`<small>${esc(hint)}</small>`:''}</label>`;
}
/** Render escaped select options while preserving explicit empty-resource choices. */
function select(name,label,value,choices,hint='') {
  return `<label class="lk-field"><span>${esc(label)}</span><select name="${esc(name)}">${choices.map(([id,label])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(label)}</option>`).join('')}</select>${hint?`<small>${esc(hint)}</small>`:''}</label>`;
}
/** Render a boolean setting with an optional explanatory hint. */
function check(name,label,value,hint='') {
  return `<label class="lk-check"><input type="checkbox" name="${esc(name)}" ${value?'checked':''}><span>${esc(label)}${hint?`<small>${esc(hint)}</small>`:''}</span></label>`;
}
/** Round-trip alias arrays as editable lines, escaping their contents. */
function textarea(name,label,value,hint='') {
  return `<label class="lk-field"><span>${esc(label)}</span><textarea name="${esc(name)}" rows="3">${esc(Array.isArray(value)?value.join('\n'):value)}</textarea>${hint?`<small>${esc(hint)}</small>`:''}</label>`;
}
/** Render source settings with minute units and visible missing-resource references. */
export function configFields(c,catalog,{item=false} = {}) {
  const resources = [['','По названию ниже'],...catalog.resources.map(r => [r.id,r.label])];
  // Keep deleted resource references visible until the GM explicitly changes them.
  const choices = key => resources.some(([id])=>id===key) ? resources : [...resources,[key,'Удалённое правило — выберите замену']];
  const when=(key,content)=>`<div class="lk-conditional" data-lk-show="${key}">${content}</div>`;
  return `<fieldset class="lk-fieldset"><legend>Горение</legend><div class="lk-grid">
    ${select('mode','Тип источника',c.mode,[['disposable','Свеча / факел'],['tank','Бак / заряд'],['infinite','Без расхода']])}
    ${field('capacityMinutes','Полный запас, мин',c.capacitySeconds/60,{type:'number',min:1/60,max:10080,step:'any'})}
    ${item?field('remainingMinutes','Осталось, мин',c.remainingSeconds/60,{type:'number',min:0,max:10080,step:'any'}):''}
    ${field('lowFuelMinutes','Предупредить за, мин',c.lowFuelSeconds/60,{type:'number',min:0,max:10080,step:'any',hint:'0 — без предупреждения'})}
    </div>${check('requiresIgnition','Нужен розжиг',c.requiresIgnition)}${check('canIgnite','Может разжигать другие источники',c.canIgnite)}${check('shutter','Шторки',c.shutter)}</fieldset>
    <details class="lk-details lk-config-section"><summary>Свет</summary><fieldset class="lk-fieldset"><legend>Параметры света</legend><div class="lk-grid">
    ${field('bright','Яркий радиус',c.bright,{type:'number',min:0,max:200,step:'any'})}${field('dim','Тусклый радиус',c.dim,{type:'number',min:0,max:200,step:'any'})}
    ${field('angle','Угол луча, °',c.angle,{type:'number',min:1,max:360,step:'any'})}${field('color','Цвет света',c.color,{type:'color'})}
    ${field('alpha','Непрозрачность',c.alpha,{type:'number',min:0,max:1,step:'0.05'})}
    ${select('animation','Анимация',c.animation,[['none','Без анимации'],['torch','Факел'],['flame','Пламя'],['pulse','Пульсация'],['chroma','Смена цвета']])}
    ${field('animationSpeed','Скорость анимации',c.animationSpeed,{type:'number',min:1,max:10,step:'1'})}${field('animationIntensity','Сила анимации',c.animationIntensity,{type:'number',min:1,max:10,step:'1'})}
    </div></fieldset></details>
    <fieldset class="lk-fieldset" data-lk-show="tank"><legend>Заправка</legend><div class="lk-grid">
    ${select('refillResource','Топливо',c.refillResource,choices(c.refillResource))}
    ${when('refillName',field('refillItem','Точное название',c.refillItem))}
    ${field('refillMinutes','Одна заправка, мин',c.refillSeconds/60,{type:'number',min:1/60,max:10080,step:'any'})}
    </div></fieldset>
    <details class="lk-details lk-config-section"><summary>Звук</summary><div class="lk-audio-files">
      <div class="lk-audio-file">${field('soundOn','Включение',c.soundOn)}${button('browse-audio','Выбрать файл',{id:'soundOn',iconName:'folder',css:'lk-small'})}</div>
      <div class="lk-audio-file">${field('soundOff','Выключение',c.soundOff)}${button('browse-audio','Выбрать файл',{id:'soundOff',iconName:'folder',css:'lk-small'})}</div>
    </div><div class="lk-grid">${field('soundVolumePercent','Громкость, %',c.soundVolume*100,{type:'number',min:0,max:100,step:1})}${field('soundFadeSeconds','Плавный вход / выход, с',c.soundFadeSeconds,{type:'number',min:0,max:30,step:'any'})}</div></details>`;
}
/** Convert minutes to seconds; blank numeric fields retain existing values, explicit zero remains valid. */
export function readConfig(form,base,{item=false} = {}) {
  const value = name => form.elements.namedItem(name)?.value;
  const checked = name => !!form.elements.namedItem(name)?.checked;
  const raw = {...base};
  const numeric=new Set(['bright','dim','angle','alpha','animationSpeed','animationIntensity']);
  for (const name of ['mode','bright','dim','angle','color','alpha','animation','animationSpeed','animationIntensity','refillResource','refillItem','soundOn','soundOff']) {
    const input=value(name);
    if (input!==undefined && !(numeric.has(name) && String(input).trim()==='')) raw[name] = input;
  }
  const seconds = (name,fallback) => {
    const input=value(name);
    return input===undefined || String(input).trim()==='' ? fallback : Number(input)*60;
  };
  raw.capacitySeconds = seconds('capacityMinutes',base?.capacitySeconds);
  raw.remainingSeconds = item ? seconds('remainingMinutes',base?.remainingSeconds) : raw.capacitySeconds;
  raw.refillSeconds = seconds('refillMinutes',base?.refillSeconds);
  raw.lowFuelSeconds = seconds('lowFuelMinutes',base?.lowFuelSeconds);
  const volume=value('soundVolumePercent'),fade=value('soundFadeSeconds');
  if(volume!==undefined && String(volume).trim()!=='')raw.soundVolume=Number(volume)/100;
  if(fade!==undefined && String(fade).trim()!=='')raw.soundFadeSeconds=Number(fade);
  raw.shutter = checked('shutter');
  for(const key of ['requiresIgnition','canIgnite'])if(form.elements.namedItem(key))raw[key]=checked(key);
  if (item) raw.enabled = checked('enabled');
  return normalizeConfig(raw);
}
const igniterChoices=[['none','Не используется'],['reusable','Не расходуется'],['quantity','Расход: 1 предмет'],['bonus','Расход: 1 Bonus']];
/** Resource consumption belongs in its own editor, never in the source configuration. */
export function readIgniter(form) {
  const mode=form.elements.namedItem('igniterMode')?.value;
  return mode==='inherit'?null:normalizeIgniter({mode});
}
function igniterField(mode,inheritLabel='') {
  return select('igniterMode','Использование для розжига',mode,[...(inheritLabel?[['inherit',inheritLabel]]:[]),...igniterChoices]);
}
/** Render an individual source editor with pinned save actions. */
export function renderItemEditor(item,c,catalog,origin,igniter={config:{mode:'none'},origin:'none'}) {
  return `<div class="lk-editor">${masthead(item.name)}
    <div class="lk-item-scroll"><div class="lk-preset-picker">${select('templateChoice','Заполнить из шаблона',c.templateId,[['','Свои настройки'],...catalog.sources.map(s=>[s.id,s.label])])}${button('load-preset','Применить',{css:'lk-primary'})}</div>
    ${check('enabled','Использовать как источник света',c.enabled)}<div data-lk-show="source">${configFields(c,catalog,{item:true})}</div>
    <fieldset class="lk-fieldset"><legend>Средство розжига</legend>${igniterField(igniter.origin==='item'?igniter.config.mode:'inherit','По библиотеке · '+(catalog.resources.find(r=>r.id===igniter.preset?.id)?.label??'нет правила'))}</fieldset>
    </div>
    <div class="lk-actions lk-editor-footer">${button('save','Сохранить предмет',{css:'lk-primary'})}<span data-lk-show="source">${button('save-template','Шаблон света',{iconName:'magic',css:'lk-quiet'})}</span></div></div>`;
}
/** Render a draft library; an empty section is valid and remains importable. */
export function renderLibrary(catalog,kind,selectedId,{dirty=false,importInfo=''} = {}) {
  const entries = catalog[kind];
  const entry = entries.find(e=>e.id===selectedId);
  const editor = entry ? `<form class="lk-template-form" autocomplete="off"><div class="lk-editor-heading"><div class="lk-row-icon">${icon(entry.icon)}</div><h3>${esc(entry.label)}</h3>${button('delete','Удалить',{css:'lk-small lk-danger'})}</div>
    <div class="lk-grid">${field('label','Название шаблона',entry.label)}${select('icon','Значок',entry.icon,Object.keys(ICONS).map(k=>[k,{candle:'Пламя',lamp:'Лампа',lantern:'Фонарь',flashlight:'Молния',magic:'Магия',fuel:'Масло',matches:'Розжиг',battery:'Батарея',settings:'Шестерёнка',folder:'Папка'}[k]]))}</div>
    <fieldset class="lk-fieldset"><legend>Распознавание предмета</legend>
      ${textarea('names','Названия и варианты',entry.names,'Один вариант в строке. Регистр, «ё» и лишние пробелы не важны.')}
      <div class="lk-grid">${select('matchMode','Сопоставление названия',entry.matchMode,[['exact','Точное совпадение'],['contains','Название содержит вариант']])}${field('itemTypes','Типы Item через запятую',entry.itemTypes.join(', '),{hint:'Пусто — все типы; например gear, weapon'})}</div>
      <details class="lk-details"><summary>Устойчивые ссылки на предметы</summary>${textarea('uuids','UUID / исходный UUID из компендиума',entry.uuids,'Такие совпадения работают и после переименования.')}</details>
    </fieldset>
    ${kind==='sources'?configFields(entry.config,catalog):`<fieldset class="lk-fieldset"><legend>Средство розжига</legend>${igniterField(entry.ignition?.mode??'none')}</fieldset>`}
    </form>` : '<div class="lk-empty">Создайте шаблон или добавьте стандартные.</div>';
  return `<div class="lk-library">
    <div class="lk-library-toolbar"><nav class="lk-tabs" aria-label="Раздел библиотеки">${button('kind','Источники',{id:'sources',css:kind==='sources'?'lk-tab-active':''})}${button('kind','Розжиг и топливо',{id:'resources',css:kind==='resources'?'lk-tab-active':''})}</nav>${button('new','Новый',{css:'lk-primary'})}</div>
    <div class="lk-library-body"><aside class="lk-library-list">${entries.map(e=>`<button type="button" data-action="select" data-id="${esc(e.id)}" class="lk-template-choice ${e.id===selectedId?'lk-selected':''}">${icon(e.icon)}<span>${esc(e.label)}</span></button>`).join('')}${entry?`<div class="lk-actions">${button('up','Выше',{css:'lk-small lk-quiet'})}${button('down','Ниже',{css:'lk-small lk-quiet'})}</div>`:''}</aside><section class="lk-library-editor">${editor}</section></div>
    <footer class="lk-library-footer"><div class="lk-actions">${button('save','Сохранить библиотеку',{css:'lk-primary'})}<span class="lk-save-state">${dirty?'Не сохранено':''}</span></div><div class="lk-actions">${button('defaults','Стандартные',{css:'lk-small lk-quiet'})}${button('export','Экспорт',{css:'lk-small lk-quiet'})}${button('import','Импорт',{css:'lk-small lk-quiet'})}<input type="file" data-lk-import accept="application/json,.json" hidden></div>${importInfo?`<p class="lk-hint">${esc(importInfo)}</p>`:''}</footer></div>`;
}
