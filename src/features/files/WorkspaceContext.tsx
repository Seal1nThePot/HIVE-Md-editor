import {createContext, useContext, useMemo, useRef, type ReactNode} from 'react';

export type RepositoryInfo={id:string;root:string;name?:string};
export type RepositoryAction={action:'add';root:string}|{action:'rename';id:string;name:string}|{action:'remove';id:string}|{action:'reorder';order:string[]};
export type WorkspaceInfo={id:string;root:string;defaultRepositoryId:string;autoSave:boolean;revision:number;repositories:RepositoryInfo[]};
export const repositoryName=(root:string)=>root.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||root;
export const repositoryLabel=(item:RepositoryInfo)=>item.name?.trim()||repositoryName(item.root);
type Guard=()=>Promise<string|void>;
type WorkspaceContextValue={info:WorkspaceInfo;request:typeof fetch;update:(patch:Partial<Pick<WorkspaceInfo,'root'|'autoSave'>>)=>Promise<void>;manage:(action:RepositoryAction)=>Promise<void>;adopt:(next:WorkspaceInfo)=>void;register:(guard:Guard)=>()=>void;flush:()=>Promise<void>};
const Context=createContext<WorkspaceContextValue|null>(null);
export function WorkspaceProvider({info,onChange,children}:{info:WorkspaceInfo;onChange:(info:WorkspaceInfo)=>void;children:ReactNode}) {
  const guards=useRef(new Set<Guard>());
  const latestInfo=useRef(info);latestInfo.current=info;
  const request=useMemo<typeof fetch>(()=>(input,init)=>{
    const headers=new Headers(init?.headers);headers.set('X-Hive-Workspace',info.id);
    return fetch(input,{...init,headers});
  },[info.id]);
  async function write(route:string,body:unknown) {
    const response=await request(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const next=await response.json();if(!response.ok)throw new Error(next.error);onChange(next);
  }
  const value:WorkspaceContextValue={info,request,register:guard=>{guards.current.add(guard);return()=>{guards.current.delete(guard);};},
    flush:async()=>{for(const guard of guards.current){const error=await guard();if(error)throw new Error(error);}},
    update:patch=>write('/api/workspace',{...patch,revision:info.revision}),
    adopt:next=>{const current=latestInfo.current;if(next.id===current.id&&next.revision>=current.revision)onChange(next);},
    manage:action=>write('/api/workspace/repositories',{...action,revision:info.revision})};
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useFileWorkspace(){const value=useContext(Context);if(!value)throw new Error('WorkspaceProvider is required');return value;}
