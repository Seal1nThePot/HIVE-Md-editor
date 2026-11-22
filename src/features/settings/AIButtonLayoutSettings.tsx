import {useEffect,useRef,useState,type KeyboardEvent,type PointerEvent as ReactPointerEvent} from 'react';
import {GripVertical,Icon} from '../../shared/icons';
import {usePanelDocument} from '../../shared/panelDocument';
import {aiButtonRegions,aiButtons,aiRegionLabels,placeAIButton,type AIButtonId,type AIButtonRegion,type useAIButtonLayout} from '../chat/aiButtonLayout';
import './ai-button-layout-settings.css';

type Destination={region:AIButtonRegion;gap:number};

export function AIButtonLayoutSettings({layout,setLayout,saveError}:ReturnType<typeof useAIButtonLayout>) {
  const root=useRef<HTMLDivElement>(null),cleanup=useRef<(()=>void)|null>(null),latest=useRef(layout);
  latest.current=layout;
  const [drag,setDrag]=useState<{id:AIButtonId;to:Destination|null}|null>(null);
  const ownerDocument=usePanelDocument();
  useEffect(()=>()=>cleanup.current?.(),[ownerDocument]);

  function begin(id:AIButtonId,event:ReactPointerEvent<HTMLButtonElement>){
    if(event.button!==0||!event.isPrimary)return;
    const target=event.currentTarget,doc=target.ownerDocument,win=doc.defaultView;
    if(!win)return;
    cleanup.current?.();
    const pointer=event.pointerId,start={x:event.clientX,y:event.clientY};
    let active=true,moving=false;
    function locate(next:PointerEvent):Destination|null{
      const hit=doc.elementFromPoint(next.clientX,next.clientY);
      const zone=hit?.closest<HTMLElement>('[data-ai-drop-region]');
      const region=zone?.dataset.aiDropRegion as AIButtonRegion|undefined;
      if(!zone||!region||!root.current?.contains(zone))return null;
      const items=[...zone.querySelectorAll<HTMLElement>('[data-ai-button-position]')];
      const targetIndex=items.findIndex(item=>{
        const rect=item.getBoundingClientRect();
        if(region!=='bottom')return next.clientY<rect.top+rect.height/2;
        return next.clientY<rect.top||(next.clientY<=rect.bottom&&next.clientX<rect.left+rect.width/2);
      });
      return {region,gap:targetIndex<0?items.length:targetIndex};
    }
    const move=(next:PointerEvent)=>{
      if(next.pointerId!==pointer)return;
      if(!moving&&Math.hypot(next.clientX-start.x,next.clientY-start.y)<5)return;
      moving=true;next.preventDefault();
      setDrag({id,to:locate(next)});
    };
    const finish=(next:PointerEvent)=>{
      if(next.pointerId!==pointer)return;
      const destination=moving?locate(next):null;
      clear();
      if(destination){next.preventDefault();setLayout(current=>placeAIButton(current,id,destination.region,destination.gap));}
    };
    const cancel=()=>clear();
    const key=(next:globalThis.KeyboardEvent)=>{
      if(next.key==='Escape'&&moving){next.preventDefault();next.stopPropagation();cancel();}
    };
    function clear(){
      if(!active||!win)return;
      active=false;
      win.removeEventListener('pointermove',move);
      win.removeEventListener('pointerup',finish);
      win.removeEventListener('pointercancel',cancel);
      win.removeEventListener('blur',cancel);
      win.removeEventListener('keydown',key,true);
      target.removeEventListener('lostpointercapture',cancel);
      if(target.hasPointerCapture(pointer))target.releasePointerCapture(pointer);
      cleanup.current=null;setDrag(null);
    }
    win.addEventListener('pointermove',move,{passive:false});
    win.addEventListener('pointerup',finish);
    win.addEventListener('pointercancel',cancel);
    win.addEventListener('blur',cancel);
    win.addEventListener('keydown',key,true);
    target.addEventListener('lostpointercapture',cancel);
    cleanup.current=cancel;
    try{target.setPointerCapture(pointer);}catch{/* Window listeners also handle pointer capture failures. */}
  }
  function keyboard(id:AIButtonId,region:AIButtonRegion,index:number,event:KeyboardEvent<HTMLButtonElement>){
    if(!event.altKey||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    const position=aiButtonRegions.indexOf(region);
    const horizontal=event.key==='ArrowLeft'||event.key==='ArrowRight';
    const delta=event.key==='ArrowUp'||event.key==='ArrowLeft'?-1:1;
    const destination=horizontal?aiButtonRegions[position+delta]:region;
    if(!destination)return;
    const gap=horizontal?latest.current[destination].length:Math.max(0,index+(delta<0?-1:2));
    setLayout(previous=>placeAIButton(previous,id,destination,gap));
    ownerDocument.defaultView?.requestAnimationFrame(()=>root.current?.querySelector<HTMLButtonElement>('[data-ai-button-position="'+id+'"]')?.focus());
  }
  return <section className="settings-card ai-button-layout-settings" aria-label="AI 功能按钮位置">
    <h2>AI 功能按钮位置</h2>
    <p>拖动按钮到对话面板的左侧、右侧或底部。也可用 Alt + 左右方向键换区，Alt + 上下方向键排序。</p>
    <div ref={root} className="ai-button-layout-grid">
      {aiButtonRegions.map(region=>{
        const insertion=drag?.to?.region===region?drag.to.gap:undefined;
        return <section key={region} aria-label={aiRegionLabels[region]} data-ai-drop-region={region}
          data-drop-active={insertion!==undefined||undefined} data-insert-end={insertion===layout[region].length||undefined}>
          <h3>{aiRegionLabels[region]}</h3>
          {layout[region].map((id,index)=><button type="button" key={id} data-ai-button-position={id}
            data-dragging={drag?.id===id||undefined} data-insert-before={insertion===index||undefined}
            onPointerDown={event=>begin(id,event)} onKeyDown={event=>keyboard(id,region,index,event)}>
            <GripVertical size={13}/><Icon name={aiButtons[id].icon} size={15}/><span>{aiButtons[id].label}</span>
          </button>)}
        </section>;
      })}
    </div>
    {saveError&&<p role="status">{saveError}</p>}
  </section>;
}
