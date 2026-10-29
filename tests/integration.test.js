import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';

const NS = 'fbl-lightkeeper';
const clone = structuredClone;
const real = {now:Date.now, setInterval, clearInterval, error:console.error};
let serial = 0;
let env;

/** Provide Foundry-style collection lookup and a snapshot contents array. */
function collection(values = []) {
  values.get = id => values.find(value => value.id === id);
  Object.defineProperty(values,'contents',{get:() => [...values]});
  return values;
}
/** Model recursive document merges rather than replacing nested flag objects. */
function merge(target, source) {
  for (const [key,value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      merge(target[key],value);
    } else target[key] = clone(value);
  }
}
/** Apply dotted document changes used by both actions and lean checkpoints. */
function apply(target, changes) {
  for (const [path,value] of Object.entries(changes)) {
    const parts = path.split('.');
    let node = target;
    for (const key of parts.slice(0,-1)) node = node[key] ??= {};
    if(parts.at(-1).startsWith('-='))delete node[parts.at(-1).slice(2)];
    else merge(node,{[parts.at(-1)]:value});
  }
}
function flag(ns,key) { return key.split('.').reduce((o,k) => o?.[k],this.flags?.[ns]); }
/** Build an embedded Item whose update methods can be failed or cancelled by a test. */
function makeItem(actor,id,config = {},quantity = 1,name = id) {
  const item = {id,name,parent:actor,documentName:'Item',system:{quantity},
    flags:{[NS]:{light:{enabled:true,mode:'tank',capacitySeconds:100,remainingSeconds:100,
      bright:4,dim:6,requiresIgnition:false,canIgnite:false,...config}}},getFlag:flag,
    async setFlag(ns,key,value) { apply(this,{[`flags.${ns}.${key}`]:value}); return this; },
    async update(changes) { apply(this,changes); return this; },
    async delete() {actor.items.splice(actor.items.indexOf(this),1);await env.fire('deleteItem',this);return this;}};
  actor.items.push(item);
  return item;
}
/** Represent one inventory and a predictable owner permission check. */
function makeActor(uuid = 'Actor.A1') {
  return {id:'A1',uuid,items:collection(),testUserPermission:user => user.id === 'P1'};
}
/** Track source flags and light restoration with native-style nested updates. */
function makeToken(actor,id = 'T1',scene = env.scene) {
  const token = {id,uuid:`Scene.${scene.id}.Token.${id}`,name:'Персонаж',actor,parent:scene,x:0,y:0,width:1,height:1,elevation:0,
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
/** Emit authenticated User update hooks when simulated request flags change. */
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
  const settingConfigs = new Map();
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
  env.scene = {id:'S1',tokens:collection(),grid:{size:100,distance:5},walls:collection()};
  env.actor = makeActor();
  env.token = makeToken(env.actor);
  env.lamp = makeItem(env.actor,'LAMP',{refillItem:'Масло',refillSeconds:40});
  env.oil = makeItem(env.actor,'OIL',{enabled:false},2,'Масло');
  env.api = {};
  globalThis.game = {user:env.gm,users:env.users,system:{id:'forbidden-lands'},paused:false,
    modules:{get:() => env.api},scenes:collection([env.scene]),
    settings:{register:(ns,key,c) => {settings.set(`${ns}.${key}`,c.default);settingConfigs.set(`${ns}.${key}`,c);},get:(ns,key) => settings.get(`${ns}.${key}`),
      registerMenu:()=>{},set:async(ns,key,value)=>{settings.set(`${ns}.${key}`,value);settingConfigs.get(`${ns}.${key}`)?.onChange?.(value);}},keybindings:{register:()=>{}},
    socket:{on:() => assert.fail('Unauthenticated module socket must not be used'),emit:() => assert.fail('Unexpected socket')}};
  globalThis.ui = {notifications:{info:m => env.notices.push(m),warn:m => env.notices.push(m)}};
  globalThis.ChatMessage = {create:async data => env.chat.push(data)};
  globalThis.Item = {createDocuments:async data => data};
  globalThis.canvas = {tokens:{controlled:[]}};
  await import(`../scripts/module.js?test=${++serial}`);
  await env.fire('init'); await env.fire('ready');
  env.action = (action,itemId = 'LAMP',token = env.token,options={}) => env.api.api.requestAction(token,action,itemId,options);
  env.active = (token = env.token) => token.getFlag(NS,'active');
  env.remaining = () => env.lamp.getFlag(NS,'light').remainingSeconds;
  env.tick = () => env.timers[0]?.();
  env.pause = async paused => { game.paused = paused; await env.fire('pauseGame',paused); };
});
afterEach(async () => {
  await env.fire('shutdown');
  Date.now = real.now; globalThis.setInterval = real.setInterval;
  globalThis.clearInterval = real.clearInterval; console.error = real.error;
});

