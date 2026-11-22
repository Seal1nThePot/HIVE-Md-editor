import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "@codemirror/view";
import { Check, List, Send, Trash2 } from "../../shared/icons";
import "./annotation-bubble.css";
import type { AnnotationSource, TextAnnotation } from "./annotations";
import {hideAnnotationSelection} from './annotationDecorations';
import {sameSourceTable} from '../editor/tableViewport';
export function clampAnnotationPosition(value:{x:number;y:number},width:number,height:number,viewportWidth:number,viewportHeight:number){
  return {x:Math.max(8,Math.min(value.x,Math.max(8,viewportWidth-width-8))),y:Math.max(8,Math.min(value.y,Math.max(8,viewportHeight-height-8)))};
}
export type ScreenRect={left:number;top:number;right:number;bottom:number};
export function placeAnnotationWindow(anchor:{x:number;y:number},target:ScreenRect,width:number,height:number,vw:number,vh:number){
  const gap=5, margin=8;
  const regions=[{x:margin,y:Math.max(margin,target.bottom+gap),w:vw-2*margin,h:vh-margin-Math.max(margin,target.bottom+gap)},
    {x:margin,y:margin,w:vw-2*margin,h:Math.min(vh-margin,target.top-gap)-margin},
    {x:Math.max(margin,target.right+gap),y:margin,w:vw-margin-Math.max(margin,target.right+gap),h:vh-2*margin},
    {x:margin,y:margin,w:Math.min(vw-margin,target.left-gap)-margin,h:vh-2*margin}];
  const viable=regions.filter(r=>r.w>0&&r.h>0);const region=viable.find(r=>r.w>=width&&r.h>=height)||viable.sort((a,b)=>Math.min(b.w,width)*Math.min(b.h,height)-Math.min(a.w,width)*Math.min(a.h,height))[0];
  if(!region)return {x:margin,y:margin,width:Math.max(1,vw-2*margin),height:Math.max(1,vh-2*margin)};
  const w=Math.min(width,region.w),h=Math.min(height,region.h);
  return {x:Math.max(region.x,Math.min(anchor.x,region.x+region.w-w)),y:Math.max(region.y,Math.min(anchor.y+29,region.y+region.h-h)),width:w,height:h};
}
export function tableAnnotationIds(element:HTMLElement):string[] {
  try {const ids=JSON.parse(element.dataset.tableAnnotationIds||'[]');return Array.isArray(ids)?ids.filter((id):id is string=>typeof id==='string'):[];}catch{return [];}
}
export function tableBatchIds(item:TextAnnotation,items:TextAnnotation[],editor:EditorView|null,groups:Map<string,string[]>):string[] {
  if(!editor)return [item.id];
  const cells=[...editor.dom.querySelectorAll<HTMLElement>('[data-table-annotation-ids]')];
  const table=cells.find(cell=>tableAnnotationIds(cell).includes(item.id))?.closest('[data-table-widget]');
  if(!table)return [item.id];
  const present=new Set(cells.filter(cell=>sameSourceTable(cell.closest('[data-table-widget]'),table)).flatMap(tableAnnotationIds));
  const group=groups.get(item.id)||items.filter(value=>value.source===item.source&&value.file===item.file&&value.createdAt===item.createdAt).map(value=>value.id);
  return group.filter(id=>present.has(id)&&items.some(value=>value.id===id));
}
export type InlineAnnotationRequest = {
  id: string;
  ids?: string[];
  nonce: string;
  focus?: boolean;
};
type AnnotationBubble={id:string;ids:string[];candidateIds:string[];source:AnnotationSource;file:string;x:number;y:number;target:ScreenRect;paragraph:ScreenRect;scroller:HTMLElement;scaleX:number;scaleY:number};

function sameRect(a:ScreenRect,b:ScreenRect){
  return a.left===b.left&&a.top===b.top&&a.right===b.right&&a.bottom===b.bottom;
}

