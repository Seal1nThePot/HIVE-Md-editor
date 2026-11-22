import type {WorkspaceInfo} from './WorkspaceContext';

export const recentRepositoriesKey='hive.recentRepositories.v1';
const menuLimit=5;
const storageLimit=512;
let sessionHistory:string[]|undefined;

export function recentRepositoryOrder(raw:unknown,info:Pick<WorkspaceInfo,'id'|'repositories'>):string[] {
  const registered=new Set(info.repositories.map(item=>item.id));
  const result=new Set<string>();
  if(registered.has(info.id))result.add(info.id);
  if(Array.isArray(raw)){
    for(const id of raw){
      if(typeof id==='string'&&registered.has(id))result.add(id);
      if(result.size>=storageLimit)break;
    }
  }
  return [...result];
}

function readHistory(){
  if(sessionHistory)return sessionHistory;
  try{return JSON.parse(localStorage.getItem(recentRepositoriesKey)??'[]') as unknown;}
  catch{return [];}
}

export function rememberRecentRepository(info:WorkspaceInfo){
  const next=recentRepositoryOrder(readHistory(),info);
  sessionHistory=next;
  try{localStorage.setItem(recentRepositoriesKey,JSON.stringify(next));}
  catch{/* Keep the current renderer history usable when persistent storage is unavailable. */}
}

export function recentRepositoryItems(info:WorkspaceInfo){
  const repositories=new Map(info.repositories.map(item=>[item.id,item]));
  return recentRepositoryOrder(readHistory(),info).slice(0,menuLimit).flatMap(id=>{
    const item=repositories.get(id);
    return item?[item]:[];
  });
}
