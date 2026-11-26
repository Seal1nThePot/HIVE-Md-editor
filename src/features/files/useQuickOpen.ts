import {useMemo,useRef,useState} from 'react';
import {flattenEntries,mapEntryPath,type Entry} from './explorerState';

export const quickOpenLimit = 4;
const visitLimit = 48;
type Visit = {path:string;count:number};
type Indexes = {folders:string[];selected:string;visits:Visit[]};
const storageKey = (workspaceId:string) => `hive.quickOpen.v1:${workspaceId}`;
const eligiblePath = (path:unknown):path is string => typeof path === 'string' && path.length > 0 && path.length <= 500
  && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part=>part && !part.startsWith('.'));

function readIndexes(workspaceId:string):Indexes {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(workspaceId)) ?? '{}');
    const folders = Array.isArray(raw?.folders) ? [...new Set<string>(raw.folders.filter(eligiblePath))].slice(0,quickOpenLimit) : [];
    const visits = new Map<string,Visit>();
    if (Array.isArray(raw?.visits)) for (const item of raw.visits.slice(0,visitLimit)) {
      if (eligiblePath(item?.path) && Number.isInteger(item.count) && item.count > 0 && item.count <= 1000000) visits.set(item.path,item);
    }
    return {folders,selected:folders.includes(raw?.selected)?raw.selected:folders[0]||'',visits:[...visits.values()]};
  } catch { return {folders:[],selected:'',visits:[]}; }
}

function countVisit(visits:Visit[],path:string) {
  const count = visits.find(item=>item.path===path)?.count ?? 0;
  return [{path,count:Math.min(count+1,1000000)},...visits.filter(item=>item.path!==path)].slice(0,visitLimit);
}

export function useQuickOpen(workspaceId:string, entries:Entry[]) {
  // The workbench is keyed by workspace ID. All windows are views of this state.
  const [indexes,setIndexes] = useState(()=>readIndexes(workspaceId));
  const current = useRef(indexes);
  const [storageError,setStorageError] = useState('');
  const foldersByPath = useMemo(()=>new Map(flattenEntries(entries).filter(entry=>entry.type==='folder'&&eligiblePath(entry.path)).map(entry=>[entry.path,entry])),[entries]);
  const folders = indexes.folders.filter(path=>foldersByPath.has(path));
  const selected = folders.includes(indexes.selected) ? indexes.selected : folders[0]||'';

  function commit(next:Indexes) {
    current.current = next;
    setIndexes(next);
    try {
      localStorage.setItem(storageKey(workspaceId),JSON.stringify(next));
      setStorageError('');
    } catch { setStorageError('快速索引暂时无法保存，当前窗口中的调整仍有效。'); }
  }

  function select(path:string) {
    const old = current.current;
    if (old.selected===path || !old.folders.includes(path) || !foldersByPath.has(path)) return;
    commit({...old,selected:path,visits:countVisit(old.visits,path)});
  }

  function bind(paths:readonly string[]) {
    const old = current.current;
    const found = [...new Set(paths)].filter(path=>foldersByPath.has(path));
    if (!found.length) return '请从当前仓库选择有效的文件夹。';
    const valid = old.folders.filter(path=>foldersByPath.has(path));
    const fresh = found.filter(path=>!valid.includes(path));
    if (fresh.length && valid.length+fresh.length>quickOpenLimit) return `最多可绑定 ${quickOpenLimit} 个文件夹。`;
    commit({...old,folders:[...valid,...fresh],selected:found[0]});
    return '';
  }

  function remove(path:string) {
    const old = current.current;
    const position = old.folders.indexOf(path);
    if (position === -1) return;
    const next = old.folders.filter(item=>item!==path && foldersByPath.has(item));
    commit({...old,folders:next,selected:next[Math.min(position,next.length-1)]||''});
  }

  function visit(path:string) {
    if (!foldersByPath.has(path)) return;
    const old = current.current;
    commit({...old,visits:countVisit(old.visits,path)});
  }

  function updatePath(from:string,to?:string) {
    const old = current.current;
    const changed = (path:string) => path===from || path.startsWith(`${from}/`);
    const replace = (path:string) => changed(path) ? to ? mapEntryPath(path,from,to) : '' : path;
    const mapped = [...new Set(old.folders.map(replace).filter(eligiblePath))];
    const visits = new Map<string,Visit>();
    for (const visit of old.visits) {
      const path = replace(visit.path);
      if (!eligiblePath(path)) continue;
      visits.set(path,{path,count:Math.min(1000000,visit.count+(visits.get(path)?.count??0))});
    }
    const selectedPath = replace(old.selected);
    if (old.folders.some(changed) || old.visits.some(entry=>changed(entry.path))) {
      commit({folders:mapped,selected:mapped.includes(selectedPath)?selectedPath:mapped[0]||'',visits:[...visits.values()]});
    }
  }

  const candidates = indexes.visits.filter(visit=>foldersByPath.has(visit.path)&&!folders.includes(visit.path))
    .sort((a,b)=>b.count-a.count).slice(0,16);
  return {folders,selected,foldersByPath,candidates,storageError,select,bind,remove,visit,updatePath};
}
