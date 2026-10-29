import {MODULE_ID,canPassFire} from './logic.js';

/** Scene-qualified keys also work for test doubles and unlinked tokens. */
export const tokenKey = token => `${token.parent?.id ?? ''}:${token.id}`;
/** Multilevel's stoken marks a visual projection, never an independent inventory or flame. */
export const isMultilevelProjection = token => Object.hasOwn(token?.flags?.['multilevel-tokens']??{},'stoken');

/** Event-maintained active set: inactive actors are never resolved by the heartbeat. */
export class ActiveSourceIndex {
  constructor(actorKey) { this.actorKey=actorKey; this.tokens=new Map(); this.entries=new Map(); this.tanks=new Map(); this.igniters=new Set();this.finiteCount=0; }

  /** Read only flags first; resolve actor identity only for an active source. */
  sync(token) {
    const state=token.getFlag(MODULE_ID,'active');
    if (!state || isMultilevelProjection(token) || token.flags?.[MODULE_ID]?.transfer) { this.remove(token); return; }
    const key=tokenKey(token), finite=state.config.mode!=='infinite',flame=canPassFire(state.config);
    const tank=state.config.mode==='tank'?JSON.stringify([this.actorKey(token),state.itemId]):null;
    const old=this.entries.get(key);
    if(old && old.finite===finite && old.tank===tank && old.flame===flame && this.tokens.get(key)===token) return;
    this.remove(token);
    this.tokens.set(key,token); this.entries.set(key,{finite,tank,flame});
    if(flame)this.igniters.add(token);
    if(finite) this.finiteCount++;
    if(tank) { if(!this.tanks.has(tank)) this.tanks.set(tank,new Set()); this.tanks.get(tank).add(token); }
  }

  /** Remove the old index entry even if the document's actor or runtime already changed. */
  remove(token) {
    const key=tokenKey(token), old=this.entries.get(key);
    if(!old) return;
    if(old.finite) this.finiteCount--;
    this.igniters.delete(this.tokens.get(key));
    if(old.tank) {
      const group=this.tanks.get(old.tank); group.delete(this.tokens.get(key));
      if(!group.size) this.tanks.delete(old.tank);
    }
    this.tokens.delete(key); this.entries.delete(key);
  }

  /** One full flag-only bootstrap per client; later changes arrive through document hooks. */
  rebuild(scenes) {
    this.clear();
    for(const scene of scenes) for(const token of scene.tokens.contents) this.sync(token);
  }

  /** Scene deletion visits only the small active set, not all world tokens. */
  removeScene(scene) { for(const token of this.tokens.values()) if(token.parent?.id===scene.id) this.remove(token); }
  /** Find an active holder in constant time without visiting unrelated scene tokens. */
  findTank(token,itemId) { return this.tanks.get(JSON.stringify([this.actorKey(token),itemId]))?.values().next().value ?? null; }
  values() { return this.tokens.values(); }
  has(token) { return this.tokens.has(tokenKey(token)); }
  clear() { this.tokens.clear(); this.entries.clear(); this.tanks.clear();this.igniters.clear(); this.finiteCount=0; }
}

/** Flatten only changed paths. Handles native Foundry diffs and dotted test updates. */
export function changedPaths(changes,prefix='') {
  const paths=[];
  for(const [key,value] of Object.entries(changes ?? {})) {
    const path=prefix?`${prefix}.${key}`:key;
    if(value && typeof value==='object' && !Array.isArray(value)) paths.push(...changedPaths(value,path));
    else paths.push(path);
  }
  return paths;
}

/** Match document fields, including Foundry's -= deletion syntax and whole-parent replacement. */
export function touchesPath(paths,prefix) {
  return paths.some(raw=>{
    const path=raw.replace(/(^|\.)-=/g,'$1');
    return path===prefix || path.startsWith(prefix+'.') || prefix.startsWith(path+'.');
  });
}

/** A true checkpoint cannot hide a structural change merely by passing a custom option. */
export function isClockUpdate(changes) {
  const paths=changedPaths(changes).filter(path=>path!=='_id' && !path.startsWith('_stats.'));
  return paths.length>0 && paths.every(path=>[
    `flags.${MODULE_ID}.active.remainingSeconds`,`flags.${MODULE_ID}.active.lastAt`,
    `flags.${MODULE_ID}.active.lowFuelWarned`,`flags.${MODULE_ID}.light.remainingSeconds`
  ].includes(path));
}

/** Decide without resolving unrelated actors: movement is the common fast exit. */
export function panelUpdateKind(event,token) {
  if(!event) return 'render';
  if(!token) return 'none';
  const doc=event.document, paths=changedPaths(event.changes);
  const related=prefix=>touchesPath(paths,prefix);
  if(event.type==='scene') return token.parent?.id===doc.id?'render':'none';
  if(event.type==='wall') return token.parent?.id===doc.parent?.id?'render':'none';
  if(event.ignitionRelevant && token.parent?.id===doc.parent?.id && !isClockUpdate(event.changes)) return 'render';
  if(event.type==='deletedToken') return tokenKey(token)===tokenKey(doc) || (!!token.actor?.uuid && token.actor.uuid===doc.actor?.uuid)?'render':'none';
  if(event.type==='token') {
    if(event.hasIgniters && tokenKey(token)===tokenKey(doc) && ['x','y','width','height','elevation'].some(related)) return 'render';
    if(!['name','hidden','actorId','actorLink','delta','light',`flags.${MODULE_ID}`].some(related)) return 'none';
    if(tokenKey(token)===tokenKey(doc)) return isClockUpdate(event.changes)?'clock':'render';
    return related(`flags.${MODULE_ID}.active`) && token.actor?.uuid===doc.actor?.uuid?'render':'none';
  }
  if(event.type==='item' && token.actor?.uuid===doc.parent?.uuid) {
    return isClockUpdate(event.changes) && token.getFlag(MODULE_ID,'active')?.itemId===doc.id?'clock':'render';
  }
  if(event.type==='actor' && token.actor?.uuid===doc.uuid && ['items','ownership','name','type'].some(related)) return 'render';
  return 'none';
}
