import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
const NS='fbl-lightkeeper';

test('an empty Bonus box stays visible with its count and reason, without spending a different tool',async()=>{
  const env=await harness({active:1,inactive:0,inventory:3});
  try {
    const token=env.tokens[0],source=env.actors[0].items[0],box=env.actors[0].items[1],matches=env.actors[0].items[2];
    await env.api.requestAction(token,'off');source.flags[NS].light.requiresIgnition=true;
    box.name='Коробок';box.flags[NS].ignition={mode:'bonus'};box.system.bonus={value:0,max:8};
    matches.name='Спички';matches.flags[NS].ignition={mode:'quantity'};
    const panel=await env.api.open(token);panel.ignitionId='item:I1';await panel.render({force:true});
    assert.match(panel.html,/<option value="item:I1"[^>]*disabled[^>]*>Коробок · Bonus 0 \/ 8/);
    assert.match(panel.html,/<small class="lk-block-reason">Нет зарядов Bonus/);
    assert.equal(await env.api.requestAction(token,'on',source.id,{ignitionId:'item:I1'}),null);
    assert.equal(matches.system.quantity,1);
    await box.update({'system.bonus.value':2});await panel.render({force:true});
    assert.doesNotMatch(panel.html,/<small class="lk-block-reason">Нет зарядов Bonus/);
    assert.ok(await env.api.requestAction(token,'on',source.id,{ignitionId:'item:I1'}));assert.equal(box.system.bonus.value,1);
  } finally {await env.close();}
});

test('a player with ownership sees disabled actions when no GM is connected',async()=>{
  const env=await harness({active:1,inactive:0,client:'P1'});
  try {
    env.users.get('GM').active=false;await env.fire('userConnected',env.users.get('GM'),false);
    const panel=await env.api.open(env.tokens[0]);
    const buttons=panel.html.match(/<button[^>]*data-action="(?:off|ignite|refill|shutter)"[^>]*>/g);
    assert.ok(buttons.length);assert.ok(buttons.every(html=>html.includes('disabled')));
    assert.match(panel.html,/Нужен подключённый ГМ/);
  } finally {await env.close();}
});

test('disposable sources do not display tank-refill warnings',async()=>{
  const env=await harness({active:1,inactive:0,inventory:1});
  try {
    await env.api.requestAction(env.tokens[0],'off');env.actors[0].items[0].flags[NS].light.mode='disposable';
    const panel=await env.api.open(env.tokens[0]);assert.doesNotMatch(panel.html,/Топливо не настроено/);assert.doesNotMatch(panel.html,/data-action="refill"/);
  }finally{await env.close();}
});

test('changing player control refreshes an already open panel without resetting its source',async()=>{
  const env=await harness({active:1,inactive:0,client:'P1',openPanel:true});
  try {
    const panel=await env.api.open(env.tokens[0]),before=structuredClone(env.tokens[0].flags[NS].active);
    env.reset();await game.settings.set(NS,'allowPlayers',false);await new Promise(resolve=>setTimeout(resolve,70));
    assert.equal(env.stats.panelRenders,1);assert.match(panel.html,/ГМ отключил управление светом для игроков/);
    assert.deepEqual(env.tokens[0].flags[NS].active,before);assert.equal(env.stats.tokenWrites,0);
  }finally{await env.close();}
});
