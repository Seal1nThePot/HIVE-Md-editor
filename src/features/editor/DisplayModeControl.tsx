import {usePanelDocument} from '../../shared/panelDocument';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,Icon} from "../../shared/icons";
import type {EditorDisplayMode} from './splitView';
import {useTypography} from '../typography/typographyStore';
import {applyTypographyPreset,isTypographyCustomized,typographyPresets,type TypographyPreset} from '../typography/typographyPreferences';
import './display-mode.css';

const displayModeLabels:Record<EditorDisplayMode,string>={preview:'实时预览',live:'实时编辑',source:'代码模式',split:'左右分栏'};

export default function DisplayModeControl({label,displayMode,typewriter,onDisplayMode,onTypewriter}:{label:string;displayMode:EditorDisplayMode;typewriter:boolean;onDisplayMode:(mode:EditorDisplayMode)=>void;onTypewriter:(enabled:boolean)=>void}){
  const document=usePanelDocument(),window=document.defaultView!;
  const {preferences,setTypography,saveError}=useTypography();
  const [open,setOpen]=useState(false),[position,setPosition]=useState({x:0,y:0});
  const button=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    if(!open||!button.current)return;const rect=button.current.getBoundingClientRect(),width=menu.current?.offsetWidth||220,height=menu.current?.offsetHeight||165;
    setPosition({x:Math.max(6,Math.min(window.innerWidth-width-6,rect.right-width)),y:rect.bottom+height+4<window.innerHeight?rect.bottom+4:Math.max(6,rect.top-height-4)});
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  },[open,document,window]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!button.current?.contains(event.target as Node))setOpen(false);};
    const close=()=>setOpen(false);document.addEventListener('pointerdown',outside);window.addEventListener('resize',close);
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',close);};
  },[open,document,window]);
  function finish(action:()=>void){setOpen(false);button.current?.focus();action();}
  return <div className="display-mode-control" data-no-drag onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}>
    <button ref={button} type="button" className={'panel-mini-button display-mode-button '+(typewriter?'typewriter-active':'')} aria-label={`${label}显示模式`} title={`显示模式 · ${displayModeLabels[displayMode]}${typewriter?' · 打字机模式':''}`} aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(value=>!value)} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();setOpen(true);}}}><Icon name="editor.mode.menu" size={12}/></button>
    {open&&createPortal(<div ref={menu} className="panel-control-menu display-mode-menu" role="menu" aria-label={`${label}显示模式选项`} style={{left:position.x,top:position.y}} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(()=>{});}
      if(event.key==='Tab')setOpen(false);
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button')),index=items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();
      }
    }}>
      <button type="button" role="menuitemradio" aria-checked={displayMode==='preview'} onClick={()=>finish(()=>onDisplayMode('preview'))}><span className="display-mode-check">{displayMode==='preview'&&<Check size={12}/>}</span><Icon name="editor.mode.preview" size={14}/>实时预览</button>
      <button type="button" role="menuitemradio" aria-checked={displayMode==='live'} onClick={()=>finish(()=>onDisplayMode('live'))}><span className="display-mode-check">{displayMode==='live'&&<Check size={12}/>}</span><Icon name="editor.mode.live" size={14}/>实时编辑</button>
      <button type="button" role="menuitemradio" aria-checked={displayMode==='source'} onClick={()=>finish(()=>onDisplayMode('source'))}><span className="display-mode-check">{displayMode==='source'&&<Check size={12}/>}</span><Icon name="editor.mode.source" size={14}/>代码模式</button>
      <button type="button" role="menuitemradio" aria-checked={displayMode==='split'} onClick={()=>finish(()=>onDisplayMode('split'))}><span className="display-mode-check">{displayMode==='split'&&<Check size={12}/>}</span><Icon name="editor.mode.split" size={14}/>左右分栏</button>
      <hr/><p className="display-mode-section">正文排版{isTypographyCustomized(preferences)?' · 已自定义':''}</p>
      {(Object.keys(typographyPresets) as TypographyPreset[]).map(preset=><button key={preset} type="button" role="menuitemradio" aria-checked={preferences.preset===preset} onClick={()=>finish(()=>setTypography(applyTypographyPreset(preset,preferences.tableDensity)))}><span className="display-mode-check">{preferences.preset===preset&&<Check size={12}/>}</span>{typographyPresets[preset].label}</button>)}
      {saveError&&<p role="status">{saveError}</p>}
      <hr/><button type="button" role="menuitemcheckbox" aria-checked={typewriter} onClick={()=>finish(()=>onTypewriter(!typewriter))}><span className="display-mode-check">{typewriter&&<Check size={12}/>}</span><Icon name="editor.mode.typewriter" size={14}/>打字机模式</button>
    </div>,document.body)}
  </div>;
}
