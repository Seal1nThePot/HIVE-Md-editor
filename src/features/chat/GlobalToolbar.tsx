import {useEffect,useRef,useState,useSyncExternalStore,type PointerEvent} from 'react';
import {Move} from "../../shared/icons";
import {DesktopPanel,useDesktopPanels} from '../workspace/DesktopPanels';
import {usePanelDocument} from '../../shared/panelDocument';
import WritingDock from './WritingDock';
import type {Mode} from '../../shared/core';
import './global-toolbar.css';

type Props={mode:Mode;continuationLimit:number;aiOpen:boolean;annotationTool:boolean;annotationHint?:string;busy?:boolean;onRun:(mode:Mode)=>void;onToggleAi:()=>void;onAnnotate:()=>void};

export function createGlobalToolbarStore(){
  let current:Props|null=null;
  const listeners=new Set<()=>void>();
  return {
    read:()=>current,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    publish(next:Props|null){
      if(current===next)return;
      current=next;
      for(const listener of listeners)listener();
    },
  };
}

export function PersistentGlobalToolbar({store}:{store:ReturnType<typeof createGlobalToolbarStore>}){
  const props=useSyncExternalStore(store.subscribe,store.read);
  return props&&<GlobalToolbar {...props}/>;
}

export default function GlobalToolbar(props:Props){
  const desktop=useDesktopPanels(),started=useRef(false);
  useEffect(()=>{if(!desktop.enabled||started.current)return;const timer=window.setTimeout(()=>{started.current=true;desktop.detach('global-toolbar');},0);return()=>window.clearTimeout(timer);},[desktop.enabled]);
  return <DesktopPanel id="global-toolbar" title="写作快捷栏" open variant="toolbar"><ToolbarSurface {...props}/></DesktopPanel>;
}

function ToolbarSurface(props:Props){
  const desktop=useDesktopPanels(),panelDocument=usePanelDocument(),nativeHost=desktop.enabled&&panelDocument!==document;
  const root=useRef<HTMLDivElement>(null),cleanup=useRef<(()=>void)|null>(null);
  const [position,setPosition]=useState<{x:number;y:number}|null>(null);
  useEffect(()=>()=>cleanup.current?.(),[]);
  useEffect(()=>{if(desktop.enabled)return;const resize=()=>{const rect=root.current?.getBoundingClientRect();if(!rect)return;setPosition(old=>old?{x:Math.max(0,Math.min(old.x,window.innerWidth-rect.width)),y:Math.max(0,Math.min(old.y,window.innerHeight-rect.height))}:old);};window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[desktop.enabled]);
  function drag(event:PointerEvent<HTMLButtonElement>){
    if(desktop.enabled){if(nativeHost)desktop.beginDrag('global-toolbar',event);return;}
    if(event.button!==0||!event.isPrimary)return;
    event.preventDefault();cleanup.current?.();const rect=root.current!.getBoundingClientRect(),startX=event.clientX,startY=event.clientY,id=event.pointerId;
    const move=(e:globalThis.PointerEvent)=>{if(e.pointerId!==id)return;setPosition({x:Math.max(0,Math.min(window.innerWidth-rect.width,rect.left+e.clientX-startX)),y:Math.max(0,Math.min(window.innerHeight-rect.height,rect.top+e.clientY-startY))});};
    const stop=(e:globalThis.PointerEvent)=>{if(e.pointerId===id)clear();};
    const clear=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);window.removeEventListener('blur',clear);cleanup.current=null;};
    cleanup.current=clear;window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);window.addEventListener('blur',clear);
  }
  return <div ref={root} data-panel-id="global-toolbar" className={'global-toolbar'+(nativeHost?' global-toolbar-native':'')} style={!desktop.enabled&&position?{left:position.x,top:position.y,bottom:'auto',transform:'none'}:undefined}>
    <WritingDock {...props}/><button type="button" className="global-toolbar-move" aria-label="移动写作快捷栏" title="拖动移动写作快捷栏" onPointerDown={drag}><Move size={14}/></button>
  </div>;
}
