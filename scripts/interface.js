import {normalizeConfig,normalizeIgniter,igniterStatus,refillHint} from './logic.js';
import {defaultCatalog,normalizeCatalog,lines} from './presets.js';
import {renderPanel,renderItemEditor,renderLibrary,readConfig,readIgniter,clockTime} from './views.js';
import {panelUpdateKind} from './runtime.js';

/** Disabled fields are irrelevant; invalid advanced fields must be revealed before focusing them. */
function validateForm(form) {
  if(!form)return true;
  const invalid=form.querySelector('input:invalid,select:invalid,textarea:invalid');
  for(let node=invalid?.parentElement;node && node!==form;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;
  return form.reportValidity();
}

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
          const show={tank:value('mode')==='tank',finite:value('mode')!=='infinite',source:!!form.elements.namedItem('enabled')?.checked,refillName:!value('refillResource')};
          for(const section of form.querySelectorAll('[data-lk-show]')) section.hidden=!show[section.dataset.lkShow];
          for(const control of form.querySelectorAll('input,select,textarea'))control.disabled=!!control.closest('[data-lk-show][hidden]');
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
      if(this.sceneId!==doc?.parent?.id || this.tokenId!==doc?.id){this.ignitionId='auto';this.tokenChanged=true;}
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
    async _renderHTML() { return renderPanel({...services.viewModel(this.token,this.ignitionId??'auto'),search:this.search ?? ''}); }
    _replaceHTML(html,content) {
      const inventoryOpen=!this.tokenChanged && content.querySelector('.lk-inventory-config')?.open;
      const selectedItem=!this.tokenChanged && content.querySelector('[name="configureItem"]')?.value;
      super._replaceHTML(html,content);
      const inventory=content.querySelector('.lk-inventory-config'),picker=content.querySelector('[name="configureItem"]');
      if(inventory)inventory.open=!!inventoryOpen;
      if(picker && [...picker.options].some(option=>option.value===selectedItem))picker.value=selectedItem;
      this.tokenChanged=false;
      const search = content.querySelector('[data-lk-search]');
      search?.addEventListener('input',() => { this.search=search.value; this.filter(); });
      content.querySelector('[name="ignitionChoice"]')?.addEventListener('change',event=>{this.ignitionId=event.target.value;scheduleRefresh();});
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
        refill.title=refill.disabled?'Бак полный':refillHint(active.config,active.remainingSeconds,refill.dataset.refillFuel);
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
      if (action==='configure-selected') {await openItem(this.token?.actor?.items.get(this.element.querySelector('[name="configureItem"]')?.value),this.token);return;}
      if (action==='configure') { await openItem(this.token?.actor?.items.get(id),this.token); return; }
      if (!this.token) throw new Error('Выберите токен персонажа.');
      if (action==='ignite') await services.action(this.token,'switch',id,{ignitionId:this.ignitionId??'auto'});
      else if (action==='adjust') await services.action(this.token,'adjust','',{deltaSeconds:Number(id)});
      else if (['off','refill','shutter'].includes(action)) await services.action(this.token,action,id ?? '');
      await this.render({force:true});
    }
  }
  class ItemEditor extends Window {
    static DEFAULT_OPTIONS = {window:{title:'Настройка предмета'},position:{width:560,height:650}};
    /** Snapshot editable Item configuration; the running instance remains independent. */
    constructor(item,token) {
      super({id:`fbl-lightkeeper-item-${item.uuid ?? item.id}`}); this.item=item;
      const identified = services.identify(item); this.config=identified.config; this.origin=identified.origin;
      this.igniter=services.identifyIgniter(item);
      this.context=services.itemContext?.(item,token)??'';
    }
    async _renderHTML() { return `<form class="lk-item-form" autocomplete="off">${renderItemEditor(this.item,this.config,services.catalog(),this.origin,this.igniter,this.context)}</form>`; }
    _replaceHTML(html,content) {
      super._replaceHTML(html,content);
      content.querySelector('[name="remainingMinutes"]')?.addEventListener('input',event=>{
        // Clearing an optional field means keeping current fuel, not restoring the opening snapshot.
        this.remainingEdited=event.target.value.trim()!=='';
      });
      const quantity=content.querySelector('[name="quantity"]');
      if(quantity && this.quantityEdited)quantity.value=this.quantityDraft;
      quantity?.addEventListener('input',event=>{this.quantityEdited=event.target.value.trim()!=='';this.quantityDraft=event.target.value;this.updateStock({refreshQuantity:false});});
      content.querySelector('form')?.addEventListener('change',()=>this.updateStock({refreshQuantity:false}));this.updateStock();
    }
    /** Keep live stock and inherited policy readable without replacing unsaved form values. */
    updateStock({refreshQuantity=true}={}) {
      const form=this.form,node=this.element?.querySelector('[data-lk-igniter-stock]');
      if(!form || !node)return;
      const policy=services.identifyIgniter(this.item),inherited=policy.preset?.ignition.mode??'none';
      const quantity=form.elements.namedItem('quantity');
      if(quantity && refreshQuantity && !this.quantityEdited && quantity!==document.activeElement)quantity.value=this.item.system.quantity;
      const stack=this.element.querySelector('[data-lk-stack-warning]');
      if(stack)stack.hidden=!(form.elements.namedItem('enabled')?.checked && form.elements.namedItem('mode')?.value==='tank' && Number(quantity?.value)>1);
      const picker=form.elements.namedItem('igniterMode'),mode=picker.value==='inherit'?inherited:picker.value;
      const inheritOption=[...picker.options].find(option=>option.value==='inherit');
      if(inheritOption)inheritOption.textContent='По библиотеке · '+(policy.preset?.label??'нет правила');
      const status=igniterStatus(this.item,mode);
      node.textContent=mode==='none'?(form.elements.namedItem('canIgnite')?.checked?'Не используется как инструмент; передаёт огонь только когда горит.':'Не используется как инструмент розжига.'):
        status.stock+(status.reason?' · '+status.reason:'')+(mode==='bonus'?' · Заряды меняются в листе предмета.':'');
    }
    get form() { return this.element?.querySelector('form'); }
    /** Validate the Item form and save either an Item snapshot or a reusable template. */
    async perform(action) {
      if(action==='open-sheet') {
        const sheet=this.item.sheet;if(!sheet?.render)throw new Error('Лист предмета недоступен.');await sheet.render(true);return;
      }
      if (action==='load-preset') {
        const ignition=readIgniter(this.form);
        this.igniter={...this.igniter,config:ignition??this.igniter.config,origin:ignition?'item':'recognized'};
        const id = this.form.elements.namedItem('templateChoice')?.value;
        const preset = services.catalog().sources.find(s=>s.id===id);
        if (!preset) throw new Error('Выберите шаблон.');
        this.config=normalizeConfig({...preset.config,remainingSeconds:preset.config.capacitySeconds});
        this.remainingEdited=true;
        await this.render({force:true}); return;
      }
      if (!validateForm(this.form)) return;
      this.config=readConfig(this.form,this.config,{item:true});
      if (action==='save') {
        const quantity=this.quantityEdited?Number(this.form.elements.namedItem('quantity').value):undefined;
        await services.saveItem(this.item,this.config,{remainingEdited:this.remainingEdited && !this.form.elements.namedItem('remainingMinutes')?.disabled,ignition:readIgniter(this.form),quantity});await this.close();
      }
      else if (action==='save-template') {
        const catalog = services.catalog(); const id=foundry.utils.randomID();
        catalog.sources.push({id,label:this.item.name,icon:'lantern',names:[this.item.name],uuids:[],itemTypes:[],matchMode:'exact',
          config:{...this.config,enabled:true,templateId:id,remainingSeconds:this.config.capacitySeconds}});
        await services.saveCatalog(catalog); await openLibrary(id);
        services.info('Шаблон создан. Изменения предмета сохраните отдельно.');
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
        this.updateRecognition();
      });
      this.updateRecognition();
      content.querySelector('[data-lk-import]')?.addEventListener('change',e => { void this.importFile(e.target.files[0]).catch(showError); });
    }
    updateRecognition() {
      const form=this.element?.querySelector('form'),node=this.element?.querySelector('[data-lk-recognition]');
      if(!form || !node)return;
      const automatic=lines(form.elements.namedItem('names')?.value).length || lines(form.elements.namedItem('uuids')?.value).length;
      node.hidden=!!automatic;node.textContent=automatic?'':'Без названий или UUID — только ручное применение шаблона.';
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
      else entry.ignition=readIgniter(form);
    }
    /** Merge JSON by ID and repair selection so an initially empty section remains saveable. */
    async importFile(file) {
      if (!file) return;
      if(!validateForm(this.element?.querySelector('form')))return;
      const raw=JSON.parse(await file.text());
      if (![1,2].includes(raw.version) || !Array.isArray(raw.sources) || !Array.isArray(raw.resources)) throw new Error('Ожидается экспорт библиотеки Lightkeeper версии 1 или 2.');
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
      if(action!=='delete' && !validateForm(this.element?.querySelector('form')))return;
      this.snapshot();
      const entries=this.draft[this.kind]; const index=entries.findIndex(e=>e.id===this.selectedId);
      if (action==='select') this.selectedId=id;
      else if (action==='kind') { this.kind=id; this.selectedId=this.draft[id][0]?.id; }
      else if (action==='new') {
        const key=foundry.utils.randomID();
        entries.push({id:key,label:this.kind==='sources'?'Новый источник':'Новый запас',icon:this.kind==='sources'?'lantern':'fuel',names:[],uuids:[],itemTypes:[],matchMode:'exact',
          ...(this.kind==='sources'?{config:normalizeConfig({enabled:true})}:{ignition:normalizeIgniter()})});
        this.selectedId=key; this.dirty=true;
      } else if (action==='delete' && index>=0) { entries.splice(index,1); this.selectedId=entries[Math.min(index,entries.length-1)]?.id; this.dirty=true; }
      else if (['up','down'].includes(action) && index>=0) {
        const next=index+(action==='up'?-1:1);
        if(next>=0 && next<entries.length) { [entries[index],entries[next]]=[entries[next],entries[index]]; this.dirty=true; }
      } else if(action==='save') {
        const form=this.element.querySelector('form');
        if (!validateForm(form)) return;
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
    else if(!id){library.bringToFront();return library;}
    if (id) {
      const added=services.catalog().sources.find(s=>s.id===id);
      if(added && !library.draft.sources.some(s=>s.id===id)) library.draft.sources.push(added);
      if(!validateForm(library.element?.querySelector('form'))){library.bringToFront();return library;}
      library.snapshot();
      library.kind='sources'; library.selectedId=id;
    }
    await library.render({force:true}); library.bringToFront(); return library;
  }
  /** Reuse one editor per document UUID and bring it forward after rendering. */
  async function openItem(item,token) {
    if (!services.isGM()) return services.warning('Настройки предмета меняет ГМ.');
    if (!item || item.documentName!=='Item') return services.warning('Выберите предмет.');
    const key=item.uuid ?? item.id;
    let editor=editors.get(key);
    if(editor?.rendered){editor.updateStock();editor.bringToFront();return editor;}
    if (!editor) { editor=new ItemEditor(item,token); editors.set(key,editor); }
    await editor.render({force:true}); editor.bringToFront(); return editor;
  }
  return {Menu:PresetLibrary,openLibrary,openItem,
    async open(token) { panel ??= new LightPanel(); panel.setToken(token); await panel.render({force:true}); document.addEventListener?.('visibilitychange',onVisibility); panel.bringToFront(); return panel; },
    /** Filter events by document relevance and update clock-only diffs without rebuilding DOM. */
    refresh(event) {
      if(!event || event.type==='item')for(const editor of editors.values()) {
        if(editor.rendered && (!event || (editor.item.uuid??editor.item.id)===(event.document.uuid??event.document.id))) {
          if(event?.deleted){void editor.close();services.info('Предмет израсходован или удалён; его редактор закрыт.');}
          else editor.updateStock();
        }
      }
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
