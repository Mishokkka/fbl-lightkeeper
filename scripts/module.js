import { MODULE_ID as NS, normalizeConfig, lightData, tickRemaining, displayTime, getQuantity, findNamedItem, makeRuntime } from './logic.js';

const DIALOG = () => foundry.applications.api.DialogV2;
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

function leadGM() {
  return game.users.filter(u => u.isGM && u.active).sort((a,b) => a.id.localeCompare(b.id))[0] ?? null;
}
function isAuthority() {
  const next = leadGM()?.id ?? null;
  if (next !== authorityId) {
    authorityId = next;
    authoritySince = Date.now();
  }
  return next === game.user.id;
}
function getConfig(item) { return normalizeConfig(item?.getFlag(NS, 'light') ?? {}); }
// getFlag returns live document data. Never mutate it before update succeeds.
function activeState(token) { return clone(token.getFlag(NS, 'active') ?? null); }
function stowedStates(token) {
  const saved = clone(token.getFlag(NS, 'stowedSources') ?? []);
  const legacy = token.getFlag(NS, 'stowed');
  if (legacy && !saved.some(s => s.itemId === legacy.itemId)) saved.push(clone(legacy));
  return saved.filter(s => s.remainingSeconds > 0);
}
function availableItems(actor) { return actor?.items.filter(i => getConfig(i).enabled && getQuantity(i) > 0) ?? []; }
function canOperate(user, token) { return !!(user?.active && token?.actor && (user.isGM || (game.settings.get(NS,'allowPlayers') && token.actor.testUserPermission(user, 'OWNER')))); }
function resolveToken(sceneId, tokenId) { return game.scenes.get(sceneId)?.tokens.get(tokenId) ?? null; }
function sceneTokens() { return game.scenes.contents.flatMap(s => s.tokens.contents); }
function actorKey(token) {
  return token.actor?.uuid ?? (token.actorLink === false
    ? `Scene.${token.parent.id}.Token.${token.id}.Actor.${token.actor?.id}` : `Actor.${token.actor?.id}`);
}
function lockKey(token) { return actorKey(token); }
async function withLock(token, callback) {
  const key = lockKey(token);
  const previous = locks.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(callback);
  locks.set(key, task);
  try { return await task; } finally { if (locks.get(key) === task) locks.delete(key); }
}
function runningTank(token, itemId) {
  return sceneTokens().find(t => actorKey(t) === actorKey(token) &&
    activeState(t)?.config.mode === 'tank' && activeState(t)?.itemId === itemId);
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
async function updateQuantity(item, change) {
  const current = getQuantity(item);
  if (current + change < 0) throw new Error(`Недостаточно предметов: «${item.name}».`);
  if (!await item.update({'system.quantity': current + change})) throw new Error(`Изменение количества «${item.name}» отменено.`);
}
function previousLight(token) {
  return token.light?.toObject?.() ?? foundry.utils.deepClone(token.toObject().light ?? {});
}
function clone(x) { return foundry.utils.deepClone(x); }
function isDisposable(runtime) { return runtime?.config?.mode === 'disposable'; }
async function saveConfig(item, config) {
  if (!await item.setFlag(NS,'light',config)) throw new Error(`Сохранение «${item.name}» отменено.`);
}
async function updateToken(token, changes) {
  if (!await token.update(changes)) throw new Error('Изменение света токена отменено.');
}

async function turnOff(token, runtime, {expired = false, discard = false} = {}) {
  const item = token.actor?.items.get(runtime.itemId);
  if (runtime.config.mode === 'tank' && item && runtime.actorKey === actorKey(token)) {
    const c = getConfig(item); c.remainingSeconds = Math.max(0, runtime.remainingSeconds ?? 0);
    await saveConfig(item,c);
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
  if (runtime.config.mode === 'tank' && item && changed) {
    const c = getConfig(item); c.remainingSeconds = runtime.remainingSeconds;
    await saveConfig(item,c);
  }
  if (runtime.remainingSeconds <= 0) { await turnOff(token, runtime, {expired: true}); return true; }
  if (changed || clockChanged) await updateToken(token,{[`flags.${NS}.active`]:runtime});
  return false;
}

async function activate(token, itemId) {
  if (activeState(token)) throw new Error('Сначала погасите текущий источник света.');
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
    ignitionItem = findNamedItem(actor, config.ignitionItem, itemId);
    if (!ignitionItem) throw new Error(`Для включения нужен предмет «${config.ignitionItem || 'не указан'}».`);
  }
  const previous = previousLight(token);
  const runtime = makeRuntime(item ?? {id:itemId,name:stowed.itemName,parent:actor}, config, previous, Date.now(), remaining);
  runtime.actorKey = actorKey(token);
  const spent = [];
  try {
    if (!resume && config.mode === 'disposable') { await updateQuantity(item,-1); spent.push(item); }
    if (config.ignitionMode === 'consume') { await updateQuantity(ignitionItem,-1); spent.push(ignitionItem); }
    runtime.lastAt = Date.now();
    await updateToken(token,{light:lightData(config), [`flags.${NS}.active`]:runtime,
      [`flags.${NS}.stowed`]:null,
      [`flags.${NS}.stowedSources`]:stowedStates(token).filter(s => s.itemId !== itemId)});
  } catch(error) {
    // Best-effort rollback if document update failed after inventory decrements.
    for (const resource of spent.reverse()) await updateQuantity(resource,1).catch(console.error);
    throw error;
  }
  return `Зажжён: ${runtime.itemName}.`;
}

async function switchOff(token) {
  if (!activeState(token)) throw new Error('У персонажа нет включённого источника.');
  const expired = await settle(token);
  if (expired) return 'Источник света погас.';
  await turnOff(token, activeState(token));
  return 'Источник света выключен.';
}

async function refill(token, itemId) {
  const actor = token.actor;
  const item = actor.items.get(itemId);
  if (!item) throw new Error('Предмет не найден.');
  let config = getConfig(item);
  if (!config.enabled || config.mode !== 'tank') throw new Error('Этот предмет нельзя заправлять.');
  const fuel = findNamedItem(actor, config.refillItem, item.id);
  if (!fuel) throw new Error(`Нужен запас топлива: «${config.refillItem || 'не задан'}».`);
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
      await updateToken(holder,{[`flags.${NS}.active`]:runtime});
    }
  } catch(error) {
    await saveConfig(item,before).catch(console.error);
    await updateQuantity(fuel,1).catch(console.error);
    throw error;
  }
  return `Заправлен: ${item.name}. Осталось ${displayTime(result)}.`;
}

