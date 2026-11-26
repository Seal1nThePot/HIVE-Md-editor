import {floatingDropContent,pruneFloatingGroup,type FloatingGroup} from './floatingLayout';
import { createRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { dockedPanels, dockResizeEdges, measureDockTree, resizeDockSplit, PANEL_HEADER_HEIGHT, type DockEdge, type DockPlacementEdge, type Rect } from "./panelLayout";
import { completeWorkspace, defaultWorkspace, detachWorkspacePanel, hideWorkspacePanel, openWorkspacePanel, placeWorkspacePanel, placeWorkspacePanelAtEdge, floatWorkspaceGroup, placeWorkspaceGroup, closeWorkspacePanelPreservingAutoHide, type WorkspaceLayout } from "./workspaceState";
import {autoHideIsNative,autoHidePanelRect,collapseAutoHidePanel,isExpandedAutoHidePanel,nearestPanelEdge,panelAutoHidePlacement,releaseAutoHidePanel,withAutoHideMetadata,repositionAutoHidePanel} from "./autoHide";
import DockGuides from "./DockGuides";
import {DockIntent,type DockScene,type DockPointer,type DockFeedback,type DockGuide} from "./dockInteraction";
import type { DragControl } from "./PanelControl";
import { fitFloatingRect, resizeFloatingRect } from "./panelUiGeometry";
import {canMovePanel,canPlacePanel,isEditorPanel,PRIMARY_EDITOR,rankedFloatingLayers,retainPrimaryEditor,panelLayers,openDockedPanel,openContentsPanel,fitPanelInStage,isFreelyMovableTool} from './workspacePolicy';
import {isPanelPositionLocked,togglePanelPositionLock,canResizeSplit,openTrashPanel,dockAutoHideRail,canDockAutoHideRail} from './workspacePolicy';
import {PanelLockGestureTracker,type PanelLockGesture} from './panelLockGesture';
import {latestGestureFrame,gestureFrameClock} from './gestureFrame';
import {useDesktopPanels} from './DesktopPanels';
import {isolateWorkspacePanel} from './workspaceState';
import {visibleDockTree,visibleFloatingGroups,railDropAt} from './nativeDocking';
import {useNativePanelDocking} from './useNativePanelDocking';
import {NativeDragHandoff,minimizeNativePanel,openNativePanel,canDetachDocumentTab,returnNativeGroup} from './nativePanelState';
import {PanelLifecycle,type PanelOperation} from './panelLifecycle';

export type PanelWorkspacePlacement={layout:WorkspaceLayout;bounds:Rect};
export function usePanelWorkspace(stage: RefObject<HTMLDivElement|null>,onActivate?:(id:string)=>void,headerHeight=PANEL_HEADER_HEIGHT,lockGesture:PanelLockGesture='doubleClick',initial?:PanelWorkspacePlacement) {
  const desktop=useDesktopPanels();
  const [rawLayout,setLayout]=useState(()=>initial?.layout??defaultWorkspace()),
    [bounds,setBounds]=useState(()=>initial?.bounds??{x:0,y:160,width:window.innerWidth,height:window.innerHeight-185}),
    [dragging,setDragging]=useState<string|null>(null),[dockFeedback,setDockFeedback]=useState<DockFeedback|null>(null);
  const [raisedDocked,setRaisedDocked]=useState<string|null>(null);
  const raisedDockedLayer=Math.max(panelLayers.floating,...Object.values(rawLayout.layers))+2;
  const normalize=(value:WorkspaceLayout,area:Rect)=>{const next=retainPrimaryEditor(withAutoHideMetadata(completeWorkspace(value),area));return {...next,layers:rankedFloatingLayers(next.layers)};};
  const layout=useMemo(()=>normalize(rawLayout,bounds),[rawLayout,bounds]);
  const refs=useRef(new Map<string,RefObject<HTMLElement|null>>()),latest=useRef(layout),cleanup=useRef<(()=>void)|null>(null);
  latest.current=layout;
  const boundsRef=useRef(bounds);boundsRef.current=bounds;
  const dragIntent=useRef<{id:string;point:DockPointer;intent:DockIntent;timer:ReturnType<typeof setInterval>;keys:(event:KeyboardEvent)=>void;signature:string}|null>(null);
  const iconAnchors=useRef(new Map<string,Rect>());
  const [lifecycle]=useState(()=>new PanelLifecycle());
  const previousNativeWindows=useRef(new Set<string>());
  useEffect(()=>()=>{lifecycle.reset();},[lifecycle]);
  const update=(change:(old:WorkspaceLayout)=>WorkspaceLayout)=>{const next=normalize(change(latest.current),boundsRef.current);latest.current=next;setLayout(next);};
  function togglePositionLock(id:string){
    if(id===PRIMARY_EDITOR)return;
    cleanup.current?.();setDragging(null);stopDocking();update(old=>togglePanelPositionLock(old,id));
  }
  useEffect(()=>{
    let held=false,lastPointerType='';
    const tracker=new PanelLockGestureTracker(lockGesture,id=>{held=true;togglePositionLock(id);});
    const target=(event:Event)=>{
      const element=event.target instanceof Element?event.target:null,header=element?.closest<HTMLElement>('.panel-drag-header[data-lock-panel]');
      if(!header||!stage.current?.contains(header))return null;
      if(element?.closest('button,input,textarea,a,select,[data-no-drag]')&&!element.closest('[data-panel-tab]'))return null;
      const id=element?.closest<HTMLElement>('[data-panel-tab]')?.dataset.panelTab||header.dataset.lockPanel;
      return id&&id!==PRIMARY_EDITOR?id:null;
    };
    const down=(event:globalThis.PointerEvent)=>{lastPointerType=event.pointerType;if(event.button!==0||!event.isPrimary)return;held=false;const id=target(event);if(id)tracker.start(id,event.clientX,event.clientY,event.pointerId);};
    const move=(event:globalThis.PointerEvent)=>tracker.move(event.clientX,event.clientY,event.pointerId);
    const up=(event:globalThis.PointerEvent)=>tracker.end(event.pointerId);
    const cancel=()=>{tracker.cancel();held=false;};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')cancel();};
    const dbl=(event:MouseEvent)=>{const id=target(event);if(id&&tracker.doubleClick(id)){held=false;event.preventDefault();event.stopPropagation();}};
    const click=(event:MouseEvent)=>{if(held&&target(event)){held=false;event.preventDefault();event.stopPropagation();}};
    const context=(event:MouseEvent)=>{if(lockGesture==='longPress'&&(held||lastPointerType==='touch'||lastPointerType==='pen')&&target(event))event.preventDefault();};
    document.addEventListener('pointerdown',down,true);document.addEventListener('pointermove',move,true);document.addEventListener('pointerup',up,true);document.addEventListener('pointercancel',cancel,true);
    document.addEventListener('dblclick',dbl,true);document.addEventListener('click',click,true);document.addEventListener('contextmenu',context,true);window.addEventListener('blur',cancel);window.addEventListener('keydown',key,true);
    return()=>{cancel();document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',cancel,true);document.removeEventListener('dblclick',dbl,true);document.removeEventListener('click',click,true);document.removeEventListener('contextmenu',context,true);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',key,true);};
  },[lockGesture,stage]);
  const viewport=()=>({width:window.innerWidth,height:window.innerHeight});
  const fit=(rect:Rect,id?:string,source=latest.current)=>{const fitted=fitFloatingRect(rect,viewport());return id&&isFreelyMovableTool(source,id)?fitted:fitPanelInStage(fitted,boundsRef.current);};
  const refFor=(id:string)=>{if(!refs.current.has(id))refs.current.set(id,createRef<HTMLElement>());return refs.current.get(id)!;};
  useLayoutEffect(()=>{
    const measure=()=>{
      const rect=stage.current?.getBoundingClientRect();
      if(rect){
        const {x,y,width,height}=rect,previous=boundsRef.current;
        if(x!==previous.x||y!==previous.y||width!==previous.width||height!==previous.height){
          boundsRef.current={x,y,width,height};
          setBounds(boundsRef.current);
        }
      }
      const current=latest.current,rects={...current.rects};
      const resolvedDocked=new Set(dockedPanels(current.tree));
      const floatingGroups=new Set(current.floatingGroups.map(group=>group.id));
      let changed=false;
      for(const [id,value] of Object.entries(rects)){
        if(desktop.enabled&&(floatingGroups.has(id)||current.open.includes(id)&&
          (current.autoHide?.[id]?autoHideIsNative(current,id):!resolvedDocked.has(id))))continue;
        const next=fit(value,id);
        if(Object.keys(next).some(key=>next[key as keyof Rect]!==value[key as keyof Rect])){rects[id]=next;changed=true;}
      }
      if(changed)update(old=>({...old,rects}));
    };
    const observer=new ResizeObserver(measure);if(stage.current)observer.observe(stage.current);measure();window.addEventListener('resize',measure);
    return()=>{observer.disconnect();window.removeEventListener('resize',measure);cleanup.current?.();};
  },[stage]);
  const {nativeProjection,detachedIds,measurements}=useMemo(()=>{
    const docked=new Set(dockedPanels(layout.tree));
    const nativeProjection=desktop.enabled?layout.open.filter(id=>lifecycle.opening(id)||(layout.autoHide?.[id]?autoHideIsNative(layout,id):!docked.has(id))):[];
    const detachedIds=new Set([...desktop.windows.keys(),...nativeProjection]);
    return {nativeProjection,detachedIds,measurements:measureDockTree(visibleDockTree(layout.tree,detachedIds),{x:0,y:0,width:bounds.width,height:bounds.height})};
  },[layout,bounds,desktop.enabled,desktop.windows,lifecycle.revision]);
  function suggestedRect(id:string):Rect{
    if(id==='repositories')return fit({x:bounds.x+Math.max(12,(bounds.width-880)/2),y:bounds.y+24,width:Math.min(880,window.innerWidth-24),height:Math.min(680,window.innerHeight-70)},id);
    if(id==='search')return fit({x:bounds.x+bounds.width*.48,y:bounds.y+24,width:Math.min(450,bounds.width),height:Math.min(295,bounds.height)},id);
    const editor=refFor('editor').current?.getBoundingClientRect(),width=Math.min(id==='scratch'?(editor?.width||640):id.startsWith('editor')?650:380,window.innerWidth-24),height=Math.min(id==='scratch'?(editor?.height||520):520,window.innerHeight-60);
    const offset=latest.current.open.length%5*22;return fit({x:bounds.x+bounds.width*.28+offset,y:bounds.y+30+offset,width,height},id);
  }
  const tabGroups=useMemo(()=>[
    ...measurements.groups.map(group=>({...group,floating:false})),
    ...visibleFloatingGroups(layout.floatingGroups,detachedIds).flatMap(group=>{
      const rect=fit(layout.rects[group.id]||suggestedRect(group.active),group.id);
      if(!group.content)return [{...group,rect,floating:true}];
      const panes=measureDockTree(group.content,rect),seen=new Set(panes.groups.flatMap(g=>g.panels));
      return [...panes.groups,...Object.entries(panes.panels).filter(([id])=>!seen.has(id)).map(([id,rect])=>({type:'group' as const,id:'pane:'+id,panels:[id],active:id,rect}))].map(pane=>({...pane,floating:true}));
    })
  ],[layout,bounds,measurements,detachedIds]);
  function groupFor(id:string){return tabGroups.find(group=>group.panels.includes(id));}
  function currentRect(id:string,wholeGroup=false):Rect{
    const group=groupFor(id);
    if(group&&wholeGroup)return {...group.rect,x:group.rect.x+(group.floating?0:bounds.x),y:group.rect.y+(group.floating?0:bounds.y)};
    const element=refFor(id).current;
    const box=element?.ownerDocument===document?element.getBoundingClientRect():undefined;if(box&&box.width>0)return {x:box.x,y:box.y,width:box.width,height:box.height};
    const rect=measurements.panels[id];if(rect)return {x:rect.x+bounds.x,y:rect.y+bounds.y,width:rect.width,height:rect.height};
    if(group)return group.rect;return fit(latest.current.rects[id]||suggestedRect(id),id);
  }
  function raise(id:string){setRaisedDocked(current=>current===id?current:null);if(dockedPanels(latest.current.tree).includes(id)&&!latest.current.autoHide?.[id])return;const group=latest.current.floatingGroups.find(value=>value.panels.includes(id));const key=group?.id||id;update(old=>({...old,layers:rankedFloatingLayers(old.layers,key)}));}
  function open(id:string){
    setRaisedDocked(current=>current===id?current:null);
    openPanel(id);
  }
  function openPanel(id:string, reveal=false){const rect=fit(latest.current.rects[id]||suggestedRect(id),id);
    const placement=latest.current.autoHide?.[id];if(desktop.enabled&&placement&&autoHideIsNative(latest.current,id)&&!lifecycle.homes.has(id))lifecycle.homes.set(id,{rect:autoHidePanelRect(placement,boundsRef.current,iconAnchors.current.get(id)),placement});
    update(old=>{
    let next:WorkspaceLayout;
    if(desktop.enabled&&lifecycle.homes.has(id))next=openNativePanel(old,id);
    else if(id==='toc')next=openContentsPanel(old,rect);
    else if(id==='trash')next=openTrashPanel(old,rect);
    else if(isEditorPanel(id)&&!old.open.includes(id)&&!old.restore[id]&&!old.autoHide?.[id]&&canPlacePanel({...old,open:[...old.open,id]},id,PRIMARY_EDITOR,'right'))next=placeWorkspacePanel(old,id,PRIMARY_EDITOR,'right',rect);
    else next=openWorkspacePanel(old,id,rect);
    if(!dockedPanels(next.tree).includes(id)||next.autoHide?.[id]){const key=next.floatingGroups.find(group=>group.panels.includes(id))?.id||id;next={...next,layers:rankedFloatingLayers(next.layers,key)};}
    return next;
  });
    if(desktop.enabled&&lifecycle.homes.has(id)){
      for(const [owner,group] of lifecycle.groups)if(group.panels.includes(id))lifecycle.groups.set(owner,{...group,active:id});
      if(!desktop.windows.has(id))lifecycle.queue(id);
      else if(reveal)desktop.reveal(id);
      else desktop.detach(id);
    }
    onActivate?.(id);
  }
  function reveal(id:string){
    openPanel(id,true);
    const next=latest.current,placement=next.autoHide?.[id];
    const localDocked=!desktop.windows.has(id)&&dockedPanels(next.tree).includes(id)&&!placement;
    setRaisedDocked(localDocked?id:null);
    // The command may originate in the independent Windows toolbar.
    if(desktop.enabled&&(localDocked||placement&&!autoHideIsNative(next,id)))
      window.hiveDesktop?.windowCommand('focus');
  }
  useEffect(()=>{
    if(!desktop.enabled)return;
    // Every desktop floating state, including restored views and newly opened tools,
    // is projected straight into a native host rather than shown inside the main page.
    for(const group of layout.floatingGroups){
      const members=group.panels.filter(id=>layout.open.includes(id));
      if(members.length<2||members.some(id=>lifecycle.opening(id)||lifecycle.handoffs.has(id)))continue;
      const live=members.filter(id=>desktop.windows.has(id));
      if(live.length===members.length&&live.every(id=>desktop.windows.get(id)===desktop.windows.get(live[0])))continue;
      // Reopening a closed pane can add a member to a still-open single-panel host.
      // Move all surfaces together so the new host can own the entire restored tree.
      if(live.length&&!desktop.returnMembers(live))continue;
      const opening=pruneFloatingGroup(group,members);prepareNativeGroup(opening,layout.rects[group.id]||suggestedRect(group.active));lifecycle.queueGroup(opening);
    }
    for(const id of nativeProjection){
      if(!lifecycle.homes.has(id)){const placement=layout.autoHide?.[id];lifecycle.homes.set(id,{rect:placement?autoHidePanelRect(placement,boundsRef.current,iconAnchors.current.get(id)):layout.rects[id]||suggestedRect(id),placement});if(placement&&layout.autoHideActive===id)update(old=>openNativePanel(old,id));}
      if(!desktop.windows.has(id))lifecycle.queue(id);
    }
    for(const [id,operation] of lifecycle.pendingGroups){
      lifecycle.pendingGroups.delete(id);const group=lifecycle.groups.get(id),home=group&&lifecycle.homes.get(group.active);
      if(!group||!home||!group.panels.every(member=>latest.current.open.includes(member))){lifecycle.finish(operation,'cancelled');continue;}
      desktop.detachGroup(group.active,group.panels,open,{rect:()=>home.rect,...nativeCallbacks(operation,group.active,group),tabDrag:beginTabDrag,
        content:()=>latest.current.floatingGroups.find(g=>g.id===group.id)?.content,
        resizeSplit:(split,ratio)=>{if(latest.current.locked||group.panels.some(member=>isPanelPositionLocked(latest.current,member)))return;
          update(old=>({...old,floatingGroups:old.floatingGroups.map(g=>g.id===group.id&&g.content?{...g,content:resizeDockSplit(g.content,split,ratio)!}:g)}));desktop.refresh(group.active);},
      });
      group.panels.forEach(member=>lifecycle.pendingOpen.delete(member));
    }
    for(const [id,operation] of lifecycle.pendingOpen){
      if(lifecycle.handoffs.has(id))continue;
      lifecycle.pendingOpen.delete(id);
      if(!latest.current.open.includes(id)){lifecycle.finish(operation,'cancelled');continue;}
      const home=lifecycle.homes.get(id);
      if(home)desktop.detach(id,{rect:()=>home.rect,...nativeCallbacks(operation,id)});
    }
  },[rawLayout,desktop]);
  useEffect(()=>{
    const returned=[...previousNativeWindows.current].filter(id=>id!=='global-toolbar'&&!desktop.windows.has(id)&&latest.current.open.includes(id)&&lifecycle.homes.has(id)&&!lifecycle.opening(id)&&!lifecycle.handoffs.has(id));
    previousNativeWindows.current=new Set(desktop.windows.keys());
    if(returned.length){
      const groups=[...lifecycle.groups.entries()].filter(([,group])=>group.panels.some(id=>returned.includes(id)));
      lifecycle.clear(returned);
      const grouped=new Set(groups.flatMap(([,group])=>group.panels));
      update(old=>{let next=old;for(const [,group] of groups)next=returnNativeGroup(next,group,desktop.lastRect(group.active)||suggestedRect(group.active));for(const id of returned)if(!grouped.has(id))next=openDockedPanel(next,id,next.rects[id]||suggestedRect(id));return next;});
    }
  },[desktop.windows]);
  function toggleAutoHide(id:string,anchor?:Rect){
    if(anchor)iconAnchors.current.set(id,anchor);
    if(isExpandedAutoHidePanel(latest.current,id)||desktop.windows.has(id)&&latest.current.autoHide?.[id]){if(desktop.windows.has(id))hide(id,true);else update(old=>collapseAutoHidePanel(old,id));return;}
    open(id);
  }
  function repositionAutoHide(id:string,offset:number,edge?:'left'|'right'){
    if(!Number.isFinite(offset)||(edge!==undefined&&edge!=='left'&&edge!=='right'))return;
    iconAnchors.current.delete(id);
    update(old=>repositionAutoHidePanel(old,id,offset,edge));
  }
  function transition(kind:Parameters<PanelLifecycle['transition']>[0],ids:readonly string[],commit:()=>void,allowed=()=>true){
    return lifecycle.transition(kind,ids,
      ()=>allowed()&&(!desktop.enabled||!desktop.isComposing()&&!ids.some(id=>lifecycle.handoffs.has(id))),
      ()=>!desktop.enabled||desktop.returnMembers(ids),
      ()=>{for(const id of ids)iconAnchors.current.delete(id);commit();});
  }
  function pullAutoHideRail(edge:'left'|'right',width:number){
    const state=latest.current,next=dockAutoHideRail(state,edge,width,boundsRef.current.width);
    if(next===state)return;
    const ids=Object.entries(state.autoHide||{}).filter(([,placement])=>placement.edge===edge).map(([id])=>id);
    return transition('dock',ids,()=>update(()=>next));
  }
  useEffect(()=>{
    const id=layout.autoHideActive;if(!id||id==='conversation')return;
    const outside=(event:globalThis.PointerEvent)=>{
      if(desktop.windows.has(id)||lifecycle.pendingOpen.has(id)||lifecycle.homes.has(id))return;
      const target=event.target as Element;
      if(refs.current.get(id)?.current?.contains(target)||target.closest('.nearby-panel-rail,.writing-dock,[role="menu"],[role="dialog"],.panel-action-rail,.modal-backdrop,.settings-page'))return;
      update(old=>old.autoHideActive===id?collapseAutoHidePanel(old,id):old);
    };
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[layout.autoHideActive,desktop.windows]);
  function hide(id:string,minimize:boolean){
    if(id===PRIMARY_EDITOR&&!minimize)return 'rejected';
    const home=lifecycle.homes.get(id),nativeRect=desktop.rect(id)||(home?desktop.lastRect(id):null);
    const rect=nativeRect||currentRect(id,true),group=groupFor(id),next=group?.panels.find(value=>value!==id);
    const placement={...(latest.current.autoHide?.[id]||home?.placement||panelAutoHidePlacement(rect,boundsRef.current,!nativeRect&&dockedPanels(latest.current.tree).includes(id))),host:nativeRect||home?'native' as const:'main' as const};
    return transition(minimize?'minimize':'close',[id],()=>{
      setRaisedDocked(current=>current===id?null:current);
      if(minimize&&(nativeRect||home))lifecycle.homes.set(id,{rect,placement:{...placement,rect}});
      update(old=>{const result=minimize&&(nativeRect||home)?minimizeNativePanel(old,id,rect,placement):hideWorkspacePanel(old,id,rect,minimize,minimize?placement:undefined);return id===PRIMARY_EDITOR?{...result,nativePrimaryHidden:true}:result;});if(next)onActivate?.(next);
    });
  }
  function floatAt(id:string,rect:Rect){if(!canMovePanel(latest.current,id))return;if(desktop.enabled){if(desktop.isComposing())return;prepareNativeFloat(id,rect);lifecycle.queue(id);return;}const fitted=fit(rect,id);update(old=>{const next=releaseAutoHidePanel(detachWorkspacePanel(old,id),id);return {...next,open:next.open.includes(id)?next.open:[...next.open,id],minimized:next.minimized.filter(value=>value!==id),rects:{...next.rects,[id]:fitted}};});raise(id);}
  function dock(id:string,target?:string,edge:DockPlacementEdge='right'){
    if(!canPlacePanel(latest.current,id,target||'',edge))return;
    const fallback=currentRect(target||id,true);transition('dock',[id],()=>update(old=>placeWorkspacePanel(old,id,target||'',edge,fallback)));
  }
  function toggleFloat(id:string){if(latest.current.autoHide?.[id]||dockedPanels(latest.current.tree).includes(id))floatAt(id,currentRect(id));else dock(id);}
  function openDocked(id:string){if(isPanelPositionLocked(latest.current,id)){open(id);return;}if(latest.current.locked&&!latest.current.autoHide?.[id]&&!dockedPanels(latest.current.tree).includes(id))return;transition('dock',[id],()=>{update(old=>openDockedPanel(old,id,currentRect(id)));onActivate?.(id);});}
  function dockAtEdge(id:string,edge:DockEdge){if(!canPlacePanel(latest.current,id,'',edge))return;transition('dock',[id],()=>{update(old=>placeWorkspacePanelAtEdge(old,id,edge));raise(id);onActivate?.(id);});}
  function splitEditor(id:string,target=PRIMARY_EDITOR,edge:DockEdge='right'){
    if(latest.current.locked||!canPlacePanel(latest.current,id,target,edge)){open(id);return;}
    transition('dock',[id],()=>{update(old=>placeWorkspacePanel(old,id,target,edge,suggestedRect(id)));onActivate?.(id);});
  }
  function openDocumentTab(id:string,target=PRIMARY_EDITOR){
    return transition('dock',[id],()=>{update(old=>placeWorkspacePanel(old,id,target,'center',suggestedRect(id)));onActivate?.(id);});
  }
  function dockingScene(id:string):DockScene {
    const state=latest.current,nativeIds=new Set([...desktop.windows.keys(),...state.open.filter(panel=>lifecycle.opening(panel))]),tree=visibleDockTree(state.tree,nativeIds),docked=dockedPanels(tree),groups=visibleFloatingGroups(state.floatingGroups,nativeIds),grouped=new Set(groups.flatMap(group=>group.panels));
    const floating:DockScene['floating']=tabGroups.filter(group=>group.floating).map(group=>({id:group.active,rect:group.rect,layer:state.layers[state.floatingGroups.find(g=>g.panels.includes(group.active))?.id||group.id]||30}));
    for(const target of state.open)if(target!==id&&!nativeIds.has(target)&&!docked.includes(target)&&!grouped.has(target))floating.push({id:target,rect:state.autoHide?.[target]?autoHidePanelRect(state.autoHide[target],boundsRef.current,iconAnchors.current.get(target)):fit(state.rects[target]||suggestedRect(target),target),layer:state.layers[target]||panelLayers.floating});
    const seen=new Set<string>(),source=desktop.owner(id);
    for(const member of desktop.windows.keys()){
      const host=desktop.owner(member);if(host===source||seen.has(host)||desktop.hiddenWindows.has(member)||member==='global-toolbar')continue;
      seen.add(host);const frame=desktop.rect(member);if(!frame)continue;
      const current=desktop.panelForHost(host),group=state.floatingGroups.find(g=>g.panels.includes(current));
      const local=group?.content?measureDockTree(group.content,frame):null;
      const visible=local?Object.keys(local.panels).filter(id=>!local.groups.some(g=>g.panels.includes(id)&&g.active!==id)):[current];
      for(const id of visible)floating.push({id,rect:local?.panels[id]||frame,layer:1000+(state.layers[group?.id||id]||0),host});
    }
    return {panel:id,tree,bounds:boundsRef.current,viewport:{x:0,y:0,width:window.innerWidth,height:window.innerHeight},floating,scale:headerHeight/PANEL_HEADER_HEIGHT,locked:!!state.locked,positionLockedPanels:state.open.filter(panel=>isPanelPositionLocked(state,panel)),protectedPanels:isEditorPanel(id)?[]:[PRIMARY_EDITOR,...(tabGroups.find(group=>group.panels.includes(PRIMARY_EDITOR))?.panels||[])],dedupeEquivalent:desktop.enabled};
  }
  function commitNativeDrop(id:string,guide:DockGuide|null,rail:ReturnType<typeof railDropAt>){
    const state=latest.current,entry=nativeGroupEntry(id),nativeGroup=entry?.[1],members=desktop.members(id)||nativeGroup?.panels||[id];
    if(rail){
      if(state.locked||members.some(member=>isPanelPositionLocked(state,member)))return;
      const rect=desktop.rect(id)||currentRect(id),placement={edge:rail.edge,offset:rail.offset,rect};
      return transition('minimize',members,()=>{
        members.forEach(member=>lifecycle.homes.set(member,{rect,placement}));
        update(old=>{let result=old;for(const member of members)result=minimizeNativePanel(result,member,rect,placement);return members.includes(PRIMARY_EDITOR)?{...result,nativePrimaryHidden:true}:result;});
      });
    }
    if(!guide)return;
    const allowed=id===PRIMARY_EDITOR?!state.locked&&!isPanelPositionLocked(state,guide.target)&&(guide.edge!=='center'||isEditorPanel(guide.target)):canPlacePanel(state,id,guide.target,guide.edge);
    if(!allowed||members.some(member=>member!==PRIMARY_EDITOR&&!canPlacePanel(state,member,guide.target,guide.edge)))return;
    if(guide.scope==='panel'&&desktop.windows.has(guide.target)){
      if(members.includes(guide.target)||members.includes(PRIMARY_EDITOR)||guide.target===PRIMARY_EDITOR)return;
      const targetMembers=desktop.members(guide.target)||[guide.target];
      if(targetMembers.includes(PRIMARY_EDITOR)||targetMembers.some(member=>isPanelPositionLocked(state,member)))return;
      const targetFrame=desktop.rect(guide.target);if(!targetFrame)return;
      const target=nativeGroupEntry(guide.target)?.[1],joined=floatingDropContent(target,guide.target,nativeGroup,id,guide.edge);
      return transition('dock',[...targetMembers,...members],()=>{update(old=>floatWorkspaceGroup(old,joined,targetFrame));onActivate?.(id);});
    }
    return transition('dock',members,()=>{
      update(old=>nativeGroup?placeWorkspaceGroup(old,nativeGroup,guide.target,guide.edge,currentRect(guide.target,true),guide.scope==='workspace'):guide.scope==='workspace'?placeWorkspacePanelAtEdge(old,id,guide.edge as DockEdge):placeWorkspacePanel(old,id,guide.target,guide.edge,currentRect(guide.target,true)));onActivate?.(id);
    });
  }
  useNativePanelDocking({scene:dockingScene,resolveId:desktop.panelForHost,allowed:id=>desktop.windows.has(id)&&id!=='global-toolbar'&&!desktop.isComposing(),drop:commitNativeDrop});
  function tickDocking(){
    const active=dragIntent.current;if(!active)return;
    const feedback=active.intent.step(active.point,dockingScene(active.id));
    const signature=JSON.stringify([feedback.visible,feedback.guides,feedback.ready?.key,!!active.point.free]);
    if(signature!==active.signature){active.signature=signature;setDockFeedback(feedback);}
  }
  function stopDocking(){
    const active=dragIntent.current;if(active){clearInterval(active.timer);window.removeEventListener('keydown',active.keys,true);window.removeEventListener('keyup',active.keys,true);}
    dragIntent.current=null;setDockFeedback(null);
  }
  function startDocking(id:string,event:globalThis.PointerEvent){
    stopDocking();const point={x:event.clientX,y:event.clientY,free:event.altKey};
    const keys=(event:KeyboardEvent)=>{if(!dragIntent.current||event.key!=='Alt')return;dragIntent.current.point={...dragIntent.current.point,free:event.altKey};tickDocking();};
    dragIntent.current={id,point,intent:new DockIntent(),keys,timer:setInterval(tickDocking,32),signature:''};
    window.addEventListener('keydown',keys,true);window.addEventListener('keyup',keys,true);tickDocking();
  }
  function track(event:PointerEvent<HTMLElement>,move:(dx:number,dy:number,event:globalThis.PointerEvent)=>void,finish?:(event:globalThis.PointerEvent)=>void,onCancel?:()=>void,onKey?:(event:KeyboardEvent)=>void){
    event.preventDefault();cleanup.current?.();const x=event.clientX,y=event.clientY,source=event.currentTarget.ownerDocument,element=source===document?(stage.current||event.currentTarget):(source.querySelector<HTMLElement>('.desktop-panel-workbench')||event.currentTarget),win=source.defaultView!;
    // Capture only a real drag: capturing a simple tab press on the stage would
    // redirect its click away from the tab. The stable stage survives tab removal.
    let captured=false;
    const movement=latestGestureFrame<globalThis.PointerEvent>(gestureFrameClock(win),e=>move(e.clientX-x,e.clientY-y,e));
    const onMove=(e:globalThis.PointerEvent)=>{
      if(e.pointerId!==event.pointerId)return;
      const dx=e.clientX-x,dy=e.clientY-y;
      if(!captured&&Math.hypot(dx,dy)>=5){element.setPointerCapture(event.pointerId);captured=true;}
      movement.push(e);
    };
    const clear=()=>{movement.cancel();win.removeEventListener('pointermove',onMove);win.removeEventListener('pointerup',end);win.removeEventListener('pointercancel',cancel);win.removeEventListener('keydown',key,true);win.removeEventListener('keyup',key,true);win.removeEventListener('blur',cancel);element.removeEventListener('lostpointercapture',cancel);cleanup.current=null;if(element.hasPointerCapture(event.pointerId))element.releasePointerCapture(event.pointerId);};
    const cancel=()=>{clear();onCancel?.();setDragging(null);stopDocking();};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();}else{movement.flush();onKey?.(e);}};
    const end=(e:globalThis.PointerEvent)=>{if(e.pointerId!==event.pointerId)return;try{movement.flush();}finally{clear();}finish?.(e);};cleanup.current=cancel;
    win.addEventListener('pointermove',onMove);win.addEventListener('pointerup',end);win.addEventListener('pointercancel',cancel);win.addEventListener('keydown',key,true);win.addEventListener('keyup',key,true);win.addEventListener('blur',cancel);element.addEventListener('lostpointercapture',cancel);
  }
  function beginDrag(id:string,event:PointerEvent<HTMLElement>,control?:DragControl){
    if(event.currentTarget.ownerDocument!==document){desktop.beginDrag(id,event);return;}
    if(!canMovePanel(latest.current,id))return;
    if(event.button!==0||(!control&&(event.target as Element).closest('button,input,textarea,a,select,[data-no-drag]')))return;
    if(desktop.enabled){beginNativeDrag(id,event,control);return;}
    const start=currentRect(id,control?.fromTab),original=latest.current;let began=false;raise(id);
    track(event,(dx,dy,e)=>{
      if(!began&&Math.hypot(dx,dy)<5)return;if(!began){began=true;control?.onStart?.();setDragging(id);}
      if(dragIntent.current)dragIntent.current.point={x:e.clientX,y:e.clientY,free:e.altKey};
      const rect=fit({...start,x:start.x+dx,y:start.y+dy},id);update(old=>{const next=releaseAutoHidePanel(detachWorkspacePanel(old,id),id);return {...next,rects:{...next.rects,[id]:rect}};});
      if(!dragIntent.current)startDocking(id,e);else tickDocking();
    },event=>{
      if(began&&event.type==='pointerup'){
        const placement=dragIntent.current?.intent.step({x:event.clientX,y:event.clientY,free:event.altKey},dockingScene(id)).ready;
        if(placement?.scope==='workspace')dockAtEdge(id,placement.edge as DockEdge);else if(placement)dock(id,placement.target,placement.edge);onActivate?.(id);
      }
      setDragging(null);stopDocking();control?.onFinish(began||event.type==='pointercancel');
    },()=>{if(began)update(old=>({...old,tree:original.tree,rects:original.rects,floatingGroups:original.floatingGroups,autoHide:original.autoHide,autoHideActive:original.autoHideActive}));control?.onFinish(true);});
  }
  function prepareNativeFloat(id:string,rect=currentRect(id)){
    if(!lifecycle.homes.has(id))lifecycle.homes.set(id,{rect,placement:latest.current.autoHide?.[id]});
    update(old=>openNativePanel(isolateWorkspacePanel(old,id),id));
  }
  function nativeCallbacks(operation:PanelOperation,id:string,group?:FloatingGroup){
    return {onReady:()=>lifecycle.finish(operation,'succeeded'),onFailure:()=>{
      if(!lifecycle.isCurrent(operation))return;
      const members=lifecycle.members(operation).filter(member=>latest.current.open.includes(member));
      lifecycle.finish(operation,'failed');lifecycle.clear(members);
      const returning=group&&{...group,panels:members,active:members.includes(group.active)?group.active:members[0]};
      update(old=>returning&&members.length>1?placeWorkspaceGroup(old,returning,PRIMARY_EDITOR,'right',currentRect(id)):members.reduce((next,member)=>openDockedPanel(next,member,currentRect(member)),old));
    }};
  }
  function floatNativePanel(id:string){if(desktop.isComposing()||!canMovePanel(latest.current,id))return;prepareNativeFloat(id);lifecycle.queue(id);}
  function closePreservingAutoHide(id:string){
    if(id===PRIMARY_EDITOR)return;
    if(latest.current.autoHide?.[id])return hide(id,true);
    const rect=desktop.rect(id)||lifecycle.homes.get(id)?.rect||currentRect(id,true);
    return transition('close',[id],()=>update(old=>closeWorkspacePanelPreservingAutoHide(old,id,rect)));
  }
  function returnNativePanel(id:string){
    const entry=nativeGroupEntry(id),group=entry?.[1],members=desktop.members(id)||group?.panels||[id],rect=desktop.rect(id)||desktop.lastRect(id)||currentRect(id);
    return transition('dock',members,()=>update(old=>group?returnNativeGroup(old,group,rect):members.reduce((next,member)=>openDockedPanel(next,member,currentRect(member)),old)))==='succeeded';
  }
  function beginTabDrag(id:string,event:PointerEvent<HTMLElement>,control?:DragControl){
    if(event.button!==0||!event.isPrimary)return;
    if(event.currentTarget.ownerDocument!==document&&(desktop.members(id)?.length||0)<2){desktop.beginDrag(id,event);return;}
    if((isEditorPanel(id)?!canDetachDocumentTab(latest.current,id):!canMovePanel(latest.current,id))||desktop.isComposing())return;
    if(desktop.enabled)beginNativeDrag(id,event,control);else beginDrag(id,event,control);
  }
  function prepareNativeGroup(group:FloatingGroup,rect:Rect){
    lifecycle.groups.set(group.id,group);
    for(const id of group.panels)lifecycle.homes.set(id,{rect,placement:latest.current.autoHide?.[id]});
  }
  function nativeGroupEntry(id:string){
    const members=desktop.members(id);
    const saved=latest.current.floatingGroups.find(group=>group.panels.includes(id));
    if(saved&&members&&members.length>1)return [saved.id,pruneFloatingGroup(saved,saved.panels.filter(member=>members.includes(member)),desktop.panelForHost(desktop.owner(id)))] as const;
    const entry=[...lifecycle.groups.entries()].find(([,group])=>group.panels.includes(id)||members?.some(member=>group.panels.includes(member)));
    if(!entry)return;
    return [entry[0],members?pruneFloatingGroup(entry[1],entry[1].panels.filter(member=>members.includes(member)),desktop.panelForHost(desktop.owner(id))):entry[1]] as const;
  }
  function beginNativeDrag(id:string,event:PointerEvent<HTMLElement>,control?:DragControl,nativeGroup?:FloatingGroup){
    if(desktop.isComposing())return;
    const sourceWindow=event.currentTarget.ownerDocument.defaultView!,fromNative=sourceWindow!==window;
    const offset={x:sourceWindow.screenX-window.screenX,y:sourceWindow.screenY-window.screenY},origin={x:event.clientX+offset.x,y:event.clientY+offset.y};
    const original=latest.current,start=fromNative?(desktop.rect(id)||currentRect(id)):currentRect(id,control?.fromTab),home=lifecycle.homes.get(id),sourceGroup=fromNative?nativeGroupEntry(id):undefined,sourceHost=fromNative?desktop.owner(id):'';
    const intent=new DockIntent();let last={...origin,free:event.altKey},movingHost=id;
    const handoff=new NativeDragHandoff(start,origin);let began=false,transfer:ReturnType<typeof desktop.extract>=null,operation:PanelOperation|undefined;
    const restore=()=>{
      if(operation&&!lifecycle.isCurrent(operation))return;
      if(operation)lifecycle.finish(operation,'cancelled');
      lifecycle.handoffs.delete(id);lifecycle.pendingOpen.delete(id);
      const restored=transfer?transfer.restore():desktop.attach(id);
      for(const member of nativeGroup?.panels||[id])lifecycle.homes.delete(member);if(nativeGroup)lifecycle.groups.delete(nativeGroup.id);
      if(sourceGroup){
        if(restored){lifecycle.groups.set(sourceGroup[0],sourceGroup[1]);if(home)lifecycle.homes.set(id,home);}
        else{lifecycle.groups.delete(sourceGroup[0]);sourceGroup[1].panels.forEach(member=>lifecycle.homes.delete(member));}
      }else if(home)lifecycle.homes.set(id,home);
      update(()=>sourceGroup&&!restored?returnNativeGroup(original,sourceGroup[1],start):original);
    };
    track(event,(dx,dy,e)=>{
      last={x:origin.x+dx,y:origin.y+dy,free:e.altKey};handoff.move(last);
      if(!began&&Math.hypot(dx,dy)<5)return;
      if(!began){
        if(fromNative){lifecycle.handoffs.add(id);transfer=desktop.extract(id);if(!transfer){lifecycle.handoffs.delete(id);cleanup.current?.();return;}
          if(sourceGroup){const panels=sourceGroup[1].panels.filter(member=>member!==id),active=desktop.panelForHost(sourceHost);if(panels.length>1)lifecycle.groups.set(sourceGroup[0],pruneFloatingGroup(sourceGroup[1],panels,active));else lifecycle.groups.delete(sourceGroup[0]);}
        }
        began=true;operation=lifecycle.begin('drag',nativeGroup?.panels||[id]);for(const member of operation.members)lifecycle.handoffs.add(member);control?.onStart?.();if(nativeGroup){prepareNativeGroup(nativeGroup,start);update(old=>({...old}));}else prepareNativeFloat(id,start);
        const options={rect:()=>handoff.placement(),inactive:true,tabDrag:beginTabDrag,onReady:()=>{
          if(!operation||!lifecycle.isCurrent(operation))return;
          for(const member of operation.members)lifecycle.handoffs.delete(member);movingHost=desktop.owner(id);
          if(handoff.phase==='cancelled')return;
          if(handoff.phase==='ended'){onActivate?.(id);const scene=dockingScene(id),rail=last.free||scene.locked?null:railDropAt(last,scene.bounds,scene.viewport.width),guide=rail?null:intent.step(last,scene).ready;commitNativeDrop(id,guide,rail);if(operation)lifecycle.finish(operation,'succeeded');return;}
          if(handoff.ready()&&!window.hiveDesktop?.panelDrag(movingHost,'start',undefined,last.free)){handoff.cancel();const cancel=cleanup.current;if(cancel)cancel();else restore();}
        },onFailure:()=>{if(!operation||!lifecycle.isCurrent(operation))return;handoff.cancel();const cancel=cleanup.current;if(cancel)cancel();else restore();}};
        if(nativeGroup)desktop.detachGroup(id,nativeGroup.panels,open,options);else desktop.detach(id,options);
      }else if(handoff.phase==='dragging')window.hiveDesktop?.panelDrag(movingHost,'move',undefined,last.free);
    },e=>{
      last={x:e.clientX+offset.x,y:e.clientY+offset.y,free:e.altKey};handoff.move(last);const active=handoff.phase==='dragging';handoff.end();
      if(active){window.hiveDesktop?.panelDrag(movingHost,'end',undefined,last.free);if(operation)lifecycle.finish(operation,'succeeded');onActivate?.(id);}
      control?.onFinish(began);
    },()=>{
      const active=handoff.phase==='dragging';handoff.cancel();
      if(active)window.hiveDesktop?.panelDrag(movingHost,'cancel');
      if(began)restore();control?.onFinish(true);
    },e=>{if(e.key==='Alt'){last.free=e.altKey;if(handoff.phase==='dragging')window.hiveDesktop?.panelDrag(movingHost,'move',undefined,last.free);}});
  }
  function groupFloat(id:string){const group=groupFor(id);if(!group||group.panels.some(member=>!canMovePanel(latest.current,member)))return;const rect=currentRect(id,true);return transition('float',group.panels,()=>{update(old=>floatWorkspaceGroup(old,group,rect));raise(id);});}
  function groupDock(id:string){const group=groupFor(id)||nativeGroupEntry(id)?.[1];if(!group||group.panels.includes(PRIMARY_EDITOR)||group.panels.some(member=>!canPlacePanel(latest.current,member,PRIMARY_EDITOR,'right')))return;const rect=currentRect(id,true);return transition('dock',group.panels,()=>update(old=>placeWorkspaceGroup(old,group,PRIMARY_EDITOR,'right',rect)));}
  function beginGroupDrag(id:string,event:PointerEvent<HTMLElement>,control?:DragControl){
    if(control?.fromTab&&!isEditorPanel(id)){beginTabDrag(id,event,control);return;}
    const group=groupFor(id);if(!group||event.button!==0)return;
    const original=latest.current;
    if(group.panels.some(member=>!canMovePanel(original,member)))return;
    if(desktop.enabled){beginNativeDrag(id,event,control,{...group,active:id});return;}
    const start=currentRect(id,true);let began=false;raise(id);
    track(event,(dx,dy,e)=>{
      if(!began&&Math.hypot(dx,dy)<5)return;
      if(!began){began=true;control?.onStart?.();setDragging(id);}
      const rect=fit({...start,x:start.x+dx,y:start.y+dy},id);
      update(old=>floatWorkspaceGroup(old,group,rect));
      if(dragIntent.current)dragIntent.current.point={x:e.clientX,y:e.clientY,free:e.altKey};
      if(!dragIntent.current)startDocking(id,e);else tickDocking();
    },event=>{
      if(began&&event.type==='pointerup'){
        const placement=dragIntent.current?.intent.step({x:event.clientX,y:event.clientY,free:event.altKey},dockingScene(id)).ready;
        if(placement&&!group.panels.includes(placement.target||'')&&group.panels.every(member=>canPlacePanel(latest.current,member,placement.target||'',placement.edge))){
          update(old=>placeWorkspaceGroup(old,group,placement.target||'',placement.edge,currentRect(id,true),placement.scope==='workspace'));
        }
      }
      setDragging(null);stopDocking();control?.onFinish(began||event.type==='pointercancel');
    },()=>{if(began)update(()=>original);control?.onFinish(true);});
  }
  function resize(id:string,event:PointerEvent<HTMLElement>,edge:string){
    if(event.currentTarget.ownerDocument!==document){desktop.beginDrag(id,event,edge);return;}
    if(event.button!==0)return;
    event.stopPropagation();const start=currentRect(id,true),original=latest.current,startTree=original.tree,docked=dockedPanels(startTree).includes(id),edgeMap=dockResizeEdges(startTree,id);
    const autoHide=original.autoHide?.[id];
    if(!isFreelyMovableTool(original,id)&&(isPanelPositionLocked(original,id)||original.locked&&docked))return;
    if(autoHide){
      track(event,(dx,dy)=>{
        const width=Math.max(120,Math.min(boundsRef.current.width,start.width+(edge==='w'?-dx:edge==='e'?dx:0)));
        const height=Math.max(80,Math.min(boundsRef.current.height,start.height+(edge==='n'?-dy:edge==='s'?dy:0)));
        update(old=>({...old,autoHide:{...old.autoHide,[id]:{...autoHide,rect:{...autoHide.rect,width,height}}},rects:{...old.rects,[id]:{...autoHide.rect,width,height}}}));
      },undefined,()=>update(old=>({...old,autoHide:original.autoHide,rects:original.rects})));return;
    }
    const group=original.floatingGroups.find(value=>value.panels.includes(id)),key=group?.id||id,requested:string[]=[];
    if(edge.includes('w'))requested.push('left');if(edge.includes('e'))requested.push('right');if(edge.includes('n'))requested.push('top');if(edge.includes('s'))requested.push('bottom');
    const dividers=measureDockTree(startTree,{x:0,y:0,width:bounds.width,height:bounds.height}).dividers,plans=requested.map(value=>dividers.find(divider=>divider.id===edgeMap?.[value as keyof typeof edgeMap]));
    if(docked&&plans.some(divider=>divider&&!canResizeSplit(original,divider.id)))return;
    if(docked&&!plans.some(Boolean))return;
    raise(id);
    const resizeDocked=docked;
    track(event,(dx,dy)=>{
      if(Math.hypot(dx,dy)<2)return;
      if(resizeDocked){let tree=startTree;for(const divider of plans){if(!divider)continue;const extent=(divider.axis==='x'?divider.parent.width:divider.parent.height)-5;tree=resizeDockSplit(tree,divider.id,divider.ratio+(divider.axis==='x'?dx:dy)/Math.max(1,extent));}update(old=>({...old,tree}));return;}
      const rect=fit(resizeFloatingRect(start,edge,dx,dy,viewport()),id);
      update(old=>({...old,rects:{...old.rects,[key]:rect}}));
    },undefined,()=>update(old=>({...old,tree:original.tree,rects:original.rects,floatingGroups:original.floatingGroups})));
  }
  function handles(id:string){if(!desktop.windows.has(id)&&!isFreelyMovableTool(layout,id)&&(isPanelPositionLocked(layout,id)||layout.locked&&dockedPanels(layout.tree).includes(id)))return null;const hidden=desktop.windows.has(id)?undefined:layout.autoHide?.[id];const edges=hidden?[({left:'e',right:'w',top:'s',bottom:'n'} as const)[hidden.edge]]:['n','s','e','w','ne','nw','se','sw'];return <>{edges.map(edge=><div key={edge} data-resize-edge={edge} className={'panel-resize panel-resize-'+edge} aria-label={`调整面板大小 ${edge}`} onPointerDown={event=>resize(id,event,edge)}/>)}</>;}
  function panel(id:string){
    const autoHide=layout.autoHide?.[id],peek=!!autoHide&&isExpandedAutoHidePanel(layout,id);
    const group=groupFor(id),floating=!measurements.panels[id]&&!autoHide,frame=peek?autoHidePanelRect(autoHide!,bounds,iconAnchors.current.get(id)):group?.rect||measurements.panels[id]||fit(layout.rects[id]||suggestedRect(id),id);
    const rect=group?{...frame,y:frame.y+headerHeight,height:Math.max(0,frame.height-headerHeight)}:frame;
    const style:CSSProperties={position:floating||peek?'fixed':'absolute',left:rect.x,top:rect.y,width:rect.width,height:rect.height,minWidth:0,minHeight:0,flex:'none',display:layout.open.includes(id)&&(!group||group.active===id)&&!detachedIds.has(id)?undefined:'none',zIndex:peek||floating?layout.layers[group?.id||id]||panelLayers.floating:raisedDocked===id?raisedDockedLayer:panelLayers.docked,boxShadow:peek?'var(--hive-popup-shadow)':undefined,borderTopLeftRadius:group?0:undefined,borderTopRightRadius:group?0:undefined};
    return {ref:refFor(id),visible:style.display!=='none',floating,movable:canMovePanel(layout,id),primary:id===PRIMARY_EDITOR,positionLocked:isPanelPositionLocked(layout,id),lockHint:isPanelPositionLocked(layout,id)?((isFreelyMovableTool(layout,id)?"停靠位置已锁定，浮窗可移动和缩放 · ":"位置已锁定 · ")+(lockGesture==="longPress"?"长按":"双击")+"标题栏解锁"):(lockGesture==="longPress"?"长按标题栏锁定位置":"双击标题栏锁定位置"),canDock:!layout.locked&&!isPanelPositionLocked(layout,id)&&id!==PRIMARY_EDITOR,autoHidden:!!autoHide,collapseEdge:autoHide?.edge||nearestPanelEdge({...frame,x:frame.x+(floating?0:bounds.x),y:frame.y+(floating?0:bounds.y)},bounds,!floating),grouped:!!group,style,raise:()=>raise(id),beginDrag:(event:PointerEvent<HTMLElement>,control?:DragControl)=>beginDrag(id,event,control),toggleFloat:()=>toggleFloat(id),floatAt:(rect:Rect)=>floatAt(id,rect),openDocked:()=>openDocked(id),openFloating:()=>floatAt(id,fit(latest.current.rects[id]||suggestedRect(id),id)),dock:()=>dock(id),dockAtEdge:(edge:DockEdge)=>dockAtEdge(id,edge),close:()=>hide(id,false),minimize:()=>hide(id,true),handles:group?null:handles(id),groupHandles:group?handles(id):null};
  }
  const chrome=<>
    {measurements.dividers.map(divider=><div key={divider.id} className={'workspace-divider axis-'+divider.axis+(!canResizeSplit(layout,divider.id)?' layout-locked':'')} role="separator" aria-disabled={!canResizeSplit(layout,divider.id)} tabIndex={canResizeSplit(layout,divider.id)?0:-1} aria-label={divider.axis==='x'?'调整左右面板比例':'调整上下面板比例'} aria-orientation={divider.axis==='x'?'vertical':'horizontal'} aria-valuenow={Math.round(divider.ratio*100)} aria-valuemin={12} aria-valuemax={88} style={{left:divider.rect.x,top:divider.rect.y,width:divider.rect.width,height:divider.rect.height}}
      onKeyDown={event=>{if(!canResizeSplit(latest.current,divider.id))return;const keys=divider.axis==='x'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];if(keys.includes(event.key)){event.preventDefault();update(old=>({...old,tree:resizeDockSplit(old.tree,divider.id,divider.ratio+(event.key===keys[0]?-.02:.02))}));}}}
      onPointerDown={event=>{if(!canResizeSplit(latest.current,divider.id))return;event.stopPropagation();const original=latest.current.tree;track(event,(dx,dy)=>{const extent=(divider.axis==='x'?divider.parent.width:divider.parent.height)-5;update(old=>({...old,tree:resizeDockSplit(old.tree,divider.id,divider.ratio+(divider.axis==='x'?dx:dy)/Math.max(1,extent))}));},undefined,()=>update(old=>({...old,tree:original})));}}/>)}
    {dragging&&createPortal(<DockGuides feedback={dockFeedback} free={!!dragIntent.current?.point.free} locked={!!layout.locked}
      label={dockFeedback?.target?refFor(dockFeedback.target.id).current?.getAttribute('aria-label')||'目标面板':''}
      draggedLabel={refFor(dragging).current?.getAttribute('aria-label')||'面板'}
      tabs={(tabGroups.find(group=>group.panels.includes(dockFeedback?.target?.id||''))?.panels.filter(id=>id!==dragging)||[dockFeedback?.target?.id||'']).map(id=>refFor(id).current?.getAttribute('aria-label')||'目标面板')}/>,document.body)}
  </>;
  function captureLayout(){
    const snapshot=structuredClone(latest.current);
    for(const group of snapshot.floatingGroups){
      const rect=desktop.rect(group.active);if(rect)snapshot.rects[group.id]=rect;
    }
    return snapshot;
  }
  return {panel,beginTabDrag,beginGroupDrag,groupFloat,groupDock,prepareNativeFloat,floatNativePanel,returnNativePanel,canPullRail:(edge:'left'|'right')=>canDockAutoHideRail(layout,edge),dockAutoHideRail:pullAutoHideRail,closePreservingAutoHide,open,reveal,splitEditor,openDocumentTab,isPositionLocked:(id:string)=>isPanelPositionLocked(layout,id),togglePositionLock,locked:!!layout.locked,toggleLocked:()=>{cleanup.current?.();stopDocking();update(old=>({...old,locked:!old.locked}));},close:(id:string)=>hide(id,false),minimize:(id:string)=>hide(id,true),toggle:(id:string)=>layout.open.includes(id)?hide(id,false):open(id),isOpen:(id:string)=>layout.open.includes(id),chrome,
    capture:captureLayout,
    capturePlacement:():PanelWorkspacePlacement=>{
      const snapshot=captureLayout(),grouped=new Set(snapshot.floatingGroups.flatMap(group=>group.panels));
      for(const id of desktop.windows.keys()){
        if(grouped.has(id)||!snapshot.open.includes(id))continue;
        const rect=desktop.rect(id);
        if(!rect)continue;
        snapshot.rects[id]=rect;
        if(snapshot.autoHide?.[id])snapshot.autoHide[id]={...snapshot.autoHide[id],rect};
      }
      return {layout:snapshot,bounds:boundsRef.current};
    },
    restoreLayout:(saved:WorkspaceLayout)=>{
      if(latest.current.locked)throw new Error('请先解锁工作区位置，再应用其他视图。');
      cleanup.current?.();setDragging(null);stopDocking();iconAnchors.current.clear();
      const next=structuredClone(saved),nativeGroups=new Set(desktop.enabled?next.floatingGroups.map(group=>group.id):[]);
      next.rects=Object.fromEntries(Object.entries(next.rects).map(([id,rect])=>[id,nativeGroups.has(id)?rect:fit(rect,id,next)]));
      const ids=[...new Set([...latest.current.open,...desktop.windows.keys(),...lifecycle.homes.keys()])];
      const result=transition('restore',ids,()=>{lifecycle.reset();previousNativeWindows.current.clear();const normalized=normalize(next,boundsRef.current);latest.current=normalized;setLayout(normalized);});
      if(result!=='succeeded')throw new Error('请先完成当前窗口操作或输入法组词，再应用视图。');
    },
    reset:()=>{if(latest.current.locked)return;cleanup.current?.();return transition('restore',[...new Set([...latest.current.open,...desktop.windows.keys(),...lifecycle.homes.keys()])],()=>{lifecycle.reset();previousNativeWindows.current.clear();update(()=>defaultWorkspace());});},openIds:layout.open,minimizedIds:layout.minimized,toggleAutoHide,repositionAutoHide,openDocked,autoHideItems:Object.entries(layout.autoHide||{}).map(([id,placement])=>({id,edge:placement.edge,offset:placement.offset,active:isExpandedAutoHidePanel(layout,id)||desktop.enabled&&(desktop.windows.has(id)||lifecycle.opening(id))&&layout.open.includes(id)})),tabGroups:tabGroups.map(group=>({...group,style:{position:group.floating?'fixed':'absolute',left:group.rect.x,top:group.rect.y,width:group.rect.width,height:group.rect.height,zIndex:group.floating?(layout.layers[group.id]||panelLayers.floating)+1:raisedDocked===group.active?raisedDockedLayer+1:panelLayers.tabs} as CSSProperties}))};
}
