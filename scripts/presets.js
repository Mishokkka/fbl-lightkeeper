import {normalizeConfig} from './logic.js';

export const ICONS = Object.freeze({candle:'fa-fire-flame-simple',lamp:'fa-fire-burner',
  lantern:'fa-lightbulb',flashlight:'fa-bolt',magic:'fa-wand-sparkles',fuel:'fa-droplet',
  matches:'fa-fire',battery:'fa-battery-half'});
const text = (value, max = 120) => String(value ?? '').trim().slice(0,max);
export const nameKey = value => text(value,300).normalize('NFKC').toLocaleLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ');
export function lines(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
  return [...new Set(list.map(v => text(v,300)).filter(Boolean))].slice(0,100);
}
function rules(raw) {
  return {names:lines(raw.names),uuids:lines(raw.uuids),itemTypes:lines(raw.itemTypes),
    matchMode:raw.matchMode === 'contains' ? 'contains' : 'exact'};
}
export function normalizeCatalog(raw = {}) {
  const unique = (values,source) => {
    const seen = new Set();
    const entries=Array.isArray(values)?values:[];
    if(entries.length>100) throw new Error('В одном разделе библиотеки поддерживается до 100 записей.');
    return entries.map((v,i) => {
      const id = text(v.id || `${source ? 'source' : 'resource'}-${i+1}`,64);
      if (seen.has(id)) throw new Error(`Повторяется ID шаблона: ${id}`);
      seen.add(id);
      return {id,label:text(v.label) || 'Без названия',icon:Object.hasOwn(ICONS,v.icon) ? v.icon : (source ? 'lantern' : 'fuel'),
        ...rules(v),...(source ? {config:normalizeConfig({...v.config,enabled:true,templateId:id})} : {})};
    });
  };
  return {version:1,sources:unique(raw?.sources,true),resources:unique(raw?.resources,false)};
}
export function matchesItem(item, rule) {
  if (rule.itemTypes.length && !rule.itemTypes.includes(item.type)) return false;
  const ids = [item.uuid,item._stats?.compendiumSource,item._stats?.duplicateSource,item.flags?.core?.sourceId];
  if (rule.uuids.some(id => ids.includes(id))) return true;
  const name = nameKey(item.name);
  return rule.names.some(alias => rule.matchMode === 'contains'
    ? name.includes(nameKey(alias)) : name === nameKey(alias));
}
export function identifySource(item, catalog, autoRecognize = true) {
  const own = item?.getFlag?.('fbl-lightkeeper','light');
  if (own && typeof own === 'object') {
    return {config:normalizeConfig(own),origin:'item',preset:catalog.sources.find(s => s.id === own.templateId) ?? null};
  }
  const preset = autoRecognize && catalog.sources.find(s => matchesItem(item,s));
  return preset ? {config:normalizeConfig(preset.config),origin:'recognized',preset}
    : {config:normalizeConfig(),origin:'none',preset:null};
}
export function findResource(actor, key, fallbackName, catalog, exceptId = '') {
  const resource = catalog.resources.find(r => r.id === key);
  if (key && !resource) return null;
  return actor.items.find(item => item.id !== exceptId && Number(item.system?.quantity) >= 1 &&
    (resource ? matchesItem(item,resource) : nameKey(item.name) === nameKey(fallbackName) && !!nameKey(fallbackName))) ?? null;
}

export function defaultCatalog() {
  const source = (id,label,icon,names,config) => ({id,label,icon,names,config:{enabled:true,...config}});
  return normalizeCatalog({sources:[
    source('candle','Свеча','candle',['Свеча','Candle'],{mode:'disposable',capacitySeconds:1800,bright:1,dim:3,ignitionMode:'consume',ignitionResource:'matches',lowFuelSeconds:120}),
    source('candle-stub','Огарок свечи','candle',['Огарок свечи'],{mode:'disposable',capacitySeconds:600,bright:1,dim:2,ignitionMode:'consume',ignitionResource:'matches'}),
    source('torch','Факел','candle',['Факел','Torch'],{mode:'disposable',capacitySeconds:3600,bright:4,dim:8,ignitionMode:'require',ignitionResource:'matches'}),
    source('oil-lamp','Масляная лампа','lamp',['Масляная лампа','Oil Lamp'],{mode:'tank',capacitySeconds:2400,bright:3,dim:5,refillResource:'oil',refillSeconds:1200,ignitionMode:'consume',ignitionResource:'matches'}),
    source('hooded-lantern','Фонарь со шторками','lantern',['Фонарь со шторками','Hooded Lantern'],{mode:'tank',capacitySeconds:2400,bright:4,dim:6,shutter:true,refillResource:'oil',refillSeconds:1200,ignitionMode:'consume',ignitionResource:'matches'}),
    source('flashlight','Карманный фонарик','flashlight',['Карманный фонарик','Фонарик','Flashlight'],{mode:'tank',capacitySeconds:900,bright:3,dim:6,angle:75,color:'#dbe9ff',animation:'none',refillResource:'battery',refillSeconds:900}),
    source('powerful-flashlight','Мощный фонарик','flashlight',['Мощный фонарик'],{mode:'tank',capacitySeconds:600,bright:6,dim:10,angle:50,color:'#edf3ff',animation:'none',refillResource:'battery',refillSeconds:600}),
    source('magic','Магический свет','magic',['Магический свет'],{mode:'infinite',bright:3,dim:6,color:'#9ad7d1',animation:'pulse'})
  ],resources:[
    {id:'matches',label:'Спички / розжиг',icon:'matches',names:['Спички','Спичка','Matches','Match']},
    {id:'oil',label:'Ламповое масло',icon:'fuel',names:['Ламповое масло','Масло','Lamp Oil']},
    {id:'battery',label:'Батарейки',icon:'battery',names:['Батарейка','Батарейки','Battery','Batteries']}
  ]});
}