async function doAction(request, userId) {
  if (!isAuthority()) throw new Error('Управление передано другому ГМу. Повторите действие.');
  if (!request || typeof request !== 'object') throw new Error('Некорректный запрос.');
  const user = game.users.get(userId);
  const token = resolveToken(request.sceneId, request.tokenId);
  if (!canOperate(user, token)) throw new Error('Нет доступа к этому токену.');
  if (!['on','off','refill'].includes(request.action)) throw new Error('Неизвестное действие.');
  return withLock(token, async () => {
    if (!isAuthority() || !canOperate(game.users.get(userId),token)) throw new Error('Нет доступа к этому токену.');
    if (request.action === 'on') return activate(token, request.itemId);
    if (request.action === 'off') return switchOff(token);
    return refill(token, request.itemId);
  });
}
async function requestAction(token, action, itemId = '') {
  const gm = leadGM();
  if (!gm) { warning('Для управления светом необходим подключённый ГМ.'); return; }
  const request = {action, itemId, sceneId:token.parent.id, tokenId:token.id};
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
    return result;
  } catch(e) { warning(e.message); console.error(`[${NS}]`,e); return null; }
}

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

function input(name, label, value, type='text', extras='') {
  return `<label>${escapeHtml(label)}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${extras}></label>`;
}
function select(name,label,value,items) {
  return `<label>${escapeHtml(label)}<select name="${name}">${items.map(([k,l]) => `<option value="${k}" ${value===k?'selected':''}>${escapeHtml(l)}</option>`).join('')}</select></label>`;
}
async function configureItem(item) {
  if (!game.user.isGM) return warning('Только ГМ может настраивать источники света.');
  if (item?.documentName !== 'Item') return warning('Сначала откройте карточку предмета.');
  const c = getConfig(item);
  const content = `<div class="fbl-lk-dialog">
    <p><strong>${escapeHtml(item.name)}</strong> · настройки сохраняются в самом предмете и передаются через Item Piles.</p>
    <label class="lk-check"><input type="checkbox" name="enabled" ${c.enabled?'checked':''}> Это источник света</label>
    <div class="lk-section">Свет</div><div class="lk-grid">
      ${input('bright','Яркий свет (ед. сцены)',c.bright,'number','min="0" max="200" step="0.5"')}
      ${input('dim','Тусклый свет (ед. сцены)',c.dim,'number','min="0" max="200" step="0.5"')}
      ${input('angle','Угол луча (1–360°)',c.angle,'number','min="1" max="360"')}
      ${input('color','Цвет, например #ffba70',c.color,'text','pattern="#[A-Fa-f0-9]{6}"')}
      ${input('alpha','Непрозрачность цвета (0–1)',c.alpha,'number','min="0" max="1" step="0.05"')}
      ${select('animation','Анимация',c.animation,[['none','Нет'],['torch','Факел'],['pulse','Пульсация'],['flame','Пламя'],['chroma','Цветовая']])}
      ${input('animationSpeed','Скорость (1–10)',c.animationSpeed,'number','min="1" max="10"')}
      ${input('animationIntensity','Интенсивность (1–10)',c.animationIntensity,'number','min="1" max="10"')}
    </div><div class="lk-section">Расход</div><div class="lk-grid">
      ${select('mode','Тип расхода',c.mode,[['infinite','Без ограничений'],['tank','Бак / заряд'],['disposable','Одноразовый (списать 1 при первом включении)']])}
      ${input('capacitySeconds','Полное время работы (сек.)',c.capacitySeconds,'number','min="1" max="604800"')}
      ${input('remainingSeconds','Текущий остаток (сек.)',c.remainingSeconds,'number','min="0" max="604800" step="any"')}
      ${input('refillItem','Название заправки из инвентаря',c.refillItem)}
      ${input('refillSeconds','Секунд за 1 заправку',c.refillSeconds,'number','min="1" max="604800"')}
    </div><div class="lk-section">Зажигание</div><div class="lk-grid">
      ${select('ignitionMode','Способ включения',c.ignitionMode,[['self','Включается сам'],['require','Требуется предмет (не расходуется)'],['consume','Требуется предмет (расход 1 шт.)']])}
      ${input('ignitionItem','Точное название предмета розжига',c.ignitionItem)}
    </div><p class="lk-help">Тип «Бак»: остаток хранится в предмете. «Одноразовый»: 1 штука списывается при первом включении, оставшийся огарок можно повторно зажечь тем же токеном. При паузе и выключении расход останавливается. Настройка начального остатка применима к новым или выключенным источникам.</p></div>`;
  const result = await DIALOG().prompt({window:{title:`Источник света: ${item.name}`},content,
    ok:{label:'Сохранить',callback:(_event,button)=>{
      const f=button.form;
      const value=name=>f.elements.namedItem(name)?.value;
      return normalizeConfig({
        enabled:f.elements.namedItem('enabled')?.checked,
        mode:value('mode'),capacitySeconds:value('capacitySeconds'),remainingSeconds:value('remainingSeconds'),
        refillItem:value('refillItem'),refillSeconds:value('refillSeconds'),
        ignitionMode:value('ignitionMode'),ignitionItem:value('ignitionItem'),
        bright:value('bright'),dim:value('dim'),angle:value('angle'),color:value('color'),alpha:value('alpha'),
        animation:value('animation'),animationSpeed:value('animationSpeed'),animationIntensity:value('animationIntensity')
      });
    }},rejectClose:false});
  if (!result) return;
  await saveConfig(item,result);
  info(`Параметры «${item.name}» сохранены.`);
}

