import {createPortal} from 'react-dom';
import ThemeSettings from '../theme/ThemeSettings';
import SettingRow from './SettingRow';
import {StatusBarSettings,type StatusPreferences} from "../editor/EditorStatusBar";
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { DesktopPanel, useDesktopPanels } from '../workspace/DesktopPanels';
import { ArrowLeft, Check, ChevronRight, Icon, Info, iconComponent, Keyboard, LayoutPanelTop, Minus, Palette, PencilLine, Plus, Search, Server, SlidersHorizontal, Trash2, X, RefreshCw, Plug, Settings, MoreHorizontal, GripVertical, WandSparkles } from "../../shared/icons";
import AboutSettings from './AboutSettings';
import {aboutSearchKeywords} from './aboutInfo';
import AppearanceSettings from './AppearanceSettings';
import AnnotationSettings from './AnnotationSettings';
import type {usePanelIconDragPreferences} from './usePanelIconDragPreferences';
import type {useAnnotationPreferences} from './useAnnotationPreferences';
import { useAppearance } from './useAppearance';
import { MODEL_CONFIGURATION_LIMIT, MODEL_CONTEXT_TOKEN_MAX, reasoningLevelValues, effectiveReasoningLevels, effectiveInputTypes, withImportedReasoningDefaults, modelConnectionAddress, inputTypeValues, type Config, type ModelService, type ModelEntry, type ModelProbeRequest, type ModelProbeResult, type ReasoningLevel, type InputType } from './modelConfig';
import { sortCatalogModels } from './catalogOrder';
import ShortcutSettings from './ShortcutSettings';
import {useWindowAnnotations} from '../annotations/windowAnnotations';
import HistoryRetentionSettings from '../history/HistoryRetentionSettings';
import type {HistoryLimits} from '../history/historyTypes';
import {AIButtonLayoutSettings} from './AIButtonLayoutSettings';
import type {useAIButtonLayout} from '../chat/aiButtonLayout';
import './settings.css';

export type SettingsSection='appearance'|'appearance-reserved'|'features'|'writing'|'models'|'shortcuts'|'about';
type Props={panelIconDragPreferences:ReturnType<typeof usePanelIconDragPreferences>;annotationPreferences:ReturnType<typeof useAnnotationPreferences>;statusPreferences:StatusPreferences;config:Config;initialSection:SettingsSection;restoreKey:number;appearance:ReturnType<typeof useAppearance>;busy:boolean;
  historyLimits?:HistoryLimits;onSaveHistoryLimits?:(limits:HistoryLimits)=>Promise<void>;
  aiButtonLayout:ReturnType<typeof useAIButtonLayout>;
  onProbe:(body:ModelProbeRequest,signal?:AbortSignal)=>Promise<ModelProbeResult>;onRequest:(route:string,body:unknown)=>Promise<void>;onReload:()=>Promise<void>;onClose:()=>void};
type ServiceDraft=Omit<ModelService,'id'|'hasKey'>&{id?:string;key:string;clearKey:boolean};
const sections=[{id:'appearance' as const,label:'界面',description:'顶部编辑栏、文字、正文排版与底部栏',Icon:LayoutPanelTop},
  {id:'appearance-reserved' as const,label:'外观',description:'外观设置',Icon:Palette},
  {id:'features' as const,label:'功能',description:'悬浮工具与面板',Icon:SlidersHorizontal},
  {id:'writing' as const,label:'写作',description:'续写与写作节奏',Icon:PencilLine},
  {id:'models' as const,label:'模型',description:'AI 服务与模型管理',Icon:iconComponent("model.choose")},
  {id:'shortcuts' as const,label:'快捷键',description:'编辑与面板操作',Icon:Keyboard},
  {id:'about' as const,label:'关于',description:'版本、应用更新、离线帮助与诊断信息',keywords:aboutSearchKeywords,Icon:Info}];

const sectionMatches=(item:typeof sections[number],search:string)=>(item.label+item.description+('keywords' in item?item.keywords:'')).toLowerCase().includes(search.trim().toLowerCase());

export default function SettingsPage(props:Props){
  return <DesktopPanel id="settings" title="设置" open><SettingsContent {...props}/></DesktopPanel>;
}

