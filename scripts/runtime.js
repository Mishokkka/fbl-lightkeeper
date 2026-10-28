import {MODULE_ID} from './logic.js';

/** Scene-qualified keys also work for test doubles and unlinked tokens. */
export const tokenKey = token => `${token.parent?.id ?? ''}:${token.id}`;

/** Event-maintained active set: inactive actors are never resolved by the heartbeat. */
export class ActiveSourceIndex {
  constructor(actorKey) { this.actorKey=actorKey; this.tokens=new Map(); this.entries=new Map(); this.tanks=new Map(); this.finiteCount=0; }

  /** Read only flags first; resolve actor identity only for an active source. */
  sync(token) {
    const state=token.getFlag(MODULE_ID,'active');
    if (!state) { this.remove(token); return; }
    const key=tokenKey(token), finite=state.config.mode!=='infinite';
    const tank=state.config.mode==='tank'?JSON.stringify([this.actorKey(token),state.itemId]):null;
    const old=this.entries.get(key);
    if(old && old.finite===finite && old.tank===tank && this.tokens.get(key)===token) return;
    this.remove(token);
    this.tokens.set(key,token); this.entries.set(key,{finite,tank});
    if(finite) this.finiteCount++;
    if(tank) { if(!this.tanks.has(tank)) this.tanks.set(tank,new Set()); this.tanks.get(tank).add(token); }
  }

  /** Remove the old index entry even if the document's actor or runtime already changed. */
  remove(token) {
    const key=tokenKey(token), old=this.entries.get(key);
    if(!old) return;
    if(old.finite) this.finiteCount--;
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
  clear() { this.tokens.clear(); this.entries.clear(); this.tanks.clear(); this.finiteCount=0; }
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
  const related=prefix=>paths.some(path=>path===prefix || path.startsWith(prefix+'.'));
  if(event.type==='scene') return token.parent?.id===doc.id?'render':'none';
  if(event.type==='deletedToken') return tokenKey(token)===tokenKey(doc) || (!!token.actor?.uuid && token.actor.uuid===doc.actor?.uuid)?'render':'none';
  if(event.type==='token') {
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
