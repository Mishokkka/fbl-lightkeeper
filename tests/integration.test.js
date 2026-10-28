import {test, after} from 'node:test';
import assert from 'node:assert/strict';

const listeners = new Map();
function register(name, fn) { const v=listeners.get(name)??[]; v.push(fn); listeners.set(name,v); }
const fire = async (name, ...args) => { for (const fn of listeners.get(name)??[]) await fn(...args); };
globalThis.Hooks = {once:register, on:register};
const deepClone = obj => JSON.parse(JSON.stringify(obj));
globalThis.foundry = {utils:{deepClone},applications:{api:{DialogV2:{}}}};
const settings = new Map();
let fakeTime = 100000;
const originalDateNow = Date.now;
Date.now = () => fakeTime;
const user = {id:'GM1',isGM:true,active:true};
const users = [user]; users.get = id => users.find(u=>u.id===id);
const items=[];
items.get=id=>items.find(i=>i.id===id);
const makeItem=(id,name,quantity,flags={}) => {
  const obj={id,name,documentName:'Item',system:{quantity},flags:deepClone(flags),parent:{id:'ACT1'},
    getFlag(ns,key){return this.flags[ns]?.[key];},
    async setFlag(ns,key,value){this.flags[ns]??={};this.flags[ns][key]=deepClone(value);},
    async update(update){ for(const[k,v] of Object.entries(update)){if(k==='system.quantity')this.system.quantity=v;else throw new Error('unexpected update');}}
  };
  items.push(obj);return obj;
};
const lamp=makeItem('LAMP','Масляная лампа',1,{'fbl-lightkeeper':{light:{enabled:true,mode:'tank',capacitySeconds:100,remainingSeconds:100,dim:6,bright:4,ignitionMode:'consume',ignitionItem:'Спички',refillItem:'Масло',refillSeconds:40}}});
const matches=makeItem('MATCH','Спички',2);
const oil=makeItem('OIL','Масло',1);
const actor={id:'ACT1',items,testUserPermission:()=>true};
const baseLight={bright:0,dim:0,angle:360};
const token={id:'TOK1',name:'Персонаж',actor,flags:{'fbl-lightkeeper':{}},light:{toObject:()=>deepClone(token.currentLight)},currentLight:deepClone(baseLight),
  getFlag(ns,key){return this.flags[ns]?.[key];},
  async update(changes){
    for (const [key,value] of Object.entries(changes)) {
      if (key==='light')this.currentLight=deepClone(value);
      else if (key.startsWith('flags.fbl-lightkeeper.'))this.flags['fbl-lightkeeper'][key.split('.').slice(2).join('.')]=deepClone(value);
      else throw new Error(`Unexpected change key ${key}`);
    }
  },
};
const scene={id:'SC1',tokens:{contents:[token],get:id=>id===token.id?token:null}};
token.parent=scene;
const notices=[];
const module={api:null};
globalThis.game={
  user,users,system:{id:'forbidden-lands'},paused:false,
  modules:{get:()=>module},
  settings:{register:(ns,k,c)=>settings.set(`${ns}.${k}`,c.default),get:(ns,k)=>settings.get(`${ns}.${k}`)},
  scenes:{contents:[scene],get:id=>id===scene.id?scene:null},
  socket:{on:()=>{},emit:()=>{}},
};
globalThis.ui={notifications:{info:m=>notices.push(m),warn:m=>notices.push(m)}};
globalThis.ChatMessage={create:async()=>{}};
globalThis.Item={createDocuments:async d=>d};
globalThis.canvas={tokens:{controlled:[]}};
await import('../scripts/module.js');
await fire('init'); await fire('ready');
const API = module.api;

test('on -> paused -> off -> refill uses real-time correctly',async()=>{
  await API.requestAction(token,'on','LAMP');
  assert.equal(matches.system.quantity,1);
  assert.equal(token.currentLight.bright,4);
  assert.equal(token.getFlag('fbl-lightkeeper','active').remainingSeconds,100);

  fakeTime += 17000;
  game.paused = true;
  await fire('pauseGame',true);
  await new Promise(r=>setTimeout(r,5));
  assert.equal(Math.round(lamp.getFlag('fbl-lightkeeper','light').remainingSeconds),83);

  fakeTime += 500000; // wall-clock advances but Foundry was paused
  game.paused = false;
  await fire('pauseGame',false);
  await new Promise(r=>setTimeout(r,5));
  fakeTime += 10000;
  await API.requestAction(token,'off');
  assert.equal(token.getFlag('fbl-lightkeeper','active'),null);
  assert.equal(Math.round(lamp.getFlag('fbl-lightkeeper','light').remainingSeconds),73);
  assert.deepEqual(token.currentLight,baseLight);

  await API.requestAction(token,'refill','LAMP');
  assert.equal(oil.system.quantity,0);
  assert.equal(Math.round(lamp.getFlag('fbl-lightkeeper','light').remainingSeconds),100);
  await API.requestAction(token,'on','LAMP');
  assert.equal(matches.system.quantity,0);
  assert.equal(token.currentLight.dim,6);
  await API.requestAction(token,'off');
});

after(async()=>{await fire('shutdown');Date.now=originalDateNow;});
