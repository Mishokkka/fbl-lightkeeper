import { MODULE_ID as NS, normalizeConfig, lightData, tickRemaining, displayTime, getQuantity, findNamedItem, makeRuntime } from './logic.js';

const DIALOG = () => foundry.applications.api.DialogV2;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const warning = message => ui.notifications.warn(`[Lightkeeper] ${message}`);
const info = message => ui.notifications.info(`[Lightkeeper] ${message}`);
const errors = new Set();
const locks = new Set();
let heartbeat = null;

function leadGM() {
  return game.users.filter(u => u.isGM && u.active).sort((a,b) => a.id.localeCompare(b.id))[0] ?? null;
}
function isAuthority() { return leadGM()?.id === game.user.id; }
function getConfig(item) { return normalizeConfig(item?.getFlag(NS, 'light') ?? {}); }
function activeState(token) { return token.getFlag(NS, 'active') ?? null; }
function stowedState(token) { return token.getFlag(NS, 'stowed') ?? null; }
function availableItems(actor) { return actor?.items.filter(i => getConfig(i).enabled && getQuantity(i) > 0) ?? []; }
function canOperate(user, token) { return !!(user && token?.actor && (user.isGM || (game.settings.get(NS,'allowPlayers') && token.actor.testUserPermission(user, 'OWNER')))); }
function resolveToken(sceneId, tokenId) { return game.scenes.get(sceneId)?.tokens.get(tokenId) ?? null; }
function sceneTokens() { return game.scenes.contents.flatMap(s => s.tokens.contents); }
function lockKey(token) { return `${token.parent?.id ?? ''}:${token.id}`; }
async function withLock(token, callback) {
  const key = lockKey(token);
  if (locks.has(key)) throw new Error('Источник света уже обрабатывается. Повторите действие.');
  locks.add(key);
  try { return await callback(); } finally { locks.delete(key); }
}
async function updateQuantity(item, change) {
  const current = getQuantity(item);
  if (current + change < 0) throw new Error(`Недостаточно предметов: «${item.name}».`);
  await item.update({'system.quantity': current + change});
}
function previousLight(token) {
  return token.light?.toObject?.() ?? foundry.utils.deepClone(token.toObject().light ?? {});
}
function clone(x) { return foundry.utils.deepClone(x); }
function isDisposable(runtime) { return runtime?.config?.mode === 'disposable'; }

async function turnOff(token, runtime, {expired = false} = {}) {
  const item = token.actor?.items.get(runtime.itemId);
  if (runtime.config.mode === 'tank' && item) {
    const c = getConfig(item); c.remainingSeconds = Math.max(0, runtime.remainingSeconds ?? 0);
    await item.setFlag(NS, 'light', c);
  }
  const stowed = !expired && isDisposable(runtime) && (runtime.remainingSeconds ?? 0) > 0
    ? {itemId:runtime.itemId, itemName:runtime.itemName, config:runtime.config, remainingSeconds:runtime.remainingSeconds}
    : null;
  // A single TokenDocument update keeps restoring light and clearing runtime atomic.
  await token.update({
    light: runtime.previousLight ?? {},
    [`flags.${NS}.active`]: null,
    [`flags.${NS}.stowed`]: stowed
  });
  if (expired && game.settings.get(NS, 'expiryChat')) {
    await ChatMessage.create({content: `<p><strong>Источник света погас:</strong> ${escapeHtml(runtime.itemName)} (${escapeHtml(token.name)}).</p>`});
  }
}

/** Commit elapsed real seconds. Called exclusively by the elected GM. */
async function settle(token, {forceCount = false, resetClock = false} = {}) {
  const runtime = activeState(token);
  if (!runtime) return false;
  const item = token.actor?.items.get(runtime.itemId);
  if (!item && !isDisposable(runtime)) { await turnOff(token, runtime); return true; }
  const now = Date.now();
  if (runtime.config.mode === 'infinite') {
    if (resetClock) await token.update({[`flags.${NS}.active.lastAt`]:now});
    return false;
  }
  const next = resetClock ? runtime.remainingSeconds :
    tickRemaining(runtime.remainingSeconds, runtime.lastAt, now, !forceCount && game.paused);
  const changed = Math.abs(next - runtime.remainingSeconds) >= 0.001;
  runtime.remainingSeconds = Math.max(0, next);
  runtime.lastAt = now;
  if (runtime.config.mode === 'tank' && item && changed) {
    const c = getConfig(item); c.remainingSeconds = runtime.remainingSeconds;
    await item.setFlag(NS, 'light', c);
  }
  if (runtime.remainingSeconds <= 0) { await turnOff(token, runtime, {expired: true}); return true; }
  if (changed || resetClock) await token.update({[`flags.${NS}.active`]:runtime});
  return false;
}

