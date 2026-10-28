import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';

const NS = 'fbl-lightkeeper';
const clone = structuredClone;
const real = {now:Date.now, setInterval, clearInterval, error:console.error};
let serial = 0;
let env;

function collection(values = []) {
  values.get = id => values.find(value => value.id === id);
  Object.defineProperty(values,'contents',{get:() => [...values]});
  return values;
}
function merge(target, source) {
  for (const [key,value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      merge(target[key],value);
    } else target[key] = clone(value);
  }
}
function apply(target, changes) {
  for (const [path,value] of Object.entries(changes)) {
    const parts = path.split('.');
    let node = target;
    for (const key of parts.slice(0,-1)) node = node[key] ??= {};
    merge(node,{[parts.at(-1)]:value});
  }
}
function flag(ns,key) { return key.split('.').reduce((o,k) => o?.[k],this.flags?.[ns]); }
function makeItem(actor,id,config = {},quantity = 1,name = id) {
  const item = {id,name,parent:actor,documentName:'Item',system:{quantity},
    flags:{[NS]:{light:{enabled:true,mode:'tank',capacitySeconds:100,remainingSeconds:100,
      bright:4,dim:6,ignitionMode:'self',...config}}},getFlag:flag,
    async setFlag(ns,key,value) { apply(this,{[`flags.${ns}.${key}`]:value}); return this; },
    async update(changes) { apply(this,changes); return this; }};
  actor.items.push(item);
  return item;
}
function makeActor(uuid = 'Actor.A1') {
  return {id:'A1',uuid,items:collection(),testUserPermission:user => user.id === 'P1'};
}
function makeToken(actor,id = 'T1',scene = env.scene) {
  const token = {id,uuid:`Scene.${scene.id}.Token.${id}`,name:'Персонаж',actor,parent:scene,
    flags:{[NS]:{}},currentLight:{bright:0,dim:0,angle:360,color:null,alpha:0.5,
      negative:false,luminosity:0.5,darkness:{min:0,max:1},
      animation:{type:null,speed:5,intensity:5}},getFlag:flag,
    light:{toObject:() => clone(token.currentLight)},
    async update(changes) {
      const update = {...changes};
      if (update.light) { merge(this.currentLight,update.light); delete update.light; }
      apply(this,update);
      return this;
    },
    updateSource(changes) { apply(this,changes); }};
  scene.tokens.push(token);
  return token;
}
function makeUser(id,isGM) {
  return {id,isGM,active:true,flags:{},getFlag:flag,
    async setFlag(ns,key,value) {
      apply(this,{[`flags.${ns}.${key}`]:value});
      await env.fire('updateUser',this,{flags:{[ns]:{[key]:value}}},{},game.user.id);
    }};
}
beforeEach(async () => {
  const listeners = new Map();
  const register = (name,fn) => listeners.set(name,[...(listeners.get(name) ?? []),fn]);
  const settings = new Map();
  env = {now:100000,notices:[],chat:[],timers:[],listeners,settings,
    fire:async (name,...args) => { for (const fn of listeners.get(name) ?? []) await fn(...args); }};
  Date.now = () => env.now;
  globalThis.setInterval = fn => { env.timers.push(fn); return env.timers.length; };
  globalThis.clearInterval = () => {};
  console.error = () => {};
  globalThis.Hooks = {once:register,on:register};
  globalThis.foundry = {utils:{deepClone:clone,randomID:() => `request-${++serial}`},
    applications:{api:{ApplicationV2:class {}}}};
  env.gm = makeUser('GM1',true);
  env.player = makeUser('P1',false);
  env.users = collection([env.gm,env.player]);
  env.scene = {id:'S1',tokens:collection()};
  env.actor = makeActor();
  env.token = makeToken(env.actor);
  env.lamp = makeItem(env.actor,'LAMP',{refillItem:'Масло',refillSeconds:40});
  env.oil = makeItem(env.actor,'OIL',{enabled:false},2,'Масло');
  env.api = {};
  globalThis.game = {user:env.gm,users:env.users,system:{id:'forbidden-lands'},paused:false,
    modules:{get:() => env.api},scenes:collection([env.scene]),
    settings:{register:(ns,key,c) => settings.set(`${ns}.${key}`,c.default),get:(ns,key) => settings.get(`${ns}.${key}`),
      registerMenu:()=>{},set:async(ns,key,value)=>settings.set(`${ns}.${key}`,value)},keybindings:{register:()=>{}},
    socket:{on:() => assert.fail('Unauthenticated module socket must not be used'),emit:() => assert.fail('Unexpected socket')}};
  globalThis.ui = {notifications:{info:m => env.notices.push(m),warn:m => env.notices.push(m)}};
  globalThis.ChatMessage = {create:async data => env.chat.push(data)};
  globalThis.Item = {createDocuments:async data => data};
  globalThis.canvas = {tokens:{controlled:[]}};
  await import(`../scripts/module.js?test=${++serial}`);
  await env.fire('init'); await env.fire('ready');
  env.action = (action,itemId = 'LAMP',token = env.token) => env.api.api.requestAction(token,action,itemId);
  env.active = (token = env.token) => token.getFlag(NS,'active');
  env.remaining = () => env.lamp.getFlag(NS,'light').remainingSeconds;
  env.tick = () => env.timers[0]();
  env.pause = async paused => { game.paused = paused; await env.fire('pauseGame',paused); };
});
afterEach(async () => {
  await env.fire('shutdown');
  Date.now = real.now; globalThis.setInterval = real.setInterval;
  globalThis.clearInterval = real.clearInterval; console.error = real.error;
});