function SettingsContent({panelIconDragPreferences,annotationPreferences,statusPreferences,config,initialSection,restoreKey,appearance,busy,historyLimits,onSaveHistoryLimits,aiButtonLayout,onProbe,onRequest,onReload,onClose}:Props){
  const [section,setSection]=useState(initialSection),[search,setSearch]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [draft,setDraft]=useState<ServiceDraft|null>(null),[modelId,setModelId]=useState(''),[modelName,setModelName]=useState(''),[filter,setFilter]=useState(''),[removeId,setRemoveId]=useState<string|null>(null),[discard,setDiscard]=useState(false);
  const [catalog,setCatalog]=useState<ModelEntry[]>([]),[catalogOpen,setCatalogOpen]=useState(false),[catalogSearch,setCatalogSearch]=useState(''),[checked,setChecked]=useState<string[]>([]),[probing,setProbing]=useState(false),[modelSettings,setModelSettings]=useState<string|null>(null),[menu,setMenu]=useState<string|null>(null),[menuPosition,setMenuPosition]=useState({left:0,top:0});
  const [generation,setGeneration]=useState<Record<string,{status:'pending'|'success'|'error'|'cancelled';message:string}>>({});
  const [contextModes,setContextModes]=useState<Record<string,boolean>>({}),[contextInputs,setContextInputs]=useState<Record<string,string>>({}),[outputModes,setOutputModes]=useState<Record<string,boolean>>({}),[outputInputs,setOutputInputs]=useState<Record<string,string>>({});
  const [limit,setLimit]=useState(String(config.continuationLimit));
  const probeController=useRef<AbortController|null>(null),probeSequence=useRef(0),capabilityEndpoint=useRef(''),autoProbeTimer=useRef<number|undefined>(undefined);
  const closeButton=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),returnFocus=useRef<HTMLElement|null>(null),dialogRef=useRef<HTMLDivElement>(null),editFocus=useRef<HTMLElement|null>(null),catalogFocus=useRef<HTMLElement|null>(null),discardRef=useRef<HTMLDivElement>(null);
  const editing=!!draft,sectionInfo=sections.find(item=>item.id===section)!;
  useEffect(()=>{if(!draft)setSection(initialSection);},[initialSection]);
  useEffect(()=>{const close=(event:Event)=>{if((event as CustomEvent).detail!=='settings')return;event.preventDefault();if(busy)return;if(draft)setDiscard(true);else onClose();};window.addEventListener('hive:panel-close-requested',close);return()=>window.removeEventListener('hive:panel-close-requested',close);},[busy,draft,onClose]);
  useEffect(()=>{setLimit(String(config.continuationLimit));},[config.continuationLimit]);
  useEffect(()=>{if(discard)discardRef.current?.scrollIntoView({block:'nearest'});},[discard]);
  const desktop=useDesktopPanels(),{markedPanels}=useWindowAnnotations();
  const detached=desktop.windows.has('settings');
  const [position,setPosition]=useState({x:Math.max(8,window.innerWidth-820),y:48});
  const [minimized,setMinimized]=useState(false),[openingNative,setOpeningNative]=useState(desktop.enabled);
  useEffect(()=>setMinimized(false),[restoreKey]);
  useEffect(()=>{
    if(!desktop.enabled)return;
    const timer=window.setTimeout(()=>{
      const rect=panel.current?.getBoundingClientRect();
      if(!rect){setOpeningNative(false);return;}
      desktop.detach('settings',{rect:()=>({x:rect.left,y:rect.top,width:rect.width,height:rect.height}),onReady:()=>setOpeningNative(false),onFailure:()=>setOpeningNative(false)});
    },0);
    return()=>window.clearTimeout(timer);
  },[]);
  useEffect(()=>{
    returnFocus.current=document.activeElement as HTMLElement;
    closeButton.current?.focus();
    return()=>{if(returnFocus.current?.isConnected)returnFocus.current.focus();};
  },[]);
  useEffect(()=>{if(draft){dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="取消编辑"]')?.focus();}else if(editFocus.current?.isConnected){editFocus.current.focus();editFocus.current=null;}},[!!draft]);
  useEffect(()=>{if(catalogOpen){catalogFocus.current=dialogRef.current?.ownerDocument.activeElement as HTMLElement;dialogRef.current?.querySelector<HTMLInputElement>('[aria-label="搜索上游模型"]')?.focus();}else if(catalogFocus.current?.isConnected){catalogFocus.current.focus();catalogFocus.current=null;}},[catalogOpen]);
  function drag(event:ReactPointerEvent<HTMLElement>){
    if(event.button!==0 || !event.isPrimary || (event.target as Element).closest('button'))return;
    if(detached){desktop.beginDrag('settings',event);return;}
    event.preventDefault();
    const target=event.currentTarget, win=target.ownerDocument.defaultView!, pointer=event.pointerId;
    const start={x:event.clientX,y:event.clientY}, rect=panel.current!.getBoundingClientRect();
    target.setPointerCapture(pointer);
    const move=(e:PointerEvent)=>{if(e.pointerId!==pointer)return;setPosition({x:Math.max(0,Math.min(win.innerWidth-80,rect.left+e.clientX-start.x)),y:Math.max(0,Math.min(win.innerHeight-36,rect.top+e.clientY-start.y))});};
    const end=(e:PointerEvent)=>{if(e.pointerId!==pointer)return;target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',end);target.removeEventListener('pointercancel',end);if(target.hasPointerCapture(pointer))target.releasePointerCapture(pointer);};
    target.addEventListener('pointermove',move);target.addEventListener('pointerup',end);target.addEventListener('pointercancel',end);
  }
  function key(event:React.KeyboardEvent){
    if(event.key!=='Escape'||panel.current?.querySelector('[data-status-dragging="true"]'))return;
    event.preventDefault();event.stopPropagation();if(busy)return;if(menu){setMenu(null);return;}if(catalogOpen){setCatalogOpen(false);return;}if(removeId){setRemoveId(null);return;}if(discard){setDiscard(false);return;}if(modelSettings){setModelSettings(null);return;}if(editing){setDiscard(true);return;}onClose();
  }
  async function run(route:string,body:unknown,success?:string){
    setError('');setNotice('');try{await onRequest(route,body);if(success)setNotice(success);return true;}
    catch(error){setError((error as Error).message);return false;}
  }
  function cancelProbe(){probeController.current?.abort();probeSequence.current++;setProbing(false);setGeneration(old=>Object.fromEntries(Object.entries(old).map(([id,item])=>[id,item.status==='pending'?{status:'cancelled',message:'测试已取消。'}:item])));}
  function edit(service?:ModelService){
    cancelProbe();editFocus.current=(panel.current?.ownerDocument.activeElement as HTMLElement)||null;capabilityEndpoint.current=service?.endpoint||'';
    setError('');setNotice('');setRemoveId(null);setDiscard(false);setModelId('');setModelName('');setFilter('');
    setCatalog([]);setCatalogOpen(false);setModelSettings(null);setGeneration({});setContextModes({});setContextInputs({});setOutputModes({});setOutputInputs({});setDraft(service?{id:service.id,name:service.name,endpoint:service.endpoint,enabled:service.enabled,models:service.models.map(item=>({...item})),key:'',clearKey:false}:
      {name:'',endpoint:'',enabled:true,models:[],key:'',clearKey:false});
  }
  function addModel(){
    if(!draft)return;const id=modelId.trim();
    if(!id){setError('请填写模型 ID。');return;}
    if(draft.models.length>=MODEL_CONFIGURATION_LIMIT){setError('最多保存 100 个模型。');return;}
    if(draft.models.some(item=>item.id===id)){setError('这个模型 ID 已添加。');return;}
    setDraft({...draft,models:[...draft.models,withImportedReasoningDefaults({id,name:modelName.trim()||id})]});setModelId('');setModelName('');setError('');
  }
  async function saveService(event:FormEvent){
    event.preventDefault();if(!draft)return;
    if(modelId.trim()){setError('还有未添加的模型，请先点击「添加模型」。');return;}
    for(const model of draft.models){const customContext=contextModes[model.id]??model.contextTokens!==undefined,customOutput=outputModes[model.id]??model.maxOutputTokens!==undefined,rawContext=contextInputs[model.id]??String(model.contextTokens??''),rawOutput=outputInputs[model.id]??String(model.maxOutputTokens??'');if(customContext&&!validToken(rawContext)){setModelSettings(model.id);setError('上下文窗口请输入有效的正整数 token。');return;}if(customOutput){const message=outputError(rawOutput,customContext?Number(rawContext):model.capabilities?.contextTokens,model.capabilities?.maxOutputTokens);if(message){setModelSettings(model.id);setError(message);return;}}}
    const {key,clearKey,...rawService}=draft;
    const same=!!modelConnectionAddress(rawService.endpoint)&&modelConnectionAddress(rawService.endpoint)===modelConnectionAddress(capabilityEndpoint.current);
    const service=same?rawService:{...rawService,models:rawService.models.map(m=>({...m,capabilities:undefined,reasoningLevels:undefined,manualReasoningLevels:undefined,defaultReasoning:undefined}))};
    if(await run('/model-services',{revision:config.revision,service,key,clearKey},'服务已保存。')){setDraft(null);setDiscard(false);}
  }
  async function probe(service:ServiceDraft, modelId?:string, quiet=false, signal?:AbortSignal){
    if(!service.endpoint.trim())return;
    if(!quiet)window.clearTimeout(autoProbeTimer.current);probeController.current?.abort();const controller=new AbortController();probeController.current=controller;const sequence=++probeSequence.current;
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    if(!quiet){setProbing(true);setError('');setNotice('');}setGeneration(old=>{const next:typeof old=Object.fromEntries(Object.entries(old).map(([id,item])=>[id,item.status==='pending'?{status:'cancelled',message:'测试已取消。'}:item]));if(modelId)next[modelId]={status:'pending',message:'生成中…'};return next;});
    try {const result=await onProbe({revision:config.revision,service:{id:service.id,endpoint:service.endpoint},key:service.key||undefined,clearKey:service.clearKey,...(modelId?{modelId}:{})},combined);
      if(combined.aborted||sequence!==probeSequence.current)return;
      if(result.kind==='catalog') {setCatalog(result.models);if(!quiet)setNotice(`模型列表可读取，共 ${result.models.length} 个候选。${result.hasMore?'上游标记列表尚未完整。':''}`);}
      else if(!quiet)setGeneration(old=>({...old,[result.modelId]:{status:'success',message:`生成成功 · ${result.elapsedMs} ms`}}));
    } catch(e){if(!combined.aborted&&sequence===probeSequence.current&&!quiet){if(modelId)setGeneration(old=>({...old,[modelId]:{status:'error',message:`生成失败 · ${(e as Error).message}`}}));else setError((e as Error).message);}} finally{if(sequence===probeSequence.current){setProbing(false);probeController.current=null;}}
  }
  useEffect(()=>{if(!draft?.endpoint.trim())return;const controller=new AbortController();autoProbeTimer.current=window.setTimeout(()=>void probe(draft,undefined,true,controller.signal),650);return()=>{window.clearTimeout(autoProbeTimer.current);controller.abort();probeController.current?.abort();probeSequence.current++;setProbing(false);setGeneration(old=>Object.fromEntries(Object.entries(old).map(([id,item])=>[id,item.status==='pending'?{status:'cancelled',message:'测试已取消。'}:item])));};},[draft?.id,draft?.endpoint,draft?.key,draft?.clearKey]);
  useEffect(()=>()=>{probeController.current?.abort();probeSequence.current++;},[]);
  function applyCatalog(){if(!draft)return;const incoming=new Map(catalog.map(m=>[m.id,m])),sameTarget=!!modelConnectionAddress(capabilityEndpoint.current)&&modelConnectionAddress(capabilityEndpoint.current)===modelConnectionAddress(draft.endpoint);const models:ModelEntry[]=draft.models.filter(m=>checked.includes(m.id)).map(m=>{const capabilities=incoming.get(m.id)?.capabilities;const allowed=m.reasoningLevels?.filter(level=>!!capabilities?.reasoning?.[level]);const updated=withImportedReasoningDefaults({...m,capabilities,reasoningLevels:allowed,manualReasoningLevels:sameTarget?m.manualReasoningLevels:undefined});return {...updated,defaultReasoning:m.defaultReasoning&&effectiveReasoningLevels(updated).includes(m.defaultReasoning)?m.defaultReasoning:undefined};});for(const candidate of catalog){if(checked.includes(candidate.id)&&!models.some(m=>m.id===candidate.id))models.push(withImportedReasoningDefaults(candidate));}if(models.length>MODEL_CONFIGURATION_LIMIT){setError('最多保存 100 个模型，请减少勾选。');return;}capabilityEndpoint.current=draft.endpoint;setDraft({...draft,models});setCatalogOpen(false);setError('');setNotice('已更新草稿；上游不再支持的强度已恢复为服务默认，请保存服务。');}
  function moveModel(from:number,to:number){if(!draft||to<0||to>=draft.models.length||from===to)return;const models=[...draft.models], [item]=models.splice(from,1);models.splice(to,0,item);setDraft({...draft,models});}
  async function moveService(from:number,to:number){if(to<0||to>=config.services.length||from===to)return;const ids=config.services.map(s=>s.id),[id]=ids.splice(from,1);ids.splice(to,0,id);await run('/model-services/reorder',{revision:config.revision,ids},'服务顺序已保存。');}
  function navigate(id:SettingsSection){if(draft)return;setSection(id);setSearch('');setError('');setNotice('');}
  const currentService=draft?.id?config.services.find(item=>item.id===draft.id):undefined;
  const shownServices=config.services.filter(item=>(item.name+' '+item.endpoint+' '+item.models.map(model=>model.name+' '+model.id).join(' ')).toLowerCase().includes(filter.toLowerCase()));
  return <div ref={panel} data-panel-id="settings" className={'settings-floating workspace-panel'+(minimized?' settings-floating-minimized':'')} role="dialog" aria-label="设置" style={{...(detached?{}:{left:position.x,top:position.y}),...(openingNative?{visibility:'hidden'}:{})}} onKeyDown={key}>
    <div className="settings-floating-title panel-drag-header" data-window-annotation={markedPanels.indexOf('settings')+1||undefined} onPointerDown={drag}><b>设置</b><div className="settings-floating-actions">
      <button type="button" aria-label={minimized?'恢复设置':'最小化设置'} title={minimized?'恢复设置':'最小化设置'} onClick={()=>{if(detached)window.hiveDesktop?.windowCommand('minimize','settings');else setMinimized(value=>!value);}}><Minus size={16}/></button>
      <button type="button" aria-label="关闭设置" disabled={busy} onClick={()=>{if(draft)setDiscard(true);else onClose();}}><X size={16}/></button>
    </div></div>
    {detached&&['n','s','e','w','ne','nw','se','sw'].map(edge=><div key={edge} className={'panel-resize panel-resize-'+edge} onPointerDown={event=>desktop.beginDrag('settings',event,edge)}/>)}
    <div className="settings-page" style={minimized?{display:'none'}:undefined}>
    <aside className="settings-sidebar" inert={editing}>
      <div className="settings-brand"><span>H</span><b>HIVE</b><small>设置</small></div>
      <button ref={closeButton} type="button" className="settings-return" onClick={()=>{if(draft)setDiscard(true);else onClose();}} disabled={busy}><ArrowLeft size={16}/>返回写作</button>
      <label className="settings-search"><Icon name="settings.search" size={15}/><input aria-label="搜索设置" placeholder="搜索设置…" value={search} disabled={editing} onChange={event=>setSearch(event.target.value)}/></label>
      <nav aria-label="设置分类">{sections.filter(item=>sectionMatches(item,search)).map(({id,label,description,Icon})=><button key={id} type="button" className={section===id?'active':''} title={description} aria-current={section===id?'page':undefined} disabled={editing} onClick={()=>navigate(id)}><Icon size={16}/><span>{label}</span></button>)}</nav>
      {search.trim()&&!sections.some(item=>sectionMatches(item,search))&&<p className="settings-nav-empty">没有匹配的设置分类</p>}
    </aside>
    <main className="settings-content" inert={editing}>
      <div className="settings-content-scroll">
      <header className="settings-page-heading"><div className="settings-title-icon">{sectionInfo.id==="models"?<Icon name="model.settings" size={22}/>:<sectionInfo.Icon size={22}/>}</div><div><h1>{sectionInfo.label==='模型'?'模型配置':sectionInfo.label}</h1><p>{sectionInfo.description}</p></div></header>
      {error&&<div className="settings-feedback error" role="alert"><span>{error}</span>{(error.includes('其他窗口')||error.includes('重新载入'))&&<button type="button" disabled={busy} onClick={async()=>{try{await onReload();setError('');setNotice('已重新载入配置。');}catch(error){setError((error as Error).message);}}}>重新载入配置</button>}</div>}
      {notice&&<p className="settings-feedback" role="status"><Check size={14}/>{notice}</p>}
      {section==='about'&&<AboutSettings/>}
      {section==='appearance'&&<>
        <section className="settings-card"><AppearanceSettings {...appearance} group="ribbon"/></section>
        <section className="settings-card"><AppearanceSettings {...appearance} group="text"/></section>
        <section className="settings-card"><AppearanceSettings {...appearance} group="typography"/></section>
        <StatusBarSettings preferences={statusPreferences}/>
      </>}
      {section==='appearance-reserved'&&<ThemeSettings/>}
      {section==='features'&&<><section className="settings-card feature-settings"><h2>悬浮工具</h2><SettingRow title="显示底部悬浮工具栏" description="显示标注工具、写作模式和 AI 开关。关闭后仍可通过右上角面板按钮打开 AI。"><input className="setting-switch" aria-label="显示底部悬浮工具栏" type="checkbox" checked={appearance.appearance.floatingToolbarVisible!==false} onChange={event=>appearance.setAppearance(old=>({...old,floatingToolbarVisible:event.target.checked}))}/></SettingRow></section>
      <section className="settings-card feature-settings"><h2>面板位置</h2><SettingRow title="锁定与解锁手势" description="在面板标题栏操作。锁定后仍可打开、关闭和收纳；标签组共享位置。"><select aria-label="面板锁定手势" value={appearance.appearance.panelLockGesture||'doubleClick'} onChange={event=>appearance.setAppearance(old=>({...old,panelLockGesture:event.target.value==='longPress'?'longPress':'doubleClick'}))}><option value="doubleClick">双击标题栏</option><option value="longPress">长按标题栏（0.6 秒）</option></select></SettingRow><SettingRow title="图标拖动标识" description="长按侧栏图标拖动时，选择跟随指针的标识样式。"><select aria-label="图标拖动标识" value={panelIconDragPreferences.preferences.holdStyle} onChange={event=>panelIconDragPreferences.setPreferences(old=>({...old,holdStyle:event.target.value==='bar'?'bar':'circle'}))}><option value="circle">圆形</option><option value="bar">长条</option></select></SettingRow><SettingRow title="图标长按时间" description="设置 0.05–3 秒；短按仍然展开或收起面板。"><PanelIconDelay label="图标长按时间" value={panelIconDragPreferences.preferences.holdDelayMs} onChange={holdDelayMs=>panelIconDragPreferences.setPreferences(old=>({...old,holdDelayMs}))}/></SettingRow><SettingRow title="最短触发时间" description="设置 0.05–3 秒；实际触发时间取长按时间与最短触发时间中较大的值。"><PanelIconDelay label="最短触发时间" value={panelIconDragPreferences.preferences.minimumTriggerMs} onChange={minimumTriggerMs=>panelIconDragPreferences.setPreferences(old=>({...old,minimumTriggerMs}))}/></SettingRow>{panelIconDragPreferences.saveError&&<p role="status">{panelIconDragPreferences.saveError}</p>}</section>{appearance.saveError&&<p role="status">{appearance.saveError}</p>}</>}
      {section==='features'&&<><AIButtonLayoutSettings {...aiButtonLayout}/><AnnotationSettings {...annotationPreferences}/>{historyLimits&&onSaveHistoryLimits&&<HistoryRetentionSettings limits={historyLimits} onSave={onSaveHistoryLimits}/>}</>}
      {section==='writing'&&<form className="settings-card writing-settings" onSubmit={async event=>{event.preventDefault();await run('/config',{revision:config.revision,continuationLimit:Number(limit)},'写作设置已保存。');}}><h2>续写长度</h2><p>每次续写生成一个完整段落，先审阅，再决定是否采纳。</p><SettingRow title={<label htmlFor="writing-limit">续写最大字数</label>} description="允许 1–10000 个可见字符，默认 100。"><div className="settings-inline-field"><input id="writing-limit" type="number" min={1} max={10000} step={1} required value={limit} onChange={event=>setLimit(event.target.value)}/><span>字</span></div></SettingRow><small>含标点，不计空白与 Markdown 标记；超限或多段输出会阻止应用。</small><button type="submit" className="settings-primary" disabled={busy}>{busy?'保存中…':'保存写作设置'}</button></form>}
      {section==='shortcuts'&&<ShortcutSettings longPress={appearance.appearance.panelLockGesture==='longPress'}/>}
      {section==='models'&&<>
        <div className="settings-section-heading"><h2>AI 服务 <span>{config.services.length}</span></h2><button type="button" className="settings-primary" disabled={busy} onClick={()=>edit()}><Plus size={16}/>添加自定义服务</button></div>
        {!!config.services.length&&<label className="settings-service-search"><Icon name="settings.searchServiceModel" size={15}/><input aria-label="搜索服务或模型" placeholder="搜索服务或模型…" value={filter} onChange={event=>setFilter(event.target.value)}/></label>}
        <div className="model-service-list">{shownServices.map(service=>{const index=config.services.indexOf(service);return <article className={'model-service-card '+(!service.enabled?'disabled-service':'')} key={service.id} draggable onDragStart={e=>e.dataTransfer.setData('text/hive-service',String(index))} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const raw=e.dataTransfer.getData('text/hive-service');const from=Number(raw);if(raw&&Number.isInteger(from))void moveService(from,index);}}>
          <span className="sort-handle" role="button" tabIndex={0} aria-description="使用上下方向键调整顺序" aria-label={`调整服务${service.name}顺序`} title="拖动排序；方向键上 / 下调整顺序" onKeyDown={e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();void moveService(index,index+(e.key==='ArrowUp'?-1:1));}}}><GripVertical size={15}/></span><button className="model-service-open" type="button" onClick={()=>edit(service)} disabled={busy}><span className="model-service-avatar">{service.name.charAt(0).toUpperCase()}</span><span><b>{service.name}</b><small>{service.endpoint} · {service.models.length} 个模型</small></span><ChevronRight size={16}/></button>
          <span className="service-menu-wrap"><button type="button" className="settings-small-action" aria-label={`${service.name}更多操作`} aria-expanded={menu===service.id} onClick={e=>{const rect=e.currentTarget.getBoundingClientRect(),win=e.currentTarget.ownerDocument.defaultView!;setMenuPosition({left:Math.max(8,Math.min(rect.right-160,win.innerWidth-168)),top:Math.max(8,Math.min(rect.bottom+4,win.innerHeight-140))});setMenu(menu===service.id?null:service.id);}}><MoreHorizontal size={16}/></button>{menu===service.id&&panel.current&&createPortal(<span className="service-menu" style={{left:menuPosition.left,top:menuPosition.top}}><button type="button" disabled={probing} onClick={()=>{setMenu(null);void probe({...service,key:'',clearKey:false});}}>测试列表连接</button><button type="button" onClick={()=>{setMenu(null);edit(service);}}>编辑与测试模型</button><button type="button" onClick={()=>{setMenu(null);void run('/model-services',{revision:config.revision,service:{...service,enabled:!service.enabled}},service.enabled?'服务已停用。':'服务已启用。');}}>{service.enabled?'停用':'启用'}</button></span>,panel.current.ownerDocument.body)}</span>
        </article>})}</div>
        {!config.services.length&&<section className="settings-empty"><Server size={28}/><h2>添加你的 AI 服务</h2><p>填写连接信息，获取或手动添加模型。</p><button type="button" className="settings-secondary" onClick={()=>edit()}><Plus size={15}/>添加第一个服务</button></section>}
        {!!config.services.length&&!shownServices.length&&<p className="settings-empty">没有匹配的服务或模型</p>}
      </>}

      </div>
    </main>
    {draft&&<div className="service-dialog-overlay"><div ref={dialogRef} className="service-dialog" role="dialog" aria-modal="true" aria-label={draft.id?'编辑 AI 服务':'添加 AI 服务'} onKeyDown={event=>{if(event.key!=='Tab')return;const root=(catalogOpen?dialogRef.current?.querySelector<HTMLElement>('.catalog-dialog'):dialogRef.current);if(!root)return;const items=[...root.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el=>el.getClientRects().length);if(!items.length)return;const active=event.currentTarget.ownerDocument.activeElement;if(event.shiftKey&&active===items[0]){event.preventDefault();items[items.length-1].focus();}else if(!event.shiftKey&&active===items[items.length-1]){event.preventDefault();items[0].focus();}}}>
      <div className="service-editor-actions"><strong>{draft.id?"编辑 AI 服务":"添加 AI 服务"}</strong><button type="button" className="settings-small-action" title="测试列表连接" aria-label="测试列表连接" disabled={probing} onClick={()=>void probe(draft)}><Plug size={16}/></button></div>
      <div className="service-dialog-scroll">
      {error&&<div className="settings-feedback error" role="alert"><span>{error}</span>{(error.includes('其他窗口')||error.includes('重新载入'))&&<button type="button" disabled={busy} onClick={async()=>{try{await onReload();setError('');setNotice('已重新载入配置。');}catch(error){setError((error as Error).message);}}}>重新载入配置</button>}</div>}
      {notice&&<p className="settings-feedback" role="status"><Check size={14}/>{notice}</p>}
      {section==='models'&&draft&&<form id="service-editor-form" className="service-editor" onSubmit={saveService}><fieldset disabled={busy}>
        {discard&&<div ref={discardRef} className="settings-discard" role="alert"><span>放弃这次尚未保存的编辑？</span><button type="button" disabled={busy} onClick={()=>{setDraft(null);setDiscard(false);setError('');}}>放弃编辑</button><button type="button" onClick={()=>setDiscard(false)}>继续编辑</button></div>}
        <section className="settings-card service-connection"><div className="service-protocol"><Server size={16}/><b>自定义服务</b><Help text="支持 OpenAI Chat Completions 兼容接口，地址填写到 /v1 或 /chat/completions。"/></div>
          <div className="service-form-grid"><label><span className="service-field-label">服务名称 <button type="button" className="service-name-import" aria-label="从接口地址填入服务名称" onClick={()=>{const name=serviceNameFromEndpoint(draft.endpoint);if(!name){setError('请输入有效的 HTTP(S) 接口地址。');return;}setError('');setDraft({...draft,name});}}><WandSparkles size={14}/><span role="tooltip">从接口地址填入服务名称</span></button></span><input aria-label="服务名称" required maxLength={120} placeholder="例如：我的本地模型" value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label><label><span className="service-field-label">接口地址</span><input aria-label="接口地址" type="url" required placeholder="http://localhost:4000/v1" value={draft.endpoint} onChange={event=>{const endpoint=event.target.value,oldTarget=modelConnectionAddress(draft.endpoint),newTarget=modelConnectionAddress(endpoint);setCatalog([]);setDraft({...draft,endpoint,key:oldTarget&&oldTarget!==newTarget?'':draft.key});}} onBlur={event=>{const endpoint=event.currentTarget.value,newTarget=modelConnectionAddress(endpoint),oldTarget=modelConnectionAddress(capabilityEndpoint.current);if(!newTarget)return;if(oldTarget&&oldTarget!==newTarget){setDraft(old=>old?{...old,models:old.models.map(m=>({...m,capabilities:undefined,reasoningLevels:undefined,manualReasoningLevels:undefined,defaultReasoning:undefined}))}:old);setNotice('连接地址已变化，旧档位能力已清除。');}capabilityEndpoint.current=endpoint;}}/></label></div>
          <label>API 密钥 <Help text="本地服务可留空。密钥明文保存在本机 state/keys.json；修改接口地址时需重新填写。"/><input aria-label="API 密钥" type="password" autoComplete="off" placeholder={currentService?.hasKey?'已设置；留空保留当前密钥':'可选，明文保存在本机 keys.json'} value={draft.key} onChange={event=>setDraft({...draft,key:event.target.value,clearKey:false})}/></label>
          {currentService?.hasKey&&<label className="service-clear-key"><input type="checkbox" checked={draft.clearKey} onChange={event=>setDraft({...draft,clearKey:event.target.checked,key:''})}/>清除当前服务的密钥</label>}
        </section>
        <section className="settings-card service-models"><div className="settings-section-heading"><h2>已选模型 <span>{draft.models.length} / {MODEL_CONFIGURATION_LIMIT}</span></h2><div><button type="button" className="settings-secondary" onClick={()=>{setChecked(draft.models.map(m=>m.id));setCatalogOpen(true);if(!catalog.length)void probe(draft);}}><RefreshCw size={15}/>获取模型</button></div></div>
          <div className="add-model-fields"><label>模型 ID<input aria-label="模型 ID" placeholder="手动填写模型 ID" maxLength={200} value={modelId} onChange={event=>setModelId(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();addModel();}}}/></label><label>显示名称<input aria-label="模型显示名称" placeholder="可选" maxLength={200} value={modelName} onChange={event=>setModelName(event.target.value)}/></label><button type="button" className="settings-secondary" onClick={addModel}><Plus size={15}/>添加模型</button></div>
          {!draft.models.length&&<p className="service-model-empty">还没有模型。可获取列表或手动填写。</p>}
          <div className="service-model-list">{draft.models.map((model,index)=><div className="service-model-row" key={model.id} draggable onDragStart={e=>e.dataTransfer.setData('text/hive-model',String(index))} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const raw=e.dataTransfer.getData('text/hive-model');const from=Number(raw);if(raw&&Number.isInteger(from))moveModel(from,index);}}><span className="sort-handle" role="button" tabIndex={0} aria-description="使用上下方向键调整顺序" aria-label={`调整模型${model.id}顺序`} title="拖动排序；方向键上 / 下调整顺序" onKeyDown={e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();moveModel(index,index+(e.key==='ArrowUp'?-1:1));}}}><GripVertical size={14}/></span><span className="service-model-id" title={model.id}>{model.name} <small>{model.id}</small></span><button type="button" className="settings-small-action model-test-button" title={`测试生成 · ${model.name}`} aria-label={`测试生成 · ${model.name}`} disabled={generation[model.id]?.status==='pending'||!draft.endpoint.trim()} onClick={()=>void probe(draft,model.id)}><Plug size={15}/><span role="tooltip">测试生成 · {model.name}</span></button><button type="button" className="settings-small-action" title="模型设置" aria-label={`设置模型${model.id}`} onClick={()=>setModelSettings(modelSettings===model.id?null:model.id)}><Settings size={15}/></button><button type="button" className="settings-small-action" title="移除" aria-label={`移除模型${model.id}`} onClick={()=>{cancelProbe();setGeneration(old=>{const next={...old};delete next[model.id];return next;});setDraft({...draft,models:draft.models.filter(item=>item.id!==model.id)});}}><X size={15}/></button>
          {generation[model.id]&&<span className={'model-test-status '+generation[model.id].status} role="status" aria-live="polite">{generation[model.id].message}</span>}
          {modelSettings===model.id&&<div className="model-detail"><label><span className="model-field-label">显示名称</span><input aria-label={`显示名称：${model.id}`} value={model.name} maxLength={200} onChange={e=>setDraft({...draft,models:draft.models.map(m=>m.id===model.id?{...m,name:e.target.value}:m)})}/></label>
          <div className="model-context"><label><span className="model-field-label">上下文窗口（token） <Help text="容量检查按请求 UTF-8 字节估算并预留输出空间；超出会阻止发送。"/></span><select aria-label={`上下文来源：${model.id}`} value={(contextModes[model.id]??model.contextTokens!==undefined)?'custom':'upstream'} onChange={e=>{const custom=e.target.value==='custom';setContextModes(old=>({...old,[model.id]:custom}));if(custom)setContextInputs(old=>({...old,[model.id]:String(model.contextTokens??'')}));else{setContextInputs(old=>({...old,[model.id]:''}));setDraft({...draft,models:draft.models.map(m=>m.id===model.id?{...m,contextTokens:undefined}:m)});}}}><option value="upstream">上游（{model.capabilities?.contextTokens??'未知'}）</option><option value="custom">自定义</option></select></label>{(contextModes[model.id]??model.contextTokens!==undefined)&&<input type="number" min="1" max={MODEL_CONTEXT_TOKEN_MAX} step="1" required aria-label={`上下文窗口：${model.id}`} aria-invalid={!validToken(contextInputs[model.id]??String(model.contextTokens??''))} placeholder="正整数 token" value={contextInputs[model.id]??String(model.contextTokens??'')} onChange={e=>{const raw=e.target.value,n=Number(raw);setContextInputs(old=>({...old,[model.id]:raw}));setDraft({...draft,models:draft.models.map(m=>m.id===model.id?{...m,contextTokens:/^\d+$/.test(raw)&&Number.isSafeInteger(n)&&n>0?n:undefined}:m)});}}/>}{(contextModes[model.id]??model.contextTokens!==undefined)&&!validToken(contextInputs[model.id]??String(model.contextTokens??''))&&<small className="model-field-error" role="status">请输入正整数 token。</small>}</div>
          <div className="model-context"><label><span className="model-field-label">最大输出（token） <Help text="发送时限制生成 token 数；需小于上下文窗口且不超过上游声明的最大值。"/></span><select aria-label={`最大输出来源：${model.id}`} value={(outputModes[model.id]??model.maxOutputTokens!==undefined)?'custom':'upstream'} onChange={e=>{const custom=e.target.value==='custom';setOutputModes(old=>({...old,[model.id]:custom}));if(custom)setOutputInputs(old=>({...old,[model.id]:String(model.maxOutputTokens??'')}));else{setOutputInputs(old=>({...old,[model.id]:''}));setDraft({...draft,models:draft.models.map(m=>m.id===model.id?{...m,maxOutputTokens:undefined}:m)});}}}><option value="upstream">上游（{model.capabilities?.maxOutputTokens??'未知'}）</option><option value="custom">自定义</option></select></label>{(outputModes[model.id]??model.maxOutputTokens!==undefined)&&<><input type="number" min="1" max={MODEL_CONTEXT_TOKEN_MAX} step="1" required aria-label={`最大输出：${model.id}`} aria-invalid={!!outputError(outputInputs[model.id]??String(model.maxOutputTokens??''),model.contextTokens??model.capabilities?.contextTokens,model.capabilities?.maxOutputTokens)} placeholder="正整数 token" value={outputInputs[model.id]??String(model.maxOutputTokens??'')} onChange={e=>{const raw=e.target.value,n=Number(raw);setOutputInputs(old=>({...old,[model.id]:raw}));setDraft({...draft,models:draft.models.map(m=>m.id===model.id?{...m,maxOutputTokens:validToken(raw)?n:undefined}:m)});}}/>{outputError(outputInputs[model.id]??String(model.maxOutputTokens??''),model.contextTokens??model.capabilities?.contextTokens,model.capabilities?.maxOutputTokens)&&<small className="model-field-error" role="status">{outputError(outputInputs[model.id]??String(model.maxOutputTokens??''),model.contextTokens??model.capabilities?.contextTokens,model.capabilities?.maxOutputTokens)}</small>}</>}</div>
          <div className="model-level-control"><span>推理档位 <Help text="上游档位自动启用；点击可开关。未由上游声明的档位可手动添加，请以服务实际支持为准。"/></span><div className="model-levels" role="group" aria-label={`推理档位：${model.id}`}>{reasoningLevelValues.map(level=>{const upstream=!!model.capabilities?.reasoning?.[level],selected=effectiveReasoningLevels(model).includes(level);return <button key={level} type="button" className={'model-level-chip'+(selected?' selected':'')} aria-label={`${level}（${upstream?'上游':'自定义'}）`} aria-pressed={selected} title={upstream?'上游提供':'自定义声明'} onClick={()=>{if(!capabilityEndpoint.current)capabilityEndpoint.current=draft.endpoint;const upstreamLevels=model.reasoningLevels??reasoningLevelValues.filter(x=>!!model.capabilities?.reasoning?.[x]);const manual=model.manualReasoningLevels??[];const next=upstream?{...model,reasoningLevels:selected?upstreamLevels.filter(x=>x!==level):[...upstreamLevels,level],manualReasoningLevels:selected?manual.filter(x=>x!==level):manual}:{...model,manualReasoningLevels:selected?manual.filter(x=>x!==level):[...manual,level]};if(next.defaultReasoning&&!effectiveReasoningLevels(next).includes(next.defaultReasoning))next.defaultReasoning=undefined;setDraft({...draft,models:draft.models.map(m=>m.id===model.id?next:m)});}}>{level}</button>})}</div><small>上游 / 自定义：悬停或聚焦档位查看来源</small></div>
          <div className="model-level-control"><span>输入类型 <Help text="声明该模型能接收的内容。图片需上游支持；未声明时按纯文本处理，发送图片会被拒绝。"/></span><div className="model-levels" role="group" aria-label={`输入类型：${model.id}`}>{inputTypeValues.map(type=>{const selected=effectiveInputTypes(model).includes(type);return <button key={type} type="button" className={'model-level-chip'+(selected?' selected':'')} aria-pressed={selected} title={type==='text'?'文本':'图片'} onClick={()=>{const current=effectiveInputTypes(model);if(type==='text'&&selected){setError('模型至少要支持文本输入。');return;}const next=inputTypeValues.filter(item=>item===type?!selected:current.includes(item));setError('');setDraft({...draft,models:draft.models.map(m=>m.id===model.id?{...m,inputTypes:[...next] as InputType[]}:m)});}}>{type==='text'?'文本':'图片'}</button>;})}</div></div>
          <label>默认推理强度<select aria-label={`默认推理强度：${model.id}`} value={model.defaultReasoning??''} onChange={e=>setDraft({...draft,models:draft.models.map(m=>m.id===model.id?{...m,defaultReasoning:(e.target.value||undefined) as ReasoningLevel|undefined}:m)})}><option value="">服务默认</option>{effectiveReasoningLevels(model).map(level=><option key={level} value={level}>{level}</option>)}</select></label></div>}</div>)}</div>

        </section>
        {catalogOpen&&<div className="catalog-overlay" role="dialog" aria-modal="true" aria-label="选择上游模型"><div className="catalog-dialog"><div className="settings-section-heading"><h2>选择模型</h2><button type="button" className="settings-small-action" title="关闭" aria-label="关闭模型选择" onClick={()=>setCatalogOpen(false)}><X size={16}/></button></div><div className="catalog-controls"><label className="settings-service-search"><Search size={15}/><input aria-label="搜索上游模型" placeholder="搜索模型" value={catalogSearch} onChange={e=>setCatalogSearch(e.target.value)}/></label><button type="button" className="settings-small-action" title="刷新模型列表" aria-label="刷新模型列表" disabled={probing} onClick={()=>void probe(draft)}><RefreshCw size={16}/></button></div><div className="catalog-list">{sortCatalogModels([...draft.models.filter(m=>!catalog.some(c=>c.id===m.id)),...catalog]).filter(m=>`${m.id} ${m.name}`.toLowerCase().includes(catalogSearch.toLowerCase())).map(m=><label key={m.id}><input type="checkbox" checked={checked.includes(m.id)} onChange={e=>setChecked(old=>e.target.checked?[...old,m.id]:old.filter(id=>id!==m.id))}/><span title={m.id}>{m.name||m.id}</span></label>)}{!catalog.length&&<p>没有获取到模型列表；仍可手动添加。</p>}</div><div className="catalog-actions"><span className="catalog-selected-count">已选 {checked.length} / {MODEL_CONFIGURATION_LIMIT}</span><button type="button" className="settings-secondary" onClick={()=>setCatalogOpen(false)}>取消</button><button type="button" className="settings-primary" onClick={applyCatalog}>应用</button></div></div></div>}
        {draft.id&&<div className="service-danger-zone"><div><b>移除服务</b><p>移除连接配置和模型，不影响写作内容。</p></div><button type="button" className="settings-danger" disabled={busy} onClick={()=>setRemoveId(draft.id!)}><Trash2 size={14}/>移除服务</button></div>}
        {removeId&&<div className="settings-discard" role="alert"><span>确认移除「{draft.name}」及其模型配置？</span><button type="button" disabled={busy} onClick={async()=>{if(await run('/model-services/remove',{id:removeId,revision:config.revision},'服务已移除。')){setDraft(null);setRemoveId(null);}}}>确认移除</button><button type="button" onClick={()=>setRemoveId(null)}>保留服务</button></div>}
      </fieldset></form>}
      </div><div className="service-editor-footer"><button type="button" className="settings-secondary service-footer-button" title="取消" aria-label="取消编辑" onClick={()=>setDiscard(true)}><X size={18}/></button><button type="submit" form="service-editor-form" className="settings-primary service-footer-button" title="保存服务" aria-label="保存服务" disabled={busy}><Check size={18}/></button></div></div></div>}

    </div>
  </div>;
}

