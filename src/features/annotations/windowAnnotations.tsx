import {createContext,useCallback,useContext,useState,useEffect,useRef,type ReactNode} from 'react';

export type MarkedDocument={sessionId:string;file:string};
export type WindowMark={id:string;workspaceId:string;document?:MarkedDocument};
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

export function windowAnnotationTarget(target:Element){
  const tab=target.closest<HTMLElement>('[data-panel-tab]');
  if(tab?.dataset.panelTab)return tab.dataset.panelTab;
  if(target.closest('button,a,input,textarea,select,[role="button"],[contenteditable],[data-no-drag]'))return;
  const title=target.closest<HTMLElement>('.panel-drag-header');
  return title?.dataset.lockPanel||title?.closest<HTMLElement>('[data-panel-id]')?.dataset.panelId;
}

export function useWindowAnnotationGesture(windows:ReadonlyMap<string,Window>,captureMark:(panel:string)=>WindowMark,documentTabs?:{
  enabled:boolean;has:(id:string)=>boolean;stage:(id:string)=>void;
}){
  const {toggle}=useWindowAnnotations();
  const capture=useRef(captureMark);capture.current=captureMark;
  const tabs=useRef(documentTabs);tabs.current=documentTabs;
  useEffect(()=>{
    const cleanups=[...new Set([window,...windows.values()])].map(owner=>{
      let press:{id:string;mark?:WindowMark;pointer:number;x:number;y:number;cancelled:boolean}|undefined;
      const identify=(event:MouseEvent)=>{
        const target=event.target as Element|null;
        if(event.altKey||event.shiftKey||event.metaKey||event.button!==0||target?.nodeType!==1)return;
        const tab=target.closest<HTMLElement>('[data-document-tab],[data-panel-tab]');
        const id=tab?.dataset.documentTab||tab?.dataset.panelTab;
        if(id&&!target.closest('[data-no-drag]')&&tabs.current?.has(id)&&(event.ctrlKey||tabs.current.enabled))return {id,documentTab:true};
        const panel=event.ctrlKey?windowAnnotationTarget(target):undefined;
        if(panel)return {id:panel,documentTab:false};
      };
      const down=(event:PointerEvent)=>{
        press=undefined;
        const hit=event.isPrimary?identify(event):undefined;
        if(!hit)return;
        press={id:hit.id,mark:hit.documentTab?undefined:capture.current(hit.id),pointer:event.pointerId,x:event.clientX,y:event.clientY,cancelled:false};
        event.preventDefault();
        event.stopPropagation();
      };
      const move=(event:PointerEvent)=>{
        if(press?.pointer===event.pointerId&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>5)press.cancelled=true;
      };
      const click=(event:MouseEvent)=>{
        const initial=press;
        press=undefined;
        const hit=identify(event);
        if(!initial||initial.id!==hit?.id||!!initial.mark===hit.documentTab||!event.detail)return;
        event.preventDefault();
        event.stopPropagation();
        if(initial.cancelled||Math.hypot(event.clientX-initial.x,event.clientY-initial.y)>5)return;
        if(initial.mark)toggle(initial.mark);
        else tabs.current?.stage(initial.id);
      };
      const cancel=()=>{press=undefined;};
      owner.addEventListener('pointerdown',down,true);
      owner.addEventListener('pointermove',move,true);
      owner.addEventListener('click',click,true);
      owner.addEventListener('pointercancel',cancel);
      owner.addEventListener('blur',cancel);
      return ()=>{
        owner.removeEventListener('pointerdown',down,true);
        owner.removeEventListener('pointermove',move,true);
        owner.removeEventListener('click',click,true);
        owner.removeEventListener('pointercancel',cancel);
        owner.removeEventListener('blur',cancel);
      };
    });
    return ()=>cleanups.forEach(cleanup=>cleanup());
  },[windows,toggle]);
}