async function openTokenMenu(token = canvas?.tokens?.controlled?.[0]) {
  if (!token?.document || !token.actor) return warning('Выберите токен персонажа.');
  if (!canOperate(game.user,token.document)) return warning('Вы не управляете этим персонажем.');
  const doc=token.document, runtime=activeState(doc), stowed=stowedStates(doc);
  const items=availableItems(token.actor);
  let radios = items.map(item => {
    const c = getConfig(item);
    const time = c.mode==='infinite'?'∞':displayTime(runtime?.itemId === item.id ? remainingAt(runtime) : c.remainingSeconds);
    if (stowed.some(s => s.itemId === item.id)) return '';
    return `<label class="lk-source"><input type="radio" name="itemId" value="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.name)}</strong><small>×${getQuantity(item)} · ${escapeHtml(c.mode==='tank'?'Остаток: '+time:c.mode==='disposable'?'Одноразовый, '+displayTime(c.capacitySeconds):'Безлимитный')}</small></span></label>`;
  }).join('');
  for (const source of stowed) radios += `<label class="lk-source"><input type="radio" name="itemId" value="${escapeHtml(source.itemId)}"><span><strong>${escapeHtml(source.itemName)} (огарок)</strong><small>Осталось ${displayTime(source.remainingSeconds)}</small></span></label>`;
  if (!radios) radios='<p>В инвентаре пока нет настроенных источников света.</p>';
  const current=runtime ? `<p><strong>Включено:</strong> ${escapeHtml(runtime.itemName)}<br>Остаток: ${runtime.config.mode==='infinite'?'∞':displayTime(remainingAt(runtime))}</p>` : '<p>Свет выключен.</p>';
  const content=`<div class="fbl-lk-dialog">${current}<div class="lk-section">Инвентарь</div>${radios}<p class="lk-help">Выберите предмет, затем «Включить» или «Заправить». Настройки предметов редактирует ГМ в карточке предмета.</p></div>`;
  const result=await DIALOG().wait({window:{title:`Свет · ${token.name}`},content,buttons:[
    {action:'on',label:'Включить',icon:'fas fa-fire',callback:(_event,button)=>({action:'on',itemId:button.form.querySelector('input[name="itemId"]:checked')?.value})},
    {action:'off',label:'Выключить',icon:'fas fa-power-off',callback:()=>({action:'off'})},
    {action:'refill',label:'Заправить',icon:'fas fa-gas-pump',callback:(_event,button)=>({action:'refill',itemId:button.form.querySelector('input[name="itemId"]:checked')?.value})},
    {action:'close',label:'Закрыть'}
  ],rejectClose:false});
  if (!result || typeof result !== 'object') return;
  if (result.action !== 'off' && !result.itemId) return warning('Выберите предмет.');
  await requestAction(doc,result.action,result.itemId ?? '');
}