test('real time, ignition, pause, refill and restoration of original light',async () => {
  Object.assign(env.lamp.flags[NS].light,{ignitionMode:'consume',ignitionItem:'Спички'});
  const matches = makeItem(env.actor,'MATCH',{enabled:false},2,'Спички');
  const base = clone(env.token.currentLight);
  await env.action('on');
  assert.equal(matches.system.quantity,1);
  assert.equal(env.token.currentLight.bright,4);
  env.now += 17000; await env.pause(true);
  assert.equal(env.remaining(),83);
  env.now += 500000; await env.pause(false);
  env.now += 10000; await env.action('off');
  assert.equal(env.active(),null); assert.equal(env.remaining(),73);
  assert.deepEqual(env.token.currentLight,base);
  await env.action('refill');
  assert.equal(env.remaining(),100); assert.equal(env.oil.system.quantity,1);
});

test('rapid toggles preserve fractional fuel',async () => {
  for (let i = 0; i < 4; i++) {
    await env.action('on'); env.now += 125; await env.action('off');
  }
  assert.equal(env.remaining(),99.5);
});

test('connecting a player does not reset elapsed time',async () => {
  await env.action('on'); env.now += 3500;
  await env.fire('userConnected',env.player,true);
  assert.equal(env.remaining(),96.5);
});

test('time without a GM is excluded on reconnect',async () => {
  await env.action('on'); env.now += 2000; await env.tick();
  env.gm.active = false; await env.fire('userConnected',env.gm,false);
  env.now += 500000;
  env.gm.active = true; await env.fire('userConnected',env.gm,true);
  assert.equal(env.remaining(),98);
  env.now += 2500; await env.tick(); assert.equal(env.remaining(),95.5);
});

test('reload ignores downtime but preserves saved active fuel',async () => {
  await env.action('on'); env.now += 2000; await env.tick();
  await env.fire('shutdown'); env.now += 500000;
  await import(`../scripts/module.js?reload=${++serial}`);
  await env.listeners.get('ready').at(-1)();
  assert.equal(env.remaining(),98);
});

test('pause and unpause are accounted for while an inventory write is pending',async () => {
  await env.action('on');
  let release;
  const original = env.lamp.setFlag;
  env.lamp.setFlag = async function(ns,key,value) {
    await new Promise(resolve => { release = resolve; });
    this.setFlag = original;
    return original.call(this,ns,key,value);
  };
  env.now += 10000;
  const tick = env.tick();
  while (!release) await Promise.resolve();
  env.now += 2000; const pausing = env.pause(true);
  env.now += 500000; const unpausing = env.pause(false);
  release(); await Promise.all([tick,pausing,unpausing]);
  assert.equal(env.remaining(),88);
  env.now += 1000; await env.action('off'); assert.equal(env.remaining(),87);
});

