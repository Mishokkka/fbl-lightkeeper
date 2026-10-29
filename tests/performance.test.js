import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';

test('six lights checkpoint with deltas, no world scans, sheet renders or library reads',async()=>{
  const env=await harness();
  try {
    assert.equal(env.intervals.size,1);env.reset();env.advance(5000);await env.tick();
    assert.equal(env.stats.tokenWrites,6);assert.equal(env.stats.itemWrites,6);
    assert.equal(env.stats.inactiveReads,0);assert.equal(env.stats.inactiveActorReads,0);
    assert.equal(env.stats.sceneScans,0);assert.equal(env.stats.tokenScans,0);
    assert.equal(env.stats.sheetRenders,0);assert.equal(env.stats.catalogReads,0);
    assert.ok(env.stats.payloadBytes<2000);
    assert.ok(env.records.every(record=>record.options.render===false));
    assert.ok(env.records.filter(record=>record.type==='item').every(record=>Object.keys(record.changes).length===1));
  } finally {await env.close();}
});

test('closed player clients never start background intervals or write timers',async()=>{
  for(const client of ['P1','P2','P3','P4','P5','P6']) {
    const env=await harness({client});
    try {assert.equal(env.intervals.size,0);env.reset();env.advance(5000);await env.tick();assert.equal(env.stats.tokenWrites+env.stats.itemWrites,0);}
    finally {await env.close();}
  }
});

test('each of six clients on separate scenes receives an authenticated GM sound once',async()=>{
  for(const client of ['P1','P2','P3','P4','P5','P6']) {
    const env=await harness({client,active:0,inactive:0});let played=0;
    try {
      game.audio={interface:{},create:()=>({duration:1,async load(){},async play(){played++;},async stop(){}})};
      const gm=env.users.get('GM'),cue={id:'shared-cue',src:'match.ogg',volume:.4,fadeSeconds:0};gm.getFlag=()=>cue;
      for(let i=0;i<2;i++)await env.fire('updateUser',gm,{flags:{'fbl-lightkeeper':{sound:{id:cue.id}}}},{},gm.id);
      for(let i=0;i<10;i++)await Promise.resolve();assert.equal(played,1);assert.equal(env.intervals.size,0);
      const player=env.users.get(client);player.getFlag=()=>({...cue,id:'forged'});
      await env.fire('updateUser',player,{flags:{'fbl-lightkeeper':{sound:{id:'forged'}}}},{},player.id);
      assert.equal(played,1);
    } finally {await env.close();}
  }
});

test('pause, zero sources and closing the panel remove unnecessary intervals',async()=>{
  const env=await harness({active:1,openPanel:true});
  try {
    assert.equal(env.intervals.size,2);await env.pause(true);await new Promise(resolve=>setTimeout(resolve,70));assert.equal(env.intervals.size,0);
    await env.pause(false);await new Promise(resolve=>setTimeout(resolve,70));assert.equal(env.intervals.size,2);
    await env.api.requestAction(env.tokens[0],'off');await new Promise(resolve=>setTimeout(resolve,70));assert.equal(env.intervals.size,0);
    await env.fire('shutdown');assert.equal(env.intervals.size,0);
  } finally {await env.close();}
});

test('checkpoint and unrelated hook bursts do not rebuild the open light panel',async()=>{
  const env=await harness({openPanel:true});
  try {
    env.reset();env.advance(5000);await env.tick();
    for(let i=0;i<100;i++) await env.fire('updateToken',env.tokens[i%6],{x:i,y:i});
    await new Promise(resolve=>setTimeout(resolve,70));assert.equal(env.stats.panelRenders,0);
    await env.fire('updateItem',env.actors[0].items[1],{name:'A'});
    await env.fire('updateItem',env.actors[0].items[2],{name:'B'});
    await env.fire('updateToken',env.tokens[0],{name:'Новое имя'});
    await new Promise(resolve=>setTimeout(resolve,70));assert.equal(env.stats.panelRenders,1);
  } finally {await env.close();}
});

