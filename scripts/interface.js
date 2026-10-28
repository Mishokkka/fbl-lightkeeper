import {normalizeConfig} from './logic.js';
import {defaultCatalog,normalizeCatalog,lines} from './presets.js';
import {renderPanel,renderItemEditor,renderLibrary,readConfig,clockTime} from './views.js';

/** Foundry windows share the same renderers as the standalone visual preview. */
export function createInterface(services) {
  const App = foundry.applications.api.ApplicationV2;
  let panel;
  let library;
  const editors = new Map();
  const showError = error => services.warning(error.message ?? String(error));
  class Window extends App {
    static DEFAULT_OPTIONS = {classes:['fbl-lk-window'],tag:'section',
      window:{resizable:true,icon:'fa-solid fa-lightbulb'},position:{width:500,height:'auto'}};
    _replaceHTML(html,content) {
      const scroll = content.querySelector('.lk-sources')?.scrollTop ?? 0;
      const searchFocus=content.querySelector('[data-lk-search]')===document.activeElement;
      const caret=searchFocus?document.activeElement.selectionStart:null;
      content.innerHTML = html;
      const list = content.querySelector('.lk-sources');
      if (list) list.scrollTop = scroll;
      if(searchFocus) {
        const search=content.querySelector('[data-lk-search]'); search?.focus();
        if(search && caret!==null) { try { search.setSelectionRange(caret,caret); } catch {} }
      }
      content.querySelectorAll('form').forEach(form => form.addEventListener('submit',e => {
        e.preventDefault(); void this.run('save');
      }));
      content.addEventListener('keydown',this.handleSave ??= e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='s') { e.preventDefault(); void this.run('save'); }
      });
    }
    _onClickAction(event,target) {
      if(event.button!==0) return;
      event.preventDefault();
      void this.run(target.dataset.action,target.dataset.id,target);
    }
    async run(action,id,target) {
      if (this.busy) return;
      this.busy = true;
      this.element?.classList.add('lk-busy');
      try { await this.perform(action,id,target); }
      catch(error) { showError(error); }
      finally { this.busy = false; this.element?.classList.remove('lk-busy'); }
    }
  }
  class LightPanel extends Window {
    static DEFAULT_OPTIONS = {id:'fbl-lightkeeper-panel',window:{title:'Lightkeeper · Источники света'},position:{width:490,height:760}};
    setToken(token) {
      const doc = token?.document ?? token;
      this.sceneId = doc?.parent?.id; this.tokenId = doc?.id;
    }
    get token() { return services.resolveToken(this.sceneId,this.tokenId); }
    async _renderHTML() { return renderPanel({...services.viewModel(this.token),search:this.search ?? ''}); }
    _replaceHTML(html,content) {
      super._replaceHTML(html,content);
      const search = content.querySelector('[data-lk-search]');
      search?.addEventListener('input',() => { this.search=search.value; this.filter(); });
      this.filter();
    }
    filter() {
      const query = (this.search ?? '').toLocaleLowerCase().trim();
      const rows = [...(this.element?.querySelectorAll('[data-lk-name]') ?? [])];
      let visible = 0;
      for (const row of rows) { row.hidden=!row.dataset.lkName.includes(query); if (!row.hidden) visible++; }
      const empty = this.element?.querySelector('[data-lk-no-results]');
      if (empty) empty.hidden = !rows.length || visible>0;
    }
    updateClock() {
      if (!this.rendered) return;
      const active = services.active(this.token);
      if (!active) return;
      const clock = this.element.querySelector('[data-lk-clock]');
      if (clock) clock.textContent = clockTime(active.remainingSeconds);
      const ratio = active.config.mode==='infinite'?100:Math.max(0,Math.min(100,100*active.remainingSeconds/active.config.capacitySeconds));
      const meter = this.element.querySelector('[data-lk-meter]');
      if (meter) { meter.style.width=`${ratio}%`; meter.parentElement.setAttribute('aria-valuenow',Math.round(ratio)); }
      this.element.querySelector('.lk-burning')?.classList.toggle('lk-low',active.remainingSeconds!==null && active.remainingSeconds<=active.config.lowFuelSeconds);
    }
    async perform(action,id) {
      if (action==='library') { await openLibrary(); return; }
      if (action==='configure') { await openItem(this.token?.actor?.items.get(id)); return; }
      if (!this.token) throw new Error('Выберите токен персонажа.');
      if (action==='ignite') await services.action(this.token,'switch',id);
      else if (action==='adjust') await services.action(this.token,'adjust','',{deltaSeconds:Number(id)});
      else if (['off','refill','shutter'].includes(action)) await services.action(this.token,action,id ?? '');
      await this.render({force:true});
    }
  }
  class ItemEditor extends Window {
    static DEFAULT_OPTIONS = {window:{title:'Lightkeeper · Настройка предмета'},position:{width:620,height:760}};
    constructor(item) {
      super({id:`fbl-lightkeeper-item-${item.id}`}); this.item=item;
      const identified = services.identify(item); this.config=identified.config; this.origin=identified.origin;
    }
    async _renderHTML() { return `<form class="lk-item-form" autocomplete="off">${renderItemEditor(this.item,this.config,services.catalog(),this.origin)}</form>`; }
    get form() { return this.element?.querySelector('form'); }
    async perform(action) {
      if (action==='load-preset') {
        const id = this.form.elements.namedItem('templateChoice')?.value;
        const preset = services.catalog().sources.find(s=>s.id===id);
        if (!preset) throw new Error('Выберите шаблон.');
        this.config=normalizeConfig({...preset.config,remainingSeconds:preset.config.capacitySeconds});
        await this.render({force:true}); return;
      }
      if (!this.form.reportValidity()) return;
      this.config=readConfig(this.form,this.config,{item:true});
      if (action==='save') { await services.saveItem(this.item,this.config); await this.close(); }
      else if (action==='save-template') {
        const catalog = services.catalog(); const id=foundry.utils.randomID();
        catalog.sources.push({id,label:this.item.name,icon:'lantern',names:[this.item.name],uuids:[],itemTypes:[],matchMode:'exact',
          config:{...this.config,enabled:true,templateId:id,remainingSeconds:this.config.capacitySeconds}});
        await services.saveCatalog(catalog); await openLibrary(id);
        services.info('Шаблон добавлен. В библиотеке можно изменить название и распознавание.');
      }
    }
    _onClose(options) { editors.delete(this.item.uuid ?? this.item.id); super._onClose(options); }
  }
  class PresetLibrary extends Window {
    static DEFAULT_OPTIONS = {id:'fbl-lightkeeper-library',window:{title:'Lightkeeper · Библиотека шаблонов'},position:{width:900,height:820}};
    constructor() {
      super();
      if(library?.rendered) return library;
      library=this; this.draft=services.catalog(); this.kind='sources'; this.selectedId=this.draft.sources[0]?.id;
    }
    async _renderHTML() { return renderLibrary(this.draft,this.kind,this.selectedId,this); }
    _replaceHTML(html,content) {
      super._replaceHTML(html,content);
      content.querySelector('form')?.addEventListener('input',() => {
        this.dirty=true; const state=this.element.querySelector('.lk-save-state'); if(state) state.textContent='Есть несохранённые изменения';
      });
      content.querySelector('[data-lk-import]')?.addEventListener('change',e => { void this.importFile(e.target.files[0]).catch(showError); });
    }
    snapshot() {
      const entry=this.draft[this.kind].find(e=>e.id===this.selectedId);
      const form=this.element?.querySelector('form');
      if (!entry || !form) return;
      const value=name=>form.elements.namedItem(name)?.value ?? '';
      Object.assign(entry,{label:value('label'),icon:value('icon'),names:lines(value('names')),uuids:lines(value('uuids')),
        itemTypes:lines(value('itemTypes').split(',').map(v=>v.trim())),matchMode:value('matchMode')});
      if (this.kind==='sources') entry.config=readConfig(form,entry.config);
    }
    async importFile(file) {
      if (!file) return;
      const raw=JSON.parse(await file.text());
      if (raw.version!==1 || !Array.isArray(raw.sources) || !Array.isArray(raw.resources)) throw new Error('Ожидается экспорт библиотеки Lightkeeper версии 1.');
      const incoming=normalizeCatalog(raw); this.snapshot();
      for (const kind of ['sources','resources']) {
        const byId=new Map(this.draft[kind].map(e=>[e.id,e]));
        for (const entry of incoming[kind]) byId.set(entry.id,entry);
        this.draft[kind]=[...byId.values()];
      }
      this.importInfo=`Импортировано: ${incoming.sources.length} источников, ${incoming.resources.length} правил. Нажмите «Сохранить библиотеку».`;
      this.dirty=true; await this.render({force:true});
    }
    async perform(action,id) {
      this.snapshot();
      const entries=this.draft[this.kind]; const index=entries.findIndex(e=>e.id===this.selectedId);
      if (action==='select') this.selectedId=id;
      else if (action==='kind') { this.kind=id; this.selectedId=this.draft[id][0]?.id; }
      else if (action==='new') {
        const key=foundry.utils.randomID();
        entries.push({id:key,label:this.kind==='sources'?'Новый источник':'Новый запас',icon:this.kind==='sources'?'lantern':'fuel',names:[],uuids:[],itemTypes:[],matchMode:'exact',config:normalizeConfig({enabled:true})});
        this.selectedId=key; this.dirty=true;
      } else if (action==='delete' && index>=0) { entries.splice(index,1); this.selectedId=entries[Math.min(index,entries.length-1)]?.id; this.dirty=true; }
      else if (['up','down'].includes(action) && index>=0) {
        const next=index+(action==='up'?-1:1);
        if(next>=0 && next<entries.length) { [entries[index],entries[next]]=[entries[next],entries[index]]; this.dirty=true; }
      } else if(action==='save') {
        if (!this.element.querySelector('form')?.reportValidity() && entries.length) return;
        this.draft=normalizeCatalog(this.draft); await services.saveCatalog(this.draft); this.dirty=false;
        services.info('Библиотека света сохранена.');
      } else if(action==='defaults') {
        const defaults=defaultCatalog();
        for(const kind of ['sources','resources']) for(const entry of defaults[kind]) if(!this.draft[kind].some(e=>e.id===entry.id)) this.draft[kind].push(entry);
        this.selectedId ??= this.draft[this.kind][0]?.id; this.dirty=true;
      } else if(action==='export') {
        const blob=new Blob([JSON.stringify(normalizeCatalog(this.draft),null,2)],{type:'application/json'});
        const url=URL.createObjectURL(blob); const anchor=document.createElement('a'); anchor.href=url; anchor.download='lightkeeper-presets.json'; anchor.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); return;
      } else if(action==='import') { this.element.querySelector('[data-lk-import]').click(); return; }
      await this.render({force:true});
    }
  }
  async function openLibrary(id) {
    if (!services.isGM()) return services.warning('Библиотеку настраивает ГМ.');
    if (!library || !library.rendered) library=new PresetLibrary();
    if (id) {
      library.snapshot();
      const added=services.catalog().sources.find(s=>s.id===id);
      if(added && !library.draft.sources.some(s=>s.id===id)) library.draft.sources.push(added);
      library.kind='sources'; library.selectedId=id;
    }
    await library.render({force:true}); library.bringToFront(); return library;
  }
  async function openItem(item) {
    if (!services.isGM()) return services.warning('Настройки предмета меняет ГМ.');
    if (!item || item.documentName!=='Item') return services.warning('Выберите предмет.');
    const key=item.uuid ?? item.id;
    let editor=editors.get(key); if (!editor) { editor=new ItemEditor(item); editors.set(key,editor); }
    await editor.render({force:true}); editor.bringToFront(); return editor;
  }
  return {Menu:PresetLibrary,openLibrary,openItem,
    async open(token) { panel ??= new LightPanel(); panel.setToken(token); await panel.render({force:true}); panel.bringToFront(); return panel; },
    refresh() { if(panel?.rendered && !panel.busy) void panel.render({force:true}); },
    follow(token) { if(panel?.rendered) { panel.setToken(token); void panel.render({force:true}); } },
    clock() { panel?.updateClock(); },
    async close() { await Promise.all([panel,library,...editors.values()].filter(Boolean).map(app=>app.close())); }
  };
}