test('real time, ignition, pause, refill and restoration of original light',async () => {
  Object.assign(env.lamp.flags[NS].light,{requiresIgnition:true});
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

test('a consumed last match disappears from the native inventory and a stub needs a new match',async()=>{
  const candle=makeItem(env.actor,'CANDLE',{},2,'Свеча');candle.flags={};
  const matches=makeItem(env.actor,'MATCH',{enabled:false},1,'Спички');
  await env.action('on','CANDLE');assert.equal(matches.system.quantity,0);
  assert.equal(env.actor.items.get('MATCH'),undefined);
  env.now+=1000;await env.action('off');assert.equal(await env.action('on','CANDLE'),null);
  assert.equal(candle.system.quantity,1);assert.equal(env.token.getFlag(NS,'stowedSources').length,1);
});

test('a consumable ignition Bonus spends one charge per fresh or resumed candle, keeping its Item',async()=>{
  const candle=makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true},2);
  const box=makeItem(env.actor,'BOX',{enabled:false},1,'Коробок');box.system.bonus={value:3,max:8};box.flags[NS].ignition={mode:'bonus'};
  await env.action('on','CANDLE');assert.equal(box.system.bonus.value,2);assert.equal(box.system.bonus.max,8);
  assert.equal(box.system.quantity,1);assert.equal(env.actor.items.get('BOX'),box);
  env.now+=1000;await env.action('off');assert.equal(box.system.bonus.value,2);
  await env.action('on','CANDLE');assert.equal(box.system.bonus.value,1);assert.equal(candle.system.quantity,1);
});

test('ignition skips empty Bonus items and never falls back to spending their quantity',async()=>{
  makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
  const empty=makeItem(env.actor,'EMPTY',{enabled:false},2,'Кремень');empty.system.bonus={value:0,max:5};empty.flags[NS].ignition={mode:'bonus'};
  const full=makeItem(env.actor,'FULL',{enabled:false},1,'Кремень');full.system.bonus={value:1,max:5};full.flags[NS].ignition={mode:'bonus'};
  await env.action('on','CANDLE');assert.equal(empty.system.bonus.value,0);assert.equal(full.system.bonus.value,0);
  await env.action('off');assert.equal(await env.action('on','CANDLE'),null);
  assert.equal(empty.system.quantity,2);assert.equal(full.system.quantity,1);
});

test('a reusable ignition tool never spends quantity or Bonus',async()=>{
  makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
  const tool=makeItem(env.actor,'TOOL',{enabled:false},1,'Огниво');tool.system.bonus={value:0,max:5};
  await env.action('on','CANDLE');await env.action('off');await env.action('on','CANDLE');
  assert.ok(env.active());assert.equal(tool.system.quantity,1);assert.equal(tool.system.bonus.value,0);
});

test('failed ignition returns Bonus and the candle without deleting either Item',async()=>{
  const candle=makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
  const box=makeItem(env.actor,'BOX',{enabled:false},1,'Спички');box.system.bonus={value:1,max:9};box.flags[NS].ignition={mode:'bonus'};
  env.token.update=async()=>{throw new Error('Token failed');};
  assert.equal(await env.action('on','CANDLE'),null);assert.equal(box.system.bonus.value,1);
  assert.equal(box.system.quantity,1);assert.equal(candle.system.quantity,1);
  assert.equal(env.actor.items.get('CANDLE'),candle);assert.equal(env.actor.items.get('BOX'),box);
});

