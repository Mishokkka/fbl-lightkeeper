import { MODULE_ID as NS, normalizeConfig, normalizeIgniter, lightData, tickRemaining, displayTime, getQuantity, getResourceStock, igniterStatus, refillAmount, refillHint, makeRuntime } from './logic.js';
import {defaultCatalog,normalizeCatalog,PresetIndex,legacyResourceConflicts} from './presets.js';
import {createInterface} from './interface.js';
import {ActiveSourceIndex,changedPaths,isClockUpdate,touchesPath} from './runtime.js';
import {createSoundPlayer} from './audio.js';
import {IgnitionReach,ignitionDistance,legacyIgniterAssignments} from './ignition.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const warning = message => ui.notifications.warn(`[Lightkeeper] ${message}`);
const info = message => ui.notifications.info(`[Lightkeeper] ${message}`);
const errors = new Set();
const locks = new Map();
const pending = new Map();
const handledRequests = new Map();
const playSound=createSoundPlayer({create:src=>game.audio.create({src,singleton:false,preload:false,context:game.audio.interface}),onError:error=>console.error(`[${NS}] Ошибка звука`,error)});
let soundBroadcast=Promise.resolve();
let heartbeat = null;
let authorityId = null;
let authoritySince = 0;
let pauseHistory = [];
let windows = null;
let presetIndex = null;
let ready = false;
let ticking = false;
let ignitionMigration=null;
const activeSources=new ActiveSourceIndex(actorKey);
const ignitionReach=new IgnitionReach();
/** Settings hooks invalidate the compiled library on every client. UI/API callers get a copy. */
const presets = () => presetIndex ??= new PresetIndex(game.settings.get(NS,'catalog') ?? defaultCatalog());
const catalog = () => clone(presets().catalog);
const identify = item => presets().identify(item,game.settings.get(NS,'autoRecognize') !== false);
const resourceFor = (actor,key,name,exceptId='',unit='quantity') => presets().findResource(actor,key,name,exceptId,unit);
const identifyIgniter = item => presets().igniter(item);

/** Choose the same connected GM on every client, independent of user-list order. */
function leadGM() {
  return game.users.filter(u => u.isGM && u.active).sort((a,b) => a.id.localeCompare(b.id))[0] ?? null;
}
/** Record a new authority epoch; elapsed time before this client took over is excluded. */
function isAuthority() {
  const next = leadGM()?.id ?? null;
  if (next !== authorityId) {
    authorityId = next;
    authoritySince = Date.now();
  }
  return next === game.user.id;
}
function getConfig(item) { return item ? identify(item).config : normalizeConfig(); }
// getFlag returns live document data. Never mutate it before update succeeds.
function activeState(token) { return clone(token.getFlag(NS, 'active') ?? null); }
/** Fence async writes to the exact document revision read before the first await. */
function sourceVersion(token) {
  const state=token.getFlag(NS,'active');
  const keys=['activationId','itemId','actorKey','lastAt','remainingSeconds'];
  const values=state?keys.map(key=>state[key]):null;
  return ()=>{
    const current=token.getFlag(NS,'active');
    return !!current && !!values && keys.every((key,i)=>Object.is(current[key],values[i]));
  };
}
/** Read disposable remainders without mutating flags; merge the legacy single-stub format. */
function stowedStates(token,{all=false}={}) {
  const saved = clone(token.getFlag(NS, 'stowedSources') ?? []);
  const legacy = token.getFlag(NS, 'stowed');
  if (legacy && !saved.some(s => s.itemId === legacy.itemId && s.actorKey===legacy.actorKey)) saved.push(clone(legacy));
  const inventory=!all && saved.length?actorKey(token):null;
  return saved.filter(s => s.remainingSeconds > 0 && (all || !s.actorKey || s.actorKey===inventory));
}
function availableItems(actor) { return actor?.items.filter(i => getConfig(i).enabled && getQuantity(i) > 0) ?? []; }
/** Respect ownership and the world player-control switch for ordinary game actions. */
function canOperate(user, token) { return !!(user?.active && token?.actor && (user.isGM || (game.settings.get(NS,'allowPlayers') && token.actor.testUserPermission(user, 'OWNER')))); }
function resolveToken(sceneId, tokenId) { return game.scenes.get(sceneId)?.tokens.get(tokenId) ?? null; }
/** Distinguish a shared linked inventory from each synthetic unlinked inventory. */
function actorKey(token) {
  return token.actor?.uuid ?? (token.actorLink === false
    ? `Scene.${token.parent.id}.Token.${token.id}.Actor.${token.actor?.id}` : `Actor.${token.actor?.id}`);
}
function lockKey(token) { return actorKey(token); }
/** Serialize every module write to one inventory, including configuration and preset edits. */
async function withQueue(key, callback) {
  const previous = locks.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(callback);
  locks.set(key, task);
  try { return await task; } finally { if (locks.get(key) === task) locks.delete(key); }
}
function withLock(token,callback) { return withQueue(lockKey(token),callback); }
function withItemLock(item,callback) { return withQueue(item.parent?.uuid ?? item.uuid ?? `Item.${item.id}`,callback); }
function runningTank(token, itemId) {
  return activeSources.findTank(token,itemId);
}
/** Integrate pause boundaries even if document writes are still queued. */
function remainingAt(runtime, now = Date.now()) {
  const authority=isAuthority();
  // With no GM only the last committed fuel amount is authoritative.
  if(!authorityId) return runtime.remainingSeconds;
  let from = Math.max(runtime.lastAt, authority ? authoritySince : runtime.lastAt);
  let paused = pauseHistory[0]?.paused ?? game.paused;
  let remaining = runtime.remainingSeconds;
  for (const boundary of pauseHistory) {
    if (boundary.at <= from) { paused = boundary.paused; continue; }
    if (boundary.at > now) break;
    remaining = tickRemaining(remaining, from, boundary.at, paused);
    from = boundary.at;
    paused = boundary.paused;
  }
  return tickRemaining(remaining, from, now, paused);
}
/** Apply a stock delta and treat a cancelled document update as a failed action. */
async function updateQuantity(item, change) {
  const current = getQuantity(item);
  if (current + change < 0) throw new Error(`Недостаточно предметов: «${item.name}».`);
  if (!await item.update({'system.quantity': current + change})) throw new Error(`Изменение количества «${item.name}» отменено.`);
}
/** Spend/refund the selected stock field; a charge never removes the tool or changes Bonus.max. */
async function updateResource(item,change,unit='quantity') {
  if(unit!=='bonus') return updateQuantity(item,change);
  const current=getResourceStock(item,'bonus');
  if(change<0 && (getQuantity(item)<1 || current+change<0)) throw new Error(`Нет зарядов Bonus: «${item.name}».`);
  if(!await item.update({'system.bonus.value':current+change})) throw new Error(`Изменение Bonus «${item.name}» отменено.`);
}
/** FBL hides quantity on gear rows: remove empty whole-item stacks only after the action commits. */
async function discardEmpty(resources) {
  for(const {item,unit} of resources) {
    if(unit==='bonus' || getQuantity(item)!==0 || typeof item.delete!=='function') continue;
    try { if(!await item.delete()) throw new Error('Удаление отменено.'); }
    catch(error) {console.error(`[${NS}] Не удалось удалить израсходованный предмет «${item.name}»`,error);}
  }
}
/** Snapshot all existing light fields so extinguishing restores the original token. */
function previousLight(token) {
  return token.light?.toObject?.() ?? foundry.utils.deepClone(token.toObject().light ?? {});
}
function clone(x) { return foundry.utils.deepClone(x); }
function isDisposable(runtime) { return runtime?.config?.mode === 'disposable'; }
async function saveConfig(item, config) {
  if (!await item.setFlag(NS,'light',config)) throw new Error(`Сохранение «${item.name}» отменено.`);
}
/** Persist one scalar without rebuilding Item/Actor sheets on all connected clients. */
async function saveRemaining(item,remaining) {
  if(item.getFlag(NS,'light')?.remainingSeconds===remaining) return;
  if(!await item.update({[`flags.${NS}.light.remainingSeconds`]:remaining},{render:false})) throw new Error(`Сохранение «${item.name}» отменено.`);
}
async function updateToken(token, changes, options={}) {
  if (!await token.update(changes,options)) throw new Error('Изменение света токена отменено.');
  activeSources.sync(token); updateHeartbeat();
}

