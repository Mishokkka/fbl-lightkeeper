import {displayTime,normalizeConfig} from './logic.js';
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
/** Render the shared lantern brand and escaped window heading. */
export const masthead = (eyebrow,title,subtitle='') => `<header class="lk-masthead"><div class="lk-emblem"><svg viewBox="0 0 32 40" aria-hidden="true" fill="none" stroke="#e4bd7d" stroke-width="1.4"><path d="M12 7V5a4 4 0 0 1 8 0v2M8 11l4-4h8l4 4M7 12h18M9 14v19M23 14v19M7 35h18M10 38h12"/><rect x="10" y="14" width="12" height="19" rx="2" fill="#17262d"/><path d="M16 29c-6 0-5-5-2-8 0 3 3 2 2-3 7 5 6 11 0 11Z" fill="#e4bd7d" stroke="none"/></svg></div><div><p class="lk-eyebrow">${esc(eyebrow)}</p><h2>${esc(title)}</h2>${subtitle?`<p class="lk-subtitle">${esc(subtitle)}</p>`:''}</div></header>`;
/** Render the structural light panel; ticking clocks subsequently update individual DOM nodes. */
export function renderPanel(model) {
  const {active,sources,gm,paused,authority,tokenName,canOperate=true} = model;
  const condition = !authority ? 'Ожидаем ГМа' : paused ? 'Мир на паузе' : 'Реальное время';
  const remaining = active?.remainingSeconds;
  const ratio = active?.config.mode === 'infinite' ? 100 : Math.max(0,Math.min(100,100*(remaining ?? 0)/(active?.config.capacitySeconds || 1)));
  const low = active && remaining !== null && remaining <= active.config.lowFuelSeconds;
  const hero = active ? `<section class="lk-burning ${low?'lk-low':''}">
    <div class="lk-burning-top"><span class="lk-kicker">${active.shutterClosed?'ШТОРКИ ЗАКРЫТЫ':'ТЕКУЩИЙ ИСТОЧНИК'}</span><span class="lk-status ${active.shutterClosed?'lk-muted':''}"><span class="lk-dot"></span>${active.shutterClosed?'Свет скрыт':'Горит'}</span></div>
    <div class="lk-burn-body"><div class="lk-source-glyph">${icon(active.icon)}</div><div class="lk-burn-copy"><h3>${esc(active.itemName)}</h3><p>${active.shutterClosed?'Топливо продолжает расходоваться':esc(modeName(active.config.mode))}</p></div></div>
    <div class="lk-clock-row"><strong data-lk-clock>${clockTime(remaining)}</strong><span>${active.config.mode==='infinite'?'без ограничений':'до полного гашения'}</span></div>
    <div class="lk-meter" role="meter" aria-label="Запас топлива" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio)}"><span data-lk-meter style="width:${ratio}%"></span></div>
    <div class="lk-actions">${active.config.shutter?button('shutter',active.shutterClosed?'Открыть шторки':'Закрыть шторки',{iconName:'lantern',disabled:!canOperate}):''}${button('off','Погасить',{iconName:'candle',css:'lk-quiet',disabled:!canOperate})}</div>
  </section>` : `<section class="lk-unlit"><div class="lk-source-glyph">${icon('lantern')}</div><h3>Свет погашен</h3><p>Выберите источник из инвентаря.<br>Огарки сохраняют оставшееся время.</p></section>`;
  const rows = sources.map(s => `<article class="lk-source-row ${s.active?'lk-selected':''}" data-lk-name="${esc(s.name.toLocaleLowerCase())}">
    <div class="lk-row-icon">${icon(s.icon)}</div><div class="lk-row-copy"><h4>${esc(s.name)}</h4><p>${s.active?`<span data-lk-current-detail>${esc(s.timeLabel ?? s.detail)}</span>${esc(s.stockLabel ?? '')}`:esc(s.detail)}</p><small>${esc(s.originLabel)}</small></div>
    <div class="lk-row-actions">${button(s.active?'off':'ignite',s.active?'Погасить':active?'Заменить':'Зажечь',{id:s.id,css:s.active?'lk-quiet':'lk-primary',disabled:!canOperate || !!s.blocked,title:s.blocked || ''})}
    ${s.refillable?button('refill','Заправить',{id:s.id,css:'lk-small lk-quiet',disabled:!canOperate || !!s.refillBlocked,title:s.refillBlocked || s.refillHint,
      data:s.active && canOperate?{'lk-current-refill':'','has-fuel':!s.fuelMissing,'refill-hint':s.refillHint}: {}}):''}
    ${gm?button('configure','Настроить',{id:s.id,css:'lk-small lk-link'}):''}</div></article>`).join('');
  return `<div class="lk-panel">
    ${masthead('LIGHTKEEPER',tokenName || 'Выберите персонажа','Свет. Топливо. Время.')}
    <div class="lk-session"><span class="lk-dot ${paused || !authority?'lk-paused':''}"></span>${esc(condition)}<span class="lk-session-note">${paused?'Расход остановлен':!authority?'Расход остановлен':'Пауза мира замораживает расход'}</span></div>
    ${!canOperate?'<p class="lk-notice">Этот персонаж недоступен для управления. Выберите свой токен.</p>':''}
    ${hero}
    <div class="lk-section-heading"><h3>При себе <span>${sources.length}</span></h3>${gm?button('library','Шаблоны',{css:'lk-small lk-link',iconName:'magic'}):''}</div>
    <label class="lk-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-lk-search placeholder="Найти источник…" aria-label="Найти источник" value="${esc(model.search ?? '')}"></label>
    <div class="lk-sources">${rows || '<div class="lk-empty">Источников пока нет.<br>Добавьте свечу или лампу в инвентарь — настроенные названия распознаются автоматически.</div>'}<p class="lk-empty" data-lk-no-results hidden>Совпадений нет.</p></div>
    ${gm && active && active.config.mode!=='infinite'?`<div class="lk-gm-tools"><span>ГМ · время</span>${button('adjust','−5 мин',{id:'-300',css:'lk-small lk-quiet'})}${button('adjust','+5 мин',{id:'300',css:'lk-small lk-quiet'})}<small>Корректировка без расхода заправки</small></div>`:''}
    <footer class="lk-footer"><span>Shift + клик по лампочке — быстрый свет</span><span>LK / 02</span></footer>
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
  return `<fieldset class="lk-fieldset"><legend>01 / Горение</legend><div class="lk-grid">
    ${select('mode','Тип источника',c.mode,[['disposable','Свеча / факел'],['tank','Бак / заряд'],['infinite','Без расхода']])}
    ${field('capacityMinutes','Полный запас, мин',c.capacitySeconds/60,{type:'number',min:1/60,max:10080,step:'any'})}
    ${item?field('remainingMinutes','Осталось, мин',c.remainingSeconds/60,{type:'number',min:0,max:10080,step:'any'}):''}
    ${field('lowFuelMinutes','Предупредить за, мин',c.lowFuelSeconds/60,{type:'number',min:0,max:10080,step:'any',hint:'0 — без предупреждения'})}
    </div>${check('shutter','Есть шторки / заслонка',c.shutter,'Скрывает свет, но сохраняет расход топлива.')}</fieldset>
    <fieldset class="lk-fieldset"><legend>02 / Свет</legend><div class="lk-grid">
    ${field('bright','Яркий радиус',c.bright,{type:'number',min:0,max:200,step:'any'})}${field('dim','Тусклый радиус',c.dim,{type:'number',min:0,max:200,step:'any'})}
    ${field('angle','Угол луча, °',c.angle,{type:'number',min:1,max:360,step:'any'})}${field('color','Цвет света',c.color,{type:'color'})}
    ${field('alpha','Непрозрачность',c.alpha,{type:'number',min:0,max:1,step:'0.05'})}
    ${select('animation','Анимация',c.animation,[['none','Без анимации'],['torch','Факел'],['flame','Пламя'],['pulse','Пульсация'],['chroma','Смена цвета']])}
    ${field('animationSpeed','Скорость анимации',c.animationSpeed,{type:'number',min:1,max:10,step:'1'})}${field('animationIntensity','Сила анимации',c.animationIntensity,{type:'number',min:1,max:10,step:'1'})}
    </div><p class="lk-hint">Радиусы — в единицах сцены. Угол меньше 360° создаёт направленный луч.</p></fieldset>
    <fieldset class="lk-fieldset"><legend>03 / Розжиг и заправка</legend><div class="lk-grid">
    ${select('ignitionMode','Включение',c.ignitionMode,[['self','Без розжига'],['require','Нужен предмет розжига'],['consume','Потратить 1 предмет розжига']])}
    ${select('ignitionResource','Распознавать розжиг как',c.ignitionResource,choices(c.ignitionResource))}
    ${field('ignitionItem','Или точное название розжига',c.ignitionItem,{hint:'Используется, когда выбран поиск по названию'})}
    ${select('refillResource','Распознавать топливо как',c.refillResource,choices(c.refillResource))}
    ${field('refillItem','Или точное название топлива',c.refillItem)}
    ${field('refillMinutes','Одна заправка, мин',c.refillSeconds/60,{type:'number',min:1/60,max:10080,step:'any'})}
    </div></fieldset>`;
}
/** Convert minutes to seconds; blank numeric fields retain existing values, explicit zero remains valid. */
export function readConfig(form,base,{item=false} = {}) {
  const value = name => form.elements.namedItem(name)?.value;
  const checked = name => !!form.elements.namedItem(name)?.checked;
  const raw = {...base};
  const numeric=new Set(['bright','dim','angle','alpha','animationSpeed','animationIntensity']);
  for (const name of ['mode','bright','dim','angle','color','alpha','animation','animationSpeed','animationIntensity','ignitionMode','ignitionResource','refillResource','ignitionItem','refillItem']) {
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
  raw.shutter = checked('shutter');
  if (item) raw.enabled = checked('enabled');
  return normalizeConfig(raw);
}
/** Render an individual source editor with pinned save actions. */
export function renderItemEditor(item,c,catalog,origin) {
  return `<div class="lk-editor">${masthead('НАСТРОЙКА ПРЕДМЕТА',item.name,'Настройки сохраняются вместе с предметом.')}
    <div class="lk-item-scroll"><div class="lk-preset-picker">${select('templateChoice','Заполнить из шаблона',c.templateId,[['','Свои настройки'],...catalog.sources.map(s=>[s.id,s.label])])}${button('load-preset','Применить',{css:'lk-primary'})}</div>
    ${origin==='recognized'?'<p class="lk-notice">Предмет распознан по библиотеке. Сохранение закрепит его собственные настройки.</p>':''}
    ${check('enabled','Использовать как источник света',c.enabled)}${configFields(c,catalog,{item:true})}
    <p class="lk-hint">Новые параметры применяются при следующем зажигании. Для работающего источника используйте панель света.</p></div>
    <div class="lk-actions lk-editor-footer">${button('save','Сохранить предмет',{css:'lk-primary'})}${button('save-template','Как новый шаблон',{iconName:'magic',css:'lk-quiet'})}</div></div>`;
}
/** Render a draft library; an empty section is valid and remains importable. */
export function renderLibrary(catalog,kind,selectedId,{dirty=false,importInfo=''} = {}) {
  const entries = catalog[kind];
  const entry = entries.find(e=>e.id===selectedId);
  const editor = entry ? `<form class="lk-template-form" autocomplete="off"><div class="lk-editor-heading"><div class="lk-row-icon">${icon(entry.icon)}</div><h3>${esc(entry.label)}</h3>${button('delete','Удалить',{css:'lk-small lk-danger'})}</div>
    <div class="lk-grid">${field('label','Название шаблона',entry.label)}${select('icon','Значок',entry.icon,Object.keys(ICONS).map(k=>[k,{candle:'Пламя',lamp:'Лампа',lantern:'Фонарь',flashlight:'Молния',magic:'Магия',fuel:'Масло',matches:'Розжиг',battery:'Батарея'}[k]]))}</div>
    <fieldset class="lk-fieldset"><legend>Распознавание предмета</legend>
      ${textarea('names','Названия и варианты',entry.names,'Один вариант в строке. Регистр, «ё» и лишние пробелы не важны.')}
      <div class="lk-grid">${select('matchMode','Сопоставление названия',entry.matchMode,[['exact','Точное совпадение'],['contains','Название содержит вариант']])}${field('itemTypes','Типы Item через запятую',entry.itemTypes.join(', '),{hint:'Пусто — все типы; например gear, weapon'})}</div>
      <details class="lk-details"><summary>Устойчивые ссылки на предметы</summary>${textarea('uuids','UUID / исходный UUID из компендиума',entry.uuids,'Такие совпадения работают и после переименования.')}</details>
    </fieldset>
    ${kind==='sources'?configFields(entry.config,catalog):'<p class="lk-notice">Это правило распознаёт запас в инвентаре. Источник выбирает его в настройках розжига или заправки; одно действие расходует одну штуку.</p>'}
    </form>` : '<div class="lk-empty">Создайте шаблон или добавьте стандартные.</div>';
  return `<div class="lk-library">${masthead('МАСТЕРСКАЯ LIGHTKEEPER','Библиотека света','Шаблоны источников и знакомые предметы вашего мира.')}
    <div class="lk-library-toolbar"><nav class="lk-tabs" aria-label="Раздел библиотеки">${button('kind','Источники',{id:'sources',css:kind==='sources'?'lk-tab-active':''})}${button('kind','Розжиг и топливо',{id:'resources',css:kind==='resources'?'lk-tab-active':''})}</nav>${button('new','Новый',{css:'lk-primary'})}</div>
    <div class="lk-library-body"><aside class="lk-library-list">${entries.map(e=>`<button type="button" data-action="select" data-id="${esc(e.id)}" class="lk-template-choice ${e.id===selectedId?'lk-selected':''}">${icon(e.icon)}<span>${esc(e.label)}<small>${e.names.length} названий${e.uuids.length?` · ${e.uuids.length} ссылок`:''}</small></span></button>`).join('')}<p class="lk-hint">При нескольких совпадениях выбирается первый шаблон.</p>${entry?`<div class="lk-actions">${button('up','Выше',{css:'lk-small lk-quiet'})}${button('down','Ниже',{css:'lk-small lk-quiet'})}</div>`:''}</aside><section class="lk-library-editor">${editor}</section></div>
    <footer class="lk-library-footer"><div class="lk-actions">${button('save','Сохранить библиотеку',{css:'lk-primary'})}<span class="lk-save-state">${dirty?'Есть несохранённые изменения':'Настройки мира'}</span></div><div class="lk-actions">${button('defaults','Стандартные',{css:'lk-small lk-quiet'})}${button('export','Экспорт',{css:'lk-small lk-quiet'})}${button('import','Импорт',{css:'lk-small lk-quiet'})}<input type="file" data-lk-import accept="application/json,.json" hidden></div>${importInfo?`<p class="lk-hint">${esc(importInfo)}</p>`:''}</footer></div>`;
}