test('two linked tokens serialize the final ignition Bonus charge',async()=>{
  const other=makeToken(env.actor,'OTHER');
  makeItem(env.actor,'A',{mode:'disposable',requiresIgnition:true});
  makeItem(env.actor,'B',{mode:'disposable',requiresIgnition:true});
  const tool=makeItem(env.actor,'TOOL',{enabled:false},1,'Огниво');tool.system.bonus={value:1,max:5};tool.flags[NS].ignition={mode:'bonus'};
  await Promise.all([env.action('on','A'),env.action('on','B',other)]);
  assert.equal([env.token,other].filter(token=>env.active(token)).length,1);
  assert.equal(tool.system.bonus.value,0);assert.equal(tool.system.quantity,1);
});

test('a cancelled Bonus update returns the candle without spending a charge',async()=>{
  const candle=makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
  const box=makeItem(env.actor,'BOX',{enabled:false},1,'Спички');box.system.bonus={value:1,max:5};box.flags[NS].ignition={mode:'bonus'};box.update=async()=>undefined;
  assert.equal(await env.action('on','CANDLE'),null);assert.equal(candle.system.quantity,1);assert.equal(box.system.bonus.value,1);assert.equal(env.active(),undefined);
});

test('cleanup failure cannot roll back a committed ignition',async()=>{
  makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
  const match=makeItem(env.actor,'MATCH',{enabled:false},1,'Спички');match.delete=async()=>{throw new Error('delete unavailable');};
  assert.ok(await env.action('on','CANDLE'));assert.ok(env.active());assert.equal(match.system.quantity,0);
  await env.action('off');assert.equal(await env.action('on','CANDLE'),null);
});

/** A separate player's inventory can provide fire without giving away or consuming its Item. */
async function lightDonor(config={}) {
  const actor=makeActor('Actor.DONOR'),token=makeToken(actor,'DONOR');token.x=100;token.name='Другой игрок';
  const item=makeItem(actor,'FIRE',{mode:'disposable',canIgnite:true,...config});
  await env.action('on','FIRE',token);
  return {actor,token,item};
}

test('one Bonus igniter has the same cost for different sources and self-starting lights ignore it',async()=>{
  const box=makeItem(env.actor,'BOX',{enabled:false},1,'Коробок');box.system.bonus={value:3,max:3};box.flags[NS].ignition={mode:'bonus'};
  makeItem(env.actor,'A',{requiresIgnition:true});makeItem(env.actor,'B',{requiresIgnition:true});
  await env.action('on','A');await env.action('off');await env.action('on','B');await env.action('off');
  assert.equal(box.system.bonus.value,1);
  await env.action('on','LAMP',env.token,{ignitionId:'item:BOX'});assert.equal(box.system.bonus.value,1);
});

test('automatic ignition prefers a reusable tool and an explicit choice can spend matches',async()=>{
  Object.assign(env.lamp.flags[NS].light,{requiresIgnition:true});
  const matches=makeItem(env.actor,'MATCH',{enabled:false},2,'Спички');makeItem(env.actor,'FLINT',{enabled:false},1,'Огниво');
  await env.action('on');assert.equal(matches.system.quantity,2);await env.action('off');
  await env.action('on','LAMP',env.token,{ignitionId:'item:MATCH'});assert.equal(matches.system.quantity,1);
});

test('a nearby burning source from another player lights a candle without spending matches',async()=>{
  const donor=await lightDonor();const matches=makeItem(env.actor,'MATCH',{enabled:false},2,'Спички');
  const candle=makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
  assert.ok(env.api.api.getIgnitionOptions(env.token).some(c=>c.id==='flame:DONOR'));
  await env.action('on','CANDLE');assert.equal(matches.system.quantity,2);assert.equal(candle.system.quantity,0);
  assert.equal(env.active(donor.token).itemId,'FIRE');assert.equal(env.active(donor.token).remainingSeconds,100);
  assert.equal(donor.actor.items.get('FIRE'),undefined,'a consumed candle still provides fire from runtime');
});

