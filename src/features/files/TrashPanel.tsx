import {usePanelDocument} from '../../shared/panelDocument';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,Eraser,Icon,RotateCcw,Trash2} from "../../shared/icons";
import {useFileWorkspace} from './WorkspaceContext';
import './trash-panel.css';
import './file-explorer.css';

export type TrashRecord={id:string;path:string;type:'file'|'folder';deletedAt:string;missing?:boolean};
export type TrashPreview={token:string;days:number;cutoff:string;expiresAt:string;items:TrashRecord[];count:number};
type Failure={id:string;path:string;error:string;dataDeleted?:boolean;partialDataDeleted?:boolean};
export type TrashDeleteResult={deletedIds:string[];failed:Failure[]};
export type TrashPurgeResult=TrashDeleteResult;
export type TrashConfirmationRequest={workspaceId:string;items:TrashRecord[]};
type Props={open:boolean;refreshKey:number;onRestore:(id:string)=>Promise<unknown>;onPreview?:(item:TrashRecord)=>Promise<unknown>;onChanged:()=>void;deleteRequest?:TrashConfirmationRequest|null;onDeleteRequestShown?:(request:TrashConfirmationRequest)=>void;onDeleted?:(items:TrashRecord[])=>void};

const SORTS=[
  {id:'newest',label:'删除时间（新→旧）',icon:'file.sortNewest',by:'time',direction:-1},
  {id:'oldest',label:'删除时间（旧→新）',icon:'file.sortOldest',by:'time',direction:1},
  {id:'name',label:'名称（A→Z）',icon:'file.sortAToZ',by:'name',direction:1},
  {id:'name-desc',label:'名称（Z→A）',icon:'file.sortZToA',by:'name',direction:-1},
] as const;
type SortId=(typeof SORTS)[number]['id'];
const DAYS=[0,7,15,30,90] as const;
const RELATIVE=new Intl.RelativeTimeFormat('zh-CN',{numeric:'auto'});
const UNITS:[Intl.RelativeTimeFormatUnit,number][]=[['year',31536000000],['month',2592000000],['day',86400000],['hour',3600000],['minute',60000]];
const nameOf=(path:string)=>path.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||path;
const parentOf=(path:string)=>{const clean=path.replace(/[\\/]+$/,'');const index=Math.max(clean.lastIndexOf('/'),clean.lastIndexOf('\\'));return index<=0?'':clean.slice(0,index);};
const sortValue = {
  time:(item:TrashRecord)=>item.deletedAt,
  name:(item:TrashRecord)=>nameOf(item.path),
};
const dateOf=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString();};
const relativeTime=(value:string)=>{
  const time=Date.parse(value);if(!Number.isFinite(time))return value;
  const diff=time-Date.now();
  for(const [unit,ms] of UNITS)if(Math.abs(diff)>=ms)return RELATIVE.format(Math.round(diff/ms),unit);
  return '刚刚';
};
const dayLabel=(days:number)=>days===0?'全部':days+' 天';
const failureText=(item:Failure)=>item.dataDeleted?'内容已永久删除，记录待清理':item.partialDataDeleted?'部分内容已删除，余项保留':'未完成';