/** Chat is a post-commit side effect: transport failure must never roll back fuel or light. */
async function announce(data) {
  try { await ChatMessage.create(data); }
  catch(error) { console.error(`[${NS}] Не удалось отправить уведомление о свете`,error); }
}
/** A last-cue flag reaches every connected client, including clients viewing another scene. */
function broadcastSound(config,phase) {
  const src=phase==='on'?config.soundOn:config.soundOff;
  if(!src || config.soundVolume===0 || !ready || !isAuthority())return;
  const cue={id:foundry.utils.randomID(),src,volume:config.soundVolume??0.5,fadeSeconds:config.soundFadeSeconds??0};
  // A replacement emits off + on: finish the first User update before computing the second diff.
  soundBroadcast=soundBroadcast.then(async()=>{
    if(!ready || !isAuthority())return;
    try {await game.user.setFlag(NS,'sound',cue);}
    catch(error){console.error(`[${NS}] Ошибка рассылки звука`,error);}
  });
  return soundBroadcast;
}

/** Persist fuel and restore light in one token transition; retain unexpired disposable stubs. */
async function turnOff(token, runtime, {expired = false, discard = false,valid=sourceVersion(token)} = {}) {
  if(!valid() || !isAuthority()) return false;
  const item = token.actor?.items.get(runtime.itemId);
  if (runtime.config.mode === 'tank' && item && runtime.actorKey === actorKey(token)) {
    await saveRemaining(item,Math.max(0,runtime.remainingSeconds ?? 0));
  }
  if(!valid() || !isAuthority()) return false;
  const stowed = stowedStates(token,{all:true}).filter(s => s.itemId !== runtime.itemId || (s.actorKey && s.actorKey!==runtime.actorKey));
  if (!expired && !discard && isDisposable(runtime) && (runtime.remainingSeconds ?? 0) > 0) {
    stowed.push({itemId:runtime.itemId, itemName:runtime.itemName, config:runtime.config,
      actorKey:runtime.actorKey, remainingSeconds:runtime.remainingSeconds});
  }
  // A single TokenDocument update keeps restoring light and clearing runtime atomic.
  await updateToken(token,{
    light: runtime.previousLight ?? {},
    [`flags.${NS}.active`]: null,
    [`flags.${NS}.stowed`]: null,
    [`flags.${NS}.stowedSources`]: stowed
  });
  void broadcastSound(runtime.config,'off');
  if (expired && game.settings.get(NS, 'expiryChat')) {
    void announce({content: `<p><strong>Источник света погас:</strong> ${escapeHtml(runtime.itemName)} (${escapeHtml(token.name)}).</p>`,
      ...(token.hidden ? {whisper:game.users.filter(u => u.isGM).map(u => u.id)} : {})});
  }
  return true;
}

/** Commit elapsed real seconds. Called exclusively by the elected GM. */
async function settle(token) {
  const valid=sourceVersion(token);
  const runtime = activeState(token);
  if (!runtime) return false;
  const item = token.actor?.items.get(runtime.itemId);
  // Migrate runtimes created before actor identity was recorded.
  const migrated=!runtime.actorKey;
  runtime.actorKey ??= actorKey(token);
  if (runtime.actorKey !== actorKey(token) || (!isDisposable(runtime) &&
      (!item || !getConfig(item).enabled || getQuantity(item) < 1))) {
    if(runtime.config.mode!=='infinite')runtime.remainingSeconds=remainingAt(runtime);
    await turnOff(token, runtime, {discard:true}); return true;
  }
  const now = Date.now();
  if (runtime.config.mode === 'infinite') {
    if(migrated) await updateToken(token,{[`flags.${NS}.active.actorKey`]:runtime.actorKey},{render:false});
    return false;
  }
  const next = remainingAt(runtime, now);
  const changed = Math.abs(next - runtime.remainingSeconds) >= 0.001;
  const clockChanged = runtime.lastAt !== now;
  runtime.remainingSeconds = Math.max(0, next);
  runtime.lastAt = now;
  const warn = next>0 && runtime.config.lowFuelSeconds>0 && next<=runtime.config.lowFuelSeconds &&
    !runtime.lowFuelWarned && game.settings.get(NS,'lowFuelNotify');
  if (warn) runtime.lowFuelWarned=true;
  if (runtime.config.mode === 'tank' && item && changed) {
    await saveRemaining(item,runtime.remainingSeconds);
  }
  // Actor reassignment can invalidate this source through a different inventory queue while Item saves.
  if(!valid() || actorKey(token)!==runtime.actorKey || !isAuthority()) return true;
  if (runtime.remainingSeconds <= 0) { await turnOff(token, runtime, {expired: true,valid}); return true; }
  if (changed || clockChanged || warn || migrated) {
    const patch={ [`flags.${NS}.active.remainingSeconds`]:runtime.remainingSeconds,[`flags.${NS}.active.lastAt`]:now };
    if(warn) patch[`flags.${NS}.active.lowFuelWarned`]=true;
    if(migrated) patch[`flags.${NS}.active.actorKey`]=runtime.actorKey;
    await updateToken(token,patch,{render:false});
  }
  if (warn) {
    const whisper=game.users.filter(user=>user.isGM || (!token.hidden && token.actor?.testUserPermission(user,'OWNER'))).map(user=>user.id);
    void announce({whisper,content:`<div class="fbl-lk-message"><strong>Свет догорает</strong><p>${escapeHtml(runtime.itemName)} · ${escapeHtml(token.name)}<br>Осталось ${displayTime(next)}.</p></div>`});
  }
  return false;
}