for(const [reason,invalidate] of [
  ['out of range',({token})=>{token.x=301;}],
  ['above reach',({token})=>{token.elevation=11;}],
  ['closed shutters',({token})=>{env.active(token).shutterClosed=true;}],
  ['no capability',({token})=>{env.active(token).config.canIgnite=false;}],
  ['expired before checkpoint',()=>{env.now+=101000;}],
  ['actor reassignment',({token})=>{token.actor=makeActor('Actor.CHANGED');}],
  ['deleted token',({token})=>{env.scene.tokens.splice(env.scene.tokens.indexOf(token),1);}],
  ['another scene',({token})=>{token.parent={id:'OTHER',grid:env.scene.grid};}]
])test(`a donor that is ${reason} cannot supply ignition`,async()=>{
  const donor=await lightDonor();invalidate(donor);
  const candle=makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
  assert.equal(await env.action('on','CANDLE',env.token,{ignitionId:'flame:DONOR'}),null);
  assert.equal(candle.system.quantity,1);assert.equal(env.active(),undefined);
});

test('a selected flame going away never silently spends a different ignition resource',async()=>{
  const {token}=await lightDonor();const matches=makeItem(env.actor,'MATCH',{enabled:false},1,'Спички');
  makeItem(env.actor,'CANDLE',{requiresIgnition:true});token.x=400;
  assert.equal(await env.action('on','CANDLE',env.token,{ignitionId:'flame:DONOR'}),null);assert.equal(matches.system.quantity,1);
  assert.ok(await env.action('on','CANDLE',env.token,{ignitionId:'auto'}));assert.equal(matches.system.quantity,0);
});

test('a closed door blocks sharing fire on another scene and opening it refreshes reach',async()=>{
  await lightDonor();makeItem(env.actor,'CANDLE',{requiresIgnition:true});
  const wall={parent:env.scene,move:20,door:1,ds:0,c:[100,0,100,100]};env.scene.walls.push(wall);
  assert.equal(await env.action('on','CANDLE'),null);
  wall.ds=1;await env.fire('updateWall',wall,{ds:1});
  assert.ok(await env.action('on','CANDLE'));
});

test('the owner of the receiving token can use another owner’s visible fire but not a hidden token',async()=>{
  const {token}=await lightDonor();makeItem(env.actor,'CANDLE',{requiresIgnition:true});token.hidden=true;
  const request={id:'share1',action:'on',sceneId:'S1',tokenId:'T1',itemId:'CANDLE',ignitionId:'flame:DONOR'};
  apply(env.player,{[`flags.${NS}.request`]:request});
  await env.fire('updateUser',env.player,{flags:{[NS]:{request}}},{},env.player.id);
  assert.equal(env.active(),undefined);assert.ok(env.player.getFlag(NS,'result').error);
  token.hidden=false;request.id='share2';apply(env.player,{[`flags.${NS}.request`]:request});
  await env.fire('updateUser',env.player,{flags:{[NS]:{request}}},{},env.player.id);
  assert.equal(env.active().itemId,'CANDLE');assert.equal(env.player.getFlag(NS,'result').error,null);
});

test('the old candle lights its replacement before being stowed and preserves the original token light',async()=>{
  const first=makeItem(env.actor,'FIRST',{mode:'disposable',canIgnite:true});
  makeItem(env.actor,'NEXT',{mode:'disposable',requiresIgnition:true});const base=clone(env.token.currentLight);
  await env.action('on','FIRST');assert.equal(env.actor.items.get(first.id),undefined);
  env.now+=3000;await env.action('switch','NEXT',env.token,{ignitionId:'flame:T1'});
  assert.equal(env.active().itemId,'NEXT');assert.equal(env.token.getFlag(NS,'stowedSources')[0].remainingSeconds,97);
  await env.action('off');assert.deepEqual(env.token.currentLight,base);
});

test('a failed replacement preserves the previous light and refunds the new candle and ignition',async()=>{
  await env.action('on');const old=clone(env.active());
  const candle=makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});const match=makeItem(env.actor,'MATCH',{enabled:false},1,'Спички');
  const update=env.token.update;env.token.update=async changes=>changes[`flags.${NS}.active`]?.itemId==='CANDLE'?undefined:update.call(env.token,changes);
  assert.equal(await env.action('switch','CANDLE'),null);
  assert.equal(env.active().itemId,old.itemId);assert.equal(env.token.currentLight.bright,4);
  assert.equal(candle.system.quantity,1);assert.equal(match.system.quantity,1);assert.deepEqual(env.token.getFlag(NS,'stowedSources'),[]);
});

