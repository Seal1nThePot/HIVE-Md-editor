import {createContext,useCallback,useContext,useState,useEffect,useRef,type ReactNode} from 'react';
import {createUiIcon,type IconName} from '../../shared/icons';

export type MarkedDocument={sessionId:string;file:string};
export type WindowMark={id:string;workspaceId:string;document?:MarkedDocument};
export type WorkspaceAnnotationTarget={kind:'file'|'folder';path:string}|{kind:'repository';repositoryId:string};
const WindowAnnotations=createContext<{
  markedPanels:readonly string[];
  marks:readonly WindowMark[];
  remove:(mark:WindowMark)=>void;
  clear:()=>void;
  toggle:(mark:WindowMark)=>void;
}>({markedPanels:[],marks:[],remove:()=>{},clear:()=>{},toggle:()=>{}});
export const useWindowAnnotations=()=>useContext(WindowAnnotations);

export function WindowAnnotationProvider({children}:{children:ReactNode}){
  const [marks,setMarks]=useState<WindowMark[]>([]);
  const remove=useCallback((mark:WindowMark)=>setMarks(old=>old.filter(current=>current!==mark)),[]);
  const toggle=useCallback((mark:WindowMark)=>setMarks(old=>{
    const current=old.find(item=>item.id===mark.id);
    if(!current)return [...old,mark];
    const a=current.document,b=mark.document;
    if(current.workspaceId===mark.workspaceId&&a?.sessionId===b?.sessionId&&a?.file===b?.file)return old.filter(item=>item!==current);
    return old.map(item=>item===current?mark:item);
  }),[]);
  return <WindowAnnotations.Provider value={{
    marks,markedPanels:marks.map(mark=>mark.id),remove,clear:()=>setMarks([]),toggle,
  }}>{children}</WindowAnnotations.Provider>;
}

const annotationControls='button,a,input,textarea,select,[role="button"],[contenteditable],[data-no-drag]';
export function windowAnnotationTarget(target:Element){
  const tab=target.closest<HTMLElement>('[data-panel-tab]');
  if(tab?.dataset.panelTab)return tab.dataset.panelTab;
  if(target.closest(annotationControls))return;
  const title=target.closest<HTMLElement>('.panel-drag-header');
  return title?.dataset.lockPanel||title?.closest<HTMLElement>('[data-panel-id]')?.dataset.panelId;
}

type GestureOptions={
  enabled:boolean;
  has:(id:string)=>boolean;
  stage:(id:string)=>void;
  canMarkWindow?:(id:string)=>boolean;
  labelForWindow?:(id:string)=>string;
  stageWorkspaceTarget?:(target:WorkspaceAnnotationTarget)=>void;
};
type AnnotationHit={element:HTMLElement;label:string}&(
  | {kind:'document-tab'|'window';id:string}
  | {kind:'workspace';target:WorkspaceAnnotationTarget}
);