/** Validate stock, exclusive tank use and the chosen ignition before starting a transition. */
function activationPlan(token, itemId,choice='auto',user=game.user) {
  const actor = token.actor;
  const stowed = stowedStates(token).find(s => s.itemId === itemId);
  let item = actor.items.get(itemId);
  let config;
  let resume = false;
  if (stowed?.itemId === itemId && stowed.remainingSeconds > 0) {
    if (stowed.actorKey && stowed.actorKey !== actorKey(token)) throw new Error('Огарок принадлежит другому персонажу.');
    config = normalizeConfig(stowed.config); resume = true;
  } else {
    if (!item) throw new Error('У персонажа нет такого предмета.');
    config = getConfig(item);
    if (!config.enabled || getQuantity(item) < 1) throw new Error('Источник света недоступен.');
  }
  // Don't allow two linked tokens to drain the same actor item simultaneously.
  if (runningTank(token, itemId)) {
    throw new Error('Этот источник уже используется другим токеном того же персонажа.');
  }
  const remaining = resume ? stowed.remainingSeconds : config.remainingSeconds;
  if (config.mode !== 'infinite' && remaining <= 0) throw new Error('Топливо или заряд закончились.');
  const candidates=config.requiresIgnition?ignitionCandidates(token,user,{includeUnavailable:true}):[];
  const ignition=config.requiresIgnition?chooseIgnition(token,itemId,choice,user,candidates):null;
  if(config.requiresIgnition && !ignition) throw new Error(ignitionProblem(token,itemId,choice,user,candidates));
  return {item,config,remaining,resume,stowed,ignition};
}
function resourceLabel(id,fallback) { return (presets().resourcesById.get(id)?.label ?? fallback) || 'не задан'; }
function fuelProblem(config,fuel) {
  if(config.refillResource && !presets().resourcesById.has(config.refillResource))return 'Удалено правило топлива — настройте источник';
  if(!config.refillResource && !config.refillItem)return 'Топливо не настроено';
  return fuel?'':'Нет топлива: '+resourceLabel(config.refillResource,config.refillItem);
}
const igniterModeLabel = mode => ({reusable:'не расходуется',quantity:'−1 шт.',bonus:'−1 Bonus'}[mode]??'Не используется');
/** Only a still-burning, exposed, inventory-valid source can pass its fire to another token. */
function flameProblem(target,donor,user) {
  if(!donor || resolveToken(donor.parent?.id,donor.id)!==donor || target.parent?.id!==donor.parent?.id || (donor.hidden && !user.isGM)) return 'Выбранный огонь недоступен';
  const state=donor.getFlag(NS,'active');
  if(!state || (state.config.mode!=='infinite' && !(remainingAt(state)>0))) return 'Выбранный огонь погас';
  if(!normalizeConfig(state.config).canIgnite) return 'Этот источник не может передавать огонь';
  if(state.shutterClosed) return 'У выбранного источника закрыты шторки';
  if(!donor.actor || (state.actorKey && state.actorKey!==actorKey(donor))) return 'Владелец выбранного огня изменился';
  // Players can read a neighbour's active Token flags without needing access to their inventory.
  if(isAuthority() && !isDisposable(state)) {
    const item=donor.actor.items.get(state.itemId);
    if(!item || !getConfig(item).enabled || getQuantity(item)<1)return 'Выбранный источник недоступен';
  }
  const setting=game.settings.get(NS,'ignitionRadius');
  const radius=Number.isFinite(setting)?Math.max(0,Math.min(20,setting)):1;
  if(ignitionDistance(target,donor)>radius+1e-8)return 'Выбранный огонь вне радиуса розжига';
  return ignitionReach.within(target,donor,radius,{walls:game.settings.get(NS,'ignitionWalls')!==false})?'':'Передаче огня мешает стена или закрытая дверь';
}
const usableFlame = (target,donor,user) => !flameProblem(target,donor,user);
/** Scan only the inventory and the active index on demand; no world scan or new polling timer. */
function ignitionCandidates(token,user=game.user,{includeUnavailable=false}={}) {
  if(!token?.actor) return [];
  const candidates=[];
  for(const donor of activeSources.igniters) if(usableFlame(token,donor,user)) {
    const state=donor.getFlag(NS,'active');
    candidates.push({id:`flame:${donor.id}`,kind:'flame',donor,activation:state.activationId??`legacy:${state.itemId}`,
      label:`${state.itemName} · ${donor===token?'свой огонь':donor.name}`,available:true,rank:donor===token?0:1});
  }
  for(const item of token.actor.items) {
    const {config}=identifyIgniter(item),mode=config.mode;
    if(mode==='none')continue;
    const status=igniterStatus(item,mode);
    if(!includeUnavailable && !status.available)continue;
    const detail=mode==='bonus'?`${status.stock} (−1)`:mode==='quantity'?`${status.stock} (−1 шт.)`:igniterModeLabel(mode);
    candidates.push({id:`item:${item.id}`,kind:'item',item,mode,...status,label:`${item.name} · ${detail}`,rank:mode==='reusable'?2:mode==='bonus'?3:4});
  }
  return candidates.sort((a,b)=>Number(b.available)-Number(a.available) || a.rank-b.rank || a.id.localeCompare(b.id));
}
function chooseIgnition(token,itemId,choice='auto',user=game.user,candidates=ignitionCandidates(token,user)) {
  const usable=candidates.filter(c=>c.available && (c.kind!=='item' || c.item.id!==itemId));
  return choice==='auto'?usable[0]??null:usable.find(c=>c.id===choice)??null;
}
function ignitionProblem(token,itemId,choice,user,candidates) {
  if(choice==='auto')return 'Нет доступного розжига или огня поблизости';
  const selected=candidates.find(c=>c.id===choice);
  if(selected?.item?.id===itemId)return 'Источник не может разжечь сам себя';
  if(selected?.reason)return selected.reason;
  if(selected?.available)return '';
  if(choice.startsWith('flame:'))return flameProblem(token,resolveToken(token?.parent?.id,choice.slice(6)),user) || 'Выбранный огонь изменился';
  return 'Выбранный розжиг недоступен. Выберите другой';
}
/** Recheck after asynchronous Item writes, including movement and extinguishing on another actor. */
function ignitionStillValid(token,ignition,user) {
  if(!ignition) return true;
  if(ignition.kind==='flame') {
    const state=ignition.donor.getFlag(NS,'active');
    return (state?.activationId??`legacy:${state?.itemId}`)===ignition.activation && usableFlame(token,ignition.donor,user);
  }
  return token.actor.items.get(ignition.item.id)===ignition.item && identifyIgniter(ignition.item).config.mode===ignition.mode &&
    (ignition.mode==='quantity' || getQuantity(ignition.item)>=1);
}
/** Start a fresh source or stub, compensating already-spent stock on failed writes. */
async function activate(token, itemId,{replace=false,choice='auto',user=game.user}={}) {
  const expectedInventory=actorKey(token);
  if (activeState(token) && !replace) throw new Error('Сначала погасите текущий источник света.');
  // Validate before settling, then again after awaits. A failed replacement leaves the old light burning.
  activationPlan(token,itemId,choice,user);
  if(activeState(token)) await settle(token);
  if(actorKey(token)!==expectedInventory || !isAuthority() || !canOperate(user,token)) throw new Error('Персонаж токена изменился. Повторите действие.');
  const previousSource=activeState(token),valid=previousSource?sourceVersion(token):()=>!activeState(token);
  const {item,config,remaining,resume,stowed,ignition}=activationPlan(token,itemId,choice,user);
  const actor=token.actor;
  const previous = previousSource?.previousLight ?? previousLight(token);
  const runtime = makeRuntime(item ?? {id:itemId,name:stowed.itemName,parent:actor}, config, previous, Date.now(), remaining);
  runtime.activationId=foundry.utils.randomID();
  runtime.shutterClosed=false;runtime.lowFuelWarned=false;
  runtime.actorKey = actorKey(token);
  runtime.icon = (item?identify(item).preset?.icon:null) ?? (config.mode==='disposable'?'candle':'lantern');
  const spent = [];
  try {
    // First use freezes the recognized template so later library edits cannot refill a running lamp.
    if (item && identify(item).origin==='recognized') await saveConfig(item,config);
    if (!resume && config.mode === 'disposable') { await updateQuantity(item,-1); spent.push({item,unit:'quantity'}); }
    if (ignition?.kind==='item' && ['quantity','bonus'].includes(ignition.mode)) {
      await updateResource(ignition.item,-1,ignition.mode);spent.push({item:ignition.item,unit:ignition.mode});
    }
    const check=()=>{
      if(actorKey(token)!==runtime.actorKey || !isAuthority() || !valid() || !canOperate(user,token) || !ignitionStillValid(token,ignition,user)) throw new Error('Источник, розжиг или персонаж изменился. Повторите действие.');
    };
    check();
    const stowedSources=stowedStates(token,{all:true}).filter(s=>s.itemId!==itemId || (s.actorKey && s.actorKey!==runtime.actorKey));
    if(previousSource) {
      const oldRemaining=previousSource.config.mode==='infinite'?null:remainingAt(previousSource);
      const oldItem=actor.items.get(previousSource.itemId);
      if(previousSource.config.mode==='tank' && oldItem) await saveRemaining(oldItem,oldRemaining);
      if(isDisposable(previousSource) && oldRemaining>0) {
        const index=stowedSources.findIndex(s=>s.itemId===previousSource.itemId && (!s.actorKey || s.actorKey===runtime.actorKey));
        if(index>=0)stowedSources.splice(index,1);
        stowedSources.push({itemId:previousSource.itemId,itemName:previousSource.itemName,config:previousSource.config,actorKey:runtime.actorKey,remainingSeconds:oldRemaining});
      }
    }
    check();
    runtime.lastAt = Date.now();
    await updateToken(token,{light:lightData(config), [`flags.${NS}.active`]:runtime,
      [`flags.${NS}.lastItemId`]:itemId,
      [`flags.${NS}.stowed`]:null,
      [`flags.${NS}.stowedSources`]:stowedSources});
  } catch(error) {
    // Best-effort rollback if document update failed after inventory decrements.
    for (const {item,unit} of spent.reverse()) await updateResource(item,1,unit).catch(console.error);
    throw error;
  }
  if(previousSource) void broadcastSound(previousSource.config,'off');
  void broadcastSound(config,'on');
  await discardEmpty(spent);
  const cost=ignition?.kind==='item' && ignition.mode!=='reusable'?` ${ignition.item.name}: −1 ${ignition.mode==='bonus'?'Bonus':'шт.'} (осталось ${getResourceStock(ignition.item,ignition.mode)}).`:ignition?` Розжиг: ${ignition.label}.`:'';
  return `Зажжён: ${runtime.itemName}.${cost}`;
}

