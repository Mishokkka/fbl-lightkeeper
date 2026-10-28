import { MODULE_ID as NS, normalizeConfig, lightData, tickRemaining, displayTime, getQuantity, makeRuntime } from './logic.js';
import {defaultCatalog,normalizeCatalog,PresetIndex} from './presets.js';
import {createInterface} from './interface.js';
import {ActiveSourceIndex,changedPaths,isClockUpdate} from './runtime.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const warning = message => ui.notifications.warn(`[Lightkeeper] ${message}`);
const info = message => ui.notifications.info(`[Lightkeeper] ${message}`);
const errors = new Set();
const locks = new Map();
const pending = new Map();
const handledRequests = new Map();
let heartbeat = null;
let authorityId = null;
let authoritySince = 0;
let pauseHistory = [];
let windows = null;
let presetIndex = null;
let ready = false;
let ticking = false;
const activeSources=new ActiveSourceIndex(actorKey);
/** Settings hooks invalidate the compiled library on every client. UI/API callers get a copy. */
const presets = () => presetIndex ??= new PresetIndex(game.settings.get(NS,'catalog') ?? defaultCatalog());
const catalog = () => clone(presets().catalog);
const identify = item => presets().identify(item,game.settings.get(NS,'autoRecognize') !== false);
const resourceFor = (actor,key,name,exceptId='') => presets().findResource(actor,key,name,exceptId);

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
/** Read disposable remainders without mutating flags; merge the legacy single-stub format. */
function stowedStates(token) {
  const saved = clone(token.getFlag(NS, 'stowedSources') ?? []);
  const legacy = token.getFlag(NS, 'stowed');
  if (legacy && !saved.some(s => s.itemId === legacy.itemId)) saved.push(clone(legacy));
  return saved.filter(s => s.remainingSeconds > 0);
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
/** Serialize changes to one inventory while allowing unrelated actors to proceed concurrently. */
async function withLock(token, callback) {
  const key = lockKey(token);
  const previous = locks.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(callback);
  locks.set(key, task);
  try { return await task; } finally { if (locks.get(key) === task) locks.delete(key); }
}
function runningTank(token, itemId) {
  return activeSources.findTank(token,itemId);
}
/** Integrate pause boundaries even if document writes are still queued. */
function remainingAt(runtime, now = Date.now()) {
  let from = Math.max(runtime.lastAt, isAuthority() ? authoritySince : runtime.lastAt);
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

/** Persist fuel and restore light in one token transition; retain unexpired disposable stubs. */
async function turnOff(token, runtime, {expired = false, discard = false} = {}) {
  const item = token.actor?.items.get(runtime.itemId);
  if (runtime.config.mode === 'tank' && item && runtime.actorKey === actorKey(token)) {
    await saveRemaining(item,Math.max(0,runtime.remainingSeconds ?? 0));
  }
  const stowed = stowedStates(token).filter(s => s.itemId !== runtime.itemId);
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
  if (expired && game.settings.get(NS, 'expiryChat')) {
    await ChatMessage.create({content: `<p><strong>Источник света погас:</strong> ${escapeHtml(runtime.itemName)} (${escapeHtml(token.name)}).</p>`,
      ...(token.hidden ? {whisper:game.users.filter(u => u.isGM).map(u => u.id)} : {})});
  }
}

/** Commit elapsed real seconds. Called exclusively by the elected GM. */
async function settle(token) {
  const runtime = activeState(token);
  if (!runtime) return false;
  const item = token.actor?.items.get(runtime.itemId);
  // Migrate runtimes created before actor identity was recorded.
  const migrated=!runtime.actorKey;
  runtime.actorKey ??= actorKey(token);
  if (runtime.actorKey !== actorKey(token) || (!isDisposable(runtime) &&
      (!item || !getConfig(item).enabled || getQuantity(item) < 1))) {
    await turnOff(token, runtime, {discard:true}); return true;
  }
  const now = Date.now();
  if (runtime.config.mode === 'infinite') {
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
  if (runtime.remainingSeconds <= 0) { await turnOff(token, runtime, {expired: true}); return true; }
  if (changed || clockChanged || warn || migrated) {
    const patch={ [`flags.${NS}.active.remainingSeconds`]:runtime.remainingSeconds,[`flags.${NS}.active.lastAt`]:now };
    if(warn) patch[`flags.${NS}.active.lowFuelWarned`]=true;
    if(migrated) patch[`flags.${NS}.active.actorKey`]=runtime.actorKey;
    await updateToken(token,patch,{render:false});
  }
  if (warn) {
    const whisper=game.users.filter(user=>user.isGM || (!token.hidden && token.actor?.testUserPermission(user,'OWNER'))).map(user=>user.id);
    await ChatMessage.create({whisper,content:`<div class="fbl-lk-message"><strong>Свет догорает</strong><p>${escapeHtml(runtime.itemName)} · ${escapeHtml(token.name)}<br>Осталось ${displayTime(next)}.</p></div>`});
  }
  return false;
}

/** Validate stock, exclusive tank use and ignition before extinguishing an existing source. */
function activationPlan(token, itemId) {
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
  if (config.mode === 'tank' && runningTank(token, itemId)) {
    throw new Error('Этот источник уже используется другим токеном того же персонажа.');
  }
  const remaining = resume ? stowed.remainingSeconds : config.remainingSeconds;
  if (config.mode !== 'infinite' && remaining <= 0) throw new Error('Топливо или заряд закончились.');
  let ignitionItem = null;
  if (config.ignitionMode !== 'self') {
    ignitionItem = resourceFor(actor,config.ignitionResource,config.ignitionItem,itemId);
    if (!ignitionItem) throw new Error(`Для включения нужен предмет розжига: «${resourceLabel(config.ignitionResource,config.ignitionItem)}».`);
  }
  return {item,config,remaining,resume,stowed,ignitionItem};
}
function resourceLabel(id,fallback) { return (presets().resourcesById.get(id)?.label ?? fallback) || 'не задан'; }
/** Start a fresh source or stub, compensating already-spent stock on failed writes. */
async function activate(token, itemId) {
  if (activeState(token)) throw new Error('Сначала погасите текущий источник света.');
  const {item,config,remaining,resume,stowed,ignitionItem}=activationPlan(token,itemId);
  const actor=token.actor;
  const previous = previousLight(token);
  const runtime = makeRuntime(item ?? {id:itemId,name:stowed.itemName,parent:actor}, config, previous, Date.now(), remaining);
  runtime.actorKey = actorKey(token);
  runtime.icon = (item?identify(item).preset?.icon:null) ?? (config.mode==='disposable'?'candle':'lantern');
  const spent = [];
  try {
    // First use freezes the recognized template so later library edits cannot refill a running lamp.
    if (item && identify(item).origin==='recognized') await saveConfig(item,config);
    if (!resume && config.mode === 'disposable') { await updateQuantity(item,-1); spent.push(item); }
    if (config.ignitionMode === 'consume') { await updateQuantity(ignitionItem,-1); spent.push(ignitionItem); }
    runtime.lastAt = Date.now();
    await updateToken(token,{light:lightData(config), [`flags.${NS}.active`]:runtime,
      [`flags.${NS}.lastItemId`]:itemId,
      [`flags.${NS}.stowed`]:null,
      [`flags.${NS}.stowedSources`]:stowedStates(token).filter(s => s.itemId !== itemId)});
  } catch(error) {
    // Best-effort rollback if document update failed after inventory decrements.
    for (const resource of spent.reverse()) await updateQuantity(resource,1).catch(console.error);
    throw error;
  }
  return `Зажжён: ${runtime.itemName}.`;
}

/** Settle elapsed time before extinguishing, including fuel expiry during the action. */
async function switchOff(token) {
  if (!activeState(token)) throw new Error('У персонажа нет включённого источника.');
  const expired = await settle(token);
  if (expired) return 'Источник света погас.';
  await turnOff(token, activeState(token));
  return 'Источник света выключен.';
}

/** Refill the actual tank holder, preserving both stock and fuel if the token write fails. */
async function refill(token, itemId) {
  const actor = token.actor;
  const item = actor.items.get(itemId);
  if (!item) throw new Error('Предмет не найден.');
  let config = getConfig(item);
  if (!config.enabled || config.mode !== 'tank') throw new Error('Этот предмет нельзя заправлять.');
  const fuel = resourceFor(actor,config.refillResource,config.refillItem,item.id);
  if (!fuel) throw new Error(`Нужен запас топлива: «${resourceLabel(config.refillResource,config.refillItem)}».`);
  const holder = runningTank(token, itemId);
  if (holder) {
    const expired = await settle(holder);
    if (expired) config = getConfig(item);
  }
  config = getConfig(item);
  if (getQuantity(item) < 1) throw new Error('Источник света отсутствует в инвентаре.');
  if (config.remainingSeconds >= config.capacitySeconds) throw new Error('Бак уже полный.');
  await updateQuantity(fuel,-1);
  const appliedAt = Date.now();
  const runtime = holder ? activeState(holder) : null;
  const remaining = runtime ? remainingAt(runtime,appliedAt) : config.remainingSeconds;
  const result = Math.min(config.capacitySeconds, remaining + config.refillSeconds);
  const before = clone(config);
  try {
    config.remainingSeconds = result;
    await saveConfig(item,config);
    if (runtime?.itemId === itemId) {
      runtime.remainingSeconds = result;
      runtime.lastAt = appliedAt;
      if (result>runtime.config.lowFuelSeconds) runtime.lowFuelWarned=false;
      await updateToken(holder,{[`flags.${NS}.active`]:runtime});
    }
  } catch(error) {
    await saveConfig(item,before).catch(console.error);
    await updateQuantity(fuel,1).catch(console.error);
    throw error;
  }
  return `Заправлен: ${item.name}. Осталось ${displayTime(result)}.`;
}

/** Toggle emission without stopping the fuel clock. */
async function shutter(token) {
  if (!activeState(token)?.config.shutter) throw new Error('У источника нет шторок.');
  if (await settle(token)) return 'Источник света погас.';
  const runtime=activeState(token); runtime.shutterClosed=!runtime.shutterClosed;
  await updateToken(token,{light:runtime.shutterClosed?{...lightData(runtime.config),bright:0,dim:0}:lightData(runtime.config),[`flags.${NS}.active`]:runtime});
  return runtime.shutterClosed?'Шторки закрыты. Топливо продолжает расходоваться.':'Шторки открыты.';
}
/** Apply a bounded GM time correction without spending inventory resources. */
async function adjustTime(token,delta) {
  if (!Number.isFinite(delta) || Math.abs(delta)>86400) throw new Error('Некорректная поправка времени.');
  if (!activeState(token) || activeState(token).config.mode==='infinite') throw new Error('Нужен работающий источник с конечным запасом.');
  if (await settle(token)) return 'Источник уже погас. Заправьте или зажгите его заново.';
  const runtime=activeState(token); const item=token.actor.items.get(runtime.itemId);
  const before=item?getConfig(item):null;
  runtime.remainingSeconds=Math.max(0,Math.min(runtime.config.capacitySeconds,runtime.remainingSeconds+delta));
  if (runtime.remainingSeconds>runtime.config.lowFuelSeconds) runtime.lowFuelWarned=false;
  try {
    if (runtime.remainingSeconds<=0) await turnOff(token,runtime,{expired:true});
    else {
      if(runtime.config.mode==='tank' && item) await saveConfig(item,{...before,remainingSeconds:runtime.remainingSeconds});
      await updateToken(token,{[`flags.${NS}.active`]:runtime});
    }
  } catch(error) { if(before && runtime.config.mode==='tank') await saveConfig(item,before).catch(console.error); throw error; }
  return `Осталось ${displayTime(runtime.remainingSeconds)}.`;
}

/** Recheck authority and ownership inside the inventory queue before applying an action. */
async function doAction(request, userId) {
  if (!isAuthority()) throw new Error('Управление передано другому ГМу. Повторите действие.');
  if (!request || typeof request !== 'object') throw new Error('Некорректный запрос.');
  const user = game.users.get(userId);
  const token = resolveToken(request.sceneId, request.tokenId);
  if (!canOperate(user, token)) throw new Error('Нет доступа к этому токену.');
  if (!['on','off','refill','switch','shutter','adjust'].includes(request.action)) throw new Error('Неизвестное действие.');
  if (request.action==='adjust' && !user.isGM) throw new Error('Время корректирует ГМ.');
  return withLock(token, async () => {
    if (!isAuthority() || !canOperate(game.users.get(userId),token)) throw new Error('Нет доступа к этому токену.');
    if (request.action === 'on') return activate(token, request.itemId);
    if (request.action === 'off') return switchOff(token);
    if (request.action === 'switch') {
      if (activeState(token)?.itemId===request.itemId) return 'Этот источник уже горит.';
      activationPlan(token,request.itemId);
      if (activeState(token)) await switchOff(token);
      return activate(token,request.itemId);
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
  const request = {action, itemId, sceneId:token.parent.id, tokenId:token.id,...(action==='adjust'?{deltaSeconds:options.deltaSeconds}: {})};
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
  return state?{...state,remainingSeconds:state.config.mode==='infinite'?null:remainingAt(state)}:null;
}
/** Build inventory availability on demand; it is not part of the one-second clock path. */
function viewModel(token) {
  const active=activeView(token);
  const sources=[];
  if(token?.actor) {
    const stowed=stowedStates(token);
    for(const item of availableItems(token.actor)) {
      if(stowed.some(s=>s.itemId===item.id)) continue;
      const identified=identify(item); const c=identified.config;
      const holder=c.mode==='tank'?runningTank(token,item.id):null;
      let blocked='';
      if(getQuantity(item)<1) blocked='Нужна целая единица предмета';
      else if(c.mode!=='infinite' && c.remainingSeconds<=0) blocked='Сначала заправьте источник';
      else if(holder && holder!==token) blocked='Источник на другом токене';
      else if(c.ignitionMode!=='self' && !resourceFor(token.actor,c.ignitionResource,c.ignitionItem,item.id)) blocked='Нет розжига: '+resourceLabel(c.ignitionResource,c.ignitionItem);
      const fuel=resourceFor(token.actor,c.refillResource,c.refillItem,item.id);
      const current=active?.itemId===item.id;
      const remaining=current?active.remainingSeconds:c.remainingSeconds;
      sources.push({id:item.id,name:item.name,icon:identified.preset?.icon ?? (c.mode==='disposable'?'candle':'lantern'),
        active:current,blocked:current?'':blocked,detail:c.mode==='infinite'?'Без расхода':c.mode==='disposable'?
          (current?'Горит · '+displayTime(remaining)+' · запас ×'+getQuantity(item):'Запас ×'+getQuantity(item)+' · по '+displayTime(c.remainingSeconds)):displayTime(remaining),
        originLabel:identified.origin==='recognized'?'Шаблон: '+identified.preset.label:identified.preset?.label ?? 'Свои настройки',
        timeLabel:displayTime(remaining),stockLabel:current && c.mode==='disposable'?' · запас ×'+getQuantity(item):'',fuelMissing:!fuel,
        refillable:c.mode==='tank',refillBlocked:!fuel?'Нет топлива: '+resourceLabel(c.refillResource,c.refillItem):remaining>=c.capacitySeconds?'Бак полный':'',
        refillHint:'1 шт. '+resourceLabel(c.refillResource,c.refillItem)+' → '+displayTime(c.refillSeconds)});
    }
    for(const s of stowed) {
      const c=normalizeConfig(s.config);
      const missing=c.ignitionMode!=='self' && !resourceFor(token.actor,c.ignitionResource,c.ignitionItem,s.itemId);
      sources.push({id:s.itemId,name:s.itemName+' · огарок',icon:'candle',active:false,refillable:false,
        detail:displayTime(s.remainingSeconds),originLabel:'Уже списан из стопки',blocked:missing?'Нет розжига: '+resourceLabel(c.ignitionResource,c.ignitionItem):''});
    }
    // A burning disposable may have consumed the last unit in the inventory.
    if(active && !sources.some(s=>s.id===active.itemId)) sources.unshift({id:active.itemId,name:active.itemName,icon:active.icon ?? 'candle',active:true,detail:displayTime(active.remainingSeconds),originLabel:'Горящий экземпляр',refillable:false});
  }
  return {tokenName:token?.name,active,sources,gm:game.user.isGM,paused:game.paused,authority:!!leadGM(),canOperate:canOperate(game.user,token)};
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
  const last=doc.getFlag(NS,'lastItemId');
  const sources=availableItems(doc.actor);
  const chosen=itemId || stowedStates(doc)[0]?.itemId || sources.find(i=>i.id===last)?.id || sources[0]?.id;
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
  for(const token of [...activeSources.values()]) {
    try { await withLock(token,()=>settle(token)); }
    catch(error) { console.error('['+NS+'] Ошибка восстановления таймера',error); }
  }
}
/** Movement and unrelated token edits do not read runtime flags or rebuild any panel. */
function onTokenUpdate(token,changes) {
  const paths=changedPaths(changes);
  if(paths.some(path=>path.startsWith('flags.'+NS+'.active') || ['actorId','actorLink','delta'].some(key=>path===key || path.startsWith(key+'.')))) {
    activeSources.sync(token); updateHeartbeat(); prunePauseHistory();
  }
  if(isAuthority() && paths.some(path=>['actorId','actorLink'].includes(path))) {
    const state=token.getFlag(NS,'active');
    if(state && state.actorKey!==actorKey(token)) void withLock(token,()=>settle(token)).catch(console.error);
  }
  windows?.refresh({type:'token',document:token,changes});
}
/** Inventory changes only affect their owning panel; invalid sources also stop during pause. */
function onItemUpdate(item,changes={},options={}) {
  windows?.refresh({type:'item',document:item,changes});
  if(!isAuthority() || isClockUpdate(changes)) return;
  const paths=changedPaths(changes);
  if(!options.deleted && !paths.some(path=>path==='system.quantity' || path.startsWith('flags.'+NS+'.light.enabled'))) return;
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
  for(const resource of library.resources) data.push({name:resource.names[0] ?? resource.label,type:'gear',system:{quantity:resource.id==='matches'?8:3}});
  const created = await Item.createDocuments(data);
  info(`Создано ${created.length} примеров в справочнике предметов. Их можно перетаскивать в Item Piles.`);
  return created;
}

Hooks.once('init',()=>{
  game.settings.register(NS,'expiryChat',{name:'Оповещать о погасших источниках',hint:'Сообщение в чат при автоматическом окончании топлива.',scope:'world',config:true,type:Boolean,default:true});
  game.settings.register(NS,'allowPlayers',{name:'Разрешить игрокам управлять своим светом',scope:'world',config:true,type:Boolean,default:true});
  game.settings.register(NS,'autoRecognize',{name:'Распознавать источники по библиотеке',hint:'Предмет без своих настроек использует первый совпавший шаблон. При первом зажигании настройки закрепляются в предмете.',scope:'world',config:true,type:Boolean,default:true,onChange:()=>windows?.refresh()});
  game.settings.register(NS,'lowFuelNotify',{name:'Предупреждать о малом запасе',hint:'Одно сообщение владельцам и ГМу при достижении порога источника. Скрытые токены видят только ГМы.',scope:'world',config:true,type:Boolean,default:true});
  game.settings.register(NS,'catalog',{scope:'world',config:false,type:Object,default:defaultCatalog(),onChange:()=>{presetIndex=null;windows?.refresh();}});
  windows=createInterface({catalog,identify,viewModel,active:activeView,timeLabel:displayTime,clockRunning:()=>!game.paused,resolveToken,action:requestAction,isGM:()=>game.user.isGM,info,warning,
    async saveItem(item,config) { await saveConfig(item,config); windows.refresh(); info(`Настройки «${item.name}» сохранены.`); },
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
  Hooks.on('createToken',token=>{activeSources.sync(token);updateHeartbeat();windows.refresh({type:'token',document:token,changes:{flags:{[NS]:{active:token.getFlag(NS,'active')}}}});});
  Hooks.on('deleteToken',token=>{activeSources.remove(token);updateHeartbeat();windows.refresh({type:'deletedToken',document:token});});
  Hooks.on('createScene',scene=>{for(const token of scene.tokens.contents) activeSources.sync(token);updateHeartbeat();});
  Hooks.on('deleteScene',scene=>{activeSources.removeScene(scene);updateHeartbeat();windows.refresh({type:'scene',document:scene});});
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
    if (!runtime && !stowedStates(token).length) return;
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
    library:id=>windows.openLibrary(id),getCatalog:catalog,
    async applyPreset(item,id) {
      if(!game.user.isGM) throw new Error('Шаблон применяет ГМ.');
      const preset=presets().sourcesById.get(id); if(!preset) throw new Error('Шаблон не найден.');
      await saveConfig(item,{...preset.config,remainingSeconds:preset.config.capacitySeconds}); windows.refresh();
    }};
  await resumeOnAuthorityChange();
  Hooks.on('userConnected',resumeOnAuthorityChange);
  Hooks.on('updateUser',(_user,changes)=>{if('role' in changes || 'active' in changes) return resumeOnAuthorityChange();});
});
Hooks.once('shutdown',()=>{
  ready=false;
  if(heartbeat!==null)clearInterval(heartbeat);
  heartbeat=null; activeSources.clear(); presetIndex=null;
  void windows?.close();
  for (const wait of pending.values()) {
    clearTimeout(wait.timeout); wait.reject(new Error('Соединение с миром закрыто.'));
  }
  pending.clear();
});