test('removing a token or source cancels only its timer, including while paused',async()=>{
  const env=await harness({active:2});
  try {
    await env.fire('deleteToken',env.tokens[0]);env.reset();env.advance(5000);await env.tick();
    assert.equal(env.stats.tokenWrites,1);
    await env.pause(true);
    const item=env.actors[1].items[0];env.actors[1].items.splice(0,1);await env.fire('deleteItem',item);
    // The invalidation runs in the existing per-inventory queue.
    await new Promise(resolve=>setTimeout(resolve,0));assert.equal(env.tokens[1].getFlag('fbl-lightkeeper','active'),null);
  } finally {await env.close();}
});

test('item sheet headers have no module configuration button',async()=>{
  const env=await harness({active:0,inactive:0});
  try {assert.equal(env.callbacks.has('getItemSheetHeaderButtons'),false);assert.equal(env.callbacks.has('getHeaderControlsApplicationV2'),false);}
  finally {await env.close();}
});

test('election changes stop the old GM timer and only the new leader restarts it',async()=>{
  const env=await harness({active:1});
  try {
    const other={id:'A-GM',isGM:true,active:true};env.users.push(other);
    await env.fire('userConnected',other,true);assert.equal(env.intervals.size,0);
    env.reset();env.advance(60000);await env.tick();assert.equal(env.stats.tokenWrites,0);
    other.active=false;await env.fire('userConnected',other,false);assert.equal(env.intervals.size,1);
    env.advance(5000);await env.tick();assert.equal(env.tokens[0].getFlag('fbl-lightkeeper','active').remainingSeconds,7195);
  } finally {await env.close();}
});

test('slow independent inventories checkpoint concurrently without overlapping heartbeats',async()=>{
  const env=await harness();
  try {
    const releases=[];
    for(const actor of env.actors) {
      const item=actor.items[0], update=item.update;
      item.update=async function(...args){await new Promise(resolve=>releases.push(resolve));return update.apply(this,args);};
    }
    env.reset();env.advance(5000);const first=env.tick();
    for(let attempt=0;attempt<100 && releases.length<6;attempt++) await Promise.resolve();
    assert.equal(releases.length,6);
    await env.tick();assert.equal(releases.length,6);
    for(const release of releases) release();await first;
    assert.equal(env.stats.itemWrites,6);assert.equal(env.stats.tokenWrites,6);
  } finally {await env.close();}
});

test('deleting the selected token clears its panel and stops the local clock',async()=>{
  const env=await harness({active:1,openPanel:true});
  try {
    const token=env.tokens[0];token.parent.tokens.splice(token.parent.tokens.indexOf(token),1);
    await env.fire('deleteToken',token);await new Promise(resolve=>setTimeout(resolve,70));
    assert.equal(env.intervals.size,0);
  } finally {await env.close();}
});

test('an infinite light is invalidated by actor reassignment without a polling timer',async()=>{
  const env=await harness({active:1});
  try {
    const token=env.tokens[0];await token.update({'flags.fbl-lightkeeper.active.config.mode':'infinite'});
    assert.equal(env.intervals.size,0);
    token.actor={id:'OTHER',uuid:'Actor.OTHER',items:new Map()};await env.fire('updateToken',token,{actorId:'OTHER'});
    await new Promise(resolve=>setTimeout(resolve,0));assert.equal(token.getFlag('fbl-lightkeeper','active'),null);
  } finally {await env.close();}
});

test('deleting an actor clears an infinite source without a polling timer',async()=>{
  const env=await harness({active:1});
  try {
    const token=env.tokens[0];await token.update({'flags.fbl-lightkeeper.active.config.mode':'infinite'});
    assert.equal(env.intervals.size,0);
    const actor=token.actor;token.actor=null;await env.fire('deleteActor',actor);
    await new Promise(resolve=>setTimeout(resolve,0));assert.equal(token.getFlag('fbl-lightkeeper','active'),null);
  } finally {await env.close();}
});