/** Settle elapsed time before extinguishing, including fuel expiry during the action. */
async function switchOff(token) {
  if (!activeState(token)) throw new Error('У персонажа нет включённого источника.');
  const expired = await settle(token);
  if (expired) return 'Источник света погас.';
  if(!await turnOff(token, activeState(token))) throw new Error('Источник света изменился. Повторите действие.');
  return 'Источник света выключен.';
}

/** Refill the actual tank holder, preserving both stock and fuel if the token write fails. */
async function refill(token, itemId) {
  const actor = token.actor;
  const inventory=actorKey(token);
  const item = actor.items.get(itemId);
  if (!item) throw new Error('Предмет не найден.');
  const holder = runningTank(token, itemId);
  if(holder) await settle(holder);
  const current=holder?activeState(holder):null;
  const valid=current?sourceVersion(holder):()=>!runningTank(token,itemId);
  const config=current?.config ?? getConfig(item);
  if (!config.enabled || config.mode !== 'tank') throw new Error('Этот предмет нельзя заправлять.');
  if (getQuantity(item) < 1) throw new Error('Источник света отсутствует в инвентаре.');
  const initial=current?remainingAt(current):config.remainingSeconds;
  if(initial>=config.capacitySeconds) throw new Error('Бак уже полный.');
  const fuel = resourceFor(actor,config.refillResource,config.refillItem,item.id);
  if (!fuel) throw new Error(fuelProblem(config,fuel));
  const before=item.getFlag(NS,'light')?.remainingSeconds ?? getConfig(item).remainingSeconds;
  const pin=!item.getFlag(NS,'light');
  let spent=false,fuelSaved=false,result,amount;
  const check=()=>{
    if(!valid() || actorKey(token)!==inventory || !isAuthority()) throw new Error('Источник или персонаж изменился. Повторите действие.');
  };
  try {
    check();
    await updateQuantity(fuel,-1);spent=true;check();
    const appliedAt=Date.now(), runtime=current?activeState(holder):null;
    const remaining=runtime?remainingAt(runtime,appliedAt):config.remainingSeconds;
    amount=refillAmount(config,remaining);result=remaining+amount.gain;
    // Preserve pending Item edits; the active instance owns its recipe until extinguished.
    if(pin) await saveConfig(item,{...config,remainingSeconds:result});
    else await saveRemaining(item,result);
    fuelSaved=true;
    check();
    if (runtime?.itemId === itemId) {
      runtime.remainingSeconds = result;
      runtime.lastAt = appliedAt;
      if (result>runtime.config.lowFuelSeconds) runtime.lowFuelWarned=false;
      await updateToken(holder,{[`flags.${NS}.active`]:runtime});
    }
  } catch(error) {
    if(fuelSaved) await saveRemaining(item,before).catch(console.error);
    if(spent) await updateQuantity(fuel,1).catch(console.error);
    throw error;
  }
  await discardEmpty([{item:fuel,unit:'quantity'}]);
  return `Заправлен: ${item.name}. ${fuel.name}: −1 шт., +${displayTime(amount.gain)}${amount.waste>0.001?`; избыток ${displayTime(amount.waste)} потерян`:''}. Осталось ${displayTime(result)}.`;
}

/** Toggle emission without stopping the fuel clock. */
async function shutter(token) {
  if (!activeState(token)?.config.shutter) throw new Error('У источника нет шторок.');
  if (await settle(token)) return 'Источник света погас.';
  const runtime=activeState(token);
  if(!runtime || runtime.actorKey!==actorKey(token)) throw new Error('Источник света изменился. Повторите действие.');
  runtime.shutterClosed=!runtime.shutterClosed;
  await updateToken(token,{light:runtime.shutterClosed?{...lightData(runtime.config),bright:0,dim:0}:lightData(runtime.config),[`flags.${NS}.active`]:runtime});
  return runtime.shutterClosed?'Шторки закрыты. Топливо продолжает расходоваться.':'Шторки открыты.';
}
/** Apply a bounded GM time correction without spending inventory resources. */
async function adjustTime(token,delta) {
  if (!Number.isFinite(delta) || Math.abs(delta)>86400) throw new Error('Некорректная поправка времени.');
  if (!activeState(token) || activeState(token).config.mode==='infinite') throw new Error('Нужен работающий источник с конечным запасом.');
  if (await settle(token)) return 'Источник уже погас. Заправьте или зажгите его заново.';
  const runtime=activeState(token);
  if(!runtime || runtime.actorKey!==actorKey(token)) throw new Error('Источник света изменился. Повторите действие.');
  const item=token.actor.items.get(runtime.itemId);
  const valid=sourceVersion(token);
  const before=item?.getFlag(NS,'light')?.remainingSeconds ?? runtime.remainingSeconds;
  runtime.remainingSeconds=Math.max(0,Math.min(runtime.config.capacitySeconds,runtime.remainingSeconds+delta));
  if (runtime.remainingSeconds>runtime.config.lowFuelSeconds) runtime.lowFuelWarned=false;
  try {
    if (runtime.remainingSeconds<=0) {
      if(!await turnOff(token,runtime,{expired:true,valid})) throw new Error('Источник света изменился. Повторите действие.');
    }
    else {
      if(runtime.config.mode==='tank' && item) await saveRemaining(item,runtime.remainingSeconds);
      if(!valid() || actorKey(token)!==runtime.actorKey || !isAuthority()) throw new Error('Источник света изменился. Повторите действие.');
      await updateToken(token,{[`flags.${NS}.active`]:runtime});
    }
  } catch(error) { if(item && runtime.config.mode==='tank') await saveRemaining(item,before).catch(console.error); throw error; }
  return `Осталось ${displayTime(runtime.remainingSeconds)}.`;
}