test('two linked tokens cannot activate the same tank concurrently',async () => {
  const other = makeToken(env.actor,'T2');
  await Promise.all([env.action('on'),env.action('on','LAMP',other)]);
  assert.equal([env.token,other].filter(t => env.active(t)).length,1);
});

test('unlinked tokens sharing a base actor ID have independent inventories',async () => {
  const otherActor = makeActor('Scene.S1.Token.T2.Actor.A1');
  const other = makeToken(otherActor,'T2'); makeItem(otherActor,'LAMP');
  await Promise.all([env.action('on'),env.action('on','LAMP',other)]);
  assert.ok(env.active()); assert.ok(env.active(other));
});

test('shared ignition stock is serialized across linked tokens',async () => {
  const other = makeToken(env.actor,'T2');
  const ignition = {ignitionMode:'consume',ignitionItem:'Спички'};
  Object.assign(env.lamp.flags[NS].light,ignition); makeItem(env.actor,'LAMP2',ignition);
  const matches = makeItem(env.actor,'MATCH',{enabled:false},1,'Спички');
  await Promise.all([env.action('on'),env.action('on','LAMP2',other)]);
  assert.equal(matches.system.quantity,0);
  assert.equal([env.token,other].filter(t => env.active(t)).length,1);
});

test('refill from a linked token updates the token actually holding the tank',async () => {
  const other = makeToken(env.actor,'T2');
  await env.action('on'); env.now += 60000; await env.action('refill','LAMP',other);
  assert.equal(env.active().remainingSeconds,80); assert.equal(env.remaining(),80);
  assert.equal(env.active(other),undefined);
  env.now += 2000; await env.action('off'); assert.equal(env.remaining(),78);
});

test('failure to consume ignition refunds the disposable source',async () => {
  const candle = makeItem(env.actor,'CANDLE',{mode:'disposable',ignitionMode:'consume',ignitionItem:'Спички'});
  const matches = makeItem(env.actor,'MATCH',{enabled:false},1,'Спички');
  matches.update = async () => { throw new Error('Inventory write failed'); };
  assert.equal(await env.action('on','CANDLE'),null);
  assert.equal(candle.system.quantity,1); assert.equal(env.active(),undefined);
});

test('failed activation refunds all consumed resources',async () => {
  const candle = makeItem(env.actor,'CANDLE',{mode:'disposable',ignitionMode:'consume',ignitionItem:'Спички'});
  const matches = makeItem(env.actor,'MATCH',{enabled:false},1,'Спички');
  env.token.update = async () => { throw new Error('Token write failed'); };
  await env.action('on','CANDLE');
  assert.equal(candle.system.quantity,1); assert.equal(matches.system.quantity,1);
  assert.equal(env.active(),undefined);
});

test('failed refill restores fuel, item remainder and live runtime',async () => {
  await env.action('on'); env.now += 60000; await env.tick();
  const before = clone(env.active()); const quantity = env.oil.system.quantity;
  env.token.update = async () => {
    assert.equal(env.oil.system.quantity,quantity - 1);
    assert.equal(env.remaining(),80);
    throw new Error('Token write failed');
  };
  await env.action('refill');
  assert.equal(env.remaining(),40); assert.equal(env.oil.system.quantity,quantity);
  assert.deepEqual(env.active(),before);
});

test('multiple candle remainders survive using a lamp and another candle',async () => {
  const a = makeItem(env.actor,'A',{mode:'disposable'},2);
  const b = makeItem(env.actor,'B',{mode:'disposable'},1);
  await env.action('on','A'); env.now += 12000; await env.action('off');
  await env.action('on'); await env.action('off');
  await env.action('on','B'); env.now += 7000; await env.action('off');
  assert.equal(env.token.getFlag(NS,'stowedSources').length,2);
  await env.action('on','A'); assert.equal(env.active().remainingSeconds,88);
  assert.equal(a.system.quantity,1); assert.equal(b.system.quantity,0);
  await env.action('off'); assert.equal(env.token.getFlag(NS,'stowedSources').length,2);
});

test('legacy stowed candle can resume after the original stack is gone',async () => {
  env.token.flags[NS].stowed = {itemId:'OLD',itemName:'Огарок',remainingSeconds:21.5,
    config:{enabled:true,mode:'disposable',capacitySeconds:100}};
  await env.action('on','OLD'); assert.equal(env.active().remainingSeconds,21.5);
  env.now += 500; await env.action('off');
  assert.equal(env.token.getFlag(NS,'stowed'),null);
  assert.equal(env.token.getFlag(NS,'stowedSources')[0].remainingSeconds,21);
});

