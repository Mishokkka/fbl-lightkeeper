// Local visual harness: actual module and windows, simulated Foundry documents.
const clone=value=>structuredClone(value);
function merge(target,source) {
  for(const [key,value] of Object.entries(source)) {
    if(value && typeof value==='object' && !Array.isArray(value)) merge(target[key]??={},value);
    else target[key]=clone(value);
  }
  return target;
}
function apply(target,changes) {
  for(const [path,value] of Object.entries(changes)) {
    const keys=path.split('.'); let node=target;
    for(const key of keys.slice(0,-1)) node=node[key]??={};
    merge(node,{[keys.at(-1)]:value});
  }
}
const listeners=new Map();
const register=(name,fn)=>listeners.set(name,[...(listeners.get(name)??[]),fn]);
async function fire(name,...args) { for(const fn of listeners.get(name)??[]) await fn(...args); }
function collection(values=[]) { values.get=id=>values.find(v=>v.id===id); Object.defineProperty(values,'contents',{get:()=>[...values]}); return values; }
function getFlag(ns,key) { return key.split('.').reduce((o,k)=>o?.[k],this.flags?.[ns]); }
let top=10;
class PreviewApp {
  static DEFAULT_OPTIONS={classes:[],window:{frame:true},position:{width:500,height:760}};
  constructor(options={}) {
    this.options={};
    const chain=[]; for(let cls=this.constructor;cls && cls!==Function.prototype;cls=Object.getPrototypeOf(cls)) if(Object.hasOwn(cls,'DEFAULT_OPTIONS')) chain.unshift(cls.DEFAULT_OPTIONS);
    for(const defaults of [...chain,options]) merge(this.options,defaults);
    this.rendered=false;
  }
  async render() {
    if(!this.element) {
      this.element=document.createElement('section'); this.element.id=this.options.id ?? crypto.randomUUID();
      this.element.className='application '+(this.options.classes??[]).join(' ');
      const pos=this.options.position;
      this.element.style.width=pos.width+'px'; this.element.style.height=(typeof pos.height==='number'?pos.height:760)+'px';
      this.element.style.top='75px'; this.element.style.left=this.element.id==='fbl-lightkeeper-panel'?'28px':'550px';
      if(innerWidth<1150 && this.element.id!=='fbl-lightkeeper-panel') this.element.style.left='40px';
      this.element.innerHTML='<header class="window-header"><i class="fa-solid fa-lightbulb"></i><h1 class="window-title"></h1><button type="button" data-action="close" aria-label="Закрыть">×</button></header><div class="window-content"></div>';
      this.element.querySelector('.window-title').textContent=this.options.window.title;
      this.element.addEventListener('click',event=>{
        const target=event.target.closest('[data-action]'); if(!target || target.disabled) return;
        if(target.dataset.action==='close') void this.close(); else this._onClickAction(event,target);
      });
      document.body.append(this.element);
    }
    const html=await this._renderHTML(); this._replaceHTML(html,this.element.querySelector('.window-content'));
    this.rendered=true; return this;
  }
  bringToFront() { if(!this.element) throw new Error('Window has not rendered'); this.element.style.zIndex=++top; }
  async close() { this.element?.remove(); this.rendered=false; this.element=null; this._onClose({}); }
  _onClose() {}
}
globalThis.Hooks={on:register,once:register};
globalThis.foundry={applications:{api:{ApplicationV2:PreviewApp}},utils:{deepClone:clone,randomID:()=>crypto.randomUUID()}};
const settings=new Map(); const settingsConfig=new Map();
const gm={id:'GM',isGM:true,active:true,flags:{},getFlag};
const actor={id:'A1',uuid:'Actor.A1',name:'Элиас Блэквуд',items:collection(),testUserPermission:()=>true};
function item(id,name,quantity=1) {
  const doc={id,uuid:'Actor.A1.Item.'+id,parent:actor,type:'gear',documentName:'Item',name,system:{quantity},flags:{},getFlag,
    async update(changes) { apply(this,changes); await fire('updateItem',this,changes); return this; },
    async setFlag(ns,key,value) { return this.update({['flags.'+ns+'.'+key]:value}); }};
  actor.items.push(doc); return doc;
}
const lamp=item('LAMP','Фонарь со шторками'); item('CANDLE','Свеча',3); item('FLASH','Карманный фонарик'); item('MATCH','Спички',8); item('OIL','Ламповое масло',2); item('BAT','Батарейка',2);
const scene={id:'SCENE',tokens:collection()};
const token={id:'TOKEN',name:actor.name,actor,parent:scene,flags:{},getFlag,
  light:{toObject:()=>({bright:0,dim:0,angle:360,negative:false,luminosity:.5,darkness:{min:0,max:1},animation:{type:null,speed:5,intensity:5}})},
  async update(changes) { apply(this,changes); await fire('updateToken',this,changes); return this; }};
scene.tokens.push(token);
const module={};
globalThis.game={user:gm,users:collection([gm]),system:{id:'forbidden-lands'},paused:false,scenes:collection([scene]),modules:{get:()=>module},
  settings:{register:(ns,key,c)=>{settings.set(ns+'.'+key,clone(c.default)); settingsConfig.set(ns+'.'+key,c);},registerMenu:()=>{},
    get:(ns,key)=>settings.get(ns+'.'+key),async set(ns,key,value){settings.set(ns+'.'+key,clone(value)); settingsConfig.get(ns+'.'+key)?.onChange?.(value);}},
  keybindings:{register:()=>{}}};
function toast(message) { const el=document.createElement('div'); el.className='demo-toast'; el.textContent=message; document.querySelector('.demo-toasts').append(el); setTimeout(()=>el.remove(),4000); }
globalThis.ui={notifications:{info:toast,warn:toast}};
globalThis.ChatMessage={create:async data=>{const div=document.createElement('div');div.innerHTML=data.content;toast(div.textContent);}};
globalThis.canvas={tokens:{controlled:[{document:token,actor}],placeables:[]}};
await import('../scripts/module.js'); await fire('init'); await fire('ready');
lamp.flags['fbl-lightkeeper']={light:{...module.api.getCatalog().sources.find(s=>s.id==='hooded-lantern').config,remainingSeconds:863}};
await module.api.requestAction(token,'on','LAMP'); await module.api.open();
document.querySelector('#demo-panel').onclick=()=>module.api.open();
document.querySelector('#demo-library').onclick=()=>module.api.library();
document.querySelector('#demo-light').onclick=()=>document.body.classList.toggle('theme-light');
document.querySelector('#demo-pause').onclick=async()=>{game.paused=!game.paused;await fire('pauseGame',game.paused);};
globalThis.demo={api:module.api,token,actor,fire};
