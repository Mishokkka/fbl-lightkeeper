/** Pure, browser-independent rules for the Lightkeeper module. */
export const MODULE_ID = 'fbl-lightkeeper';
export const MODES = Object.freeze(['infinite', 'tank', 'disposable']);
export const IGNITER_MODES = Object.freeze(['none','reusable','quantity','bonus']);
/** An igniter owns its consumption policy, independently of the object it lights. */
export function normalizeIgniter(raw={}) {
  return {mode:IGNITER_MODES.includes(raw?.mode)?raw.mode:'none'};
}
/** Used only to translate the pre-0.4 source-owned policy during migration. */
export function legacyIgniterMode(raw) {
  return raw?.ignitionMode==='require'?'reusable':raw?.ignitionMode==='consume'?(raw.ignitionCost==='bonus'?'bonus':'quantity'):null;
}
export const canPassFire = raw => typeof raw?.canIgnite==='boolean'?raw.canIgnite:!!legacyIgniterMode(raw);
/** Use defaults for missing numbers; retain explicit zero and clamp finite numeric values. */
const limit = (value, min, max, fallback) => {
  if(value===null || value===undefined || (typeof value==='string' && value.trim()==='')) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
/** Normalize stored source settings; durations are seconds and remaining fuel keeps fractions. */
export function normalizeConfig(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.includes(raw.mode) ? raw.mode : 'tank';
  const capacitySeconds = Math.round(limit(raw.capacitySeconds, 1, 604800, 1800));
  const remaining = raw.remainingSeconds === null || raw.remainingSeconds === undefined
    ? capacitySeconds : limit(raw.remainingSeconds, 0, 604800, capacitySeconds);
  return {
    enabled: !!raw.enabled,
    mode,
    capacitySeconds,
    remainingSeconds: Math.min(remaining, capacitySeconds),
    refillItem: String(raw.refillItem ?? '').trim().slice(0, 120),
    refillSeconds: Math.round(limit(raw.refillSeconds, 1, 604800, 900)),
    requiresIgnition: typeof raw.requiresIgnition==='boolean'?raw.requiresIgnition:!!legacyIgniterMode(raw),
    canIgnite: canPassFire(raw),
    refillResource: String(raw.refillResource ?? '').trim().slice(0,64),
    templateId: String(raw.templateId ?? '').trim().slice(0,64),
    shutter: !!raw.shutter,
    soundOn:String(raw.soundOn??'').trim().slice(0,1024),
    soundOff:String(raw.soundOff??'').trim().slice(0,1024),
    soundVolume:limit(raw.soundVolume,0,1,0.5),
    soundFadeSeconds:limit(raw.soundFadeSeconds,0,30,0),
    lowFuelSeconds: Math.round(limit(raw.lowFuelSeconds,0,604800,60)),
    bright: limit(raw.bright, 0, 200, 3),
    dim: limit(raw.dim, 0, 200, 6),
    angle: limit(raw.angle, 1, 360, 360),
    color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color)) ? String(raw.color) : '#ffba70',
    alpha: limit(raw.alpha, 0, 1, 0.45),
    animation: raw.animation === 'flickering' ? 'flame' :
      (['none', 'torch', 'pulse', 'chroma', 'flame'].includes(raw.animation) ? raw.animation : 'torch'),
    animationSpeed: Math.round(limit(raw.animationSpeed, 1, 10, 3)),
    animationIntensity: Math.round(limit(raw.animationIntensity, 1, 10, 3))
  };
}
/** Build v13 emission fields without inheriting darkness mode from the original token. */
export function lightData(config) {
  const c = normalizeConfig(config);
  return {
    negative: false, luminosity: 0.5, darkness: {min:0,max:1},
    bright: c.bright, dim: Math.max(c.bright, c.dim),
    angle: c.angle, color: c.color, alpha: c.alpha,
    animation: { type: c.animation === 'none' ? null : c.animation, speed: c.animationSpeed, intensity: c.animationIntensity }
  };
}
/** Subtract only forward unpaused wall time and never allow negative fuel. */
export function tickRemaining(remainingSeconds, lastAt, now, paused) {
  const current = Math.max(0, Number(remainingSeconds) || 0);
  if (paused || !Number.isFinite(lastAt) || lastAt <= 0 || now <= lastAt) return current;
  const delta = (now - lastAt) / 1000;
  return Math.max(0, current - delta);
}
/** Format remaining seconds for UI text; non-finite values represent unlimited light. */
export function displayTime(seconds) {
  if (!Number.isFinite(seconds)) return '∞';
  const s = Math.ceil(Math.max(0, seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} ч ${String(m % 60).padStart(2, '0')} м` : `${m} м ${String(s % 60).padStart(2, '0')} с`;
}
/** Read supported numerical stock, treating missing or invalid quantities as empty. */
export function getQuantity(item) {
  const n = Number(item?.system?.quantity);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
/** Bonus is the visible current charge counter in Forbidden Lands; max is never changed by spending. */
export function getResourceStock(item,unit='quantity') {
  if(unit!=='bonus') return getQuantity(item);
  const value=Number(item?.system?.bonus?.value);
  return Number.isFinite(value) && value>=0?value:0;
}
/** The same live stock is shown in the picker/editor and checked before consumption. */
export function igniterStatus(item,mode) {
  const quantity=getQuantity(item),charges=getResourceStock(item,'bonus');
  const rawMax=item?.system?.bonus?.max,max=Number(rawMax);
  const maximum=rawMax!==null && rawMax!==undefined && rawMax!=='' && Number.isFinite(max) && max>=0?max:null;
  const stock=mode==='bonus'?`Bonus ${charges}${maximum===null?'':' / '+maximum}`:`Запас ×${quantity}`;
  const reason=mode==='none'?'Предмет не используется для розжига':quantity<1?`Нет целого предмета «${item.name}»`:
    mode==='bonus' && charges<1?`Нет зарядов Bonus: «${item.name}»`:'';
  return {stock,reason,available:!reason};
}
/** Refilling spends a whole unit; expose both the actual gain and the discarded excess. */
export function refillAmount(config,remaining) {
  const gain=Math.max(0,Math.min(config.refillSeconds,config.capacitySeconds-remaining));
  return {gain,waste:Math.max(0,config.refillSeconds-gain)};
}
export function refillHint(config,remaining,fuelName) {
  const {gain,waste}=refillAmount(config,remaining);
  return `1 шт. ${fuelName} → +${displayTime(gain)}${waste>0.001?`; избыток ${displayTime(waste)} потеряется`:''}`;
}
/** Legacy exact-name lookup requiring at least one whole resource unit. */
export function findNamedItem(actor, name, exceptId = '') {
  if (!name?.trim()) return null;
  return actor.items.find(i => i.id !== exceptId &&
    String(i.name ?? '').trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase() && getQuantity(i) >= 1) ?? null;
}
/** Create a serializable runtime snapshot with a stable previous-light backup. */
export function makeRuntime(item, config, previousLight, now, remainder = null) {
  const c = normalizeConfig(config);
  return {
    itemId: item.id, itemName: item.name, actorId: item.parent?.id ?? '',
    config: c,
    previousLight,
    remainingSeconds: c.mode === 'infinite' ? null : (remainder ?? c.remainingSeconds),
    lastAt: now
  };
}