test('the panel uses the active recipe even after the Item changes to another mode',async()=>{
  const env=await harness({active:1});
  try {
    const token=env.tokens[0],item=env.actors[0].items[0];
    await token.update({'flags.fbl-lightkeeper.active.config.refillItem':'Топливо'});
    env.actors[0].items[1].name='Топливо';
    await item.update({'flags.fbl-lightkeeper.light.mode':'infinite','flags.fbl-lightkeeper.light.refillItem':'Другой запас'});
    const panel=await env.api.open(token);
    assert.match(panel.html,/data-action="refill"/);assert.match(panel.html,/1 шт\. Топливо/);
  } finally {await env.close();}
});

test('without any GM the open panel freezes fuel and stops its local clock',async()=>{
  const env=await harness({active:1,openPanel:true});
  try {
    const gm=env.users.get('GM');gm.active=false;await env.fire('userConnected',gm,false);
    env.advance(60000);const panel=await env.api.open(env.tokens[0]);
    assert.match(panel.html,/data-lk-clock>02:00:00</);assert.equal(env.intervals.size,0);
  } finally {await env.close();}
});

test('editors for copied Item IDs use different Foundry application IDs',async()=>{
  const env=await harness({active:2,inactive:0,inventory:1});
  try {
    const first=await env.api.configure(env.actors[0].items[0]);
    const second=await env.api.configure(env.actors[1].items[0]);
    assert.notEqual(first.options.id,second.options.id);
  } finally {await env.close();}
});

test('applying an Item preset waits for its in-flight inventory checkpoint',async()=>{
  const env=await harness({active:1,inactive:0});
  let release;const work=[];
  try {
    const item=env.actors[0].items[0],update=item.update;
    item.update=async function(changes,...args) {
      if('flags.fbl-lightkeeper.light.remainingSeconds' in changes && !release) await new Promise(resolve=>{release=resolve;});
      return update.call(this,changes,...args);
    };
    env.advance(5000);const checkpoint=env.tick();work.push(checkpoint);
    while(!release) await Promise.resolve();
    let applied=false;const applying=env.api.applyPreset(item,'flashlight').then(()=>{applied=true;});work.push(applying);
    for(let i=0;i<20;i++) await Promise.resolve();assert.equal(applied,false);
    release();await Promise.all(work);assert.equal(item.getFlag('fbl-lightkeeper','light').remainingSeconds,900);
  } finally {release?.();await Promise.allSettled(work);await env.close();}
});

test('an in-flight checkpoint cannot resurrect a source cleared by actor reassignment',async()=>{
  const env=await harness({active:1,inactive:0});
  let release,checkpoint;
  try {
    const token=env.tokens[0],item=env.actors[0].items[0],update=item.update;
    item.update=async function(...args) {await new Promise(resolve=>{release=resolve;});return update.apply(this,args);};
    env.advance(5000);checkpoint=env.tick();while(!release) await Promise.resolve();
    token.actor={id:'OTHER',uuid:'Actor.OTHER',items:new Map()};await token.update({actorId:'OTHER'});
    await new Promise(resolve=>setTimeout(resolve,0));assert.equal(token.getFlag('fbl-lightkeeper','active'),null);
    release();await checkpoint;assert.equal(token.getFlag('fbl-lightkeeper','active'),null);
  } finally {release?.();await checkpoint;await env.close();}
});

test('Foundry flag deletions remove active indexes and stop all clocks',async()=>{
  for(const namespace of [false,true]) {
    const env=await harness({active:1,inactive:0,openPanel:true});
    try {
      const token=env.tokens[0];let changes;
      if(namespace) {delete token.flags['fbl-lightkeeper'];changes={flags:{'-=fbl-lightkeeper':null}};}
      else {delete token.flags['fbl-lightkeeper'].active;changes={flags:{'fbl-lightkeeper':{'-=active':null}}};}
      await env.fire('updateToken',token,changes);await new Promise(resolve=>setTimeout(resolve,70));
      assert.equal(env.intervals.size,0);
    } finally {await env.close();}
  }
});