/** Recheck authority and ownership inside the inventory queue before applying an action. */
async function doAction(request, userId) {
  if(ignitionMigration)await ignitionMigration.catch(()=>{});
  if (!isAuthority()) throw new Error('Управление передано другому ГМу. Повторите действие.');
  if (!request || typeof request !== 'object') throw new Error('Некорректный запрос.');
  const user = game.users.get(userId);
  const token = resolveToken(request.sceneId, request.tokenId);
  if (!canOperate(user, token)) throw new Error('Нет доступа к этому токену.');
  if (!['on','off','refill','switch','shutter','adjust'].includes(request.action)) throw new Error('Неизвестное действие.');
  if (request.action==='adjust' && !user.isGM) throw new Error('Время корректирует ГМ.');
  const inventory=actorKey(token);
  return withLock(token, async () => {
    if (!isAuthority() || !canOperate(game.users.get(userId),token)) throw new Error('Нет доступа к этому токену.');
    if(actorKey(token)!==inventory) throw new Error('Персонаж токена изменился. Повторите действие.');
    const choice=typeof request.ignitionId==='string'?request.ignitionId:'auto';
    if (request.action === 'on') return activate(token, request.itemId,{choice,user});
    if (request.action === 'off') return switchOff(token);
    if (request.action === 'switch') {
      if (activeState(token)?.itemId===request.itemId) return 'Этот источник уже горит.';
      return activate(token,request.itemId,{replace:true,choice,user});
    }
    if (request.action === 'shutter') return shutter(token);
    if (request.action === 'adjust') return adjustTime(token,Number(request.deltaSeconds));
    return refill(token, request.itemId);
  });
}
/** Run locally on the elected GM or await a correlated authenticated User-document response. */
async function requestAction(token, action, itemId = '', options = {}) {
  const gm = leadGM();
  if (!gm) { warning('Для управления светом необходим подключённый ГМ.'); return; }
  const request = {action, itemId, sceneId:token.parent.id, tokenId:token.id,
    ...(['on','switch'].includes(action)?{ignitionId:typeof options.ignitionId==='string'?options.ignitionId.slice(0,100):'auto'}:{}),
    ...(action==='adjust'?{deltaSeconds:options.deltaSeconds}: {})};
  try {
    let result;
    if (isAuthority()) result = await doAction(request, game.user.id);
    else {
      const id = foundry.utils.randomID();
      result = await new Promise((resolve,reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('ГМ не ответил. Проверьте состояние источника перед повтором.')); },15000);
        pending.set(id,{resolve,reject,timeout,gmId:gm.id});
        // User document updates carry the server-authenticated initiator ID.
        // A module socket payload alone cannot prove who sent a request.
        game.user.setFlag(NS,'request',{id,...request}).catch(error => {
          clearTimeout(timeout); pending.delete(id); reject(error);
        });
      });
    }
    info(result);
    windows?.refresh();
    return result;
  } catch(e) { warning(e.message); console.error(`[${NS}]`,e); return null; }
}

/** Handle server-originated User diffs; never trust a requester identity inside the payload. */
async function onUserUpdate(user, changes, _options, userId) {
  if(changes.flags?.[NS]?.sound && user.id===userId && user.isGM && userId===leadGM()?.id) void playSound(clone(user.getFlag(NS,'sound')));
  // Foundry hooks receive a diff, so repeated actions may only change the ID.
  const response = changes.flags?.[NS]?.result ? user.getFlag(NS,'result') : null;
  if (response && user.id === game.user.id) {
    const wait = pending.get(response.id);
    if (wait && userId === wait.gmId && game.users.get(userId)?.isGM) {
      clearTimeout(wait.timeout); pending.delete(response.id);
      response.error ? wait.reject(new Error(response.error)) : wait.resolve(response.message);
    }
  }
  const request = changes.flags?.[NS]?.request ? clone(user.getFlag(NS,'request')) : null;
  if (!request?.id || userId !== user.id || !isAuthority()) return;
  if (handledRequests.get(userId) === request.id) return;
  handledRequests.set(userId,request.id);
  let result;
  try { result = {id:request.id,message:await doAction(request,userId),error:null}; }
  catch(error) { result = {id:request.id,error:error.message,message:null}; }
  await user.setFlag(NS,'result',result).catch(error => console.error(`[${NS}] Ошибка отправки ответа`,error));
}

