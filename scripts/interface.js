import {normalizeConfig} from './logic.js';
import {defaultCatalog,normalizeCatalog,lines} from './presets.js';
import {renderPanel,renderItemEditor,renderLibrary,readConfig,clockTime} from './views.js';
import {panelUpdateKind} from './runtime.js';

/** Foundry windows share the same renderers as the standalone visual preview. */
export function createInterface(services) {
  const App = foundry.applications.api.ApplicationV2;
  let panel;
  let library;
  const editors = new Map();
  const showError = error => services.warning(error.message ?? String(error));
  let refreshTimer=null, clockTimer=null, dirty=false;
  /** Coalesce a burst of document hooks into one render, and never queue renders while closed. */
  function scheduleRefresh() {
    if(!panel?.rendered) return;
    dirty=true;
    if(refreshTimer!==null || panel.busy) return;
    refreshTimer=setTimeout(async()=>{
      refreshTimer=null;
      if(!panel?.rendered || panel.busy || !dirty) return;
      dirty=false;
      try { await panel.render({force:true}); } catch(error) { showError(error); }
      if(dirty) scheduleRefresh();
    },50);
  }
  /** The 1 Hz DOM-only clock exists only while its panel is open. Hidden tabs do no UI work. */
  function startClock() {
    const active=panel?.rendered?services.active(panel.token):null;
    const needed=active && active.config.mode!=='infinite' && services.clockRunning() && !document.hidden;
    if(needed && clockTimer===null) clockTimer=setInterval(()=>panel?.updateClock(),1000);
    else if(!needed && clockTimer!==null) {clearInterval(clockTimer);clockTimer=null;}
  }
  const onVisibility=()=>{startClock();if(!document.hidden) panel?.updateClock();};
  class Window extends App {
    static DEFAULT_OPTIONS = {classes:['fbl-lk-window'],tag:'section',
      window:{resizable:true,icon:'fa-solid fa-lightbulb'},position:{width:500,height:'auto'}};
    /** Replace a frame body while retaining search position and keyboard/form handlers. */
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
      content.querySelectorAll('form').forEach(form => {
        form.addEventListener('submit',e=>{e.preventDefault();void this.run('save');});
        const updateSections=()=>{
          const value=name=>form.elements.namedItem(name)?.value;
          const show={tank:value('mode')==='tank',ignition:value('ignitionMode')!=='self',cost:value('ignitionMode')==='consume',ignitionName:!value('ignitionResource'),refillName:!value('refillResource')};
          for(const section of form.querySelectorAll('[data-lk-show]')) section.hidden=!show[section.dataset.lkShow];
        };
        form.addEventListener('change',updateSections);updateSections();
      });
      content.addEventListener('keydown',this.handleSave ??= e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='s') { e.preventDefault(); void this.run('save'); }
      });
    }
    /** Dispatch only primary pointer actions; right-clicks must not consume resources. */
    _onClickAction(event,target) {
      if(event.button!==0) return;
      event.preventDefault();
      void this.run(target.dataset.action,target.dataset.id,target);
    }
    /** Keep each window action single-flight and drain deferred panel refreshes afterwards. */
    async run(action,id,target) {
      if (this.busy) return;
      this.busy = true;
      this.element?.classList.add('lk-busy');
      try {
        if(action==='browse-audio') {
          const input=this.element.querySelector(`[name="${id}"]`);
          const Picker=foundry.applications.apps.FilePicker.implementation;
          new Picker({type:'audio',current:input.value,callback:path=>{input.value=path;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}}).render({force:true});
        } else await this.perform(action,id,target);
      }
      catch(error) { showError(error); }
      finally { this.busy = false; this.element?.classList.remove('lk-busy'); if(this===panel && dirty) scheduleRefresh(); }
    }
  }
  class LightPanel extends Window {
    static DEFAULT_OPTIONS = {id:'fbl-lightkeeper-panel',window:{title:'Lightkeeper'},position:{width:420,height:540}};
    /** Store document IDs rather than a stale token reference across scene updates. */
    setToken(token) {
      const doc = token?.document ?? token;
      this.sceneId = doc?.parent?.id; this.tokenId = doc?.id;
    }
    get token() { return services.resolveToken(this.sceneId,this.tokenId); }
    /** Explicit actions and debounced hooks share one pending render rather than piling up. */
    async render(options) {
      if(this.renderPromise) { dirty=true; return this.renderPromise; }
      if(refreshTimer!==null) { clearTimeout(refreshTimer); refreshTimer=null; }
      dirty=false;
      this.renderPromise=super.render(options);
      try { return await this.renderPromise; }
      finally { this.renderPromise=null; startClock(); if(dirty) scheduleRefresh(); }
    }
    async _renderHTML() { return renderPanel({...services.viewModel(this.token),search:this.search ?? ''}); }
    _replaceHTML(html,content) {
      super._replaceHTML(html,content);
      const search = content.querySelector('[data-lk-search]');
      search?.addEventListener('input',() => { this.search=search.value; this.filter(); });
      this.filter();
    }
    /** Filter existing inventory nodes without rebuilding the panel or reading documents. */
    filter() {
      const query = (this.search ?? '').toLocaleLowerCase().trim();
      const rows = [...(this.element?.querySelectorAll('[data-lk-name]') ?? [])];
      let visible = 0;
      for (const row of rows) { row.hidden=!row.dataset.lkName.includes(query); if (!row.hidden) visible++; }
      const empty = this.element?.querySelector('[data-lk-no-results]');
      if (empty) empty.hidden = !rows.length || visible>0;
    }
    /** Update only live timer nodes and refill availability, without rerendering forms. */
    updateClock() {
      if (!this.rendered) return;
      const active = services.active(this.token);
      if (!active) return;
      const clock = this.element.querySelector('[data-lk-clock]');
      const time=clockTime(active.remainingSeconds);
      if (clock && clock.textContent!==time) clock.textContent=time;
      const ratio = active.config.mode==='infinite'?100:Math.max(0,Math.min(100,100*active.remainingSeconds/active.config.capacitySeconds));
      const meter = this.element.querySelector('[data-lk-meter]');
      if (meter) { meter.style.width=`${ratio}%`; meter.parentElement.setAttribute('aria-valuenow',Math.round(ratio)); }
      this.element.querySelector('.lk-burning')?.classList.toggle('lk-low',active.remainingSeconds!==null && active.remainingSeconds<=active.config.lowFuelSeconds);
      const detail=this.element.querySelector('[data-lk-current-detail]');
      if(detail) detail.textContent=services.timeLabel(active.remainingSeconds);
      const refill=this.element.querySelector('[data-lk-current-refill]');
      if(refill && refill.dataset.hasFuel==='true') {
        refill.disabled=active.remainingSeconds>=active.config.capacitySeconds;
        refill.title=refill.disabled?'Бак полный':refill.dataset.refillHint;
      }
    }
    _onClose(options) {
      if(refreshTimer!==null) clearTimeout(refreshTimer);
      if(clockTimer!==null) clearInterval(clockTimer);
      refreshTimer=null; clockTimer=null; dirty=false;
      document.removeEventListener?.('visibilitychange',onVisibility);
      super._onClose(options);
    }
    /** Route panel actions through the authoritative inventory queue. */
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
    static DEFAULT_OPTIONS = {window:{title:'Источник света'},position:{width:560,height:650}};
    /** Snapshot editable Item configuration; the running instance remains independent. */
    constructor(item) {
      super({id:`fbl-lightkeeper-item-${item.uuid ?? item.id}`}); this.item=item;
      const identified = services.identify(item); this.config=identified.config; this.origin=identified.origin;
    }
    async _renderHTML() { return `<form class="lk-item-form" autocomplete="off">${renderItemEditor(this.item,this.config,services.catalog(),this.origin)}</form>`; }
    _replaceHTML(html,content) {
      super._replaceHTML(html,content);
      content.querySelector('[name="remainingMinutes"]')?.addEventListener('input',event=>{
        // Clearing an optional field means keeping current fuel, not restoring the opening snapshot.
        this.remainingEdited=event.target.value.trim()!=='';
      });
    }
    get form() { return this.element?.querySelector('form'); }
    /** Validate the Item form and save either an Item snapshot or a reusable template. */
    async perform(action) {
      if (action==='load-preset') {
        const id = this.form.elements.namedItem('templateChoice')?.value;
        const preset = services.catalog().sources.find(s=>s.id===id);
        if (!preset) throw new Error('Выберите шаблон.');
        this.config=normalizeConfig({...preset.config,remainingSeconds:preset.config.capacitySeconds});
        this.remainingEdited=true;
        await this.render({force:true}); return;
      }
      if (!this.form.reportValidity()) return;
      this.config=readConfig(this.form,this.config,{item:true});
      if (action==='save') { await services.saveItem(this.item,this.config,{remainingEdited:this.remainingEdited}); await this.close(); }
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
    static DEFAULT_OPTIONS = {id:'fbl-lightkeeper-library',window:{title:'Шаблоны света'},position:{width:800,height:710}};
    /** Share the library window opened from settings and the token panel. */
    constructor() {
      super();
      if(library?.rendered) return library;
      library=this; this.draft=services.catalog(); this.kind='sources'; this.selectedId=this.draft.sources[0]?.id;
    }
    async _renderHTML() { return renderLibrary(this.draft,this.kind,this.selectedId,this); }
    _replaceHTML(html,content) {
      super._replaceHTML(html,content);
      content.querySelector('form')?.addEventListener('input',() => {
        this.dirty=true; const state=this.element.querySelector('.lk-save-state'); if(state) state.textContent='Не сохранено';
      });
      content.querySelector('[data-lk-import]')?.addEventListener('change',e => { void this.importFile(e.target.files[0]).catch(showError); });
    }
    /** Retain the current form in the draft before selecting, importing or saving entries. */
    snapshot() {
      const entry=this.draft[this.kind].find(e=>e.id===this.selectedId);
      const form=this.element?.querySelector('form');
      if (!entry || !form) return;
      const value=name=>form.elements.namedItem(name)?.value ?? '';
      Object.assign(entry,{label:value('label'),icon:value('icon'),names:lines(value('names')),uuids:lines(value('uuids')),
        itemTypes:lines(value('itemTypes').split(',').map(v=>v.trim())),matchMode:value('matchMode')});
      if (this.kind==='sources') entry.config=readConfig(form,entry.config);
    }
    /** Merge JSON by ID and repair selection so an initially empty section remains saveable. */
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
      if (!this.draft[this.kind].some(entry=>entry.id===this.selectedId)) this.selectedId=this.draft[this.kind][0]?.id;
      this.importInfo=`Импортировано: ${incoming.sources.length} источников, ${incoming.resources.length} правил. Нажмите «Сохранить библиотеку».`;
      this.dirty=true; await this.render({force:true});
    }
    /** Apply library actions to the draft; persist only after explicit save. */
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
        const form=this.element.querySelector('form');
        if (form && !form.reportValidity()) return;
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
  /** Reuse the library and preserve its unsaved draft when adding an Item-derived preset. */
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
  /** Reuse one editor per document UUID and bring it forward after rendering. */
  async function openItem(item) {
    if (!services.isGM()) return services.warning('Настройки предмета меняет ГМ.');
    if (!item || item.documentName!=='Item') return services.warning('Выберите предмет.');
    const key=item.uuid ?? item.id;
    let editor=editors.get(key); if (!editor) { editor=new ItemEditor(item); editors.set(key,editor); }
    await editor.render({force:true}); editor.bringToFront(); return editor;
  }
  return {Menu:PresetLibrary,openLibrary,openItem,
    async open(token) { panel ??= new LightPanel(); panel.setToken(token); await panel.render({force:true}); document.addEventListener?.('visibilitychange',onVisibility); panel.bringToFront(); return panel; },
    /** Filter events by document relevance and update clock-only diffs without rebuilding DOM. */
    refresh(event) {
      if(!panel?.rendered) return;
      const selected=panel.token ?? {id:panel.tokenId,parent:{id:panel.sceneId}};
      const kind=panelUpdateKind(event,selected);
      if(kind==='clock') {panel.updateClock();startClock();}
      else if(kind==='render') scheduleRefresh();
    },
    follow(token) { if(panel?.rendered) { panel.setToken(token); scheduleRefresh(); } },
    clock() { panel?.updateClock(); },
    /** Cancel owned timers and visibility listeners before closing all module windows. */
    async close() {
      if(refreshTimer!==null) clearTimeout(refreshTimer);
      if(clockTimer!==null) clearInterval(clockTimer);
      refreshTimer=null; clockTimer=null;
      if(typeof document!=='undefined') document.removeEventListener?.('visibilitychange',onVisibility);
      await Promise.all([panel,library,...editors.values()].filter(Boolean).map(app=>app.close()));
    }
  };
}