async function activate(token, itemId) {
  if (activeState(token)) throw new Error('Сначала погасите текущий источник света.');
  const actor = token.actor;
  const stowed = stowedState(token);
  let item = actor.items.get(itemId);
  let config;
  let resume = false;
  if (stowed?.itemId === itemId && stowed.remainingSeconds > 0) {
    config = normalizeConfig(stowed.config); resume = true;
  } else {
    if (!item) throw new Error('У персонажа нет такого предмета.');
    config = getConfig(item);
    if (!config.enabled || getQuantity(item) < 1) throw new Error('Источник света недоступен.');
  }
  // Don't allow two linked tokens to drain the same actor item simultaneously.
  if (config.mode === 'tank' && sceneTokens().some(t => t !== token && t.actor?.id === actor.id && activeState(t)?.itemId === itemId)) {
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
  // Spend resources only after all validations. GM serializes actions by token.
  if (!resume && config.mode === 'disposable') await updateQuantity(item,-1);
  if (config.ignitionMode === 'consume') await updateQuantity(ignitionItem,-1);
  try {
    await token.update({light:lightData(config), [`flags.${NS}.active`]:runtime, [`flags.${NS}.stowed`]:null});
  } catch(error) {
    // Best-effort rollback if document update failed after inventory decrements.
    if (!resume && config.mode === 'disposable') await updateQuantity(item,1).catch(console.error);
    if (config.ignitionMode === 'consume') await updateQuantity(ignitionItem,1).catch(console.error);
    throw error;
  }
  return `Зажжён: ${runtime.itemName}.`;
}

async function switchOff(token) {
  if (!activeState(token)) throw new Error('У персонажа нет включённого источника.');
  const expired = await settle(token);
  if (expired) return 'Топливо закончилось.';
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
  if (activeState(token)?.itemId === itemId) {
    const expired = await settle(token);
    if (expired) config = getConfig(item);
  }
  config = getConfig(item);
  if (config.remainingSeconds >= config.capacitySeconds) throw new Error('Бак уже полный.');
  await updateQuantity(fuel,-1);
  const result = Math.min(config.capacitySeconds, config.remainingSeconds + config.refillSeconds);
  try {
    config.remainingSeconds = result;
    await item.setFlag(NS,'light',config);
    const runtime = activeState(token);
    if (runtime?.itemId === itemId) {
      runtime.remainingSeconds = result;
      runtime.lastAt = Date.now();
      await token.update({[`flags.${NS}.active`]:runtime});
    }
  } catch(error) {
    await updateQuantity(fuel,1).catch(console.error);
    throw error;
  }
  return `Заправлен: ${item.name}. Осталось ${displayTime(result)}.`;
}

async function doAction(request, userId) {
  const user = game.users.get(userId);
  const token = resolveToken(request.sceneId, request.tokenId);
  if (!canOperate(user, token)) throw new Error('Нет доступа к этому токену.');
  if (!['on','off','refill'].includes(request.action)) throw new Error('Неизвестное действие.');
  return withLock(token, async () => {
    if (request.action === 'on') return activate(token, request.itemId);
    if (request.action === 'off') return switchOff(token);
    return refill(token, request.itemId);
  });
}
async function requestAction(token, action, itemId = '') {
  const gm = leadGM();
  if (!gm) { warning('Для управления светом необходим подключённый ГМ.'); return; }
  const request = {action, itemId, sceneId:token.parent.id, tokenId:token.id};
  if (isAuthority()) {
    try { info(await doAction(request, game.user.id)); } catch(e) { warning(e.message); console.error(e); }
  } else game.socket.emit(`module.${NS}`,{kind:'request',request, userId:game.user.id});
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
      ${input('alpha','Насыщенность цвета (0–1)',c.alpha,'number','min="0" max="1" step="0.05"')}
      ${select('animation','Анимация',c.animation,[['none','Нет'],['torch','Пламя'],['pulse','Пульсация'],['flickering','Мерцание'],['chroma','Цветовая']])}
      ${input('animationSpeed','Скорость (1–10)',c.animationSpeed,'number','min="1" max="10"')}
      ${input('animationIntensity','Интенсивность (1–10)',c.animationIntensity,'number','min="1" max="10"')}
    </div><div class="lk-section">Расход</div><div class="lk-grid">
      ${select('mode','Тип расхода',c.mode,[['infinite','Без ограничений'],['tank','Бак / заряд'],['disposable','Одноразовый (списать 1 при первом включении)']])}
      ${input('capacitySeconds','Полное время работы (сек.)',c.capacitySeconds,'number','min="1" max="604800"')}
      ${input('remainingSeconds','Текущий остаток (сек.)',Math.round(c.remainingSeconds),'number','min="0" max="604800"')}
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
  await item.setFlag(NS,'light',result);
  info(`Параметры «${item.name}» сохранены.`);
}

async function openTokenMenu(token = canvas?.tokens?.controlled?.[0]) {
  if (!token?.document || !token.actor) return warning('Выберите токен персонажа.');
  if (!canOperate(game.user,token.document)) return warning('Вы не управляете этим персонажем.');
  const doc=token.document, runtime=activeState(doc), stowed=stowedState(doc);
  const items=availableItems(token.actor);
  let radios = items.map(item => {
    const c = getConfig(item);
    const time = c.mode==='infinite'?'∞':displayTime(c.remainingSeconds);
    return `<label class="lk-source"><input type="radio" name="itemId" value="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.name)}</strong><small>×${getQuantity(item)} · ${escapeHtml(c.mode==='tank'?'Остаток: '+time:c.mode==='disposable'?'Одноразовый, '+displayTime(c.capacitySeconds):'Безлимитный')}</small></span></label>`;
  }).join('');
  if (stowed && stowed.remainingSeconds > 0) radios += `<label class="lk-source"><input type="radio" name="itemId" value="${escapeHtml(stowed.itemId)}"><span><strong>${escapeHtml(stowed.itemName)} (огарок)</strong><small>Осталось ${displayTime(stowed.remainingSeconds)}</small></span></label>`;
  if (!radios) radios='<p>В инвентаре пока нет настроенных источников света.</p>';
  const current=runtime ? `<p><strong>Включено:</strong> ${escapeHtml(runtime.itemName)}<br>Остаток: ${runtime.config.mode==='infinite'?'∞':displayTime(tickRemaining(runtime.remainingSeconds,runtime.lastAt,Date.now(),game.paused))}</p>` : '<p>Свет выключен.</p>';
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
  if (!isAuthority() || game.paused) return;
  for (const token of sceneTokens()) {
    if (!activeState(token)) continue;
    if (locks.has(lockKey(token))) continue;
    try { await withLock(token,()=>settle(token)); }
    catch (error) {
      if (!errors.has(token.id)) { console.error(`[${NS}] Ошибка таймера:`, token.name, error); errors.add(token.id); }
    }
  }
}
async function onPause(paused) {
  if (!isAuthority()) return;
  for (const token of sceneTokens()) {
    if (!activeState(token) || locks.has(lockKey(token))) continue;
    try { await withLock(token,()=>settle(token,{forceCount:paused,resetClock:!paused})); }
    catch(error) { console.error(`[${NS}] Ошибка переключения паузы`,error); }
  }
}
async function resumeOnAuthorityChange() {
  if (!isAuthority()) return;
  for (const token of sceneTokens()) {
    if (!activeState(token) || locks.has(lockKey(token))) continue;
    // Do not charge for time elapsed while no authoritative GM client was present.
    try { await withLock(token,()=>settle(token,{resetClock:true})); }
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
  Hooks.on('pauseGame',paused=>{void onPause(paused);});
});
Hooks.once('ready',()=>{
  if (game.system.id !== 'forbidden-lands') console.warn(`[${NS}] Модуль предназначен для Forbidden Lands; система: ${game.system.id}`);
  game.socket.on(`module.${NS}`, async payload=>{
    if (payload?.kind==='result') {
      if (payload.userId===game.user.id) payload.error?warning(payload.error):info(payload.message);
      return;
    }
    if (payload?.kind!=='request' || !isAuthority()) return;
    try {
      const message=await doAction(payload.request,payload.userId);
      game.socket.emit(`module.${NS}`,{kind:'result',userId:payload.userId,message});
    } catch(error) {
      console.error(`[${NS}]`,error);
      game.socket.emit(`module.${NS}`,{kind:'result',userId:payload.userId,error:error.message});
    }
  });
  // A small public API for macros and other modules.
  game.modules.get(NS).api={open:openTokenMenu,configure:configureItem,requestAction,createExamples};
  heartbeat=setInterval(()=>void heartbeatTick(),5000);
  void resumeOnAuthorityChange();
  Hooks.on('userConnected',()=>{void resumeOnAuthorityChange();});
});
Hooks.once('shutdown',()=>{if(heartbeat)clearInterval(heartbeat);});