/** Provide a presentation-only copy with locally interpolated fuel, without writing documents. */
function activeView(token) {
  const state=token?activeState(token):null;
  return state?{...state,config:normalizeConfig(state.config),remainingSeconds:state.config.mode==='infinite'?null:remainingAt(state)}:null;
}
/** Build inventory availability on demand; it is not part of the one-second clock path. */
function viewModel(token,ignitionId='auto') {
  const active=activeView(token);
  const sources=[];
  const candidates=ignitionCandidates(token,game.user,{includeUnavailable:true});
  if(token?.actor) {
    const stowed=stowedStates(token);
    for(const item of availableItems(token.actor)) {
      if(stowed.some(s=>s.itemId===item.id)) continue;
      const identified=identify(item), current=active?.itemId===item.id;
      const holder=runningTank(token,item.id);
      const held=holder && !current?activeState(holder):null;
      const c=current?active.config:(held?.config ?? identified.config);
      let blocked='';
      if(getQuantity(item)<1) blocked='Нужна целая единица предмета';
      else if(c.mode!=='infinite' && c.remainingSeconds<=0) blocked='Сначала заправьте источник';
      else if(holder && holder!==token) blocked='Источник на другом токене';
      else if(c.requiresIgnition && !chooseIgnition(token,item.id,ignitionId,game.user,candidates)) blocked=ignitionProblem(token,item.id,ignitionId,game.user,candidates);
      const fuel=c.mode==='tank'?resourceFor(token.actor,c.refillResource,c.refillItem,item.id):null;
      const remaining=current?active.remainingSeconds:held?remainingAt(held):c.remainingSeconds;
      sources.push({id:item.id,name:item.name,icon:identified.preset?.icon ?? (c.mode==='disposable'?'candle':'lantern'),
        active:current,requiresIgnition:c.requiresIgnition,blocked:current?'':blocked,detail:c.mode==='infinite'?'Без расхода':c.mode==='disposable'?
          (current?'Горит · '+displayTime(remaining)+' · запас ×'+getQuantity(item):'Запас ×'+getQuantity(item)+' · по '+displayTime(c.remainingSeconds)):displayTime(remaining),
        originLabel:identified.origin==='recognized'?'Шаблон: '+identified.preset.label:identified.preset?.label ?? 'Свои настройки',
        timeLabel:displayTime(remaining),stockLabel:current && c.mode==='disposable'?' · запас ×'+getQuantity(item):'',fuelMissing:!fuel,
        refillable:c.mode==='tank',refillBlocked:c.mode!=='tank'?'':getQuantity(item)<1?'Нужен целый источник':fuelProblem(c,fuel) || (remaining>=c.capacitySeconds?'Бак полный':''),
        refillFuel:fuel?.name??resourceLabel(c.refillResource,c.refillItem),refillHint:refillHint(c,remaining,fuel?.name??resourceLabel(c.refillResource,c.refillItem))});
    }
    for(const s of stowed) {
      const c=normalizeConfig(s.config);
      const missing=c.requiresIgnition && !chooseIgnition(token,s.itemId,ignitionId,game.user,candidates);
      const stock=getQuantity(token.actor.items.get(s.itemId));
      sources.push({id:s.itemId,name:s.itemName+' · огарок',icon:'candle',active:false,refillable:false,requiresIgnition:c.requiresIgnition,
        detail:displayTime(s.remainingSeconds)+(stock>=1?' · новых ×'+stock:''),originLabel:'Сначала догорает огарок',configurable:!!token.actor.items.get(s.itemId),blocked:missing?ignitionProblem(token,s.itemId,ignitionId,game.user,candidates):''});
    }
    // A burning disposable may have consumed the last unit in the inventory.
    if(active && !sources.some(s=>s.id===active.itemId)) sources.unshift({id:active.itemId,name:active.itemName,icon:active.icon ?? 'candle',active:true,requiresIgnition:active.config.requiresIgnition,detail:displayTime(active.remainingSeconds),originLabel:'Горящий экземпляр',configurable:!!token.actor.items.get(active.itemId),refillable:false});
  }
  return {tokenName:token?.name,active,sources,gm:game.user.isGM,paused:game.paused,authority:!!leadGM(),canOperate:canOperate(game.user,token),ignitionId,
    hasActor:!!token?.actor,operationProblem:!token?.actor?'Выберите токен персонажа':!game.user.isGM && !game.settings.get(NS,'allowPlayers')?'ГМ отключил управление светом для игроков':'Нет доступа к этому персонажу',
    ignitionProblem:ignitionId==='auto'?'':ignitionProblem(token,'',ignitionId,game.user,candidates),
    igniters:candidates.map(({id,label,available})=>({id,label,available})),items:game.user.isGM?(token?.actor?.items??[]).map(item=>({id:item.id,name:item.name})):[]};
}
/** Explain only relevant constraints; reading this does not create another world-token scan. */
function itemContext(item,token) {
  const notes=[];
  if([...activeSources.values()].some(t=>{const state=t.getFlag(NS,'active');return state.itemId===item.id && state.actorKey===item.parent?.uuid;}))notes.push('Горящий экземпляр сохранит прежние параметры.');
  if(token?.actor?.uuid===item.parent?.uuid && stowedStates(token).some(s=>s.itemId===item.id))notes.push('Огарок сохранит свои параметры; эти настройки относятся к новым свечам.');
  return notes.join(' ');
}
function configureItem(item) { return windows?.openItem(item); }
function openTokenMenu(token=canvas?.tokens?.controlled?.[0]) { return windows?.open(token); }
/** Find the selected or visible token representing this exact inventory. */
function tokenForActor(actor) {
  return canvas?.tokens?.controlled?.find(t=>t.actor?.uuid===actor.uuid) ??
    canvas?.tokens?.placeables?.find(t=>t.actor?.uuid===actor.uuid);
}
/** Reuse a requested source, saved stub or previous source for a single quick action. */
async function quickToggle(token=canvas?.tokens?.controlled?.[0],itemId='') {
  const doc=token?.document ?? token;
  if(!doc?.actor) return warning('Выберите токен персонажа.');
  const active=activeState(doc);
  if(active && (!itemId || active.itemId===itemId)) return requestAction(doc,'off');
  if(itemId)return requestAction(doc,'switch',itemId);
  const last=doc.getFlag(NS,'lastItemId');
  const sources=availableItems(doc.actor);
  const ids=[...new Set([last,...stowedStates(doc).map(s=>s.itemId),...sources.map(i=>i.id)].filter(Boolean))];
  const chosen=ids.find(id=>{try{activationPlan(doc,id);return true;}catch{return false;}});
  if(!chosen) return openTokenMenu(token);
  return requestAction(doc,'switch',chosen);
}
/** Append one styled HUD control while leaving existing Foundry controls intact. */
function installHUD(app,html) {
  const token=app.object;
  if(!token?.actor || !canOperate(game.user,token.document)) return;
  const root=html instanceof HTMLElement?html:(html?.[0] ?? app.element);
  const holder=root?.querySelector('.col.right') ?? root;
  if(!holder || holder.querySelector('.fbl-lk-token-button')) return;
  const button=document.createElement('button');
  button.type='button'; button.className='control-icon fbl-lk-token-button'+(activeState(token.document)?' lk-on':'');
  button.title='Lightkeeper · управление светом. Shift + клик — включить / погасить';
  button.setAttribute('aria-label',button.title); button.innerHTML='<i class="fa-solid fa-lightbulb"></i>';
  button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation(); if(event.shiftKey) void quickToggle(token); else openTokenMenu(token);});
  holder.append(button);
}
/** Add inventory actions only on recognized source rows; no Item-header buttons are installed. */
function installSheet(app,html) {
  const actor=app.actor ?? app.document ?? app.object;
  if(!actor?.items) return;
  const root=html instanceof HTMLElement?html:(html?.[0] ?? app.element);
  for(const row of root?.querySelectorAll('[data-item-id]') ?? []) {
    const item=actor.items.get(row.dataset.itemId);
    if(!item || !getConfig(item).enabled || row.querySelector('.fbl-lk-sheet-button')) continue;
    const holder=row.querySelector('.item-edit')?.parentElement ?? row.querySelector('.item-controls') ?? row.querySelector('td:last-child');
    if(!holder) continue;
    const button=document.createElement('button'); button.type='button'; button.className='fbl-lk-sheet-button';
    button.title='Свет: '+item.name+' · Shift + клик — быстрое включение'; button.setAttribute('aria-label',button.title);
    button.innerHTML='<i class="fa-solid fa-lightbulb"></i>';
    button.addEventListener('click',event=>{
      event.preventDefault();event.stopPropagation();
      const token=tokenForActor(actor);
      if(!token) return warning('Поместите персонажа на сцену и выберите его токен.');
      if(event.shiftKey) void quickToggle(token,item.id); else openTokenMenu(token);
    }); holder.prepend(button);
  }
}