test('replacement resets shutter and warning state rather than inheriting flags through a deep merge',async()=>{
  Object.assign(env.lamp.flags[NS].light,{shutter:true});await env.action('on');await env.action('shutter');
  env.active().lowFuelWarned=true;makeItem(env.actor,'NEXT',{shutter:true});
  await env.action('switch','NEXT');assert.equal(env.active().shutterClosed,false);assert.equal(env.active().lowFuelWarned,false);
  assert.equal(env.token.currentLight.bright,4);
});

test('extinguishing a donor while a target Item saves cancels ignition and refunds the candle',async()=>{
  const donor=await lightDonor(),candle=makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
  const update=candle.update;candle.update=async function(changes){if(changes['system.quantity']===0)await env.action('off','FIRE',donor.token);return update.call(this,changes);};
  assert.equal(await env.action('on','CANDLE'),null);assert.equal(candle.system.quantity,1);assert.equal(env.active(),undefined);
});

test('a restarted donor is a different flame even when its token and Item ID stay the same',async()=>{
  const donor=await lightDonor({mode:'tank'}),candle=makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
  const update=candle.update;candle.update=async function(changes){
    if(changes['system.quantity']===0){await env.action('off','FIRE',donor.token);await env.action('on','FIRE',donor.token);}
    return update.call(this,changes);
  };
  assert.equal(await env.action('on','CANDLE'),null);assert.equal(candle.system.quantity,1);assert.ok(env.active(donor.token));
});

test('players can list a neighbour’s fire without reading their private inventory',async()=>{
  const donor=await lightDonor({mode:'tank'}),items=donor.actor.items;
  donor.actor.items={get(){assert.fail('Neighbour inventory was read on a player client');}};game.user=env.player;
  try{assert.ok(env.api.api.getIgnitionOptions(env.token).some(c=>c.id==='flame:DONOR'));}
  finally{donor.actor.items=items;game.user=env.gm;}
});

test('the elected GM migrates v1 Item and catalog policies once, including a Bonus matchbox',async()=>{
  const legacy=makeItem(env.actor,'OLD');delete legacy.flags[NS].light.requiresIgnition;delete legacy.flags[NS].light.canIgnite;
  Object.assign(legacy.flags[NS].light,{ignitionMode:'consume',ignitionCost:'bonus',ignitionItem:'Коробок'});
  const box=makeItem(env.actor,'BOX',{enabled:false},1,'Коробок');box.system.bonus={value:3,max:5};
  game.actors=collection([env.actor]);
  await game.settings.set(NS,'catalog',{version:1,sources:[{id:'s',config:{ignitionMode:'consume',ignitionCost:'bonus',ignitionResource:'box'}}],resources:[{id:'box',names:['Коробок']}]});
  await game.settings.set(NS,'ignitionSchema',0);
  env.gm.active=false;await env.fire('userConnected',env.gm,false);env.gm.active=true;await env.fire('userConnected',env.gm,true);
  assert.equal(box.getFlag(NS,'ignition').mode,'bonus');assert.equal(env.api.api.getCatalog().resources[0].ignition.mode,'bonus');
  assert.equal(game.settings.get(NS,'ignitionSchema'),2);
  await env.action('on','OLD');assert.equal(box.system.bonus.value,2);assert.equal(box.system.quantity,1);
});

test('legacy Item costs migrate even when the world still uses the unsaved default library',async()=>{
  const legacy=makeItem(env.actor,'OLD');delete legacy.flags[NS].light.requiresIgnition;delete legacy.flags[NS].light.canIgnite;
  Object.assign(legacy.flags[NS].light,{ignitionMode:'consume',ignitionCost:'bonus',ignitionItem:'Спички'});
  const box=makeItem(env.actor,'BOX',{enabled:false},1,'Спички');box.system.bonus={value:2,max:5};game.actors=collection([env.actor]);
  await game.settings.set(NS,'ignitionSchema',0);
  env.gm.active=false;await env.fire('userConnected',env.gm,false);env.gm.active=true;await env.fire('userConnected',env.gm,true);
  assert.equal(box.getFlag(NS,'ignition').mode,'bonus');assert.equal(box.system.bonus.value,2);
  game.actors={get contents(){assert.fail('Completed migration repeated its inventory scan');}};
  env.gm.active=false;await env.fire('userConnected',env.gm,false);env.gm.active=true;await env.fire('userConnected',env.gm,true);
});

