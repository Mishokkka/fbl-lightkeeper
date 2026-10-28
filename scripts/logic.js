/** Pure, browser-independent rules for the Lightkeeper module. */
export const MODULE_ID = 'fbl-lightkeeper';
export const MODES = Object.freeze(['infinite', 'tank', 'disposable']);
export const IGNITION = Object.freeze(['self', 'require', 'consume']);
const limit = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
export function normalizeConfig(raw = {}) {
  const mode = MODES.includes(raw.mode) ? raw.mode : 'tank';
  const ignitionMode = IGNITION.includes(raw.ignitionMode) ? raw.ignitionMode : 'self';
  const capacitySeconds = Math.round(limit(raw.capacitySeconds, 1, 604800, 1800));
  const remaining = raw.remainingSeconds === null || raw.remainingSeconds === undefined
    ? capacitySeconds : Math.round(limit(raw.remainingSeconds, 0, 604800, capacitySeconds));
  return {
    enabled: !!raw.enabled,
    mode,
    capacitySeconds,
    remainingSeconds: Math.min(remaining, capacitySeconds),
    refillItem: String(raw.refillItem ?? '').trim().slice(0, 120),
    refillSeconds: Math.round(limit(raw.refillSeconds, 1, 604800, 900)),
    ignitionMode,
    ignitionItem: String(raw.ignitionItem ?? '').trim().slice(0, 120),
    bright: limit(raw.bright, 0, 200, 3),
    dim: limit(raw.dim, 0, 200, 6),
    angle: limit(raw.angle, 1, 360, 360),
    color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color)) ? String(raw.color) : '#ffba70',
    alpha: limit(raw.alpha, 0, 1, 0.45),
    animation: ['none', 'torch', 'pulse', 'chroma', 'flickering'].includes(raw.animation) ? raw.animation : 'torch',
    animationSpeed: limit(raw.animationSpeed, 1, 10, 3),
    animationIntensity: limit(raw.animationIntensity, 1, 10, 3)
  };
}
export function lightData(config) {
  const c = normalizeConfig(config);
  return {
    bright: Math.min(c.bright, c.dim), dim: Math.max(c.bright, c.dim),
    angle: c.angle, color: c.color, alpha: c.alpha,
    animation: { type: c.animation, speed: c.animationSpeed, intensity: c.animationIntensity }
  };
}
export function tickRemaining(remainingSeconds, lastAt, now, paused) {
  const current = Math.max(0, Number(remainingSeconds) || 0);
  if (paused || !Number.isFinite(lastAt) || lastAt <= 0 || now <= lastAt) return current;
  const delta = (now - lastAt) / 1000;
  return Math.max(0, current - delta);
}
export function displayTime(seconds) {
  if (!Number.isFinite(seconds)) return '∞';
  const s = Math.ceil(Math.max(0, seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} ч ${String(m % 60).padStart(2, '0')} м` : `${m} м ${String(s % 60).padStart(2, '0')} с`;
}
export function getQuantity(item) {
  const n = Number(item?.system?.quantity);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
export function findNamedItem(actor, name, exceptId = '') {
  if (!name?.trim()) return null;
  return actor.items.find(i => i.id !== exceptId &&
    i.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase() && getQuantity(i) > 0) ?? null;
}
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
