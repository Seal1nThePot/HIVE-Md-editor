import {useEffect,useId,useRef,useState} from 'react';
import {Folder,FileText,Settings2} from '../../shared/icons';
import {requestJson} from '../../shared/api';
import {readOrder,sortEntries} from './explorerState';
import {REFERENCE_DRAG_TYPE,readReferenceDrag} from './referenceDrag';
import {quickOpenLimit,type useQuickOpen} from './useQuickOpen';
import './quick-open.css';

type Props = {workspaceId:string;indexes:ReturnType<typeof useQuickOpen>;request:typeof fetch;modelConfigured:boolean;
  onOpen:(path:string)=>Promise<void>;onClose:()=>void;dropError:string;onDropError:(message:string)=>void};

export default function QuickOpenPanel({workspaceId,indexes,request,modelConfigured,onOpen,onClose,dropError,onDropError}:Props) {
  const {folders,selected,foldersByPath,storageError} = indexes;
  const [settings,setSettings] = useState(false);
  const [choosing,setChoosing] = useState(false);
  const [choice,setChoice] = useState('');
  const [suggestions,setSuggestions] = useState<{path:string;selected:boolean}[]>([]);
  const [recommending,setRecommending] = useState(false);
  const [opening,setOpening] = useState(false);
  const [dragActive,setDragActive] = useState(false);
  const pending = useRef<AbortController|null>(null);
  const alive = useRef(true);
  useEffect(()=>{
    alive.current = true;
    return ()=>{alive.current=false;pending.current?.abort();};
  },[]);
  const contentId = useId();
  const available = [...foldersByPath.values()].filter(entry=>!folders.includes(entry.path));
  let storedOrder = null;
  try { storedOrder = localStorage.getItem(`hive.explorer.v1:${workspaceId}`); } catch { /* Use the explorer defaults. */ }
  const docs = sortEntries(foldersByPath.get(selected)?.children ?? [],readOrder(storedOrder),selected)
    .filter(entry=>entry.type==='file'&&/\.md$/i.test(entry.path));
  const room = quickOpenLimit - folders.length;
  const availableSuggestions = suggestions.filter(item=>foldersByPath.has(item.path)&&!folders.includes(item.path));
  const picked = availableSuggestions.filter(item=>item.selected);

  function bind(paths:string[]) {
    const error = indexes.bind(paths);
    onDropError(error);
    if (!error) { setChoosing(false);setChoice('');setSuggestions([]);setSettings(false); }
  }

  async function recommend() {
    if (pending.current || !room || !indexes.candidates.length || !modelConfigured) return;
    const controller = new AbortController();
    pending.current = controller;
    setChoosing(false);setSuggestions([]);setRecommending(true);onDropError('');
    try {
      const {paths} = await requestJson<{paths:string[]}>(request,'/ai-tools/quick-open',
        {workspaceId,limit:room,candidates:indexes.candidates},controller.signal);
      if (controller.signal.aborted) return;
      setSuggestions(paths.map(path=>({path,selected:true})));
    } catch (error) {
      if (!controller.signal.aborted) onDropError(error instanceof Error ? error.message : '无法获取快速索引建议。');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (alive.current) setRecommending(false);
      }
    }
  }

  async function open(path:string) {
    if (opening) return;
    setOpening(true);onDropError('');
    try { await onOpen(path); }
    catch (error) { if (alive.current) onDropError(error instanceof Error ? error.message : '无法打开文档。'); }
    finally { if (alive.current) setOpening(false); }
  }

  return <div className="quick-open-panel" onKeyDown={event=>{
    if(event.key==='Escape'&&!event.nativeEvent.isComposing&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();onClose();}
  }}>
    {folders.length>0&&<div className="quick-open-tabs" role="tablist" aria-label="已绑定文件夹">{folders.map((path,index)=>{
      const name = foldersByPath.get(path)!.name;
      return <button key={path} id={`${contentId}-${index}`} type="button" role="tab" aria-selected={path===selected} aria-controls={contentId}
        title={path} tabIndex={path===selected?0:-1} onClick={()=>indexes.select(path)} onKeyDown={event=>{
          const next = event.key==='ArrowRight'?(index+1)%folders.length:event.key==='ArrowLeft'?(index-1+folders.length)%folders.length
            :event.key==='Home'?0:event.key==='End'?folders.length-1:-1;
          if (next===-1) return;
          event.preventDefault();indexes.select(folders[next]);event.currentTarget.ownerDocument.getElementById(`${contentId}-${next}`)?.focus();
        }}><Folder size={13}/><span>{name}</span>{folders.some(other=>other!==path&&foldersByPath.get(other)?.name===name)&&<small>{path.split('/').slice(0,-1).join('/')||'根目录'}</small>}</button>;
    })}</div>}
    <div className="quick-open-docs" id={contentId} role={selected?'tabpanel':undefined} aria-labelledby={selected?`${contentId}-${folders.indexOf(selected)}`:undefined}
      data-quick-open-drop="" data-reference-workspace={workspaceId} data-drag-active={dragActive||undefined}
      onDragOver={event=>{if(!Array.from(event.dataTransfer.types).includes(REFERENCE_DRAG_TYPE))return;event.preventDefault();event.dataTransfer.dropEffect='copy';setDragActive(true);}}
      onDragLeave={event=>{if(!event.relatedTarget||!event.currentTarget.contains(event.relatedTarget as Node))setDragActive(false);}}
      onDrop={event=>{
        if(!Array.from(event.dataTransfer.types).includes(REFERENCE_DRAG_TYPE))return;
        event.preventDefault();event.stopPropagation();setDragActive(false);
        const source = readReferenceDrag(event.dataTransfer.getData(REFERENCE_DRAG_TYPE),workspaceId);
        if(source?.type==='folder')bind([source.path]);
        else onDropError('请从当前仓库拖入文件夹。');
      }}>
      {docs.length>0?<ul>{docs.map(doc=><li key={doc.path}><button type="button" title={doc.path} disabled={opening} onClick={()=>void open(doc.path)}><FileText size={15}/><span>{doc.name}</span></button></li>)}</ul>
        :<p>{selected?'此文件夹暂无直属文档。':'从文档树拖入文件夹。'}</p>}
    </div>
    {settings&&<div className="quick-open-settings">
      <div className="quick-open-actions">
        <button type="button" disabled={!room||!available.length||recommending} onClick={()=>{setChoosing(true);setSuggestions([]);onDropError('');}}>创建新索引</button>
        <button type="button" disabled={!selected} onClick={()=>{indexes.remove(selected);onDropError('');}}>关闭当前索引</button>
        <button type="button" disabled={!room||!indexes.candidates.length||!modelConfigured||recommending} onClick={()=>void recommend()}>{recommending?'正在请求 AI…':'AI 推荐索引'}</button>
      </div>
      {room>0&&(!modelConfigured||!indexes.candidates.length)&&<p>{!modelConfigured?'启用模型后可推荐索引。':'打开文件夹或其中的文稿后可推荐索引。'}</p>}
      {choosing&&<form onSubmit={event=>{event.preventDefault();bind([choice]);}}>
        <select aria-label="选择索引文件夹" value={choice} onChange={event=>setChoice(event.target.value)}><option value="">选择文件夹</option>
          {available.map(folder=><option key={folder.path} value={folder.path}>{folder.path}</option>)}
        </select><button type="submit" disabled={!room||!choice}>创建索引</button>
      </form>}
      {suggestions.length>0&&<fieldset><legend>AI 推荐文件夹</legend>
        {availableSuggestions.map(item=><label key={item.path} title={item.path}><input type="checkbox" checked={item.selected}
          onChange={event=>setSuggestions(current=>current.map(option=>option.path===item.path?{...option,selected:event.target.checked}:option))}/>{item.path}</label>)}
        {availableSuggestions.length===0&&<span>推荐的文件夹已变化，请重试。</span>}
        <button type="button" disabled={!picked.length||picked.length>room} onClick={()=>bind(picked.map(item=>item.path))}>创建所选索引</button>
      </fieldset>}
    </div>}
    {(dropError||storageError)&&<p className="quick-open-error" role="alert">{dropError||storageError}</p>}
    <footer className="panel-status-footer quick-open-footer">
      <button className="icon-button" aria-label="快速索引设置" title="快速索引设置" aria-expanded={settings} type="button" onClick={()=>setSettings(value=>!value)}><Settings2 size={15}/></button>
    </footer>
  </div>;
}