test('expiry restores light and announces once',async () => {
  await env.action('on'); env.now += 101000; await env.tick(); await env.tick();
  assert.equal(env.active(),null); assert.equal(env.remaining(),0);
  assert.equal(env.token.currentLight.bright,0); assert.equal(env.chat.length,1);
});

test('hidden NPC expiry does not reveal their presence to players',async () => {
  env.token.hidden = true; env.token.name = '<secret>';
  await env.action('on'); env.now += 101000; await env.tick();
  assert.deepEqual(env.chat[0].whisper,['GM1']);
  assert.ok(env.chat[0].content.includes('&lt;secret&gt;'));
});

test('removing a tank stops its light even during pause',async () => {
  await env.action('on'); await env.pause(true);
  env.actor.items.splice(env.actor.items.indexOf(env.lamp),1); await env.tick();
  assert.equal(env.active(),null); assert.equal(env.token.currentLight.bright,0);
  assert.equal(env.chat.length,0);
});

test('pasting a token cannot clone an already consumed candle',async () => {
  makeItem(env.actor,'CANDLE',{mode:'disposable'}); await env.action('on','CANDLE');
  const copied = makeToken(env.actor,'COPY'); copied.flags = clone(env.token.flags);
  await env.fire('preCreateToken',copied);
  assert.equal(copied.getFlag(NS,'active'),null);
  assert.deepEqual(copied.getFlag(NS,'stowedSources'),[]);
  assert.equal(copied.light.bright,0); assert.ok(env.active());
});

test('server-authenticated requester controls authorization, ignoring payload userId',async () => {
  env.actor.testUserPermission = () => false;
  await env.player.setFlag(NS,'request',{id:'forged',action:'on',sceneId:'S1',tokenId:'T1',itemId:'LAMP',userId:'GM1'});
  assert.equal(env.active(),undefined);
  await env.fire('updateUser',env.player,{flags:{[NS]:{request:{id:'forged'}}}},{},'P1');
  assert.equal(env.active(),undefined);
  assert.match(env.player.getFlag(NS,'result').error,/Нет доступа/);
});

test('authenticated requests use full User flags when Foundry emits only a diff',async () => {
  env.player.flags[NS] = {result:{id:'old',error:'Previous request failed'}};
  apply(env.player,{[`flags.${NS}.request`]:{id:'one',action:'on',sceneId:'S1',tokenId:'T1',itemId:'LAMP'}});
  await env.fire('updateUser',env.player,{flags:{[NS]:{request:{id:'one'}}}},{},'P1');
  assert.ok(env.active()); await env.action('off');
  env.player.flags[NS].request.id = 'two';
  await env.fire('updateUser',env.player,{flags:{[NS]:{request:{id:'two'}}}},{},'P1');
  assert.ok(env.active()); assert.equal(env.player.getFlag(NS,'result').id,'two');
  assert.equal(env.player.getFlag(NS,'result').error,null);
});

test('infinite source and required ignition never spend fuel or ignition stock',async () => {
  makeItem(env.actor,'MAGIC',{mode:'infinite',ignitionMode:'require',ignitionItem:'Спички'});
  const matches = makeItem(env.actor,'MATCH',{enabled:false},1,'Спички');
  await env.action('on','MAGIC'); env.now += 900000; await env.tick();
  assert.equal(env.active().remainingSeconds,null);
  assert.equal(matches.system.quantity,1);
  await env.action('off'); matches.system.quantity = 0;
  assert.equal(await env.action('on','MAGIC'),null);
});

test('there is no action and no resource consumption without a connected GM',async () => {
  env.gm.active = false;
  await env.action('on');
  assert.equal(env.active(),undefined);
  assert.match(env.notices[0],/подключённый ГМ/);
});

test('timer also runs on tokens in a scene the GM is not viewing',async () => {
  const scene = {id:'S2',tokens:collection()}; game.scenes.push(scene);
  const other = makeToken(env.actor,'OTHER',scene);
  await env.action('on','LAMP',other); env.now += 12345; await env.tick();
  assert.equal(env.active(other).remainingSeconds,87.655);
});

