import {useTheme} from '../theme/themeStore';
import {accentForeground} from '../theme/themePreferences';
import {usePanelDocument} from '../../shared/panelDocument';
import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type PointerEvent as ReactPointerEvent} from 'react';
import {createPortal} from 'react-dom';
import {Check,Icon,Search} from "../../shared/icons";
import {activeModelLabel,modelChoice,effectiveReasoningLevels,type Config} from '../settings/modelConfig';
import {previewReasoningDrag,reasoningLevels,type ReasoningEffort} from './modelReasoning';
import './model-picker.css';

const thumbInset=8;
type ReasoningDrag=ReturnType<typeof previewReasoningDrag>;

export default function ModelPicker({config,disabled,onModelChange,reasoningEffort='default',onReasoningChange}:{config:Config;disabled:boolean;onModelChange:(choice:string)=>void;reasoningEffort?:ReasoningEffort;onReasoningChange?:(effort:ReasoningEffort)=>void}){
  const document=usePanelDocument(),window=document.defaultView!;
 const {preferences}=useTheme();
 const [thumbHover,setThumbHover]=useState(false),[trailVisible,setTrailVisible]=useState(false),[documentVisible,setDocumentVisible]=useState(!document.hidden);
 const rangeRef=useRef<HTMLDivElement>(null),thumbRef=useRef<HTMLSpanElement>(null);
 const dragPointer=useRef<{id:number;heldIndex:number|null}|null>(null);
 const [drag,setDrag]=useState<ReasoningDrag|null>(null);
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[section,setSection]=useState(''),[position,setPosition]=useState<{left:number;top?:number;bottom?:number;maxHeight:number}>({left:8,top:8,maxHeight:380});
 const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null);
 const services=config.services.filter(s=>s.enabled&&s.models.length),models=services.flatMap(service=>service.models.map(model=>({value:modelChoice({serviceId:service.id,modelId:model.id}),service,model})));
 const current=!config.demo&&config.selection?modelChoice(config.selection):'',validCurrent=models.some(x=>x.value===current);
 const activeSection=services.some(s=>s.id===section)?section:(services.find(s=>s.id===config.selection?.serviceId)?.id||services[0]?.id||'');
 const filtered=models.filter(x=>(query.trim()||x.service.id===activeSection)&&`${x.model.id} ${x.model.name} ${x.service.name}`.toLowerCase().includes(query.trim().toLowerCase()));
 const trackColors=preferences.reasoningTrackProfiles?.[preferences.base];
 const selected=models.find(x=>x.value===current)?.model;
 const levels=selected?effectiveReasoningLevels(selected):[];
 const levelKey=levels.join(',');
 const lastIndex=Math.max(0,levels.length-1);
 const canChangeReasoning=validCurrent&&!!onReasoningChange;
 const serviceDefault=drag===null&&reasoningEffort==='default';
 const selectedIndex=reasoningEffort==='default'?lastIndex:Math.max(0,levels.indexOf(reasoningEffort));
 const index=drag?.index??selectedIndex;
 const effectLevel=levels[index];
 const firstColorIndex=levels[0]==='off'?1:0;
 const colorIndex=Math.max(index,firstColorIndex);
 const colorLevel=levels[colorIndex];
 const effect=colorLevel?preferences.reasoningEffects?.[colorLevel]:undefined;
 const thumbRatio=drag?.ratio??(lastIndex?index/lastIndex:1);
 const unfilled=effectLevel==='off'&&(!drag||thumbRatio===0);
 const particleColor=effect?.color??'#ffffff';
 const strength=serviceDefault?1:levels.length>1?(index+1)/levels.length:1;
 const particleCount=colorLevel&&!unfilled?(effect?.particles??Math.max(1,Math.ceil(strength*8))):0;
 const motionActive=trailVisible&&documentVisible;
 const colorRank=colorIndex-firstColorIndex+1;
 const colorCount=levels.length-firstColorIndex;
 // Reserve the top quarter of each tier for the template's glow preference.
 const glow=colorRank>0&&colorCount>0?(colorRank-.25+.25*(effect?.glow??1))/colorCount:0;
 const trailSpeed=Math.round(1900-strength*1150);
 const rangeStyle={
   '--reasoning-ratio':thumbRatio,
   '--reasoning-fade-rate':lastIndex*2,
   '--reasoning-glow-blur':glow?`${2+5*glow}px`:'0px',
   '--reasoning-glow-opacity':glow?`${14+24*glow}%`:'0%',
   '--reasoning-thumb-inset':`${thumbInset}px`,
   '--trail-speed':`${trailSpeed}ms`,
   '--reasoning-particle-color':particleColor,
   '--reasoning-particle-edge':accentForeground(particleColor),
   '--reasoning-color-end':`var(--reasoning-${colorLevel}-color, var(--gold))`,
   '--reasoning-duration':`var(--reasoning-${effectLevel}-duration,350ms)`,
   '--reasoning-easing':`var(--reasoning-${effectLevel}-easing,cubic-bezier(.22,1,.36,1))`,
 } as CSSProperties;
 function pointerPosition(event:ReactPointerEvent<HTMLInputElement>){
   const rect=event.currentTarget.getBoundingClientRect();
   const trackWidth=Math.max(1,rect.width-thumbInset*2);
   const ratio=Math.max(0,Math.min(1,(event.clientX-rect.left-thumbInset)/trackWidth));
   return {ratio,trackWidth};
 }

 function positionDrag(event:ReactPointerEvent<HTMLInputElement>,heldIndex:number|null){
   const {ratio,trackWidth}=pointerPosition(event);
   return previewReasoningDrag(ratio,trackWidth,lastIndex,heldIndex);
 }
 function previewDrag(event:ReactPointerEvent<HTMLInputElement>){
   const pointer=dragPointer.current;
   if(pointer?.id!==event.pointerId)return;
   const next=positionDrag(event,pointer.heldIndex);
   pointer.heldIndex=next.snapIndex;
   setDrag(previous=>previous?.ratio===next.ratio&&previous.snapIndex===next.snapIndex?previous:next);
 }
 function cancelDrag(event:ReactPointerEvent<HTMLInputElement>){
   if(dragPointer.current?.id!==event.pointerId)return;
   dragPointer.current=null;
   setDrag(null);
 }
 useLayoutEffect(()=>{dragPointer.current=null;setDrag(null);},[open,current,levelKey,canChangeReasoning]);
 useEffect(()=>{const changed=()=>setDocumentVisible(!document.hidden);document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[document]);
 useEffect(()=>{setThumbHover(false);setTrailVisible(false);if(!open||!rangeRef.current)return;const observer=new IntersectionObserver(entries=>setTrailVisible(entries.some(x=>x.isIntersecting)),{root:panel.current,threshold:.01});observer.observe(rangeRef.current);return()=>observer.disconnect();},[open,levels.length]);
 const levelLabel=(value:string)=>reasoningLevels.find(x=>x.value===value)?.label||value;
 const levelText=validCurrent?(serviceDefault?'服务默认':levelLabel(effectLevel??reasoningEffort)):'未选择';
 const lowerPreview=drag&&drag.snapIndex===null?Math.floor(thumbRatio*lastIndex):-1;
 const previewText=lowerPreview>=0&&lowerPreview<lastIndex
   ?`${levelLabel(levels[lowerPreview])}至${levelLabel(levels[lowerPreview+1])}`
   :levelText;
 const meterBars=levels.length&&effectLevel!=='off'?Math.max(1,Math.round(((index+1)/levels.length)*4)):0;
 useLayoutEffect(()=>{if(!open)return;const update=()=>{const r=trigger.current?.getBoundingClientRect();if(r){const left=Math.max(8,Math.min(r.left,window.innerWidth-Math.min(380,window.innerWidth-16)-8));const above=Math.max(0,r.top-14),below=Math.max(0,window.innerHeight-r.bottom-14);if(above>=320||above>=below){setPosition({left,bottom:Math.max(8,window.innerHeight-r.top+6),maxHeight:Math.max(0,Math.min(380,above,window.innerHeight-16))});}else{setPosition({left,top:Math.max(8,r.bottom+6),maxHeight:Math.max(0,Math.min(380,below,window.innerHeight-16))});}}};update();window.addEventListener('resize',update);window.addEventListener('scroll',update,true);search.current?.focus();return()=>{window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);};},[open,document,window]);
 useEffect(()=>{if(!open)return;const outside=(e:PointerEvent)=>{if(!panel.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))setOpen(false);};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};},[open,document,window]);
 const settings=()=>{setOpen(false);onModelChange('settings');};
 const choose=(value:string)=>{onModelChange(value);setOpen(false);};
 return <><button ref={trigger} type="button" className="model-picker-trigger" title={!validCurrent?'选择模型':levels.length?`${activeModelLabel(config)} · 推理强度：${levelText}`:activeModelLabel(config)} aria-label={!validCurrent?'选择模型':levels.length?`选择模型 · 推理强度：${levelText}`:`选择模型：${activeModelLabel(config)}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={()=>{setOpen(!open);setQuery('');setSection(services.find(s=>s.id===config.selection?.serviceId)?.id||services[0]?.id||'');}}><Icon name="model.choose" size={15}/>{!!levels.length&&<span className="model-picker-meter" aria-hidden="true">{Array.from({length:4},(_,i)=><i key={i} className={i<meterBars?'on':''}/>)}</span>}</button>
 {open&&createPortal(<div ref={panel} className="model-picker" style={{left:position.left,top:position.top,bottom:position.bottom,maxHeight:position.maxHeight}} role="dialog" aria-label="选择模型">
 <div className="model-picker-header"><div className="model-picker-search"><Search size={16}/><input ref={search} aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={e=>setQuery(e.target.value)}/></div><button type="button" className="model-picker-settings" title="模型设置" aria-label="模型设置" onClick={settings}><Icon name="model.settings" size={17}/></button></div>
 <div className="model-picker-body"><nav className="model-picker-nav" aria-label="模型服务">{services.map(s=><button type="button" key={s.id} className={activeSection===s.id?'active':''} onClick={()=>setSection(s.id)}>{s.name}</button>)}</nav><div className="model-picker-list">{filtered.length?filtered.map(x=><button type="button" key={x.value} className="model-picker-item" onClick={()=>choose(x.value)}><span><strong>{x.model.name}</strong><small>{x.service.name}</small></span>{current===x.value&&<Check size={16} aria-label="当前模型"/>}</button>):<div className="model-picker-empty">{models.length?(query?'没有找到匹配的模型':'该服务暂无可用模型'):<>暂无可用模型 <button type="button" onClick={settings}>前往模型设置</button></>}</div>}</div></div>
 <div className="model-picker-reasoning"><div className="model-picker-reasoning-head"><span>推理强度{!serviceDefault&&effectLevel&&` · ${previewText}`}</span>{!!levels.length&&<button type="button" className="model-picker-default" aria-label={serviceDefault?'关闭服务默认推理强度':'使用服务默认推理强度'} aria-pressed={serviceDefault} disabled={!canChangeReasoning} onClick={()=>{onReasoningChange?.(serviceDefault?(levels[0]??'default'):'default');}}><Icon name="model.reasoning.serviceDefault" size={13}/><span className="model-picker-default-label">服务默认</span><span className="model-picker-default-short">默认</span><span role="tooltip">{serviceDefault?'关闭服务默认：回到初始档':'使用服务默认推理强度'}</span></button>}</div>
 {levels.length?<div ref={rangeRef} className={
   'model-picker-range'+(drag?' is-dragging':'')+(drag?.snapIndex!=null?' is-snapped':'')+
   (thumbHover?' thumb-hover':'')+(trackColors?' custom-track':'')+(firstColorIndex?' reasoning-has-off':'')+(unfilled?' reasoning-unfilled':'')
 } style={rangeStyle} data-motion-active={motionActive||undefined}>
   <input type="range" aria-label="推理强度" min="0" max={lastIndex} step="1" value={index}
     aria-valuetext={levelText}
     disabled={!canChangeReasoning}
     onChange={event=>{
       // The native range can still emit input events from touch during pointer capture.
       if(dragPointer.current===null)onReasoningChange?.(levels[Number(event.currentTarget.value)]);
     }}
     onPointerDown={event=>{
       if(!event.isPrimary||event.button!==0||!lastIndex||dragPointer.current!==null)return;
       event.preventDefault();
       event.currentTarget.focus();
       event.currentTarget.setPointerCapture(event.pointerId);
       dragPointer.current={id:event.pointerId,heldIndex:null};
       setThumbHover(false);
       previewDrag(event);
     }}
     onPointerMove={event=>{
       if(dragPointer.current!==null){
         previewDrag(event);
         return;
       }
       const rect=thumbRef.current?.getBoundingClientRect();
       setThumbHover(!!rect&&Math.hypot(event.clientX-rect.left-rect.width/2,event.clientY-rect.top-rect.height/2)<=11);
     }}
     onPointerLeave={()=>setThumbHover(false)}
     onPointerUp={event=>{
       const pointer=dragPointer.current;
       if(pointer?.id!==event.pointerId)return;
       const next=levels[positionDrag(event,pointer.heldIndex).index];
       cancelDrag(event);
       onReasoningChange?.(next);
     }}
     onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
   />
   <span className="reasoning-fill" aria-hidden="true" style={trackColors?{
     '--track-left':trackColors.left,'--track-middle':trackColors.middle,'--track-right':trackColors.right,
   } as CSSProperties:undefined}/>
   <span ref={thumbRef} className="reasoning-thumb" aria-hidden="true"/>
   <div className="reasoning-particles" aria-hidden="true">
     {motionActive&&Array.from({length:particleCount},(_,i)=><i key={i} style={{
       '--particle-delay':`${-i*trailSpeed/Math.max(1,particleCount)}ms`,'--particle-row':`${(i%3-1)*1.5}px`,
     } as CSSProperties}/>)}
   </div>
   <div className="model-picker-dots" aria-hidden="true" data-service-default={serviceDefault||undefined}>
     {levels.map((level,i)=><span key={level} style={{
       left:`${lastIndex?100*i/lastIndex:100}%`,'--stop-exit-delay':`${(lastIndex-i)*38}ms`,
     } as CSSProperties}/>)}
   </div>
 </div>:<p className="model-picker-unknown">{validCurrent?'暂无可用档位，可在模型设置中添加。':'选择模型后查看推理强度。'}</p>}
 </div>
 </div>,document.body)}</>;
}