function sameAnnotationBubble(a:AnnotationBubble,b:AnnotationBubble){
  return a.id===b.id&&a.file===b.file&&a.source===b.source&&a.scroller===b.scroller&&a.scaleX===b.scaleX&&a.scaleY===b.scaleY&&
    a.x===b.x&&a.y===b.y&&sameRect(a.target,b.target)&&sameRect(a.paragraph,b.paragraph)&&
    a.ids.join('\0')===b.ids.join('\0')&&a.candidateIds.join('\0')===b.candidateIds.join('\0');
}

function screenAnnotationBubble(bubble:AnnotationBubble, target=bubble.target){
  const {scroller,scaleX,scaleY}=bubble,rect=scroller.getBoundingClientRect();
  const x=(value:number)=>rect.left+(value-scroller.scrollLeft+scroller.clientLeft)*scaleX;
  const y=(value:number)=>rect.top+(value-scroller.scrollTop+scroller.clientTop)*scaleY;
  return {x:x(bubble.x),y:y(bubble.y),target:{left:x(target.left),top:y(target.top),right:x(target.right),bottom:y(target.bottom)}};
}

export default function InlineAnnotationEditor({
  ownerDocument = document,
  items,
  request,
  editorFor,
  onDismiss,
  onEdit,
  onSend,
  onOpenGlobal,
  onFocusGlobal,
  onReveal,
  onRemove,
  onCancel,
  saving,
  busy,
  toolActive=false,
  bubblePlacement="right",
}: {
  ownerDocument?: Document;
  items: TextAnnotation[];
  request: InlineAnnotationRequest | null;
  editorFor: (source: AnnotationSource) => EditorView | null;
  onDismiss?: (request: InlineAnnotationRequest) => void;
  onEdit: (id: string, note: string) => void;
  onSend: (ids: string[]) => void;
  onOpenGlobal: (id:string) => void;
  onFocusGlobal?: (id:string) => void;
  onReveal?: () => void;
  onRemove?: (id:string) => void;
  onCancel?: (ids:string[]) => void;
  saving: boolean;
  busy: boolean;
  toolActive?:boolean;
  bubblePlacement?:"left"|"right"|"above"|"below";
}) {
  const document=ownerDocument, window=document.defaultView!;
  const [shown, setShown] = useState<{
      id: string;
      ids: string[];
      pinned: boolean;
      focus: boolean;
    } | null>(null),
    [position, setPosition] = useState({ x: 12, y: 180 });
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setShown(null);
    if (request) onDismiss?.(request);
  }, [request, onDismiss]);
  const [hovered, setHovered] = useState<string|null>(null);
  const [hoverIds,setHoverIds]=useState<string[]>([]);
  const bubblesRef=useRef<AnnotationBubble[]>([]);
  const [bubblePosition, setBubblePosition] = useState({x:0,y:0});
  const hoverTimer = useRef<ReturnType<typeof setTimeout>|null>(null);
  const groups=useRef(new Map<string,string[]>());
  const hoveredCell=useRef<HTMLElement|null>(null);
  const outlined=useRef<HTMLElement[]>([]);
  const clearOutline=()=>{for(const cell of outlined.current)cell.classList.remove('cm-table-annotation-top','cm-table-annotation-right','cm-table-annotation-bottom','cm-table-annotation-left');outlined.current=[];};
  useEffect(()=>()=>clearOutline(),[]);
  useEffect(()=>{setChoices([]);if(toolActive){setHovered(null);setShown(null);clearOutline();}},[toolActive]);
  function setVisibleIds(ids:string[]){
    setHoverIds(current=>current.length===ids.length&&current.every((id,index)=>id===ids[index])?current:ids);
    setHovered(ids[0]??null);
  }
  useEffect(()=>{if(request){const ids=request.ids?.length?request.ids:[request.id];if(ids.length>1)for(const id of ids)groups.current.set(id,ids);setVisibleIds(ids);setShown({id:request.id,ids,pinned:true,focus:request.focus !== false});}else setShown(null);},[request]);
  useEffect(()=>{
    function leave(){
      if(hoverTimer.current)return;
      hoverTimer.current=setTimeout(()=>{hoverTimer.current=null;setVisibleIds([]);},350);
    }
    function enter(ids:string[]){
      if(hoverTimer.current)clearTimeout(hoverTimer.current);
      hoverTimer.current=null;
      setVisibleIds(ids);
    }
    const over=(event:PointerEvent)=>{
      const target=event.target as Element|null;
      if(target?.nodeType!==1)return;
      if(target.closest('.annotation-bubble-choices,.inline-annotation-editor')){
        if(hoverTimer.current)clearTimeout(hoverTimer.current);
        hoverTimer.current=null;
        return;
      }
      const key=target.closest<HTMLElement>('.annotation-bubble')?.dataset.annotationKey;
      const bubble=bubblesRef.current.find(value=>value.id===key);
      if(bubble){enter([...new Set([...bubble.ids,...bubble.candidateIds])]);return;}
      const cell=target.closest<HTMLElement>('[data-table-annotation-ids]');
      hoveredCell.current=cell;
      const scroller=target.closest('.cm-scroller');
      const candidates=bubblesRef.current.filter(value=>{
        if(value.scroller!==scroller)return false;
        const {target:rect}=screenAnnotationBubble(value,value.paragraph);
        return event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom;
      });
      if(candidates.length)enter([...new Set(candidates.flatMap(value=>[...value.ids,...value.candidateIds]))]);
      else leave();
    };
    const out=(event:PointerEvent)=>{if(!event.relatedTarget)leave();};
    const focus=(event:FocusEvent)=>{const target=event.target as Element,cell=target.closest<HTMLElement>('[data-table-annotation-ids]'),mark=target.closest<HTMLElement>('[data-annotation-id]');const ids=cell?tableAnnotationIds(cell):mark?.dataset.annotationId?[mark.dataset.annotationId]:[];if(ids.length)enter(ids);};
    const open=(event:Event)=>{const id=(event as CustomEvent<{id:string}>).detail?.id;if(id&&!toolActive){enter([id]);setShown(current=>current?.id===id?null:{id,ids:[id],pinned:true,focus:false});}};
    document.addEventListener('hive:open-annotation',open);
    document.addEventListener('pointerover',over);
    document.addEventListener('pointermove',over);
    document.addEventListener('pointerout',out);
    document.addEventListener('focusin',focus);
    return()=>{
      document.removeEventListener('hive:open-annotation',open);
      document.removeEventListener('pointerover',over);
      document.removeEventListener('pointermove',over);
      document.removeEventListener('pointerout',out);
      document.removeEventListener('focusin',focus);
      if(hoverTimer.current)clearTimeout(hoverTimer.current);
      hoverTimer.current=null;
    };
  },[toolActive,document]);
  const bubbleItem=items.find(value=>value.id===hovered);
  const [choices,setChoices]=useState<string[]>([]);
  const open = !!shown || choices.length > 0;
  useEffect(() => {
    if (!open) return;
    const dismiss = () => { close(); setChoices([]); };
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.nodeType === 1 && (box.current?.contains(target) || target.closest('.annotation-bubble,.annotation-bubble-choices'))) return;
      dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss);
    };
  }, [open, close, document, window]);
  const [bubbles,setBubbles]=useState<AnnotationBubble[]>([]);
  function measureAllBubbles(){
    const result:typeof bubbles=[],seen=new Set<string>();
    for(const item of items){
      if(item.stale)continue;const editor=editorFor(item.source);if(!editor||!editor.dom.isConnected||editor.dom.closest('[inert]')||!editor.dom.getClientRects().length)continue;
      const cells=[...editor.dom.querySelectorAll<HTMLElement>('[data-table-annotation-ids]')],ownCell=cells.find(cell=>tableAnnotationIds(cell).includes(item.id));
      const ids=ownCell?tableBatchIds(item,items,editor,groups.current):[item.id],key=ids.slice().sort().join('\0');if(!ids.length||seen.has(key))continue;seen.add(key);
      const table=ownCell?.closest('[data-table-widget]');
      const targets=ownCell?cells.filter(cell=>sameSourceTable(cell.closest('[data-table-widget]'),table)&&tableAnnotationIds(cell).some(id=>ids.includes(id))):[...editor.dom.querySelectorAll<HTMLElement>('[data-annotation-id]')].filter(mark=>mark.dataset.annotationId===item.id);
      const rects=targets.flatMap(mark=>[...mark.getClientRects()]);
      const scroller=editor.scrollDOM,clip=scroller.getBoundingClientRect();
      const fragments=rects.filter(r=>r.width>0&&r.height>0);
      if(!fragments.some(r=>r.right>Math.max(0,clip.left)&&r.left<Math.min(window.innerWidth,clip.right)&&r.bottom>Math.max(0,clip.top)&&r.top<Math.min(window.innerHeight,clip.bottom)))continue;
      const scaleX=editor.scaleX||1,scaleY=editor.scaleY||1;
      const localX=(x:number)=>(x-clip.left)/scaleX+scroller.scrollLeft-scroller.clientLeft;
      const localY=(y:number)=>(y-clip.top)/scaleY+scroller.scrollTop-scroller.clientTop;
      const target={left:localX(Math.min(...fragments.map(r=>r.left))),top:localY(Math.min(...fragments.map(r=>r.top))),right:localX(Math.max(...fragments.map(r=>r.right))),bottom:localY(Math.max(...fragments.map(r=>r.bottom)))};
      const lines=ownCell?[]:targets.map(mark=>mark.closest('.cm-line')?.getBoundingClientRect()).filter(rect=>!!rect?.height);
      const paragraph=lines.length?{left:localX(clip.left),right:localX(clip.right),top:localY(Math.min(...lines.map(r=>r!.top))),bottom:localY(Math.max(...lines.map(r=>r!.bottom)))}:target;
      let x=target.right+4,y=(target.top+target.bottom-24)/2;if(bubblePlacement==='left')x=target.left-28;if(bubblePlacement==='above'){x=(target.left+target.right-24)/2;y=target.top-28;}if(bubblePlacement==='below'){x=(target.left+target.right-24)/2;y=target.bottom+4;}
      // Keep the anchor in scroll-content coordinates so text and pencil advance in the same paint.
      const visibleLeft=scroller.scrollLeft;
      x=Math.max(visibleLeft+2,Math.min(visibleLeft+scroller.clientWidth-26,x));
      y=Math.max(0,y);
      const same=!ownCell&&result.find(b=>b.source===item.source&&b.file===item.file&&b.target.left===target.left&&b.target.top===target.top&&b.target.right===target.right&&b.target.bottom===target.bottom);
      if(same)same.candidateIds.push(item.id);
      else result.push({id:item.id,ids,candidateIds:[item.id],source:item.source,file:item.file,x,y,target,paragraph,scroller,scaleX,scaleY});
    }
    bubblesRef.current=result;
    setBubbles(old=>old.length===result.length&&old.every((item,index)=>sameAnnotationBubble(item,result[index]))?old:result);
  }
  function syncHighlightVisibility(){
    const ids=new Set(hoverIds);
    for(const source of ['document','scratch'] as const){
      const editor=editorFor(source);
      if(!editor||editor.dom.ownerDocument!==document)continue;
      const host=editor.dom.closest('.editor-host')||editor.dom;
      for(const frame of host.querySelectorAll<HTMLElement>('[data-annotation-frame-id]')){
        frame.toggleAttribute('data-annotation-visible',ids.has(frame.dataset.annotationFrameId!));
      }
      for(const cell of host.querySelectorAll<HTMLElement>('[data-table-annotation-ids]')){
        cell.toggleAttribute('data-annotation-visible',tableAnnotationIds(cell).some(id=>ids.has(id)));
      }
      const hidden=hideAnnotationSelection(editor.state,ids);
      editor.dom.toggleAttribute('data-annotation-selection-hidden',hidden);
      for(const pane of host.querySelectorAll('.cm-editor'))pane.toggleAttribute('data-annotation-selection-hidden',hidden);
    }
  }
  useLayoutEffect(()=>{measureAllBubbles();syncHighlightVisibility();});
  useEffect(()=>{
    let frame=0;
    const schedule=()=>{if(!frame)frame=window.requestAnimationFrame(()=>{frame=0;measureAllBubbles();syncHighlightVisibility();});};
    const mutations=new MutationObserver(schedule),resizes=new ResizeObserver(schedule);
    for(const source of ['document','scratch'] as const){
      const editor=editorFor(source);if(!editor||editor.dom.ownerDocument!==document)continue;
      mutations.observe(editor.dom,{subtree:true,childList:true,attributes:true,attributeFilter:['data-annotation-id','data-table-annotation-ids']});
      resizes.observe(editor.scrollDOM);
    }
    window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);
    return()=>{mutations.disconnect();resizes.disconnect();window.cancelAnimationFrame(frame);window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule);};
  },[document,items,bubblePlacement,hoverIds]);
  useEffect(()=>{setChoices([]);},[hovered]);
  function measureBubble(){
    if(!bubbleItem){clearOutline();return;}
    const editor=editorFor(bubbleItem.source);if(!editor || !editor.dom.isConnected || editor.dom.closest('[inert]') || !editor.dom.getClientRects().length){clearOutline();return;}
    const allTableCells=[...editor.dom.querySelectorAll<HTMLElement>('[data-table-annotation-ids]')];
    const anchorCell=allTableCells.find(cell=>tableAnnotationIds(cell).includes(bubbleItem.id));
    const anchorTable=anchorCell?.closest('[data-table-widget]');
    const idsInTable=new Set(allTableCells.filter(cell=>sameSourceTable(cell.closest('[data-table-widget]'),anchorTable)).flatMap(tableAnnotationIds));
    const group=anchorTable?(groups.current.get(bubbleItem.id)||items.filter(value=>value.source===bubbleItem.source&&value.file===bubbleItem.file&&value.createdAt===bubbleItem.createdAt&&idsInTable.has(value.id)).map(value=>value.id)):[bubbleItem.id];
    const tableCells=[...editor.dom.querySelectorAll<HTMLElement>('[data-table-annotation-ids]')].filter(el=>tableAnnotationIds(el).some(id=>group.includes(id)));
    const marks=[...editor.dom.querySelectorAll<HTMLElement>('[data-annotation-id]')].filter(el=>el.dataset.annotationId===bubbleItem.id);
    const mark=tableCells.find(el=>el.matches(':hover'))||tableCells.find(el=>el.contains(document.activeElement))||tableCells[0]||marks.find(el=>el.matches(':hover'))||marks.find(el=>el===document.activeElement)||marks[0];if(!mark || !mark.isConnected || !mark.getClientRects().length){clearOutline();return;}
    const table=mark.closest<HTMLElement>('[data-table-widget]');
    let rect:DOMRect;
    if(table){
      const cells=tableCells.filter(cell=>sameSourceTable(cell.closest('[data-table-widget]'),table)&&cell.getClientRects().length);
      const rects=cells.map(cell=>cell.getBoundingClientRect());
      const left=Math.min(...rects.map(r=>r.left)),top=Math.min(...rects.map(r=>r.top)),right=Math.max(...rects.map(r=>r.right)),bottom=Math.max(...rects.map(r=>r.bottom));
      rect=rects.length?new DOMRect(left,top,right-left,bottom-top):table.getBoundingClientRect();
      clearOutline();
      cells.forEach((cell,index)=>{const r=rects[index],near=(a:number,b:number)=>Math.abs(a-b)<1;
        if(near(r.top,top))cell.classList.add('cm-table-annotation-top');
        if(near(r.right,right))cell.classList.add('cm-table-annotation-right');
        if(near(r.bottom,bottom))cell.classList.add('cm-table-annotation-bottom');
        if(near(r.left,left))cell.classList.add('cm-table-annotation-left');
      });outlined.current=cells;
    }
    else clearOutline();
  }
  useLayoutEffect(()=>{measureBubble();});
  useEffect(()=>{if(hovered&&!items.some(value=>value.id===hovered))setHovered(null);if(shown&&!items.some(value=>value.id===shown.id))setShown(null);},[items,hovered,shown]);
  useEffect(()=>{window.addEventListener('scroll',measureBubble,true);window.addEventListener('resize',measureBubble);return()=>{window.removeEventListener('scroll',measureBubble,true);window.removeEventListener('resize',measureBubble);};},[bubbleItem,bubblePlacement]);
  function openBubble(id:string){
    const bubbleItem=items.find(item=>item.id===id);if(!bubbleItem)return;
    onFocusGlobal?.(id);
    const clicked=bubbles.find(b=>b.id===id);if(clicked){const {x,y}=screenAnnotationBubble(clicked);setBubblePosition({x,y});}
    const editor=editorFor(bubbleItem.source);
    const cells=editor?[...editor.dom.querySelectorAll<HTMLElement>('[data-table-annotation-ids]')]:[];
    const cell=cells.find(el=>el===hoveredCell.current&&tableAnnotationIds(el).includes(bubbleItem.id))||cells.find(el=>el.contains(document.activeElement)&&tableAnnotationIds(el).includes(bubbleItem.id))||cells.find(el=>tableAnnotationIds(el).includes(bubbleItem.id));
    const currentBatch=tableBatchIds(bubbleItem,items,editor,groups.current);
    if(shown && shown.ids.some(id=>currentBatch.includes(id)||clicked?.candidateIds.includes(id))){close();setChoices([]);return;}
    const ids=cell?tableAnnotationIds(cell).filter(id=>items.some(item=>item.id===id)):(clicked?.candidateIds||[]);
    const representatives=ids.filter((id,index)=>{const item=items.find(value=>value.id===id)!;return !ids.slice(0,index).some(other=>tableBatchIds(item,items,editor,groups.current).includes(other));});
    if(representatives.length>1){setChoices(representatives);return;}
    setChoices([]);setShown(current=>current?.id===bubbleItem.id?null:{id:bubbleItem.id,ids:tableBatchIds(bubbleItem,items,editor,groups.current),pinned:true,focus:false});
  }
  function cancelBubble(bubble:AnnotationBubble){
    const related=[...bubble.ids,...bubble.candidateIds];
    const displayed=shown?.ids.filter(id=>related.includes(id));
    const ids=displayed?.length ? displayed : bubble.ids;
    if(displayed?.length)close();
    setChoices(current=>current.filter(id=>!ids.includes(id)));
    setVisibleIds(hoverIds.filter(id=>!ids.includes(id)));
    for(const id of ids)groups.current.delete(id);
    onCancel?.(ids);
  }
  const item = items.find((value) => value.id === shown?.id);
  const noteVisible=!!shown?.ids.some(id=>hoverIds.includes(id));
  const revealedRequest=useRef<string|null>(null);
  useLayoutEffect(()=>{
    if(!request?.focus||item?.id!==request.id||revealedRequest.current===request.nonce)return;
    revealedRequest.current=request.nonce;
    onReveal?.();
  },[item?.id,request,onReveal]);
  const [windowLimit,setWindowLimitState]=useState({width:360,height:window.innerHeight-16});
  const setWindowLimit=(next:{width:number;height:number})=>setWindowLimitState(old=>old.width===next.width&&old.height===next.height?old:next);
  const moved=useRef(false), previousShown=useRef<string|null>(null);
  const drag=useRef<{pointer:number;startX:number;startY:number;origin:{x:number;y:number};wasMoved:boolean;element:HTMLElement}|null>(null);
  const clampPosition=(value:{x:number;y:number})=>{
    const bounds=box.current?.getBoundingClientRect(),width=bounds?.width||360,height=bounds?.height||180;
    return clampAnnotationPosition(value,width,height,window.innerWidth,window.innerHeight);
  };
  const movePosition=(value:{x:number;y:number})=>{const next=clampPosition(value);setPosition(old=>Math.abs(old.x-next.x)<0.5&&Math.abs(old.y-next.y)<0.5?old:next);};
  function measure() {
    if(!shown||!item)return;
    if(moved.current){setPosition(old=>{const next=clampPosition(old);return old.x===next.x&&old.y===next.y?old:next;});return;}
    const editor=editorFor(item.source);if(!editor||!editor.dom.isConnected)return;
    const active=bubbles.find(b=>b.ids.some(id=>shown.ids.includes(id))||b.candidateIds.some(id=>shown.ids.includes(id)));
    if(active){const anchor=screenAnnotationBubble(active),rect=box.current?.getBoundingClientRect(),placed=placeAnnotationWindow(anchor,anchor.target,rect?.width||360,rect?.height||180,window.innerWidth,window.innerHeight);setWindowLimit({width:placed.width,height:placed.height});setPosition(old=>old.x===placed.x&&old.y===placed.y?old:{x:placed.x,y:placed.y});return;}
    const point=editor.coordsAtPos(Math.min(item.from,editor.state.doc.length)),content=editor.contentDOM.getBoundingClientRect();
    const target=point?{left:point.left,right:point.right,top:point.top,bottom:point.bottom}:content;
    const rect=box.current?.getBoundingClientRect(),placed=placeAnnotationWindow({x:target.right+4,y:target.top},target,rect?.width||360,rect?.height||180,window.innerWidth,window.innerHeight);
    setWindowLimit({width:placed.width,height:placed.height});setPosition(old=>old.x===placed.x&&old.y===placed.y?old:{x:placed.x,y:placed.y});
  }
  useLayoutEffect(()=>{const key=shown?shown.id+'\0'+shown.ids.join('\0'):null;if(previousShown.current!==key){previousShown.current=key;moved.current=false;}measure();});
  useEffect(()=>{window.addEventListener('scroll',measure,true);window.addEventListener('resize',measure);return()=>{window.removeEventListener('scroll',measure,true);window.removeEventListener('resize',measure);};},[item,shown,bubbles,bubblePlacement]);
  function endDrag(cancel:boolean){const current=drag.current;if(!current)return;drag.current=null;if(current.element.hasPointerCapture(current.pointer))current.element.releasePointerCapture(current.pointer);if(cancel){moved.current=current.wasMoved;movePosition(current.origin);}}
  useEffect(()=>{const cancel=()=>endDrag(true),key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&drag.current){event.preventDefault();event.stopImmediatePropagation();endDrag(true);}};window.addEventListener('blur',cancel);window.addEventListener('keydown',key,true);return()=>{window.removeEventListener('blur',cancel);window.removeEventListener('keydown',key,true);endDrag(true);};},[]);
  function beginDrag(event:ReactPointerEvent<HTMLElement>){if(event.button!==0||!event.isPrimary)return;event.preventDefault();const element=event.currentTarget;drag.current={pointer:event.pointerId,startX:event.clientX,startY:event.clientY,origin:position,wasMoved:moved.current,element};moved.current=true;element.setPointerCapture(event.pointerId);}
  function dragMove(event:ReactPointerEvent<HTMLElement>){const current=drag.current;if(!current||event.pointerId!==current.pointer)return;movePosition({x:current.origin.x+event.clientX-current.startX,y:current.origin.y+event.clientY-current.startY});}
  return createPortal(
    <>
    {bubbles.map(bubble=>createPortal(<button key={bubble.id} type="button" className="annotation-bubble" data-annotation-key={bubble.id}
      data-annotation-visible={[...bubble.ids,...bubble.candidateIds].some(id=>hoverIds.includes(id))||undefined}
      title={`标注：${items.find(item=>item.id===bubble.id)?.original.slice(0,30)||''}`} aria-label="打开标注要求"
      aria-expanded={noteVisible&&!!shown&&shown.ids.some(id=>bubble.ids.includes(id)||bubble.candidateIds.includes(id))} style={{left:bubble.x,top:bubble.y}}
      onContextMenu={event=>{if(!onCancel)return;event.preventDefault();event.stopPropagation();cancelBubble(bubble);}}
      onClick={()=>{setVisibleIds([...new Set([...bubble.ids,...bubble.candidateIds])]);openBubble(bubble.id);}}>✎</button>,bubble.scroller,bubble.id))}
    {choices.length>0 && <div className="annotation-bubble-choices" data-annotation-visible={choices.some(id=>hoverIds.includes(id))||undefined} role="menu" style={{left:Math.max(2,Math.min(window.innerWidth-130,bubblePosition.x)),top:Math.max(2,Math.min(window.innerHeight-Math.min(choices.length*34+8,window.innerHeight-4)-2,bubblePosition.y+28)),maxHeight:"calc(100vh - 8px)",overflowY:"auto"}}>{choices.map((id,index)=><button type="button" role="menuitem" key={id} onClick={()=>{const selected=items.find(value=>value.id===id);if(selected)setShown({id,ids:tableBatchIds(selected,items,editorFor(selected.source),groups.current),pinned:true,focus:false});setChoices([]);}}>标注 {index+1}</button>)}</div>}
    {shown && item && <div
      ref={box}
      className="inline-annotation-editor"
      data-annotation-visible={noteVisible||undefined}
      role="dialog"
      aria-label="原位标注要求"
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();close();}}}
      style={{ left: position.x, top: position.y, maxWidth:windowLimit.width, maxHeight:windowLimit.height, overflowY:"auto" }}
    >
      <div className="annotation-drag-handle" role="button" tabIndex={0} aria-label="拖动标注要求窗口" onPointerDown={beginDrag} onPointerMove={dragMove} onPointerUp={event=>{if(drag.current?.pointer===event.pointerId)endDrag(false);}} onPointerCancel={()=>endDrag(true)} onLostPointerCapture={()=>{if(drag.current)endDrag(true);}} onKeyDown={event=>{const delta:Record<string,[number,number]>={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]};if(delta[event.key]){event.preventDefault();moved.current=true;movePosition({x:position.x+delta[event.key][0],y:position.y+delta[event.key][1]});}}}/>
        <textarea
          key={shown.id}
          aria-label="这处文字的标注要求"
          autoFocus={shown.focus}
          value={item.note}
          onChange={(event) => {const live=new Set(items.map(value=>value.id));for(const id of shown.ids)if(live.has(id))onEdit(id,event.target.value);}}
          placeholder="直接在这里写疑问、修改要求或想讨论的方向…"
        />
      {item.stale && (
        <p className="annotation-warning">
          原文已变化，当前显示上次位置附近。重新选择文字后，可从标注标题的右键菜单更新位置。
        </p>
      )}
      <div className="inline-annotation-footer">
        <button type="button" className="annotation-open-global" aria-label="打开全局标注栏" onClick={()=>{close();onOpenGlobal(item.id);}}><List size={12} aria-hidden />全局标注</button>
        {(onCancel||onRemove)&&<button type="button" className="text-button annotation-remove" aria-label={shown.ids.length>1?'删除这组标注':'删除此标注'} disabled={busy} onClick={()=>{if(onCancel)onCancel(shown.ids);else for(const id of shown.ids)onRemove?.(id);close();}}><Trash2 size={12} aria-hidden />删除</button>}
        <span className="annotation-save-status" role="status">{saving ? "正在保存…" : "已自动保留要求"}</span>
        <button className="text-button" onClick={close}>
          <Check size={12} />
          完成
        </button>
        <button
          className="gold-button"
          disabled={busy || item.stale}
          onClick={() => {
            close();
            onSend(shown.ids.filter(id=>items.some(value=>value.id===id)));
          }}
        >
          <Send size={12} />
          发送
        </button>
      </div>
    </div>}
    </>,
    document.body,
  );
}