/** Run only on the elected GM, while finite sources burn and the world is not paused. */
function updateHeartbeat() {
  const needed=ready && isAuthority() && !game.paused && activeSources.finiteCount>0;
  if(needed && heartbeat===null) heartbeat=setInterval(heartbeatTick,5000);
  else if(!needed && heartbeat!==null) { clearInterval(heartbeat); heartbeat=null; }
}
/** Keep the last pause state before the oldest live timestamp; bound history on every client. */
function prunePauseHistory() {
  if(pauseHistory.length<2) return;
  let cutoff=Date.now();
  for(const token of activeSources.values()) {
    const state=token.getFlag(NS,'active');
    if(state?.config.mode!=='infinite' && Number.isFinite(state?.lastAt)) cutoff=Math.min(cutoff,state.lastAt);
  }
  let first=0;
  while(first+1<pauseHistory.length && pauseHistory[first+1].at<=cutoff) first++;
  if(first) pauseHistory=pauseHistory.slice(first);
}
/** Independent inventories checkpoint concurrently; each shared inventory retains its queue. */
async function heartbeatTick() {
  if(!isAuthority() || ticking) return;
  ticking=true;
  try {
    const groups=new Map();
    for(const token of activeSources.values()) {
      const key=actorKey(token);
      if(locks.has(key)) continue;
      if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(token);
    }
    await Promise.all([...groups.values()].map(tokens=>withLock(tokens[0],async()=>{
      for(const token of tokens) {
        try { if(isAuthority()) await settle(token); errors.delete(token.uuid ?? token.id); }
        catch(error) {
          const key=token.uuid ?? token.id;
          if(!errors.has(key)) { console.error('['+NS+'] Ошибка таймера:',token.name,error);errors.add(key); }
        }
      }
    })));
    prunePauseHistory();
  } finally { ticking=false; updateHeartbeat(); }
}
/** Record boundaries synchronously even when a document write is still pending. */
async function onPause(paused) {
  pauseHistory.push({at:Date.now(),paused}); updateHeartbeat(); windows?.refresh();
  if(!isAuthority()) return;
  for(const token of [...activeSources.values()]) {
    try { await withLock(token,()=>settle(token)); }
    catch(error) { console.error('['+NS+'] Ошибка переключения паузы',error); }
  }
  prunePauseHistory();
}
/** Unrelated player connections neither write documents nor reset a running clock. */
async function resumeOnAuthorityChange() {
  const previous=authorityId, authority=isAuthority(); updateHeartbeat();
  if(previous===authorityId) return;
  windows?.refresh();
  if(!authority) return;
  ignitionMigration=migrateIgnitionSettings();
  try {await ignitionMigration;}
  catch(error){console.error(`[${NS}] Ошибка переноса розжига`,error);warning('Не все настройки розжига удалось перенести. Проверьте консоль; перенос повторится при следующем запуске ГМа.');}
  finally{ignitionMigration=null;}
  for(const token of [...activeSources.values()]) {
    try { await withLock(token,()=>settle(token)); }
    catch(error) { console.error('['+NS+'] Ошибка восстановления таймера',error); }
  }
}
/** One elected GM performs the v1 inventory migration, once; ordinary timers never scan actors. */
async function migrateIgnitionSettings() {
  if(game.settings.get(NS,'ignitionSchema')>=2) return;
  const raw=game.settings.get(NS,'catalog');
  const inventories=new Map((game.actors?.contents??[]).map(actor=>[actor.uuid,actor.items.contents]));
  const runtimeConfigs=new Map();
  for(const scene of game.scenes.contents) for(const token of scene.tokens.contents) {
    if(token.actorLink===false && token.actor) inventories.set(actorKey(token),token.actor.items.contents);
    // The last candle's Item may already be deleted: its old policy survives only in Token flags.
    const states=[token.getFlag(NS,'active'),token.getFlag(NS,'stowed'),...(token.getFlag(NS,'stowedSources')??[])].filter(Boolean);
    for(const state of states) {
      if(!state.config || typeof state.config.requiresIgnition==='boolean')continue;
      const key=state.actorKey??actorKey(token);
      if(!runtimeConfigs.has(key))runtimeConfigs.set(key,[]);
      runtimeConfigs.get(key).push(state.config);
    }
  }
  if(game.items?.contents?.length)inventories.set('world',game.items.contents);
  let conflicts=0;
  for(const [key,items] of inventories) await withQueue(key,async()=>{
    for(const {item,config,conflict} of legacyIgniterAssignments(items,presets(),runtimeConfigs.get(key))) {
      if(!isAuthority())throw new Error('ГМ переноса изменился.');
      if(!await item.setFlag(NS,'ignition',config))throw new Error(`Не удалось перенести розжиг «${item.name}».`);
      if(conflict)conflicts++;
    }
  });
  if(!isAuthority())throw new Error('ГМ переноса изменился.');
  if(raw?.version<2)await game.settings.set(NS,'catalog',catalog());
  if(conflicts)warning(`Розжиг перенесён в предметы. У ${conflicts} предметов были разные старые правила; выбран нерасходуемый режим. Проверьте их настройки.`);
  const resources=legacyResourceConflicts(raw);
  if(resources.length)warning(`В старых шаблонах расход розжига различался: ${resources.join(', ')}. Для этих запасов выбран нерасходуемый режим; проверьте библиотеку.`);
  await game.settings.set(NS,'ignitionSchema',2);
}
/** Movement updates reach only for a donor or the selected token; unrelated movement stays cheap. */
function onTokenUpdate(token,changes) {
  const wasIgniter=activeSources.igniters.has(token);
  const paths=changedPaths(changes);
  if(touchesPath(paths,`flags.${NS}.active`) || ['actorId','actorLink','delta'].some(key=>touchesPath(paths,key))) {
    activeSources.sync(token); updateHeartbeat(); prunePauseHistory();
  }
  const identityChange=paths.some(path=>['actorId','actorLink'].includes(path)) ||
    (!isClockUpdate(changes) && touchesPath(paths,`flags.${NS}.active`));
  if(identityChange && isAuthority()) {
    const state=token.getFlag(NS,'active');
    if(state?.actorKey && state.actorKey!==actorKey(token)) void withLock(token,()=>settle(token)).catch(console.error);
  }
  const reachChanged=['x','y','width','height','elevation','hidden','name','actorId','actorLink','delta',`flags.${NS}.active`].some(key=>touchesPath(paths,key));
  windows?.refresh({type:'token',document:token,changes,ignitionRelevant:reachChanged && (wasIgniter||activeSources.igniters.has(token)),hasIgniters:activeSources.igniters.size>0});
}
/** Inventory changes only affect their owning panel; invalid sources also stop during pause. */
function onItemUpdate(item,changes={},options={}) {
  windows?.refresh({type:'item',document:item,changes,deleted:!!options.deleted});
  if(!isAuthority() || isClockUpdate(changes)) return;
  const paths=changedPaths(changes);
  if(!options.deleted && !touchesPath(paths,'system.quantity') && !touchesPath(paths,`flags.${NS}.light`)) return;
  for(const token of activeSources.values()) {
    const state=token.getFlag(NS,'active');
    if(state.itemId!==item.id || token.actor?.uuid!==item.parent?.uuid || isDisposable(state)) continue;
    void withLock(token,()=>settle(token)).catch(error=>console.error('['+NS+'] Ошибка инвентаря',error));
  }
}

/** Creates only world-item templates. Nothing is added to actors, scenes, or Item Piles automatically. */
async function createExamples() {
  if (!game.user.isGM) throw new Error('Эту функцию может вызвать только ГМ.');
  const library=catalog();
  const data=library.sources.map(preset=>({name:preset.names[0] ?? preset.label,type:'gear',system:{quantity:1},flags:{[NS]:{light:normalizeConfig({...preset.config,remainingSeconds:preset.config.capacitySeconds})}}}));
  for(const resource of library.resources) data.push({name:resource.names[0] ?? resource.label,type:'gear',system:{quantity:1},flags:{[NS]:{ignition:resource.ignition}}});
  const created = await Item.createDocuments(data);
  info(`Создано ${created.length} примеров в справочнике предметов. Их можно перетаскивать в Item Piles.`);
  return created;
}