test('migration recovers Bonus policy from a burning candle whose last Item was already deleted',async()=>{
  const box=makeItem(env.actor,'BOX',{enabled:false},1,'Спички');box.system.bonus={value:2,max:5};game.actors=collection([env.actor]);
  const config={enabled:true,mode:'disposable',capacitySeconds:100,remainingSeconds:80,ignitionMode:'consume',ignitionCost:'bonus',ignitionItem:'Спички'};
  env.token.flags[NS].active={itemId:'DELETED',itemName:'Старая свеча',actorKey:env.actor.uuid,config,remainingSeconds:80,lastAt:env.now,previousLight:{bright:0,dim:0}};
  await env.fire('updateToken',env.token,{flags:{[NS]:{active:env.active()}}});await game.settings.set(NS,'ignitionSchema',0);
  env.gm.active=false;await env.fire('userConnected',env.gm,false);env.gm.active=true;await env.fire('userConnected',env.gm,true);
  assert.equal(box.getFlag(NS,'ignition').mode,'bonus');assert.equal(box.system.bonus.value,2);
  await env.action('off');await env.action('on','DELETED');assert.equal(box.system.bonus.value,1);assert.equal(box.system.quantity,1);
});

test('committed on/off transitions broadcast audio and duplicate delivery plays only once',async()=>{
  const played=[];game.audio={interface:{},create:options=>({duration:2,async load(){},async play(playback){played.push({src:options.src,...playback});},schedule(){},async stop(){}})};
  Object.assign(env.lamp.flags[NS].light,{soundOn:'on.ogg',soundOff:'off.ogg',soundVolume:.3,soundFadeSeconds:.2});
  await env.action('on');env.lamp.flags[NS].light.soundOff='future.ogg';await env.action('off');
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.deepEqual(played.map(p=>p.src),['on.ogg','off.ogg']);assert.ok(played.every(p=>p.volume===.3 && p.fade===200));
  await env.fire('updateUser',env.gm,{flags:{[NS]:{sound:{id:env.gm.getFlag(NS,'sound').id}}}},{},env.gm.id);
  assert.equal(played.length,2);
});

test('replacement sound cues are delivered in order without delaying the inventory action',async()=>{
  const played=[],sent=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  game.audio={interface:{},create:options=>({async load(){},async play(){played.push(options.src);},async stop(){}})};
  env.lamp.flags[NS].light.soundOff='old-off.ogg';await env.action('on');
  makeItem(env.actor,'NEXT',{soundOn:'new-on.ogg'});
  const setFlag=env.gm.setFlag;env.gm.setFlag=async function(ns,key,value){
    if(key==='sound'){sent.push(value.src);if(value.src==='old-off.ogg')await gate;}
    return setFlag.call(this,ns,key,value);
  };
  await env.action('switch','NEXT');assert.equal(env.active().itemId,'NEXT');assert.deepEqual(sent,['old-off.ogg']);
  release();for(let i=0;i<30;i++)await Promise.resolve();
  assert.deepEqual(sent,['old-off.ogg','new-on.ogg']);assert.deepEqual(played,['old-off.ogg','new-on.ogg']);
});

