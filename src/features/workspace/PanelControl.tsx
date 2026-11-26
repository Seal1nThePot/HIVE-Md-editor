import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsDown, ChevronsLeft, ChevronsRight, ChevronsUp, Icon, Maximize2, Menu, PanelLeftOpen, X } from "../../shared/icons";
import type {DockEdge} from "./panelLayout";
import { placePanelActions } from "./panelUiGeometry";
import { usePanelDocument } from '../../shared/panelDocument';
export type DragControl = { onStart?: () => void; onFinish: (dragged: boolean) => void; fromTab?:boolean };
export type PanelAction = { label: string; icon?: ReactNode; run: () => void; disabled?:boolean; checked?:boolean };
/** A tab first selects its member; the next task uses that member's actual menu. */
export function openPanelContextMenu(document:Document,id:string,x:number,y:number){
  document.defaultView?.setTimeout(()=>{
    const candidates=[...document.querySelectorAll<HTMLButtonElement>('[data-panel-menu-id]')].filter(node=>node.dataset.panelMenuId===id);
    const button=candidates.find(node=>node.getClientRects().length)||candidates[0];
    if(button){const event=new document.defaultView!.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:2});button.dispatchEvent(event);}
  },0);
}
export default function PanelControl({ label, panelId, floating, onToggleFloat, onOpen, onClose, onMinimize, collapseEdge, primary=false, movable=true, canDock=true, actions=[], memberActions, detached=false, floatAction, actionsOnly=false, onCloseCurrent=onClose, closeCurrentDisabled=primary }: {
  onCloseCurrent?:()=>void;closeCurrentDisabled?:boolean;
  panelId?:string;
  label: string; floating: boolean;
  onToggleFloat: () => void; onOpen:()=>void;onClose: () => void;
  onMinimize:()=>void;collapseEdge?:DockEdge;primary?:boolean;movable?:boolean;canDock?:boolean;
  actions?:PanelAction[];memberActions?:PanelAction[];detached?:boolean;floatAction?:PanelAction;actionsOnly?:boolean;
}) {
  const document = usePanelDocument(), window = document.defaultView!;
  const [open, setOpen] = useState(false), [position, setPosition] = useState({x:0,y:0,width:158,height:30,orientation:"horizontal"});
  const button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [contextAnchor,setContextAnchor]=useState<{x:number;y:number}|null>(null);
  const CollapseIcon=collapseEdge?({left:ChevronsLeft,right:ChevronsRight,top:ChevronsUp,bottom:ChevronsDown})[collapseEdge]:ChevronsLeft;
  const choices: PanelAction[] = actionsOnly ? actions : [
    ...actions,
    floatAction || {label:memberActions?'整组浮动':'浮动面板',icon:<Maximize2 size={14}/>,run:onToggleFloat,disabled:detached||primary||floating||!movable},
    ...(memberActions?[{label:'整组收纳',icon:<Icon name="panel.stashGroup" size={14}/>,run:onMinimize,disabled:primary}]:[]),
    {label:memberActions?'整组关闭':'关闭面板',icon:<X size={14}/>,run:onClose,disabled:primary},
    {label:memberActions?'整组打开停靠':'打开面板',icon:<PanelLeftOpen size={14}/>,run:onOpen,disabled:detached||primary||!canDock},
    ...(detached?[]:memberActions||[]),
  ];
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = contextAnchor?{...contextAnchor,width:0,height:0}:button.current.getBoundingClientRect();
    const scale=Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))||1;
    const textScale=Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-scale'))||1;
    setPosition(placePanelActions({x:rect.x,y:rect.y,width:rect.width,height:rect.height},{width:window.innerWidth,height:window.innerHeight},choices.length,scale,textScale));
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open, choices.length, document,contextAnchor]);
  useEffect(()=>{
    if(!panelId)return;
    const context=(event:MouseEvent)=>{
      const target=event.target as Element;if(event.defaultPrevented||!target?.closest||target.closest('input,textarea,select,[contenteditable="true"],.cm-editor,.markdown-preview,[role="menu"]'))return;
      const marker=target.closest<HTMLElement>('[data-panel-context],[data-panel-tab],[data-panel-id]');
      if((marker?.dataset.panelContext||marker?.dataset.panelTab||marker?.dataset.panelId)!==panelId)return;
      const scope=target.closest('.workspace-group-header,.independent-panel-header,.document-panel-header')||document;
      const candidates=[...scope.querySelectorAll<HTMLButtonElement>('[data-panel-menu-id]')].filter(node=>node.dataset.panelMenuId===panelId);
      const chosen=candidates.find(node=>node.getClientRects().length)||candidates[0];
      if(chosen!==button.current)return;
      event.preventDefault();setContextAnchor({x:event.clientX,y:event.clientY});setOpen(true);
    };
    document.addEventListener('contextmenu',context);return()=>document.removeEventListener('contextmenu',context);
  },[document,panelId]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if(event.key==='Escape'){setOpen(false);button.current?.focus();} };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown',outside,true); document.addEventListener('keydown',escape);
    window.addEventListener('resize',close);window.addEventListener('blur',close);
    return () => {document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);window.removeEventListener('resize',close);window.removeEventListener('blur',close);};
  },[open, document, window]);
  return <div className="panel-controls" data-no-drag onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}>
    {!actionsOnly&&(!primary||detached)&&<button type="button" className="panel-mini-button" aria-label={`收纳${label}面板`} title="收纳到主窗口侧栏" onClick={onMinimize}><CollapseIcon size={11}/></button>}

    <button type="button" ref={button} className="panel-mini-button panel-menu-button" data-panel-menu-id={panelId} data-panel-control aria-label={`${label}面板功能`}
      title="面板功能 · 单击展开" aria-haspopup="menu" aria-expanded={open}
      onClick={()=>{setContextAnchor(null);setOpen(value=>!value);}}
      onContextMenu={event=>{event.preventDefault();event.stopPropagation();setContextAnchor({x:event.clientX,y:event.clientY});setOpen(true);}}
      >
      <Menu size={11}/>
    </button>
    <button type="button" className="panel-mini-button panel-close-button" aria-label={`关闭${label}面板`} disabled={closeCurrentDisabled} title={closeCurrentDisabled?'主编辑区需保持打开':'关闭当前面板'} onClick={onCloseCurrent}><X size={11}/></button>
    {open&&createPortal(<div ref={menu} className="panel-action-rail vertical" role="menu" aria-label={`${label}面板操作`} style={{left:position.x,top:position.y,width:position.width,maxHeight:position.height}}
      onContextMenu={event=>event.preventDefault()}
      onKeyDown={event=>{
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
          event.preventDefault();
          const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          if (!buttons.length) return;
          const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
          const last=buttons.length-1;
          const next=event.key==='Home'?0:event.key==='End'?last:event.key==='ArrowDown'?(index+1)%buttons.length:index<=0?last:index-1;
          buttons[next].focus();
        } else if(event.key==='Tab'){setOpen(false);}
      }}>
      {choices.map(choice=><button type="button" role={choice.checked===undefined?'menuitem':'menuitemcheckbox'} aria-checked={choice.checked} disabled={choice.disabled} key={choice.label} onClick={()=>{setOpen(false);button.current?.focus();choice.run();}}>{choice.icon}<span>{choice.label}</span>{choice.checked&&<Check className="panel-action-check" size={14}/>}</button>)}
    </div>,document.body)}
  </div>;
}