test('a candle is emitted as light even when the underlying token emits darkness',async () => {
  Object.assign(env.token.currentLight,{negative:true,luminosity:0,darkness:{min:0.8,max:1}});
  const before = clone(env.token.currentLight);
  await env.action('on');
  assert.equal(env.token.currentLight.negative,false);
  assert.equal(env.token.currentLight.luminosity,0.5);
  assert.deepEqual(env.token.currentLight.darkness,{min:0,max:1});
  await env.action('off'); assert.deepEqual(env.token.currentLight,before);
});

test('cancelled document updates refund activation resources',async () => {
  const candle = makeItem(env.actor,'CANDLE',{mode:'disposable'});
  env.token.update = async () => undefined;
  assert.equal(await env.action('on','CANDLE'),null);
  assert.equal(candle.system.quantity,1);
  assert.equal(env.active(),undefined);
});

test('a failed fuel-state write does not mutate live runtime',async () => {
  await env.action('on'); const before = clone(env.active()); env.now += 2500;
  env.lamp.setFlag = async () => { throw new Error('Item write failed'); };
  await env.tick();
  assert.deepEqual(env.active(),before);
  assert.equal(env.remaining(),100);
});

test('expiry of one candle preserves other stowed remainders',async () => {
  makeItem(env.actor,'A',{mode:'disposable'}); makeItem(env.actor,'B',{mode:'disposable'});
  await env.action('on','A'); env.now += 5000; await env.action('off');
  await env.action('on','B'); env.now += 101000; await env.tick();
  assert.equal(env.token.getFlag(NS,'stowedSources').length,1);
  assert.equal(env.token.getFlag(NS,'stowedSources')[0].itemId,'A');
});

test('player operations respect the world setting and inactive users are rejected',async () => {
  const send = async id => {
    apply(env.player,{[`flags.${NS}.request`]:{id,action:'on',sceneId:'S1',tokenId:'T1',itemId:'LAMP'}});
    await env.fire('updateUser',env.player,{flags:{[NS]:{request:{id}}}},{},'P1');
  };
  env.settings.set(`${NS}.allowPlayers`,false);
  await send('disabled'); assert.equal(env.active(),undefined);
  env.settings.set(`${NS}.allowPlayers`,true); env.player.active = false;
  await send('inactive'); assert.equal(env.active(),undefined);
});

test('non-authority caller waits for a correlated result from the selected GM',async () => {
  game.user = env.player;
  let request;
  env.player.setFlag = async (_ns,_key,value) => { request = value; };
  const action = env.action('on'); assert.ok(request.id);
  apply(env.player,{[`flags.${NS}.result`]:{id:request.id,message:'Зажжён'}});
  await env.fire('updateUser',env.player,{flags:{[NS]:{result:{id:request.id}}}},{},'P1');
  assert.equal(env.notices.length,0);
  await env.fire('updateUser',env.player,{flags:{[NS]:{result:{id:request.id}}}},{},'GM1');
  assert.equal(await action,'Зажжён');
});

test('an unconfigured candle uses a template and pins its settings on first ignition',async()=>{
  const candle=makeItem(env.actor,'AUTO',{},2,'Свеча'); candle.flags={};
  const matches=makeItem(env.actor,'MATCH',{enabled:false},2,'Matches');
  await env.action('on','AUTO');
  assert.equal(env.active().config.capacitySeconds,1800);
  assert.equal(candle.system.quantity,1); assert.equal(matches.system.quantity,1);
  assert.equal(candle.getFlag(NS,'light').templateId,'candle');
  const catalog=env.api.api.getCatalog(); catalog.sources[0].config.capacitySeconds=9999;
  env.settings.set(`${NS}.catalog`,catalog);
  assert.equal(env.active().config.capacitySeconds,1800);
});

test('resource aliases work for refills and disabled manual configuration blocks recognition',async()=>{
  env.lamp.flags[NS].light.refillResource='oil'; env.oil.name='Lamp Oil';
  env.lamp.flags[NS].light.remainingSeconds=20;
  await env.action('refill'); assert.equal(env.remaining(),60);
  const candle=makeItem(env.actor,'DISABLED',{enabled:false},1,'Свеча');
  await env.action('on','DISABLED'); assert.equal(env.active(),undefined);
  assert.equal(candle.system.quantity,1);
});