function PanelIconDelay({value,onChange,label}:{value:number;onChange:(value:number)=>void;label:string}){
  const [draft,setDraft]=useState(String(value/1000));
  useEffect(()=>setDraft(String(value/1000)),[value]);
  const apply=()=>{const seconds=Number(draft);if(!draft.trim()||!Number.isFinite(seconds)||seconds<.05||seconds>3){setDraft(String(value/1000));return;}const ms=Math.round(seconds*20)*50;setDraft(String(ms/1000));onChange(ms);};
  return <><input type="number" aria-label={label} min="0.05" max="3" step="0.05" value={draft} onChange={event=>setDraft(event.target.value)} onBlur={apply} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}}}/><span>秒</span></>;
}

function Help({text}:{text:string}){return <span className="settings-help" tabIndex={0} aria-label={text}><Info size={14}/><span role="tooltip">{text}</span></span>;}

function validToken(raw:string){const n=Number(raw);return /^\d+$/.test(raw)&&Number.isSafeInteger(n)&&n>0&&n<=MODEL_CONTEXT_TOKEN_MAX;}
function outputError(raw:string,context?:number,upstream?:number){if(!validToken(raw))return '请输入正整数 token。';const n=Number(raw);if(context&&n>=context)return '最大输出须小于上下文窗口。';if(upstream&&n>upstream)return '最大输出不能超过上游上限。';return '';}

function serviceNameFromEndpoint(value:string){try{const u=new URL(value.trim());if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return '';const host=u.hostname.toLowerCase();if(host==='localhost'||host.includes(':')||/^\d+(?:\.\d+){3}$/.test(host))return u.host.slice(0,120);const parts=host.split('.').filter(Boolean);while(parts.length>2&&['www','api'].includes(parts[0]))parts.shift();return (parts[0]||u.host).slice(0,120);}catch{return '';}}