test('failed activation emits no audio, and audio failure cannot undo a successful source',async()=>{
  Object.assign(env.lamp.flags[NS].light,{soundOn:'missing.ogg'});let creates=0;
  game.audio={interface:{},create:()=>{creates++;throw new Error('audio failed');}};
  const update=env.token.update;env.token.update=async()=>undefined;
  assert.equal(await env.action('on'),null);assert.equal(creates,0);
  env.token.update=update;assert.ok(await env.action('on'));for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(creates,1);assert.ok(env.active());assert.equal(env.remaining(),100);
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
  assert.equal(env.remaining(),100);
  await env.action('off'); assert.equal(env.remaining(),96.5);
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
  const original = env.lamp.update;
  env.lamp.update = async function(changes) {
    await new Promise(resolve => { release = resolve; });
    this.update = original;
    return original.call(this,changes);
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
  const ignition = {requiresIgnition:true};
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

test('refilling reports the actual gain and loss, and a deleted fuel rule is identified explicitly',async()=>{
  env.lamp.flags[NS].light.remainingSeconds=90;
  const result=await env.action('refill');assert.equal(env.remaining(),100);assert.equal(env.oil.system.quantity,1);
  assert.match(result,/\+0 м 10 с; избыток 0 м 30 с потерян/);
  Object.assign(env.lamp.flags[NS].light,{remainingSeconds:50,refillResource:'deleted'});
  assert.equal(await env.action('refill'),null);assert.match(env.notices.at(-1),/Удалено правило топлива/);assert.equal(env.oil.system.quantity,1);
});

test('disabling a burning tank settles the last seconds instead of returning unsaved fuel',async()=>{
  await env.action('on');env.now+=3250;env.lamp.flags[NS].light.enabled=false;
  await env.fire('updateItem',env.lamp,{flags:{[NS]:{light:{enabled:false}}}});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(env.active(),null);assert.equal(env.remaining(),96.75);
});

test('a burning tank refills from its frozen recipe while edits apply on the next ignition',async () => {
  const battery=makeItem(env.actor,'BATTERY',{enabled:false},2,'Батарейка');
  await env.action('on');env.now+=60000;await env.tick();
  Object.assign(env.lamp.flags[NS].light,{capacitySeconds:500,refillSeconds:90,refillItem:'Батарейка'});
  await env.action('refill');
  assert.equal(env.active().remainingSeconds,80);
  assert.equal(env.remaining(),80);assert.equal(env.oil.system.quantity,1);assert.equal(battery.system.quantity,2);
  assert.equal(env.lamp.getFlag(NS,'light').capacitySeconds,500);
  await env.action('off');await env.action('on');await env.action('refill');
  assert.equal(env.active().config.capacitySeconds,500);assert.equal(env.remaining(),170);
  assert.equal(battery.system.quantity,1);
});

test('changing the future mode does not prevent refilling the currently burning tank',async () => {
  await env.action('on');env.now+=60000;await env.tick();
  env.lamp.flags[NS].light.mode='infinite';
  assert.ok(await env.action('refill'));
  assert.equal(env.active().config.mode,'tank');assert.equal(env.active().remainingSeconds,80);
  assert.equal(env.lamp.getFlag(NS,'light').mode,'infinite');assert.equal(env.oil.system.quantity,1);
});

test('a pending mode change cannot let another linked token reuse a burning tank',async()=>{
  const other=makeToken(env.actor,'T2');await env.action('on');env.lamp.flags[NS].light.mode='infinite';
  assert.equal(await env.action('on','LAMP',other),null);assert.equal(env.active(other),undefined);
});

test('actor reassignment while ignition stock is saving refunds the original inventory',async()=>{
  const candle=makeItem(env.actor,'CANDLE',{mode:'disposable'}),original=candle.update;
  let release;const oldActor=env.actor;
  candle.update=async function(changes){await new Promise(resolve=>{release=resolve;});this.update=original;return original.call(this,changes);};
  const action=env.action('on','CANDLE');while(!release) await Promise.resolve();
  env.token.actor=makeActor('Actor.OTHER');release();
  assert.equal(await action,null);assert.equal(candle.system.quantity,1);assert.equal(env.active(),undefined);
  assert.equal(oldActor.items.get('CANDLE'),candle);
});

test('actor reassignment while refill stock saves refunds it without rewriting the cleared source',async()=>{
  await env.action('on');env.now+=60000;await env.tick();
  const update=env.oil.update;let release;
  env.oil.update=async function(changes){await new Promise(resolve=>{release=resolve;});this.update=update;return update.call(this,changes);};
  const action=env.action('refill');while(!release) await Promise.resolve();
  env.token.actor=makeActor('Actor.OTHER');await env.fire('updateToken',env.token,{actorId:'OTHER'});
  await new Promise(resolve=>setTimeout(resolve,0));release();
  assert.equal(await action,null);assert.equal(env.oil.system.quantity,2);assert.equal(env.remaining(),40);
  assert.equal(env.active(),null);
});

test('legacy infinite sources persist their actor identity during takeover',async()=>{
  makeItem(env.actor,'MAGIC',{mode:'infinite'});await env.action('on','MAGIC');delete env.active().actorKey;
  env.gm.active=false;await env.fire('userConnected',env.gm,false);
  env.gm.active=true;await env.fire('userConnected',env.gm,true);
  assert.equal(env.active().actorKey,env.actor.uuid);
});

test('candle stubs remain scoped to their inventory when a token changes between copied actors',async()=>{
  const candle=makeItem(env.actor,'CANDLE',{mode:'disposable'},2);
  await env.action('on','CANDLE');env.now+=10000;await env.action('off');
  const other=makeActor('Actor.OTHER'),copied=makeItem(other,'CANDLE',{mode:'disposable'},1);
  env.token.actor=other;
  assert.ok(await env.action('on','CANDLE'));assert.equal(copied.system.quantity,0);assert.equal(env.active().remainingSeconds,100);
  await env.action('off');assert.equal(env.token.getFlag(NS,'stowedSources').length,2);
  env.token.actor=env.actor;await env.action('on','CANDLE');
  assert.equal(env.active().remainingSeconds,90);assert.equal(candle.system.quantity,1);
});

test('a failed expiry chat cannot refund fuel after a committed GM time adjustment',async () => {
  await env.action('on');ChatMessage.create=async()=>{throw new Error('Chat unavailable');};
  assert.ok(await env.api.api.requestAction(env.token,'adjust','',{deltaSeconds:-100}));
  assert.equal(env.active(),null);assert.equal(env.remaining(),0);assert.equal(env.token.currentLight.bright,0);
});

test('a failed low-fuel chat does not abort extinguishing an already settled lamp',async () => {
  env.lamp.flags[NS].light.lowFuelSeconds=90;
  await env.action('on');env.now+=15000;ChatMessage.create=async()=>{throw new Error('Chat unavailable');};
  assert.ok(await env.action('off'));assert.equal(env.active(),null);assert.equal(env.remaining(),85);
});

test('slow chat delivery does not hold the inventory action queue',async () => {
  env.lamp.flags[NS].light.lowFuelSeconds=90;
  await env.action('on');env.now+=15000;
  let deliver;ChatMessage.create=()=>new Promise(resolve=>{deliver=resolve;});
  let completed=false;const action=env.action('off').then(()=>{completed=true;});
  try {
    for(let i=0;i<100;i++) await Promise.resolve();
    assert.equal(completed,true);assert.equal(env.active(),null);
  } finally {deliver?.();await action;}
});

test('failure to consume ignition refunds the disposable source',async () => {
  const candle = makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
  const matches = makeItem(env.actor,'MATCH',{enabled:false},1,'Спички');
  matches.update = async () => { throw new Error('Inventory write failed'); };
  assert.equal(await env.action('on','CANDLE'),null);
  assert.equal(candle.system.quantity,1); assert.equal(env.active(),undefined);
});

test('failed activation refunds all consumed resources',async () => {
  const candle = makeItem(env.actor,'CANDLE',{mode:'disposable',requiresIgnition:true});
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
  makeItem(env.actor,'MAGIC',{mode:'infinite',requiresIgnition:true});
  const matches = makeItem(env.actor,'MATCH',{enabled:false},1,'Спички');
  matches.flags[NS].ignition={mode:'reusable'};
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
  env.lamp.update = async () => { throw new Error('Item write failed'); };
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
  await game.settings.set(NS,'catalog',catalog);
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
  makeItem(env.actor,'NEW',{mode:'disposable',requiresIgnition:true});
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

test('quick toggle prefers the last usable source over an unrelated stub, while that stub keeps priority in its stack',async()=>{
  const candle=makeItem(env.actor,'CANDLE',{mode:'disposable'},2);
  await env.action('on','CANDLE');await env.action('off');await env.action('on');await env.action('off');
  await env.api.api.quickToggle(env.token);assert.equal(env.active().itemId,'LAMP');await env.action('off');
  await env.api.api.quickToggle(env.token,'CANDLE');assert.equal(env.active().itemId,'CANDLE');assert.equal(candle.system.quantity,1);
});

test('quick toggle skips an empty last tank and uses another available light',async()=>{
  await env.action('on');await env.action('off');env.lamp.flags[NS].light.remainingSeconds=0;
  makeItem(env.actor,'BACKUP',{mode:'infinite'});await env.api.api.quickToggle(env.token);assert.equal(env.active().itemId,'BACKUP');
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