function installHUD(app, html) {
  const token=app.object;
  if (!token?.actor || !canOperate(game.user,token.document)) return;
  const root=html instanceof HTMLElement?html:(app.element ?? null);
  const holder=root?.querySelector('.col.right') ?? root?.querySelector('.col.left') ?? root;
  if (!holder || holder.querySelector('.fbl-lk-token-button')) return;
  const button=document.createElement('div');
  button.className='control-icon fbl-lk-token-button';
  button.title='Источник света · открыть управление';
  button.innerHTML='<i class="fas fa-lightbulb"></i>';
  button.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();void openTokenMenu(token);});
  holder.append(button);
}

async function heartbeatTick() {
  if (!isAuthority()) return;
  for (const token of sceneTokens()) {
    if (!activeState(token)) continue;
    if (locks.has(lockKey(token))) continue;
    try { await withLock(token,()=>settle(token)); }
    catch (error) {
      if (!errors.has(token.uuid ?? token.id)) { console.error(`[${NS}] Ошибка таймера:`, token.name, error); errors.add(token.uuid ?? token.id); }
    }
  }
}
async function onPause(paused) {
  pauseHistory.push({at:Date.now(),paused});
  if (!isAuthority()) return;
  for (const token of sceneTokens()) {
    if (!activeState(token)) continue;
    try { await withLock(token,()=>settle(token)); }
    catch(error) { console.error(`[${NS}] Ошибка переключения паузы`,error); }
  }
}
async function resumeOnAuthorityChange() {
  if (!isAuthority()) return;
  for (const token of sceneTokens()) {
    if (!activeState(token) || locks.has(lockKey(token))) continue;
    // remainingAt excludes time before this GM actually took authority.
    try { await withLock(token,()=>settle(token)); }
    catch(error) { console.error(`[${NS}] Ошибка восстановления таймера`,error); }
  }
}

