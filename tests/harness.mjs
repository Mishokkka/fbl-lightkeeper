import {normalizeConfig,makeRuntime} from '../scripts/logic.js';

let serial=0;
const NS='fbl-lightkeeper';
/** Deterministic Foundry adapter; counters measure module work, not a real server or WebGL. */
export async function harness({active=6,inactive=4000,inventory=100,client='GM',moduleUrl=new URL('../scripts/module.js',import.meta.url),openPanel=false}={}) {
  const keys=['Hooks','game','foundry','ui','canvas','document','ChatMessage','Item','setInterval','clearInterval'];
  const originals=new Map(keys.map(key=>[key,{exists:key in globalThis,value:globalThis[key]}]));
  const originalNow=Date.now;
  const stats={}, records=[], intervals=new Map(), callbacks=new Map();
  const reset=()=>{for(const key of ['tokenWrites','itemWrites','sheetRenders','panelRenders','payloadBytes','inactiveReads','inactiveActorReads','sceneScans','tokenScans','catalogReads']) stats[key]=0;records.length=0;};reset();
  let now=1000000, nextTimer=0;
  const register=(name,fn)=>callbacks.set(name,[...(callbacks.get(name)??[]),fn]);
  const fire=async(name,...args)=>{for(const fn of callbacks.get(name)??[]) await fn(...args);};
  const collection=(array=[])=>{
    array.get=id=>array.find(doc=>doc.id===id);
    Object.defineProperty(array,'contents',{get:()=>[...array],configurable:true});return array;
  };
  /** Merge dotted update paths like Foundry, so timestamp deltas exercise real controller code. */
  const apply=(target,changes)=>{
    for(const [path,value] of Object.entries(changes)) {
      const parts=path.split('.');let node=target;
      for(const key of parts.slice(0,-1)) node=node[key]??={};
      const key=parts.at(-1);
      if(value && typeof value==='object' && !Array.isArray(value)) {node[key]??={};apply(node[key],value);}
      else node[key]=structuredClone(value);
    }
  };
  const getFlag=function(ns,key){return key.split('.').reduce((o,k)=>o?.[k],this.flags?.[ns]);};
  const record=(type,id,changes,options)=>{
    stats[type==='token'?'tokenWrites':'itemWrites']++;
    stats.payloadBytes+=Buffer.byteLength(JSON.stringify(changes));
    if(options.render!==false) stats.sheetRenders++;
    records.push({type,id,changes:structuredClone(changes),options:{...options}});
  };
  class Application {
    constructor(options={}) {this.options=options;this.rendered=false;this.element={classList:{add(){},remove(){}},querySelector:()=>null};}
    async render() {stats.panelRenders++;this.html=await this._renderHTML();this.rendered=true;return this;}
    bringToFront() {}
    async close() {this.rendered=false;this._onClose({});}
    _onClose() {}
  }
  const settings=new Map(), configs=new Map();
  const users=collection([{id:'GM',isGM:true,active:true},...Array.from({length:6},(_,i)=>({id:'P'+(i+1),isGM:false,active:true}))]);
  const actors=[],tokens=[],scenes=collection(Array.from({length:20},(_,i)=>({id:'S'+i,tokens:collection()})));
  for(let i=0;i<active;i++) {
    const actor={id:'A'+i,uuid:'Actor.A'+i,items:collection(),testUserPermission:user=>user.id==='P'+(i%6+1)};
    /** Item updates emit hooks even when render:false suppresses associated sheets. */
    for(let j=0;j<inventory;j++) {
      const config=j===0?normalizeConfig({enabled:true,capacitySeconds:7200,remainingSeconds:7200,lowFuelSeconds:0}):{enabled:false};
      const item={id:'I'+j,uuid:actor.uuid+'.Item.I'+j,documentName:'Item',name:j===0?'Лампа '+i:'Снаряжение '+j,type:'gear',parent:actor,system:{quantity:1},flags:{[NS]:{light:config}},getFlag,
        async update(changes,options={}){record('item',this.id,changes,options);apply(this,changes);await fire('updateItem',this,changes,options,game.user.id);return this;},
        async setFlag(ns,key,value){return this.update({['flags.'+ns+'.'+key]:value});}};
      actor.items.push(item);
    }
    const scene=scenes[i%scenes.length];
    const token={id:'T'+i,uuid:'Scene.'+scene.id+'.Token.T'+i,name:'Персонаж '+i,parent:scene,actor,flags:{},getFlag,
      light:{toObject:()=>({bright:0,dim:0})},
      async update(changes,options={}){record('token',this.id,changes,options);apply(this,changes);await fire('updateToken',this,changes,options,game.user.id);return this;}};
    const runtime=makeRuntime(actor.items[0],actor.items[0].getFlag(NS,'light'),{bright:0,dim:0},now);
    runtime.actorKey=actor.uuid;token.flags[NS]={active:runtime};scene.tokens.push(token);tokens.push(token);actors.push(actor);
  }
  for(let i=0;i<inactive;i++) {
    const scene=scenes[i%scenes.length];
    scene.tokens.push({id:'OFF'+i,parent:scene,flags:{},getFlag(ns,key){stats.inactiveReads++;return getFlag.call(this,ns,key);},
      get actor(){stats.inactiveActorReads++;throw new Error('Inactive actor was resolved by a background path');}});
  }
  Object.defineProperty(scenes,'contents',{get:()=>{stats.sceneScans++;return [...scenes];},configurable:true});
  for(const scene of scenes) Object.defineProperty(scene.tokens,'contents',{get:()=>{stats.tokenScans++;return [...scene.tokens];},configurable:true});
  // Arrays above use a configurable contents property only for the root scan counter.
  Date.now=()=>now;
  globalThis.setInterval=(fn,ms)=>{const id=++nextTimer;intervals.set(id,{fn,ms});return id;};
  globalThis.clearInterval=id=>intervals.delete(id);
  globalThis.Hooks={on:register,once:register};
  globalThis.foundry={applications:{api:{ApplicationV2:Application}},utils:{deepClone:value=>structuredClone(value),randomID:()=>`req-${++serial}`}};
  const mod={};
  globalThis.game={user:users.get(client),users,system:{id:'forbidden-lands'},paused:false,modules:{get:()=>mod},scenes,
    settings:{register:(ns,key,c)=>{settings.set(ns+'.'+key,structuredClone(c.default));configs.set(ns+'.'+key,c);},registerMenu(){},
      get:(ns,key)=>{if(key==='catalog')stats.catalogReads++;return settings.get(ns+'.'+key);},
      async set(ns,key,value){settings.set(ns+'.'+key,value);configs.get(ns+'.'+key)?.onChange?.(value);}},keybindings:{register(){}}};
  globalThis.ui={notifications:{info(){},warn(){}}};globalThis.document={hidden:false};
  globalThis.canvas={tokens:{controlled:tokens[0]?[{document:tokens[0],actor:actors[0]}]:[]}};
  globalThis.ChatMessage={create:async()=>{}};globalThis.Item={createDocuments:async data=>data};
  await import(moduleUrl.href+'?harness='+ ++serial);await fire('init');await fire('ready');
  if(openPanel && tokens[0]) await mod.api.open({document:tokens[0],actor:actors[0]});
  return {stats,records,intervals,callbacks,tokens,actors,scenes,users,api:mod.api,fire,reset,apply,
    advance(ms){now+=ms;},
    async tick(){await [...intervals.values()].find(timer=>timer.ms===5000)?.fn();},
    async pause(value){game.paused=value;await fire('pauseGame',value);},
    async close(){await fire('shutdown');Date.now=originalNow;for(const [key,old] of originals){if(old.exists)globalThis[key]=old.value;else delete globalThis[key];}}
  };
}