Hooks.once('init',()=>{
  game.settings.register(NS,'expiryChat',{name:'Оповещать о погасших источниках',hint:'Сообщение в чат при автоматическом окончании топлива.',scope:'world',config:true,type:Boolean,default:true});
  game.settings.register(NS,'allowPlayers',{name:'Разрешить игрокам управлять своим светом',scope:'world',config:true,type:Boolean,default:true,onChange:()=>windows?.refresh()});
  game.settings.register(NS,'autoRecognize',{name:'Распознавать источники по библиотеке',hint:'Предмет без своих настроек использует первый совпавший шаблон. При первом зажигании настройки закрепляются в предмете.',scope:'world',config:true,type:Boolean,default:true,onChange:()=>windows?.refresh()});
  game.settings.register(NS,'lowFuelNotify',{name:'Предупреждать о малом запасе',hint:'Одно сообщение владельцам и ГМу при достижении порога источника. Скрытые токены видят только ГМы.',scope:'world',config:true,type:Boolean,default:true});
  game.settings.register(NS,'ignitionRadius',{name:'Дальность передачи огня, клеток',hint:'Расстояние между границами токенов с учётом высоты. Работает и без сетки: используется её масштаб. 0 — только соприкасающиеся токены.',scope:'world',config:true,type:Number,range:{min:0,max:20,step:0.5},default:1,onChange:()=>windows?.refresh()});
  game.settings.register(NS,'ignitionWalls',{name:'Стены препятствуют передаче огня',hint:'Учитывать стены, блокирующие движение, и закрытые двери между центрами токенов.',scope:'world',config:true,type:Boolean,default:true,onChange:()=>windows?.refresh()});
  game.settings.register(NS,'ignitionSchema',{scope:'world',config:false,type:Number,default:0});
  game.settings.register(NS,'catalog',{scope:'world',config:false,type:Object,default:defaultCatalog(),onChange:()=>{presetIndex=null;windows?.refresh();}});
  windows=createInterface({catalog,identify,identifyIgniter,itemContext,viewModel,active:activeView,timeLabel:displayTime,clockRunning:()=>!game.paused && !!leadGM(),resolveToken,action:requestAction,isGM:()=>game.user.isGM,info,warning,
    async saveItem(item,config,{remainingEdited=false,ignition,quantity}={}) {
      await withItemLock(item,async()=>{
        const patch={...config};
        // Exclude untouched fuel from the update itself, so another client cannot be overwritten either.
        if(!remainingEdited && item.getFlag(NS,'light')) delete patch.remainingSeconds;
        const update={[`flags.${NS}.light`]:patch};
        if(quantity!==undefined) {
          if(!Number.isFinite(quantity) || quantity<0 || !Number.isFinite(item.system.quantity))throw new Error('Некорректное количество предметов.');
          update['system.quantity']=quantity;
        }
        if(ignition)update[`flags.${NS}.ignition`]=normalizeIgniter(ignition);
        else if(ignition===null && item.getFlag(NS,'ignition'))update[`flags.${NS}.-=ignition`]=null;
        if(!await item.update(update))throw new Error(`Сохранение «${item.name}» отменено.`);
      });
      windows.refresh(); info(`Настройки «${item.name}» сохранены.`);
    },
    async saveCatalog(value) {
      if(!game.user.isGM) throw new Error('Библиотеку настраивает ГМ.');
      await game.settings.set(NS,'catalog',normalizeCatalog(value)); presetIndex=null; windows.refresh();
    }});
  game.settings.registerMenu(NS,'templates',{name:'Библиотека источников света',label:'Открыть мастерскую',hint:'Шаблоны, распознаваемые названия, розжиг и топливо.',icon:'fa-solid fa-lightbulb',type:windows.Menu,restricted:true});
  game.keybindings.register(NS,'quickToggle',{name:'Быстро включить / погасить свет',hint:'Выбранный токен использует последний источник или сохранённый огарок.',editable:[{key:'KeyL',modifiers:['SHIFT']}],onDown:()=>{void quickToggle();return true;}});
  Hooks.on('getSceneControlButtons',controls=>{
    if (!controls.tokens?.tools) return;
    controls.tokens.tools['fbl-lightkeeper']={name:'fbl-lightkeeper',title:'Управление светом выбранного токена',icon:'fas fa-lightbulb',order:Object.keys(controls.tokens.tools).length,button:true,visible:true,onChange:()=>void openTokenMenu()};
  });
  Hooks.on('getActorSheetHeaderButtons',(app,buttons)=>{
    buttons.unshift({class:'fbl-lightkeeper',label:'Свет',icon:'fa-solid fa-lightbulb',onclick:()=>{
      const token=tokenForActor(app.actor ?? app.object);
      return token?openTokenMenu(token):warning('Поместите персонажа на сцену и выберите его токен.');
    }});
  });
  Hooks.on('renderTokenHUD',installHUD);
  Hooks.on('renderActorSheet',installSheet);
  Hooks.on('controlToken',(token,controlled)=>{if(controlled) windows.follow(token);});
  Hooks.on('updateToken',onTokenUpdate);
  Hooks.on('createToken',token=>{activeSources.sync(token);updateHeartbeat();windows.refresh({type:'token',document:token,ignitionRelevant:activeSources.igniters.has(token),changes:{flags:{[NS]:{active:token.getFlag(NS,'active')}}}});});
  Hooks.on('deleteToken',token=>{const ignitionRelevant=activeSources.igniters.has(token);activeSources.remove(token);updateHeartbeat();windows.refresh({type:'deletedToken',document:token,ignitionRelevant});});
  Hooks.on('createScene',scene=>{for(const token of scene.tokens.contents) activeSources.sync(token);updateHeartbeat();});
  Hooks.on('deleteScene',scene=>{activeSources.removeScene(scene);updateHeartbeat();windows.refresh({type:'scene',document:scene});});
  Hooks.on('updateScene',(scene,changes)=>{if(changedPaths(changes).some(path=>path==='grid' || path.startsWith('grid.')))windows.refresh({type:'scene',document:scene});});
  for(const hook of ['createWall','updateWall','deleteWall'])Hooks.on(hook,wall=>{ignitionReach.invalidate(wall.parent);windows.refresh({type:'wall',document:wall});});
  Hooks.on('updateItem',onItemUpdate);
  Hooks.on('createItem',item=>windows.refresh({type:'item',document:item,changes:{created:true}}));
  Hooks.on('deleteItem',item=>onItemUpdate(item,{}, {deleted:true}));
  Hooks.on('updateActor',(actor,changes)=>windows.refresh({type:'actor',document:actor,changes}));
  Hooks.on('deleteActor',actor=>{
    if(!isAuthority()) return;
    for(const token of activeSources.values()) if(token.getFlag(NS,'active')?.actorKey===actor.uuid) {
      void withLock(token,async()=>{
        const runtime=activeState(token);
        if(runtime) await turnOff(token,runtime,{discard:true});
      }).catch(console.error);
    }
  });
  Hooks.on('pauseGame',onPause);
  Hooks.on('updateUser',onUserUpdate);
  Hooks.on('preCreateToken',token=>{
    // A pasted token must not duplicate an already consumed candle or active tank.
    const runtime = activeState(token);
    if (!runtime && !stowedStates(token,{all:true}).length) return;
    token.updateSource({...(runtime ? {light:runtime.previousLight ?? {}} : {}),
      [`flags.${NS}.active`]:null,[`flags.${NS}.stowed`]:null,[`flags.${NS}.stowedSources`]:[]});
  });
});
Hooks.once('ready',async()=>{
  if (game.system.id !== 'forbidden-lands') console.warn(`[${NS}] Модуль предназначен для Forbidden Lands; система: ${game.system.id}`);
  pauseHistory = [{at:Date.now(),paused:game.paused}];
  activeSources.rebuild(game.scenes.contents);
  ready=true;
  // A small public API for macros and other modules.
  game.modules.get(NS).api={open:openTokenMenu,configure:configureItem,requestAction,createExamples,quickToggle,
    library:id=>windows.openLibrary(id),getCatalog:catalog,getIgnitionOptions:token=>ignitionCandidates(token?.document??token).map(({id,label})=>({id,label})),
    async applyPreset(item,id) {
      if(!game.user.isGM) throw new Error('Шаблон применяет ГМ.');
      const preset=presets().sourcesById.get(id); if(!preset) throw new Error('Шаблон не найден.');
      await withItemLock(item,()=>saveConfig(item,{...preset.config,remainingSeconds:preset.config.capacitySeconds})); windows.refresh();
    },
    async applyIgniterPreset(item,id) {
      if(!game.user.isGM) throw new Error('Шаблон применяет ГМ.');
      const preset=presets().resourcesById.get(id);if(!preset)throw new Error('Шаблон розжига не найден.');
      await withItemLock(item,async()=>{if(!await item.setFlag(NS,'ignition',preset.ignition))throw new Error('Настройки розжига не сохранены.');});windows.refresh();
    }};
  await resumeOnAuthorityChange();
  Hooks.on('userConnected',resumeOnAuthorityChange);
  Hooks.on('updateUser',(_user,changes)=>{if('role' in changes)windows?.refresh();if('role' in changes || 'active' in changes) return resumeOnAuthorityChange();});
});
Hooks.once('shutdown',()=>{
  ready=false;
  if(heartbeat!==null)clearInterval(heartbeat);
  heartbeat=null; activeSources.clear(); presetIndex=null;
  playSound.close();
  void windows?.close();
  for (const wait of pending.values()) {
    clearTimeout(wait.timeout); wait.reject(new Error('Соединение с миром закрыто.'));
  }
  pending.clear();
});
