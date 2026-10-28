/** Pure, browser-independent rules for the Lightkeeper module. */
export const MODULE_ID = 'fbl-lightkeeper';
export const MODES = Object.freeze(['infinite', 'tank', 'disposable']);
export const IGNITION = Object.freeze(['self', 'require', 'consume']);
/** Coerce a finite numeric value and clamp it to a supported range. */
const limit = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
/** Normalize stored source settings; durations are seconds and remaining fuel keeps fractions. */
export function normalizeConfig(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.includes(raw.mode) ? raw.mode : 'tank';
  const ignitionMode = IGNITION.includes(raw.ignitionMode) ? raw.ignitionMode : 'self';
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
    ignitionMode,
    ignitionItem: String(raw.ignitionItem ?? '').trim().slice(0, 120),
    ignitionResource: String(raw.ignitionResource ?? '').trim().slice(0,64),
    refillResource: String(raw.refillResource ?? '').trim().slice(0,64),
    templateId: String(raw.templateId ?? '').trim().slice(0,64),
    shutter: !!raw.shutter,
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