function panelElement(target:Element,id:string){
  const frame=target.closest<HTMLElement>('[data-panel-id]');
  if(frame?.dataset.panelId===id)return frame;
  return target.ownerDocument.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`);
}

function annotationHit(target:Element,options:GestureOptions|undefined,ctrlKey=false):AnnotationHit|undefined{
  const tab=target.closest<HTMLElement>('[data-document-tab],[data-panel-tab]');
  const tabId=tab?.dataset.documentTab||tab?.dataset.panelTab;
  if(tab&&tabId&&!target.closest('[data-no-drag]')&&options?.has(tabId)&&(options.enabled||ctrlKey))return {
    element:tab,id:tabId,kind:'document-tab',label:options.labelForWindow?.(tabId)||tab.title||tab.textContent?.trim()||'正文',
  };
  if(!options?.enabled&&!ctrlKey)return;
  if(options?.enabled&&(target.closest(annotationControls)||target.closest('[role="menu"],dialog,[role="dialog"]')))return;
  if(options?.enabled&&options.stageWorkspaceTarget){
    const row=target.closest<HTMLElement>('.explorer-row[data-path]');
    const path=row?.dataset.path;
    if(row&&path){
      const kind=row.hasAttribute('aria-expanded')?'folder':'file';
      return {element:row,kind:'workspace',target:{kind,path},label:path.split('/').at(-1)||path};
    }
    const card=target.closest<HTMLElement>('.repository-card[data-repository-id]');
    const repositoryId=card?.dataset.repositoryId;
    if(card&&repositoryId)return {
      element:card,kind:'workspace',target:{kind:'repository',repositoryId},
      label:card.querySelector('h3')?.textContent?.trim()||repositoryId,
    };
  }
  const frame=target.closest<HTMLElement>('[data-panel-id]');
  const titleId=windowAnnotationTarget(target);
  const id=titleId||(options?.enabled?frame?.dataset.panelId:undefined);
  if(!id||!(ctrlKey&&titleId)&&!options?.canMarkWindow?.(id))return;
  const element=panelElement(target,id);
  if(element)return {element,id,kind:'window',label:options?.labelForWindow?.(id)||element.getAttribute('aria-label')||id};
}

const targetPresentation:Record<'document-tab'|'window'|WorkspaceAnnotationTarget['kind'],{name:string;icon:IconName}>={
  'document-tab':{name:'文件',icon:'file.text'},
  file:{name:'文件',icon:'file.text'},
  folder:{name:'文件夹',icon:'Folder'},
  repository:{name:'仓库',icon:'panel.repositories'},
  window:{name:'窗口',icon:'Square'},
};
function annotationPreview(owner:Window){
  const doc=owner.document,caption=doc.createElement('div');
  caption.className='window-annotation-target-caption';
  caption.setAttribute('aria-hidden','true');
  let highlighted:HTMLElement|undefined,captionSize={width:0,height:0};
  function clear(){
    if(highlighted)delete highlighted.dataset.windowAnnotationPreview;
    highlighted=undefined;
    caption.remove();
  }
  function show(hit:AnnotationHit,x:number,y:number){
    if(highlighted!==hit.element){
      clear();
      const kind=hit.kind==='workspace'?hit.target.kind:hit.kind;
      const {name,icon}=targetPresentation[kind];
      highlighted=hit.element;
      highlighted.dataset.windowAnnotationPreview=kind;
      const text=doc.createElement('span');
      text.textContent=name+' · '+hit.label;
      caption.replaceChildren(createUiIcon(doc,icon,13),text);
      doc.body.append(caption);
      captionSize={width:caption.offsetWidth,height:caption.offsetHeight};
    }
    const {width,height}=captionSize,edge=6,gap=12;
    const nearX=x+gap+width>doc.documentElement.clientWidth-edge?x-gap-width:x+gap;
    const nearY=y+gap+height>doc.documentElement.clientHeight-edge?y-gap-height:y+gap;
    caption.style.left=Math.max(edge,nearX)+'px';
    caption.style.top=Math.max(edge,nearY)+'px';
  }
  return {show,clear};
}

export function useWindowAnnotationGesture(windows:ReadonlyMap<string,Window>,captureMark:(panel:string)=>WindowMark,options?:GestureOptions){
  const {toggle}=useWindowAnnotations();
  const capture=useRef(captureMark);capture.current=captureMark;
  const settings=useRef(options);settings.current=options;
  const enabled=!!options?.enabled;
  useEffect(()=>{
    const cleanups=[...new Set([window,...windows.values()])].map(owner=>{
      const preview=annotationPreview(owner);
      let press:{hit:AnnotationHit;mark?:WindowMark;pointer:number;x:number;y:number;cancelled:boolean}|undefined;
      let pointer:{x:number;y:number}|undefined;
      const identify=(event:MouseEvent)=>{
        const target=event.target as Element|null;
        if(event.altKey||event.shiftKey||event.metaKey||event.button!==0||target?.nodeType!==1)return;
        return annotationHit(target,settings.current,event.ctrlKey);
      };
      const refresh=()=>{
        if(!enabled||!pointer)return;
        const target=owner.document.elementFromPoint(pointer.x,pointer.y);
        const hit=target&&annotationHit(target,settings.current);
        if(hit)preview.show(hit,pointer.x,pointer.y);
        else preview.clear();
      };
      const down=(event:PointerEvent)=>{
        press=undefined;
        const hit=event.isPrimary?identify(event):undefined;
        if(!hit)return;
        press={hit,mark:hit.kind==='window'?capture.current(hit.id):undefined,pointer:event.pointerId,x:event.clientX,y:event.clientY,cancelled:false};
        // File and folder rows use pointerdown to begin the existing drag into context.
        if(hit.kind==='workspace'&&hit.target.kind!=='repository')return;
        event.preventDefault();
        event.stopPropagation();
      };
      const move=(event:PointerEvent)=>{
        if(press?.pointer===event.pointerId&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>5)press.cancelled=true;
        if(!enabled||!event.isPrimary)return;
        if(event.buttons&&press?.cancelled){pointer=undefined;preview.clear();return;}
        pointer={x:event.clientX,y:event.clientY};
        refresh();
      };
      const click=(event:MouseEvent)=>{
        const initial=press;
        press=undefined;
        const hit=identify(event);
        if(!initial||!hit||initial.hit.element!==hit.element||initial.hit.kind!==hit.kind||!event.detail)return;
        event.preventDefault();
        event.stopPropagation();
        if(initial.cancelled||Math.hypot(event.clientX-initial.x,event.clientY-initial.y)>5)return;
        preview.clear();
        if(initial.mark)toggle(initial.mark);
        else if(hit.kind==='document-tab')settings.current?.stage(hit.id);
        else if(hit.kind==='workspace')settings.current?.stageWorkspaceTarget?.(hit.target);
      };
      const cancel=()=>{press=undefined;pointer=undefined;preview.clear();};
      const leave=(event:PointerEvent)=>{if(!event.relatedTarget){pointer=undefined;preview.clear();}};
      owner.addEventListener('pointerdown',down,true);
      owner.addEventListener('pointermove',move,true);
      owner.addEventListener('pointerout',leave,true);
      owner.addEventListener('click',click,true);
      owner.addEventListener('pointercancel',cancel);
      owner.addEventListener('blur',cancel);
      if(enabled)owner.addEventListener('scroll',refresh,{capture:true,passive:true});
      return ()=>{
        cancel();
        owner.removeEventListener('pointerdown',down,true);
        owner.removeEventListener('pointermove',move,true);
        owner.removeEventListener('pointerout',leave,true);
        owner.removeEventListener('click',click,true);
        owner.removeEventListener('pointercancel',cancel);
        owner.removeEventListener('blur',cancel);
        owner.removeEventListener('scroll',refresh,true);
      };
    });
    return ()=>cleanups.forEach(cleanup=>cleanup());
  },[windows,toggle,enabled]);
}