/** Creates only world-item templates. Nothing is added to actors, scenes, or Item Piles automatically. */
async function createExamples() {
  if (!game.user.isGM) throw new Error('Эту функцию может вызвать только ГМ.');
  const presets = [
    ['Огарок свечи', {mode:'disposable',capacitySeconds:600,dim:2,bright:1,angle:360,animation:'torch',ignitionMode:'consume',ignitionItem:'Спички'}],
    ['Свеча', {mode:'disposable',capacitySeconds:1800,dim:3,bright:1,ignitionMode:'consume',ignitionItem:'Спички'}],
    ['Масляная лампа', {mode:'tank',capacitySeconds:2400,dim:5,bright:3,refillItem:'Ламповое масло',refillSeconds:1200,ignitionMode:'consume',ignitionItem:'Спички'}],
    ['Фонарь со шторками', {mode:'tank',capacitySeconds:2400,dim:6,bright:4,refillItem:'Ламповое масло',refillSeconds:1200,ignitionMode:'consume',ignitionItem:'Спички'}],
    ['Карманный фонарик', {mode:'tank',capacitySeconds:900,dim:6,bright:3,angle:75,color:'#e8f0ff',animation:'none',refillItem:'Батарейка',refillSeconds:900}],
    ['Мощный фонарик', {mode:'tank',capacitySeconds:600,dim:10,bright:6,angle:50,color:'#f2f6ff',animation:'none',refillItem:'Батарейка',refillSeconds:600}],
  ];
  const data = presets.map(([name,c])=>({name,type:'gear',system:{quantity:1},flags:{[NS]:{light:normalizeConfig({enabled:true,...c})}}}));
  data.push(
    {name:'Спички',type:'gear',system:{quantity:8}},
    {name:'Ламповое масло',type:'gear',system:{quantity:3}},
    {name:'Батарейка',type:'gear',system:{quantity:2}}
  );
  const created = await Item.createDocuments(data);
  info(`Создано ${created.length} примеров в справочнике предметов. Их можно перетаскивать в Item Piles.`);
  return created;
}

Hooks.once('init',()=>{
  game.settings.register(NS,'expiryChat',{name:'Оповещать о погасших источниках',hint:'Сообщение в чат при автоматическом окончании топлива.',scope:'world',config:true,type:Boolean,default:true});
  game.settings.register(NS,'allowPlayers',{name:'Разрешить игрокам управлять своим светом',scope:'world',config:true,type:Boolean,default:true});
  Hooks.on('getSceneControlButtons',controls=>{
    if (!controls.tokens?.tools) return;
    controls.tokens.tools['fbl-lightkeeper']={name:'fbl-lightkeeper',title:'Управление светом выбранного токена',icon:'fas fa-lightbulb',order:Object.keys(controls.tokens.tools).length,button:true,visible:true,onChange:()=>void openTokenMenu()};
  });
  Hooks.on('getHeaderControlsApplicationV2',(app,controls)=>{
    if (app.document?.documentName !== 'Item' || !game.user?.isGM) return;
    controls.push({action:'fbl-lightkeeper-config',label:'Свет / топливо',icon:'fas fa-lightbulb',onClick:()=>configureItem(app.document)});
  });
  Hooks.on('getItemSheetHeaderButtons',(app,buttons)=>{
    if (!game.user?.isGM) return;
    buttons.unshift({class:'fbl-lightkeeper',label:'Свет',icon:'fas fa-lightbulb',onclick:()=>configureItem(app.object ?? app.item)});
  });
  Hooks.on('renderTokenHUD',installHUD);
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
  // A small public API for macros and other modules.
  game.modules.get(NS).api={open:openTokenMenu,configure:configureItem,requestAction,createExamples};
  heartbeat=setInterval(heartbeatTick,5000);
  await resumeOnAuthorityChange();
  Hooks.on('userConnected',resumeOnAuthorityChange);
});
Hooks.once('shutdown',()=>{
  if(heartbeat)clearInterval(heartbeat);
  for (const wait of pending.values()) {
    clearTimeout(wait.timeout); wait.reject(new Error('Соединение с миром закрыто.'));
  }
  pending.clear();
});