test('shutters hide light while fuel keeps burning and restore the source on opening',async()=>{
  env.lamp.flags[NS].light.shutter=true;
  await env.action('on'); env.now+=10000; await env.action('shutter');
  assert.equal(env.token.currentLight.bright,0); assert.equal(env.active().shutterClosed,true);
  env.now+=5000; await env.tick(); assert.equal(env.remaining(),85);
  await env.action('shutter'); assert.equal(env.token.currentLight.bright,4);
  assert.equal(env.active().shutterClosed,false);
  await env.action('off'); assert.equal(env.token.currentLight.bright,0);
});

test('switching prevalidates the next source before extinguishing the current one',async()=>{
  await env.action('on');
  makeItem(env.actor,'NEW',{mode:'disposable',ignitionMode:'consume',ignitionItem:'Missing'});
  assert.equal(await env.action('switch','NEW'),null);
  assert.equal(env.active().itemId,'LAMP');
  makeItem(env.actor,'CANDLE',{mode:'disposable'});
  env.now+=2000; await env.action('switch','CANDLE');
  assert.equal(env.active().itemId,'CANDLE'); assert.equal(env.remaining(),98);
});

test('quick toggle reuses the last source and preserves a candle stub',async()=>{
  makeItem(env.actor,'CANDLE',{mode:'disposable'});
  await env.api.api.quickToggle(env.token,'CANDLE'); env.now+=3000;
  await env.api.api.quickToggle(env.token); assert.equal(env.active(),null);
  await env.api.api.quickToggle(env.token);
  assert.equal(env.active().itemId,'CANDLE'); assert.equal(env.active().remainingSeconds,97);
});

test('low-fuel warning is private, once per threshold crossing and rearmed by refill',async()=>{
  env.lamp.flags[NS].light.lowFuelSeconds=60;
  await env.action('on'); env.now+=45000; await env.tick(); await env.tick();
  assert.equal(env.chat.length,1); assert.deepEqual(env.chat[0].whisper,['GM1','P1']);
  await env.action('refill'); assert.equal(env.active().lowFuelWarned,false);
  env.now+=40000; await env.tick(); assert.equal(env.chat.length,2);
});

test('low-fuel notification can be disabled globally',async()=>{
  env.settings.set(`${NS}.lowFuelNotify`,false);
  await env.action('on'); env.now+=45000; await env.tick(); assert.equal(env.chat.length,0);
});

test('GM time adjustment changes the active tank without consuming fuel stock',async()=>{
  env.lamp.flags[NS].light.capacitySeconds=1000;
  await env.action('on');
  await env.api.api.requestAction(env.token,'adjust','',{deltaSeconds:300});
  assert.equal(env.active().remainingSeconds,400); assert.equal(env.remaining(),400);
  assert.equal(env.oil.system.quantity,2);
  await env.api.api.requestAction(env.token,'adjust','',{deltaSeconds:-500});
  assert.equal(env.active(),null); assert.equal(env.remaining(),0);
});

test('players cannot accidentally use GM time adjustment',async()=>{
  await env.action('on');
  apply(env.player,{[`flags.${NS}.request`]:{id:'adjust',action:'adjust',deltaSeconds:300,sceneId:'S1',tokenId:'T1'}});
  await env.fire('updateUser',env.player,{flags:{[NS]:{request:{id:'adjust'}}}},{},'P1');
  assert.match(env.player.getFlag(NS,'result').error,/корректирует ГМ/);
  assert.equal(env.active().remainingSeconds,100);
});

test('hidden low-fuel warning remains visible only to GMs',async()=>{
  env.token.hidden=true;
  await env.action('on'); env.now+=45000; await env.tick();
  assert.deepEqual(env.chat[0].whisper,['GM1']);
});

test('new example items use current world templates and their shutters',async()=>{
  const data=await env.api.api.createExamples();
  const hooded=data.find(i=>i.name==='Фонарь со шторками');
  assert.ok(hooded.flags[NS].light.shutter);
  assert.equal(hooded.flags[NS].light.refillResource,'oil');
  assert.ok(data.some(i=>i.name==='Спички'));
});