export default function TrashPanel({open,refreshKey,onRestore,onPreview,onChanged,deleteRequest,onDeleteRequestShown,onDeleted}:Props){
  const {info,request}=useFileWorkspace(),document=usePanelDocument(),window=document.defaultView!;
  const [items,setItems]=useState<TrashRecord[]>([]),[query,setQuery]=useState(''),[sort,setSort]=useState<SortId>('newest'),[days,setDays]=useState(30);
  const [sortMenuOpen,setSortMenuOpen]=useState(false);
  const sortButton=useRef<HTMLButtonElement>(null),sortMenu=useRef<HTMLDivElement>(null);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [confirm,setConfirm]=useState<{preview:TrashPreview}|{items:TrashRecord[]}|null>(null);
  const dialog=useRef<HTMLDialogElement>(null),generation=useRef(0),controllers=useRef(new Set<AbortController>()),listSequence=useRef(0),busyRef=useRef(false);
  const openings=useRef(new Map<string,number>());
  const abortAll=useCallback(()=>{generation.current++;listSequence.current++;controllers.current.forEach(controller=>controller.abort());controllers.current.clear();busyRef.current=false;},[]);
  const load=useCallback(async()=>{
    if(!open)return;
    const epoch=generation.current,seq=++listSequence.current,controller=new AbortController();controllers.current.add(controller);setLoading(true);
    try{const response=await request('/api/explorer/trash',{signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error||'无法读取回收站');if(epoch===generation.current&&seq===listSequence.current)setItems(data);}
    catch(e){if(epoch===generation.current&&seq===listSequence.current&&(e as Error).name!=='AbortError')setError((e as Error).message);}
    finally{controllers.current.delete(controller);if(epoch===generation.current&&seq===listSequence.current)setLoading(false);}
  },[open,request]);
  useEffect(()=>{abortAll();setItems([]);setSortMenuOpen(false);setConfirm(null);setError('');setNotice('');setBusy(false);setLoading(false);if(open)void load();return abortAll;},[open,info.id,request,abortAll]);
  useEffect(()=>{if(open)void load();},[refreshKey]);
  useEffect(()=>{if(!open)return;const focus=()=>void load();window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus);},[open,load]);
  useEffect(()=>{
    if(!open||!deleteRequest||deleteRequest.workspaceId!==info.id||!deleteRequest.items.length||busy||confirm)return;
    setError('');setConfirm({items:deleteRequest.items});onDeleteRequestShown?.(deleteRequest);
  },[open,deleteRequest,info.id,busy,confirm,onDeleteRequestShown]);
  useEffect(()=>{const node=dialog.current;if(!node)return;if(confirm&&!node.open)node.showModal();if(!confirm&&node.open)node.close();},[confirm,document]);
  const sortOption=SORTS.find(option=>option.id===sort)!;
  const sortLabel=sortOption.label;
  const showSortMenu=open&&sortMenuOpen&&!busy&&!confirm;
  useLayoutEffect(()=>{
    const button=sortButton.current,menu=sortMenu.current;
    if(!showSortMenu||!button||!menu)return;
    const anchor=button.getBoundingClientRect(),top=anchor.bottom+4;
    menu.style.left=`${Math.max(6,Math.min(anchor.left,window.innerWidth-menu.offsetWidth-6))}px`;
    menu.style.top=`${top}px`;
    menu.style.maxHeight=`${Math.max(0,window.innerHeight-top-6)}px`;
    menu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  },[showSortMenu,document,window]);
  useEffect(()=>{
    if(!showSortMenu)return;
    const close=()=>setSortMenuOpen(false);
    const outside=(event:PointerEvent)=>{
      const target=event.target as Node;
      if(!sortMenu.current?.contains(target)&&!sortButton.current?.contains(target))close();
    };
    document.addEventListener('pointerdown',outside,true);
    window.addEventListener('blur',close);
    window.addEventListener('resize',close);
    return ()=>{
      document.removeEventListener('pointerdown',outside,true);
      window.removeEventListener('blur',close);
      window.removeEventListener('resize',close);
    };
  },[showSortMenu,document,window]);
  function closeSortMenu(){
    setSortMenuOpen(false);
    sortButton.current?.focus();
  }
  const visible=useMemo(()=>{
    const value=sortValue[sortOption.by];
    const needle=query.trim().toLocaleLowerCase();
    return items.filter(item=>item.path.toLocaleLowerCase().includes(needle))
      .sort((a,b)=>sortOption.direction*value(a).localeCompare(value(b),'zh-CN'));
  },[items,query,sortOption]);
  async function fetchPreview(){
    if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');setNotice('');const epoch=generation.current,controller=new AbortController();controllers.current.add(controller);
    try{const response=await request('/api/explorer/trash/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days}),signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error||'无法预览清理');if(epoch!==generation.current)return;if(!data.count){setNotice(days===0?'回收站没有可清理的条目。':'没有 '+days+' 天以前可清理的条目。');return;}setConfirm({preview:data as TrashPreview});}
    catch(e){if(epoch===generation.current&&(e as Error).name!=='AbortError')setError((e as Error).message);}
    finally{controllers.current.delete(controller);if(epoch===generation.current){busyRef.current=false;setBusy(false);}}
  }
  async function purge(preview:TrashPreview){
    if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');const epoch=generation.current,controller=new AbortController();controllers.current.add(controller);
    try{const response=await request('/api/explorer/trash/purge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:preview.token}),signal:controller.signal});const data=await response.json();if(epoch!==generation.current)return;if(!response.ok){if(response.status===409){setConfirm(null);throw new Error('回收站内容已变化或预览已过期，请重新预览后再清理。');}throw new Error(data.error||'清理失败');}const result=data as TrashPurgeResult;const removed=new Set(result.deletedIds);onDeleted?.(preview.items.filter(item=>removed.has(item.id)));listSequence.current++;setItems(items=>items.filter(item=>!removed.has(item.id)));setConfirm(null);setNotice('已永久删除 '+result.deletedIds.length+' 项。'+(result.failed.length?' 另有 '+result.failed.length+' 项未完全处理：'+result.failed.map(item=>item.path+'（'+failureText(item)+'：'+item.error+'）').join('；'):''));onChanged();await load();}
    catch(e){if(epoch===generation.current&&(e as Error).name!=='AbortError')setError((e as Error).message);}
    finally{controllers.current.delete(controller);if(epoch===generation.current){busyRef.current=false;setBusy(false);}}
  }
  async function remove(targets:TrashRecord[]){
    if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');setNotice('');const epoch=generation.current,controller=new AbortController();controllers.current.add(controller);
    const ids=new Set(targets.map(item=>item.id));
    const single=targets.length===1?nameOf(targets[0].path):'';
    try{
      const response=await request('/api/explorer/trash/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[...ids]}),signal:controller.signal});
      const data=await response.json();if(epoch!==generation.current)return;
      if(!response.ok&&response.status!==404)throw new Error(data.error||(single?'无法删除该项目':'无法删除这些项目'));
      const result=response.ok?data as TrashDeleteResult:null;
      const removed=result?new Set(result.deletedIds):ids;
      listSequence.current++;setItems(items=>items.filter(entry=>!removed.has(entry.id)));setConfirm(null);
      if(result)onDeleted?.(targets.filter(item=>removed.has(item.id)));
      if(!result)setNotice(single?'该条目已不在回收站中。':'这些条目已不在回收站中。');
      else if(single)setNotice(result.failed.length?'未能完全删除 '+single+'：'+result.failed.map(entry=>entry.error).join('；'):'已永久删除 '+single+'。');
      else setNotice('已永久删除 '+result.deletedIds.length+' 项。'+(result.failed.length?' 另有 '+result.failed.length+' 项未完全处理：'+result.failed.map(item=>item.path+'（'+failureText(item)+'：'+item.error+'）').join('；'):''));
      onChanged();await load();
    }
    catch(e){if(epoch===generation.current&&(e as Error).name!=='AbortError'){setError((e as Error).message);setConfirm(null);}}
    finally{controllers.current.delete(controller);if(epoch===generation.current){busyRef.current=false;setBusy(false);}}
  }
  async function restore(item:TrashRecord){if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');setNotice('');const epoch=generation.current;try{await onRestore(item.id);if(epoch!==generation.current)return;setNotice('已恢复 '+nameOf(item.path)+'。');onChanged();await load();}catch(e){if(epoch===generation.current)setError((e as Error).message);}finally{if(epoch===generation.current){busyRef.current=false;setBusy(false);}}}
  function canPreview(item:TrashRecord){return !!onPreview&&item.type==='file'&&!item.missing&&/\.md$/i.test(item.path);}
  async function openDocument(item:TrashRecord){
    const epoch=generation.current;
    if(!onPreview||busyRef.current||!canPreview(item)||openings.current.get(item.id)===epoch)return;
    openings.current.set(item.id,epoch);
    setError('');
    try{await onPreview(item);}
    catch(error){if(generation.current===epoch&&(error as Error).name!=='AbortError')setError((error as Error).message);}
    finally{if(openings.current.get(item.id)===epoch)openings.current.delete(item.id);}
  }
  if(!open)return null;
  const preview=confirm&&'preview' in confirm?confirm.preview:null;
  const targets=confirm&&'items' in confirm?confirm.items:[];
  const target=targets.length===1?targets[0]:null;
  const purgeLabel=days===0?'清理回收站中的全部条目':'清理 '+days+' 天以前的条目';
  return <section className="trash-panel" aria-label="回收站" aria-busy={busy||loading}>
    <div className="trash-panel-search"><Icon name="trash.filter" size={13}/><input aria-label="筛选回收站" placeholder="查找回收站…" value={query} onChange={e=>setQuery(e.target.value)}/></div>
    <div className="trash-panel-toolbar">
      <label className="trash-panel-period" title={purgeLabel}><span>清理</span><select aria-label="清理期限" value={days} disabled={busy||!items.length} onChange={e=>setDays(Number(e.target.value))}>{DAYS.map(n=><option key={n} value={n}>{dayLabel(n)}</option>)}</select></label>
      <button ref={sortButton} type="button" className="trash-panel-tool" aria-label={'排序：'+sortLabel} title={'排序：'+sortLabel}
        aria-haspopup="menu" aria-expanded={showSortMenu} disabled={busy}
        onClick={()=>setSortMenuOpen(value=>!value)} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();setSortMenuOpen(true);}}}>
        <Icon name={sortOption.icon} size={13}/>
      </button>
      <button type="button" className="trash-panel-tool" aria-label={purgeLabel} title={purgeLabel} disabled={busy||!items.length} onClick={()=>void fetchPreview()}><Eraser size={13}/></button>
    </div>
    {showSortMenu&&createPortal(<div className="explorer-menu trash-sort-menu" ref={sortMenu} role="menu" aria-label="回收站排序"
      onKeyDown={event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeSortMenu();return;}
        if(event.key==='Tab'){setSortMenuOpen(false);return;}
        if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
        event.preventDefault();
        const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
        buttons[next]?.focus();
      }}>
      {SORTS.map(option=><button key={option.id} type="button" role="menuitemradio" aria-checked={sort===option.id}
        onClick={()=>{setSort(option.id);closeSortMenu();}}>
        <span className="explorer-menu-label"><Icon name={option.icon} size={18}/>{option.label}</span>
        {sort===option.id&&<Check size={12}/>}
      </button>)}
    </div>,document.body)}
    {error&&<p className="trash-panel-message" role="alert">{error}</p>}{notice&&<p className="trash-panel-message" role="status">{notice}</p>}
    <div className="trash-panel-list">
      {visible.map(item=><div className="trash-panel-row" key={item.id} title={item.path} data-trash-id={item.id}
        onDoubleClick={canPreview(item)?event=>{if(!(event.target as Element).closest('.trash-panel-actions'))void openDocument(item);}:undefined}>
        <Icon name={item.type==='folder'?'trash.deletedFolder':'trash.deletedFile'} size={15} className="trash-panel-kind"/>
        {canPreview(item)?<button type="button" className="trash-panel-name trash-preview-trigger" title="双击预览文稿" disabled={busy}
          aria-label={'预览 '+nameOf(item.path)} onClick={event=>{if(event.detail===0)void openDocument(item);}}>{nameOf(item.path)}</button>:<span className="trash-panel-name">{nameOf(item.path)}</span>}
        <span className="trash-panel-meta">
          <span className="trash-panel-path" title={parentOf(item.path)||'根目录'}>{parentOf(item.path)||'根目录'}</span>
          <time dateTime={item.deletedAt} title={dateOf(item.deletedAt)}>{relativeTime(item.deletedAt)}</time>
        </span>
        <span className="trash-panel-actions">
          <button type="button" aria-label={'恢复 '+nameOf(item.path)} title={item.missing?'原内容已不存在，无法恢复':'恢复'} disabled={busy||item.missing} onClick={()=>void restore(item)}><RotateCcw size={13}/></button>
          <button type="button" aria-label={'永久删除 '+nameOf(item.path)} title="永久删除" disabled={busy} onClick={()=>{setError('');setConfirm({items:[item]});}}><Icon name="trash.deletePermanently" size={13}/></button>
        </span>
      </div>)}
      {!visible.length&&!loading&&<div className="trash-panel-empty"><Trash2 size={28} aria-hidden="true"/><p className="trash-panel-empty-title">{query?'没有匹配的条目':'回收站为空'}</p><p className="trash-panel-empty-note">{query?'换个关键词试试':'删除的项目会保留 30 天'}</p></div>}
      {loading&&!items.length&&<p className="trash-panel-empty-note">正在读取…</p>}
    </div>
    {confirm&&createPortal(<dialog ref={dialog} className="trash-confirm" role="alertdialog" aria-labelledby="trash-confirm-title" onCancel={e=>{e.preventDefault();if(!busy)setConfirm(null);}}>
      <h2 id="trash-confirm-title">{target?'永久删除这个项目？':'永久删除这些条目？'}</h2>
      {preview?<>
        <p>将永久删除{preview.days===0?'全部':' '+preview.days+' 天以前的'} {preview.count} 项（截止时间：{dateOf(preview.cutoff)}）。删除后无法恢复；文件夹及其中所有内容都会被删除。</p>
        <ul>{preview.items.map(item=><li key={item.id} title={item.path}>{nameOf(item.path)}{item.type==='folder'?' /':''}</li>)}</ul>
      </>:target?<p>将永久删除「{nameOf(target.path)}」{target.type==='folder'?'及其中所有内容':''}，删除后无法恢复。原位置：{parentOf(target.path)||'根目录'}</p>:<>
        <p>将永久删除以下 {targets.length} 项。删除后无法恢复，文件夹中的所有内容也会一并删除。</p>
        <ul>{targets.map(item=><li key={item.id}>{item.path}{item.type==='folder'?' /':''}</li>)}</ul>
      </>}
      {error&&<p role="alert">{error}</p>}
      <div className="trash-confirm-actions">
        <button type="button" disabled={busy} onClick={()=>setConfirm(null)}>取消</button>
        <button type="button" className="trash-confirm-danger" disabled={busy} onClick={()=>{if(preview)void purge(preview);else if(targets.length)void remove(targets);}}>{target?'永久删除':'永久删除 '+(preview?.count??targets.length)+' 项'}</button>
      </div>
    </dialog>,document.body)}
  </section>;
}
