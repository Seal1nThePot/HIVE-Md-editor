import {isImagePath} from './fileKinds';
import {REFERENCE_DRAG_TYPE,referenceDragData,readReferenceDrag} from './referenceDrag';
import {usePanelDocument} from '../../shared/panelDocument';
import {Fragment,useEffect,useMemo,useRef,useState,type Dispatch,type SetStateAction} from 'react';
import {createPortal} from 'react-dom';
import {ArrowDownWideNarrow,Check,ChevronDown,ChevronRight,FileImage,Folder,Icon,MoreHorizontal,Search,Sparkles,Upload,X,type IconName} from "../../shared/icons";
import {explorerView,flattenEntries,mapEntryPath,parentPath,readOrder,remapOrder,reorderEntry,sortEntries,sortDirection,menuActions,independentEntries,selectRange,describeBatchResults,describePreflightFailure,type BatchItemResult,type Entry,type ExplorerOrder,type SortMode,type SortDirection} from './explorerState';
import {useShortcutPreferences} from '../settings/ShortcutPreferences';
import {matchesShortcut,shortcutLabel} from '../settings/shortcuts';
import './file-explorer.css';
import ImageLibrary from './ImageLibrary';
import type {WorkspaceReferenceSource} from '../chat/referenceSources';
import {useFileWorkspace} from './WorkspaceContext';
import {pastedDocumentPath} from './localDocumentPath';

export type FileAction={action:string;path?:string;parent?:string;name?:string;type?:'file'|'folder';id?:string};
export type FileResult={path:string;from?:string;type:'file'|'folder';id?:string;deletedAt?:string;warning?:string};
type ReferenceDestination='basis'|'chat';
type Props={entries:Entry[];workspaceId:string;root:string;file:string;dirty:boolean;filter:string;setFilter:(value:string)=>void;collapsed:Set<string>;setCollapsed:Dispatch<SetStateAction<Set<string>>>;
  onFolderVisit?:(path:string)=>void;onRefresh?:()=>Promise<void>;onReferenceDrop?:(source:WorkspaceReferenceSource,destination:ReferenceDestination)=>void;onOpen:(path:string,newTab?:boolean)=>Promise<void>;onOpenPath?:(path:string)=>Promise<void>;onAction:(action:FileAction,options?:{quiet?:boolean})=>Promise<FileResult>;onPreflight?:(actions:FileAction[])=>Promise<void>;onReferenceBatch?:(sources:WorkspaceReferenceSource[])=>Promise<{path:string;ok:boolean;error?:string;warning?:string}[]>;onAI:(path:string)=>void;onOpenRepositories?:()=>void;treeReady?:boolean;renameRequest?:{path:string;key:string}};
type Menu={x:number;y:number;entry?:Entry;sort?:boolean;more?:boolean};
type Drop={path:string;where:'before'|'after'|'inside'};
function sortIcon(mode:SortMode,direction:SortDirection):IconName {
  if(mode==='manual')return 'file.sortManual';
  if(mode==='name')return direction==='asc'?'file.sortAToZ':'file.sortZToA';
  return direction==='asc'?'file.sortOldest':'file.sortNewest';
}
export default function FileExplorer({entries,workspaceId,root,file,dirty,filter,setFilter,collapsed,setCollapsed,onOpen,onOpenPath,onAction,onAI,renameRequest,onReferenceDrop,onRefresh,onPreflight,onReferenceBatch,onOpenRepositories,onFolderVisit,treeReady=true}:Props){
  const {bindings}=useShortcutPreferences();
  const document=usePanelDocument(),window=document.defaultView!;
  const storage='hive.explorer.v1:'+workspaceId;
  const space=useFileWorkspace();
  const pastedPath=onOpenPath&&pastedDocumentPath(filter);
  const referenceDrop=useRef(onReferenceDrop);referenceDrop.current=onReferenceDrop;
  const [externalDrop,setExternalDrop]=useState(false),[importStatus,setImportStatus]=useState(''),[imageRevision,setImageRevision]=useState(0);
  const [imagesOpen,setImagesOpen]=useState(false);
  const [searchExpanded,setSearchExpanded]=useState(()=>!!filter),searchButton=useRef<HTMLButtonElement>(null);
  function openSearch(){setSearchExpanded(true);window.requestAnimationFrame(()=>search.current?.focus());}
  function closeSearch(){setFilter('');setSearchExpanded(false);window.requestAnimationFrame(()=>searchButton.current?.focus());}
  const [searchResult,setSearchResult]=useState<{scope:string;query:string;matches:{path:string;line:number|null;excerpt:string}[];truncated:boolean}|null>(null),[searching,setSearching]=useState(false);

  const [order,setOrder]=useState<ExplorerOrder>(()=>{try{return readOrder(localStorage.getItem(storage));}catch{return readOrder(null);}});
  const [selected,setSelected]=useState(''),[scope,setScope]=useState(''),[menu,setMenu]=useState<Menu|null>(null),[rename,setRename]=useState<{path:string;value:string}|null>(null),[pendingOperation,setOperation]=useState<'open'|'manage'|null>(null),[error,setError]=useState(''),[warning,setWarning]=useState('');
  useEffect(()=>{if(filter)setSearchExpanded(true);},[filter]);
  const busy=pendingOperation!==null;
  const [selection,setSelection]=useState<Set<string>>(new Set()),anchor=useRef(''),[batch,setBatch]=useState<{kind:'move'|'trash';entries:Entry[]}|null>(null),[batchResult,setBatchResult]=useState<string[]>([]);
  const foldersSeen=useRef<{workspace:string;paths:Set<string>}>({workspace:workspaceId,paths:new Set()});
  const [move,setMove]=useState<Entry|null>(null),[moveParent,setMoveParent]=useState(''),[deleting,setDeleting]=useState<Entry|null>(null),[drop,setDrop]=useState<Drop|null>(null);
  useEffect(()=>{
    if(!scope||!filter.trim()||pastedPath){setSearchResult(null);setSearching(false);return;}
    const controller=new AbortController();let alive=true;setSearching(true);
    const timer=setTimeout(()=>{void space.request('/api/explorer/search?folder='+encodeURIComponent(scope)+'&query='+encodeURIComponent(filter),{signal:controller.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);if(alive)setSearchResult({...data,scope,query:filter});}).catch(error=>{if(alive&&error.name!=='AbortError')setError(error.message);}).finally(()=>{if(alive)setSearching(false);});},250);
    return()=>{alive=false;clearTimeout(timer);controller.abort();};
  },[scope,filter,pastedPath,space.request,entries]);
  const importInput=useRef<HTMLInputElement>(null),importLease=useRef<AbortController|null>(null),currentWorkspace=useRef(workspaceId);
  const workspaceEpoch=useRef(0);if(currentWorkspace.current!==workspaceId){currentWorkspace.current=workspaceId;workspaceEpoch.current++;}
  useEffect(()=>{setOperation(null);setSelected('');setSelection(new Set());anchor.current='';setBatch(null);setMove(null);setDeleting(null);setBatchResult([]);setError('');setWarning('');setImagesOpen(false);setMenu(null);return()=>{importLease.current?.abort();importLease.current=null;};},[workspaceId]);
  useEffect(()=>{
    const prevent=(event:DragEvent)=>{if(Array.from(event.dataTransfer?.types||[]).includes('Files'))event.preventDefault();};
    const clear=()=>setExternalDrop(false);
    window.addEventListener('dragover',prevent);window.addEventListener('drop',prevent);window.addEventListener('drop',clear);window.addEventListener('blur',clear);
    return()=>{window.removeEventListener('dragover',prevent);window.removeEventListener('drop',prevent);window.removeEventListener('drop',clear);window.removeEventListener('blur',clear);};
  },[window]);
  async function importDropped(sources:File[],destination=focused?.type==='folder'?focused.path:focused?parentPath(focused.path):scope){
    if(importLease.current||busy){setImportStatus('文件操作进行中，请稍后重试。');return;}
    if(!sources.length){setImportStatus('未取得文件，请拖入文件而不是文件夹。');return;}
    const lease=new AbortController();importLease.current=lease;
    const valid=()=>importLease.current===lease&&!lease.signal.aborted&&currentWorkspace.current===workspaceId;
    setOperation('manage');setImportStatus('正在导入…');const ok:string[]=[],failed:string[]=[];
    try{
      for(const source of sources){
        if(!valid())return;
        try{
          if(source.size>12*1024*1024)throw new Error('文件超过 12 MB。');
          const response=await space.request('/api/import?name='+encodeURIComponent(source.name)+'&parent='+encodeURIComponent(destination),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:source,signal:lease.signal});
          const result=await response.json();if(!valid())return;if(!response.ok)throw new Error(result.error||'导入失败。');ok.push(result.path);
        }catch(error){if(!valid())return;failed.push(source.name+'：'+(error as Error).message);}
      }
      if(!valid())return;
      let refreshError='';try{await onRefresh?.();if(valid())setImageRevision(value=>value+1);}catch(error){refreshError='列表刷新失败：'+(error as Error).message;}
      if(!valid())return;
      setFilter('');setScope('');setImportStatus([ok.length?'已导入 '+ok.length+' 个：'+ok.join('、'):'',failed.length?'未导入 '+failed.length+' 个：'+failed.join('；'):'',refreshError].filter(Boolean).join('。'));
    }finally{if(valid()){importLease.current=null;setOperation(null);}}
  }
  const container=useRef<HTMLDivElement>(null),menuRef=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null),drag=useRef<string|null>(null),renaming=useRef(false),cancelRename=useRef(false);
  const skipClick=useRef(false),dragCleanup=useRef<(()=>void)|null>(null);
  useEffect(()=>()=>dragCleanup.current?.(),[document]);
  const all=useMemo(()=>flattenEntries(entries),[entries]);
  const byPath=useMemo(()=>new Map(all.map(entry=>[entry.path,entry])),[all]),focused=byPath.get(selected);
  if(foldersSeen.current.workspace!==workspaceId)foldersSeen.current={workspace:workspaceId,paths:new Set()};
  const newFolders=useMemo(()=>all.filter(item=>item.type==='folder'&&!foldersSeen.current.paths.has(item.path)).map(item=>item.path),[all,workspaceId,collapsed]);
  const effectiveCollapsed=useMemo(()=>newFolders.length?new Set([...collapsed,...newFolders]):collapsed,[collapsed,newFolders]);
  useEffect(()=>{const pending=newFolders.filter(path=>!foldersSeen.current.paths.has(path));if(!pending.length)return;pending.forEach(path=>foldersSeen.current.paths.add(path));setCollapsed(old=>new Set([...old,...pending]));},[entries,workspaceId,setCollapsed]);
  function store(next:ExplorerOrder){setOrder(next);try{localStorage.setItem(storage,JSON.stringify(next));}catch{setError('排序已生效，但无法保存在此浏览器中。');}}
  function expand(path:string){const parts=path.split('/');for(let i=1;i<=parts.length;i++)foldersSeen.current.paths.add(parts.slice(0,i).join('/'));setCollapsed(old=>new Set([...old].filter(value=>path!==value&&!path.startsWith(value+'/'))));}
  async function run<T>(fn:()=>Promise<T>,kind:'open'|'manage'='manage'):Promise<T|undefined>{if(busy)return;const owner=workspaceId,epoch=workspaceEpoch.current;setOperation(kind);setError('');try{const result=await fn();if(currentWorkspace.current!==owner||workspaceEpoch.current!==epoch)return undefined;if(result&&typeof result==='object'&&'warning' in result&&typeof result.warning==='string')setWarning(result.warning);return result;}catch(error){if(currentWorkspace.current===owner&&workspaceEpoch.current===epoch)setError((error as Error).message);}finally{if(currentWorkspace.current===owner&&workspaceEpoch.current===epoch)setOperation(null);}}
  function beginRename(entry:Entry){cancelRename.current=false;setRename({path:entry.path,value:entry.name});setSelected(entry.path);expand(entry.path);}
  useEffect(()=>{if(!renameRequest)return;setFilter('');setScope('');beginRename({path:renameRequest.path,name:renameRequest.path.split('/').at(-1)!,type:'file'});},[renameRequest?.key]);
  async function commitRename(){if(!rename||renaming.current||cancelRename.current)return;const current=rename;renaming.current=true;
    if(!current.value.trim()){setError('名称不能为空。');renaming.current=false;return;}
    if(current.value===byPath.get(current.path)?.name){setRename(null);renaming.current=false;return;}
    const result=await run(()=>onAction({action:'rename',path:current.path,name:current.value.trim()}));
    if(result){store(remapOrder(order,current.path,result.path));setSelected(result.path);setRename(null);if(scope) setScope(mapEntryPath(scope,current.path,result.path));window.requestAnimationFrame(()=>container.current?.querySelector<HTMLElement>('[data-selected="true"]')?.focus());}
    renaming.current=false;
  }
  async function create(type:'file'|'folder',parent=focused?.type==='folder'?focused.path:focused?parentPath(focused.path):scope){
    const result=await run(()=>onAction({action:'create',parent,type}));if(!result)return;
    expand(result.path);setFilter('');setScope('');
    if(type==='file')await run(()=>onOpen(result.path,true),'open');
    beginRename({name:result.path.split('/').at(-1)!,path:result.path,type});
  }
  async function operation(action:string,entry:Entry){setMenu(null);
    if(action==='rename'){beginRename(entry);return;}
    if(action==='move'){if(selection.size>1&&selection.has(entry.path)){startBatch('move');return;}setMove(entry);setMoveParent(parentPath(entry.path));return;}
    if(action==='trash'){if(selection.size>1&&selection.has(entry.path)){startBatch('trash');return;}setDeleting(entry);return;}
    if(action==='search'){setScope(entry.path);setFilter('');expand(entry.path);openSearch();return;}
    if(action==='ai'){if(isImagePath(entry.path)){setError('图片用于查看或插入正文，文字依据请选择 Markdown。');return;}if(selection.size>1&&selection.has(entry.path))void referenceBatch();else onAI(entry.path);return;}
    if(action==='copy'){await run(()=>navigator.clipboard.writeText(root.replace(/[\\/]$/,'')+'\\'+entry.path.replace(/\//g,'\\')));return;}
    if(action==='tab'){await run(()=>onOpen(entry.path,true),'open');return;}
    const result=await run(()=>onAction({action,path:entry.path}));if(result&&action==='duplicate')beginRename({name:result.path.split('/').at(-1)!,path:result.path,type:result.type});
  }
  useEffect(()=>{
    if(!menu)return;const box=menuRef.current;if(box){const rect=box.getBoundingClientRect();box.style.left=Math.max(6,Math.min(menu.x,window.innerWidth-rect.width-6))+'px';box.style.top=Math.max(6,Math.min(menu.y,window.innerHeight-rect.height-6))+'px';box.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();}
    const close=()=>setMenu(null);
    const outside=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node))close();};
    document.addEventListener('pointerdown',outside,true);window.addEventListener('blur',close);
    return()=>{document.removeEventListener('pointerdown',outside,true);window.removeEventListener('blur',close);};
  },[menu,document,window]);
  function closeMenu(){setMenu(null);window.requestAnimationFrame(()=>container.current?.querySelector<HTMLElement>('[data-selected="true"]')?.focus());}
  const currentResults=searchResult?.scope===scope&&searchResult.query===filter?searchResult:null;
  const resultByPath=useMemo(()=>currentResults?new Map(currentResults.matches.map(hit=>[hit.path,hit])):null,[currentResults]);
  const view=useMemo(()=>explorerView(entries,order,effectiveCollapsed,filter,scope,resultByPath?new Set(resultByPath.keys()):undefined),[entries,order,effectiveCollapsed,filter,scope,resultByPath]);
  const visiblePaths=view.paths;
  const visibleKey=useMemo(()=>visiblePaths.join('\0'),[visiblePaths]);
  useEffect(()=>{const visible=new Set(visiblePaths);setSelection(old=>{const next=new Set([...old].filter(path=>visible.has(path)));return next.size===old.size?old:next;});if(anchor.current&&!visible.has(anchor.current))anchor.current='';setSelected(old=>visible.has(old)?old:(visiblePaths[0]||''));},[visibleKey,workspaceId]);
  const chosen=useMemo(()=>all.filter(item=>selection.has(item.path)&&view.visible.has(item.path)),[all,selection,view]);
  const planned=independentEntries;
  function startBatch(kind:'move'|'trash'){if(!chosen.length)return;setBatch({kind,entries:chosen});setMoveParent('');setBatchResult([]);}
  async function executeBatch(){if(!batch||busy)return;const owner=workspaceId,epoch=workspaceEpoch.current,valid=()=>currentWorkspace.current===owner&&workspaceEpoch.current===epoch,items=planned(batch.entries);
    const acts:FileAction[]=items.map(item=>({action:batch.kind,path:item.path,...(batch.kind==='move'?{parent:moveParent}:{})}));
    setOperation('manage');setError('');setBatchResult([]);
    try{
      try{if(!onPreflight)throw new Error('批量操作检查不可用。');await onPreflight(acts);}catch(error){if(valid())setBatchResult(describePreflightFailure(batch.entries,(error as Error).message));return;}
      if(!valid())return;
      const results:BatchItemResult[]=[],succeeded:string[]=[];let nextOrder=order;
      for(let i=0;i<acts.length;i++){if(!valid())return;try{const result=await onAction(acts[i],{quiet:true});if(!valid())return;succeeded.push(items[i].path);if(batch.kind==='move')nextOrder=remapOrder(nextOrder,items[i].path,result.path);results.push({path:items[i].path,ok:true,warning:result.warning});}catch(error){if(!valid())return;results.push({path:items[i].path,ok:false,error:(error as Error).message});}}
      if(batch.kind==='move')store(nextOrder);if(batch.kind==='trash'&&succeeded.some(path=>scope===path||scope.startsWith(path+'/')))setScope('');setBatchResult(describeBatchResults(batch.entries,results));setSelection(new Set());
    }finally{if(valid())setOperation(null);}
  }
  async function referenceBatch(){if(!chosen.length||busy)return;const owner=workspaceId,epoch=workspaceEpoch.current,entries=chosen,items=planned(entries),valid=()=>currentWorkspace.current===owner&&workspaceEpoch.current===epoch;setOperation('manage');setError('');setBatchResult([]);
    try{
      try{if(!onPreflight||!onReferenceBatch)throw new Error('批量添加依据不可用。');await onPreflight(items.map(item=>({action:'basis',path:item.path})));}catch(error){if(valid())setBatchResult(describePreflightFailure(entries,(error as Error).message));return;}
      if(!valid())return;
      try{const results=await onReferenceBatch!(items.map(item=>({path:item.path,type:item.type})));if(valid())setBatchResult(describeBatchResults(entries,results));}catch(error){if(valid())setBatchResult(entries.map(item=>item.path+'：未取得结果：'+(error as Error).message));}
    }finally{if(valid())setOperation(null);}}
  async function dropAt(target:Drop){const source=drag.current;drag.current=null;setDrop(null);if(!source||source===target.path)return;
    const destination=target.where==='inside'?target.path:parentPath(target.path),name=source.split('/').at(-1)!,nextPath=[destination,name].filter(Boolean).join('/');
    if(destination===source||destination.startsWith(source+'/')){setError('不能把文件夹拖入自身。');return;}
    if(parentPath(source)!==destination){const result=await run(()=>onAction({action:'move',path:source,parent:destination}));if(!result)return;expand(result.path);}
    const siblings=sortEntries(destination?byPath.get(destination)?.children||[]:entries,order,destination).map(item=>item.path);
    let before=target.where==='before'?target.path:target.where==='after'?siblings[siblings.indexOf(target.path)+1]:undefined;
    if(before===source)before=siblings[siblings.indexOf(source)+1];
    store(reorderEntry(remapOrder(order,source,nextPath),siblings.map(value=>value===source?nextPath:value),nextPath,before));setSelected(nextPath);
  }
  function beginDrag(path:string,event:React.PointerEvent<HTMLElement>){
    if(event.button!==0||!event.isPrimary||busy||rename||(event.target as HTMLElement).closest('input,button'))return;
    dragCleanup.current?.();
    skipClick.current=false;
    const start={x:event.clientX,y:event.clientY},pointerId=event.pointerId,epoch=workspaceEpoch.current;
    const source=byPath.get(path);
    const canReference=!!source&&(source.type==='folder'||/\.md$/i.test(source.path));
    let started=false,highlighted:HTMLElement|undefined;
    function referenceAt(hit:Element|null):{target:HTMLElement;destination:ReferenceDestination}|undefined{
      if(!canReference||!referenceDrop.current)return;
      const target=hit?.closest<HTMLElement>('[data-reference-drop][data-reference-workspace]');
      if(!target||target.dataset.referenceWorkspace!==workspaceId)return;
      const destination=target.dataset.referenceDrop;
      if(destination==='basis'||destination==='chat')return {target,destination};
    }
    function treeDropAt(hit:Element|null,y:number):Drop|null {
      const row=hit?.closest<HTMLElement>('.explorer-row'),tree=container.current?.querySelector('.explorer-tree');
      if(!row||!container.current?.contains(row))return tree?.contains(hit)?{path:'',where:'inside'}:null;
      const rect=row.getBoundingClientRect(),ratio=(y-rect.y)/rect.height,targetPath=row.dataset.path!,folder=byPath.get(targetPath)?.type==='folder';
      return {path:targetPath,where:folder&&ratio>.25&&ratio<.75?'inside':ratio<.5?'before':'after'};
    }
    function highlight(target?:HTMLElement){
      if(highlighted===target)return;
      if(highlighted)delete highlighted.dataset.referencePointerActive;
      highlighted=target;
      if(highlighted)highlighted.dataset.referencePointerActive='';
    }
    function clean(){
      window.removeEventListener('pointermove',movePointer);
      window.removeEventListener('pointerup',finish);
      window.removeEventListener('pointercancel',cancelPointer);
      window.removeEventListener('keydown',key,true);
      window.removeEventListener('blur',cancel);
      highlight();
      dragCleanup.current=null;
    }
    function movePointer(next:PointerEvent){
      if(next.pointerId!==pointerId)return;
      if(!started&&Math.hypot(next.clientX-start.x,next.clientY-start.y)<5)return;
      started=true;skipClick.current=true;drag.current=path;next.preventDefault();
      const hit=document.elementFromPoint(next.clientX,next.clientY),reference=referenceAt(hit);
      highlight(reference?.target);
      if(reference){setDrop(null);return;}
      const tree=container.current?.querySelector('.explorer-tree');
      if(tree){
        const rect=tree.getBoundingClientRect();
        if(next.clientY<rect.y+20)tree.scrollTop-=12;
        else if(next.clientY>rect.bottom-20)tree.scrollTop+=12;
      }
      setDrop(treeDropAt(hit,next.clientY));
    }
    function cancel(){clean();drag.current=null;setDrop(null);}
    function cancelPointer(next:PointerEvent){if(next.pointerId===pointerId)cancel();}
    function key(next:KeyboardEvent){
      if(next.key==='Escape'&&started){next.preventDefault();next.stopImmediatePropagation();cancel();}
    }
    function finish(next:PointerEvent){
      if(next.pointerId!==pointerId)return;
      clean();
      if(!started)return;
      if(epoch!==workspaceEpoch.current){drag.current=null;setDrop(null);return;}
      const hit=document.elementFromPoint(next.clientX,next.clientY),reference=referenceAt(hit);
      const addReference=referenceDrop.current;
      if(reference&&source&&addReference){
        drag.current=null;setDrop(null);
        addReference({path:source.path,type:source.type},reference.destination);
        return;
      }
      const finalDrop=treeDropAt(hit,next.clientY);
      if(finalDrop)void dropAt(finalDrop);
      else{drag.current=null;setDrop(null);}
    }
    window.addEventListener('pointermove',movePointer,{passive:false});
    window.addEventListener('pointerup',finish);
    window.addEventListener('pointercancel',cancelPointer);
    window.addEventListener('keydown',key,true);
    window.addEventListener('blur',cancel);
    dragCleanup.current=cancel;
  }
  function row(items:Entry[],depth=0){return (items.length?view.rowsByParent.get(depth?parentPath(items[0].path):'')||[]:[]).map(entry=>{
    const hit=resultByPath?.get(entry.path);
    const folder=entry.type==='folder',open=!effectiveCollapsed.has(entry.path)||!!filter||!!scope,editing=rename?.path===entry.path;
    return <div key={entry.path} role="none"><div className={'explorer-row '+(file===entry.path?'active-file ':'')+(drop?.path===entry.path?'drop-'+drop.where:'')} role="treeitem" aria-level={depth+1} aria-selected={selection.has(entry.path)} aria-expanded={folder?open:undefined} data-path={entry.path} data-selected={selected===entry.path} title={entry.path+(hit?.line?'\n第 '+hit.line+' 行：'+hit.excerpt:'')} tabIndex={(view.visible.has(selected)?selected:visiblePaths[0])===entry.path?0:-1} draggable={!editing&&!busy&&!isImagePath(entry.path)} onDragStart={event=>{dragCleanup.current?.();drag.current=entry.path;event.dataTransfer.effectAllowed='copyMove';event.dataTransfer.setData(REFERENCE_DRAG_TYPE,referenceDragData(workspaceId,{path:entry.path,type:entry.type}));skipClick.current=true;}} onDragEnd={()=>{drag.current=null;setDrop(null);setTimeout(()=>{skipClick.current=false;},0);}}
      onDragOver={event=>{if(!Array.from(event.dataTransfer.types).includes(REFERENCE_DRAG_TYPE))return;event.preventDefault();event.stopPropagation();const rect=event.currentTarget.getBoundingClientRect(),ratio=(event.clientY-rect.y)/rect.height;setDrop({path:entry.path,where:folder&&ratio>.25&&ratio<.75?'inside':ratio<.5?'before':'after'});}}
      onDrop={event=>{if(!Array.from(event.dataTransfer.types).includes(REFERENCE_DRAG_TYPE))return;event.preventDefault();event.stopPropagation();const source=readReferenceDrag(event.dataTransfer.getData(REFERENCE_DRAG_TYPE),workspaceId);if(!source||!byPath.has(source.path))return;drag.current=source.path;const rect=event.currentTarget.getBoundingClientRect(),ratio=(event.clientY-rect.y)/rect.height;void dropAt({path:entry.path,where:folder&&ratio>.25&&ratio<.75?'inside':ratio<.5?'before':'after'});}}
      onPointerDown={event=>beginDrag(entry.path,event)}
      style={{paddingLeft:8+depth*16}} onFocus={()=>{if(!busy)setSelected(entry.path);}}
      onClick={event=>{if(busy||skipClick.current&&event.detail>0)return;setSelected(entry.path);if(editing)return;if(event.shiftKey){const start=visiblePaths.indexOf(anchor.current),end=visiblePaths.indexOf(entry.path);if(start>=0&&end>=0)setSelection(new Set(selectRange(visiblePaths,anchor.current,entry.path)));else{anchor.current=entry.path;setSelection(new Set([entry.path]));}return;}if(event.ctrlKey||event.metaKey){anchor.current=entry.path;setSelection(old=>{const next=new Set(old);if(next.has(entry.path))next.delete(entry.path);else next.add(entry.path);return next;});return;}anchor.current=entry.path;setSelection(new Set([entry.path]));if(folder){if(effectiveCollapsed.has(entry.path))onFolderVisit?.(entry.path);setCollapsed(old=>{const next=new Set(old);if(next.has(entry.path))next.delete(entry.path);else next.add(entry.path);return next;});}else void run(()=>onOpen(entry.path),'open');}}
      onContextMenu={event=>{event.preventDefault();event.stopPropagation();if(busy)return;setSelected(entry.path);if(!selection.has(entry.path)){setSelection(new Set([entry.path]));anchor.current=entry.path;}setMenu({x:event.clientX,y:event.clientY,entry});}}
      onKeyDown={event=>{if(editing||busy||event.nativeEvent.isComposing)return;if(event.key==='Enter'&&!event.ctrlKey&&!event.metaKey){event.preventDefault();event.currentTarget.click();}if(folder&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();if(event.key==='ArrowRight'&&effectiveCollapsed.has(entry.path))onFolderVisit?.(entry.path);setCollapsed(old=>{const next=new Set(old);if(event.key==='ArrowLeft')next.add(entry.path);else next.delete(entry.path);return next;});}if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const nodes=Array.from(container.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')||[]),index=nodes.indexOf(event.currentTarget),next=event.key==='Home'?0:event.key==='End'?nodes.length-1:Math.max(0,Math.min(nodes.length-1,index+(event.key==='ArrowDown'?1:-1)));if(event.shiftKey&&nodes[next]){if(!anchor.current||!visiblePaths.includes(anchor.current))anchor.current=entry.path;setSelection(new Set(selectRange(visiblePaths,anchor.current,nodes[next].dataset.path!)));}nodes[next]?.focus();}if(matchesShortcut(bindings,'fileMenu',event.nativeEvent)){event.preventDefault();event.stopPropagation();const rect=event.currentTarget.getBoundingClientRect();setMenu({entry,x:rect.x+30,y:rect.bottom});}}}>
      {folder?(open?<ChevronDown size={12}/>:<ChevronRight size={12}/>):<span className="explorer-spacer"/>}{folder?<Folder size={15}/>:isImagePath(entry.path)?<FileImage size={15}/>:<Icon name="file.text" size={15}/>}
      {editing?<input aria-label="文件名称" autoFocus value={rename.value} disabled={busy} onClick={event=>event.stopPropagation()} onFocus={event=>{const end=entry.type==='file'?event.currentTarget.value.replace(/\.md$/i,'').length:event.currentTarget.value.length;event.currentTarget.setSelectionRange(0,end);}} onChange={event=>setRename({...rename,value:event.target.value})} onBlur={()=>void commitRename()} onKeyDown={event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();void commitRename();}if(event.key==='Escape'){cancelRename.current=true;setRename(null);}}}/>:<span className="explorer-name">{entry.name.replace(/\.md$/i,'')}</span>}
      {hit?.line&&<small className="explorer-hit-line">{hit.line} 行</small>}
      {!folder&&file===entry.path&&<i className={dirty?'dirty-dot':'file-dot'}/>}
    </div>{folder&&open&&<div role="group">{row(entry.children||[],depth+1)}</div>}</div>;
  });}
  const sortOptions:{label:string;mode:SortMode}[]=[{label:'文件名',mode:'name'},{label:'编辑时间',mode:'modified'},{label:'创建时间',mode:'created'},{label:'自定义',mode:'manual'}];
  const actions:Record<string,{label:string;key?:string;run:()=>void}>= {
    tab:{label:'在新标签页中打开',key:shortcutLabel(bindings,'openFileTab'),run:()=>void operation('tab',menu!.entry!)},
    duplicate:{label:'创建副本',run:()=>void operation('duplicate',menu!.entry!)},
    move:{label:'移动到…',run:()=>void operation('move',menu!.entry!)},
    search:{label:'在文件夹中查找',key:shortcutLabel(bindings,'findInFolder'),run:()=>void operation('search',menu!.entry!)},
    copy:{label:'复制路径',key:shortcutLabel(bindings,'copyFilePath'),run:()=>void operation('copy',menu!.entry!)},
    reveal:{label:'在系统资源管理器中显示',run:()=>void operation('reveal',menu!.entry!)},
    ai:{label:'添加到依据',run:()=>void operation('ai',menu!.entry!)},
    rename:{label:'重命名',key:shortcutLabel(bindings,'renameFile'),run:()=>void operation('rename',menu!.entry!)},
    trash:{label:'删除到回收站',key:shortcutLabel(bindings,'trashFile'),run:()=>void operation('trash',menu!.entry!)},
  };
  const actionOrder=menuActions(menu?.entry?.type);if(isImagePath(menu?.entry?.path||'')){const i=actionOrder.indexOf('ai');if(i>=0)actionOrder.splice(i,1);}if(actionOrder.includes('ai')){actionOrder.splice(actionOrder.indexOf('ai'),1);const tab=actionOrder.indexOf('tab');actionOrder.splice(tab<0?0:tab+1,0,'ai');}
  type MenuItem={id?:string;label:string;key?:string;run:()=>void;emphasis?:boolean;disabled?:boolean;separator?:boolean;icon?:IconName;selected?:boolean};
  const selectionItems:MenuItem[]=[
    {id:'select-visible',label:'全选可见结果',key:'Ctrl+A',disabled:!visiblePaths.length,run:()=>{setSelection(new Set(visiblePaths));anchor.current=visiblePaths[0]||'';closeMenu();}},
    {id:'clear-selection',label:'清除选择',key:'Esc',disabled:!chosen.length,run:()=>{setSelection(new Set());anchor.current='';closeMenu();}},
  ];
  const selectedItems:MenuItem[]=[
    {id:'basis-selection',label:'添加到依据',run:()=>{setMenu(null);void referenceBatch();}},
    {id:'move-selection',label:'移动到…',run:()=>{setMenu(null);startBatch('move');}},
    {id:'trash-selection',label:'删除到回收站',key:shortcutLabel(bindings,'trashFile'),run:()=>{setMenu(null);startBatch('trash');}},
  ];
  const multipleMenu=chosen.length>1&&!menu?.sort&&(!menu?.entry||selection.has(menu.entry.path));
  const imageItem:MenuItem={id:'images',label:'图片详情…',separator:true,run:()=>{setMenu(null);setImagesOpen(true);}};
  const menuItems:MenuItem[]=menu?.sort?sortOptions.map(option=>{
    const selected=order.mode===option.mode;
    const direction=selected?sortDirection(order):sortDirection({mode:option.mode,parents:order.parents});
    const suffix=selected&&option.mode!=='manual'?(option.mode==='name'?(direction==='asc'?' A → Z':' Z → A'):(direction==='desc'?' 新 → 旧':' 旧 → 新')):'';
    return {id:option.mode,label:option.label+suffix,icon:sortIcon(option.mode,direction),selected,
      run:()=>store({...order,mode:option.mode,direction:selected?(direction==='asc'?'desc':'asc'):direction})};
  }):
    menu?.more?[...(chosen.length?selectedItems:[]),...selectionItems.map((item,index)=>({...item,separator:!!chosen.length&&index===0})),imageItem]:
    [...(multipleMenu?selectedItems:actionOrder.map(action=>({...actions[action],id:action,emphasis:action==='ai'})))];
  return <div ref={container} className={'file-explorer '+(externalDrop?'external-drop-active':'')} aria-busy={busy}
    onDragEnter={event=>{if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();setExternalDrop(true);}}}
    onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes(REFERENCE_DRAG_TYPE)){event.preventDefault();event.dataTransfer.dropEffect='move';setDrop({path:'',where:'inside'});return;}if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}}}
    onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setExternalDrop(false);}}
    onDrop={event=>{if(Array.from(event.dataTransfer.types).includes(REFERENCE_DRAG_TYPE)){event.preventDefault();event.stopPropagation();const source=readReferenceDrag(event.dataTransfer.getData(REFERENCE_DRAG_TYPE),workspaceId);if(source&&byPath.has(source.path)){drag.current=source.path;void dropAt({path:'',where:'inside'});}return;}if(!Array.from(event.dataTransfer.types).includes('Files'))return;event.preventDefault();event.stopPropagation();setExternalDrop(false);if(busy){setImportStatus('文件操作进行中，请稍后重试。');return;}const target=(event.target as Element).closest<HTMLElement>('.explorer-row'),entry=target&&byPath.get(target.dataset.path||'');void importDropped(Array.from(event.dataTransfer.files),entry?.type==='folder'?entry.path:entry?parentPath(entry.path):undefined);}}
    onKeyDown={event=>{
    if(busy||event.defaultPrevented||event.nativeEvent.isComposing||(event.target as HTMLElement).closest('input,textarea,button,a,select,[role="menu"]'))return;
    const matches=(id:Parameters<typeof matchesShortcut>[1])=>matchesShortcut(bindings,id,event.nativeEvent);
    const ctrl=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
    if(ctrl&&key==='a'){event.preventDefault();setSelection(new Set(visiblePaths));anchor.current=visiblePaths[0]||'';}
    else if(event.key==='Escape'&&selection.size){event.preventDefault();setSelection(new Set());anchor.current='';}
    else if(matches('newFolder')||matches('newNote')){event.preventDefault();if(!event.repeat)void create(matches('newFolder')?'folder':'file');}
    else if(focused){
      if(matches('renameFile')){event.preventDefault();beginRename(focused);}
      else if(matches('trashFile')){event.preventDefault();if(!event.repeat){if(selection.size>1)startBatch('trash');else if(selection.has(focused.path)&&visiblePaths.includes(focused.path))setDeleting(focused);}}
      else if(matches('openFileTab')&&focused.type==='file'){event.preventDefault();if(!event.repeat)void operation('tab',focused);}
      else if(matches('copyFilePath')){event.preventDefault();void operation('copy',focused);}
      else if(matches('findInFolder')&&focused.type==='folder'){event.preventDefault();void operation('search',focused);}
    }
  }}>
    {externalDrop&&<div className="explorer-external-drop" aria-hidden="true">松开以导入 Markdown 或图片<br/><small>复制到当前文件库</small></div>}
    {searchExpanded?<div className="explorer-search"><Search size={13}/><input ref={search} disabled={busy} aria-label="筛选文件" placeholder={scope?'在文件夹中查找…':'查找文件或粘贴路径…'} value={filter} onChange={event=>setFilter(event.target.value)} onKeyDown={event=>{
      if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();closeSearch();return;}
      if(event.key!=='Enter'||event.nativeEvent.isComposing||event.repeat||!pastedPath||!onOpenPath)return;
      event.preventDefault();event.stopPropagation();
      void run(async()=>{await onOpenPath(pastedPath);return true;},'open').then(opened=>{if(opened)setFilter('');});
    }}/><button type="button" aria-label="收起文件查找" title="收起并清空查找（Esc）" disabled={busy} onClick={closeSearch}><X size={13}/></button></div>:<button ref={searchButton} type="button" className="explorer-search explorer-search-toggle" aria-label="查找文件" aria-expanded="false" disabled={busy} onClick={openSearch}><Search size={13}/><span>查找文件</span></button>}
    <div className="explorer-tools" data-opening-file={pendingOperation==='open'||undefined}><span className="explorer-heading" title={scope}><span>{scope?scope.split('/').at(-1):'全部文档'}</span>{chosen.length>1&&<small role="status" aria-label={`已选择 ${chosen.length} 项`}>已选 {chosen.length} 项</small>}</span>{scope&&<button type="button" disabled={busy} onClick={()=>{setScope('');setFilter('');}}>全部</button>}<div>
      <input ref={importInput} type="file" hidden multiple accept=".md,.png,.jpg,.jpeg,.gif,.webp" onChange={event=>{const files=Array.from(event.currentTarget.files||[]);event.currentTarget.value='';if(files.length)void importDropped(files);}}/>
      <button type="button" aria-label="导入文件" title="导入文件" disabled={busy} onClick={()=>importInput.current?.click()}><Upload size={14}/></button>
      <button type="button" disabled={busy} aria-label="文件排序" title="排序" aria-haspopup="menu" onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setMenu({x:rect.x,y:rect.bottom,sort:true});}}><ArrowDownWideNarrow size={14}/></button>
      <button type="button" aria-label="新建文件夹" title={`新建文件夹（${shortcutLabel(bindings,'newFolder')}）`} disabled={busy} onClick={()=>void create('folder')}><Icon name="file.newFolder" size={14}/></button>
      <button type="button" aria-label="新建文档" title={`新建文档（${shortcutLabel(bindings,'newNote')}）`} disabled={busy} onClick={()=>void create('file')}><Icon name="file.newNote" size={15}/></button>
      <button type="button" aria-label="文档更多操作" title="更多操作" aria-haspopup="menu" aria-expanded={!!menu?.more} disabled={busy} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setMenu(menu?.more?null:{x:rect.right,y:rect.bottom,more:true});}}><MoreHorizontal size={15}/></button>
    </div></div>
    {batchResult.length>0&&!batch&&<div className="explorer-batch-result" role="status">{batchResult.map((item,index)=><div key={index}>{item}</div>)}<button type="button" onClick={()=>setBatchResult([])}>关闭结果</button></div>}
    {scope&&filter&&!pastedPath&&<small className="explorer-search-status" role="status">{searching?'正在查找文件名与正文…':currentResults?`找到 ${currentResults.matches.length} 份文档${currentResults.truncated?'，仅显示前 200 份':''}`:'查找文件名与正文'}</small>}
    {warning&&<p className="explorer-error" role="status">操作已完成：{warning}<button type="button" aria-label="关闭文件操作警告" onClick={()=>setWarning('')}><X size={12}/></button></p>}
    {error&&<p className="explorer-error" role="alert">{error}<button type="button" aria-label="关闭文件操作提示" onClick={()=>setError('')}><X size={12}/></button></p>}
    {importStatus&&<p className="explorer-import-status" role="status">{importStatus}<button type="button" aria-label="关闭导入结果" onClick={()=>setImportStatus('')}><X size={12}/></button></p>}
    <div className={'explorer-tree '+(drop?.path===''?'drop-inside':'')}>
      <div role="tree" aria-multiselectable="true" aria-label="文件和文件夹">{row(entries)}</div>
      {treeReady&&!entries.length&&!scope&&!filter
        ? onOpenRepositories&&<div className="explorer-empty"><button type="button" disabled={busy} onClick={onOpenRepositories}>打开仓库管理</button></div>
        : treeReady&&!view.matching.size&&<p className="empty-note">{pastedPath?'按 Enter 打开 Markdown 文稿。':filter?'没有匹配的文件。':'从一份新文档开始。'}</p>}
      <div className="explorer-root-drop">拖到空白处移至根目录</div>
    </div>
    {imagesOpen&&<ImageLibrary workspaceId={workspaceId} file={file} refreshKey={imageRevision} onClose={()=>{setImagesOpen(false);window.requestAnimationFrame(()=>container.current?.querySelector<HTMLButtonElement>('[aria-label="文档更多操作"]')?.focus());}}/>}
    {menu&&menuItems.length>0&&createPortal(<div ref={menuRef} role="menu" aria-label={menu.sort?'文件排序':menu.more?'文档更多操作':'文件操作'} className="explorer-menu" style={{left:menu.x,top:menu.y}} onKeyDown={event=>{const nodes=Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')||[]),index=nodes.indexOf(document.activeElement as HTMLButtonElement);if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();nodes[event.key==='Home'?0:event.key==='End'?nodes.length-1:(index+(event.key==='ArrowDown'?1:-1)+nodes.length)%nodes.length]?.focus();}if(event.key==='Escape'){event.preventDefault();closeMenu();}if(event.key==='Tab')closeMenu();}}>{multipleMenu&&<div className="explorer-menu-caption">已选 {chosen.length} 项</div>}{menuItems.map(item=><Fragment key={item.id||item.label}>{item.separator&&<hr role="separator"/>}<button role="menuitem" type="button" aria-current={item.selected||undefined} className={item.emphasis?'explorer-menu-ai':undefined} disabled={busy||item.disabled} onClick={()=>void item.run()}><span className="explorer-menu-label">{item.icon&&<Icon name={item.icon} size={18}/>}{item.emphasis&&<Sparkles size={14} aria-hidden="true"/>}{item.label}</span>{item.selected&&<Check size={12}/>}{item.key&&<kbd>{item.key}</kbd>}</button></Fragment>)}</div>,document.body)}
    {batch&&createPortal(<dialog className="explorer-dialog" aria-label={batch.kind==='move'?'批量移动':'批量删除'} ref={element=>{if(element&&!element.open)element.showModal();}} onCancel={event=>{event.preventDefault();if(!busy)setBatch(null);}}><h2>{batch.kind==='move'?'批量移动':'批量删除到回收站'}</h2><p>将处理以下项目；选中父文件夹内的项目随父文件夹处理。</p><ul>{batch.entries.map(item=>{const ancestor=batch.entries.find(other=>other.type==='folder'&&other.path!==item.path&&item.path.startsWith(other.path+'/'));return <li key={item.path}>{item.path}{ancestor?'（包含于 '+ancestor.path+'）':''}</li>;})}</ul>{batch.kind==='move'&&<label>目标文件夹<select value={moveParent} onChange={event=>setMoveParent(event.target.value)}><option value="">根目录</option>{all.filter(item=>item.type==='folder'&&!planned(batch.entries).some(source=>item.path===source.path||item.path.startsWith(source.path+'/'))).map(item=><option key={item.path} value={item.path}>{item.path}</option>)}</select></label>}{error&&<p role="alert">{error}</p>}{batchResult.length>0&&<div role="status">{batchResult.map((item,index)=><div key={index}>{item}</div>)}</div>}<button type="button" disabled={busy||batchResult.length>0} onClick={()=>void executeBatch()}>{batch.kind==='move'?'移动':'移到回收站'}</button><button type="button" disabled={busy} onClick={()=>{setBatch(null);setError('');}}>关闭</button></dialog>,document.body)}
    {(move||deleting)&&createPortal(<dialog className="explorer-dialog" aria-label={move?'移动到文件夹':'删除到回收站'} ref={element=>{if(element&&!element.open)element.showModal();}} onCancel={event=>{event.preventDefault();if(!busy){setMove(null);setDeleting(null);}}}>
      <h2>{move?'移动到文件夹':'删除到回收站'}</h2>
      {error&&<p role="alert">{error}</p>}
      {move&&<><p>{move.name}</p><label>目标文件夹<select aria-label="目标文件夹" value={moveParent} onChange={event=>setMoveParent(event.target.value)}><option value="">根目录</option>{all.filter(item=>item.type==='folder'&&item.path!==move.path&&!item.path.startsWith(move.path+'/')).map(item=><option key={item.path} value={item.path}>{item.path}</option>)}</select></label><button type="button" disabled={busy} onClick={async()=>{const result=await run(()=>onAction({action:'move',path:move.path,parent:moveParent}));if(result){store(remapOrder(order,move.path,result.path));expand(result.path);setSelected(result.path);setMove(null);}else setMove(null);}}>移动</button></>}
      {deleting&&<><p>将「{deleting.name}」{deleting.type==='folder'?'及其中所有文件':''}移到回收站？可从回收站恢复。</p><button type="button" disabled={busy} onClick={async()=>{const result=await run(()=>onAction({action:'trash',path:deleting.path}));if(result){setDeleting(null);setSelected('');if(scope===deleting.path||scope.startsWith(deleting.path+'/'))setScope('');}else setDeleting(null);}}>移到回收站</button></>}
      <button type="button" disabled={busy} onClick={()=>{setMove(null);setDeleting(null);setError('');}}>取消</button>
    </dialog>,document.body)}
  </div>;
}

