import {useSyncExternalStore} from 'react';
import type {IconOverrides} from '../../../shared/iconPack.mjs';
import {setIconOverrides} from '../../shared/icons';
import {normalizeTheme,type BaseColor,type ThemePreferences} from './themePreferences';
import {defaultTemplateId,bindThemeTemplate,flushThemePreferences,getThemeSnapshot} from './themeStore';

export type TemplateInfo={version:1;id:string;name:string;description:string;bases:BaseColor[];colorsFile:'colors.json';directory:string};
type IconPack={version:1;icons:IconOverrides;warning:string;packRevision:string};
type TemplateRecord={template:TemplateInfo;directory:string;colors:ThemePreferences;revision:string|null;defaults?:ThemePreferences;defaultsRevision?:string|null;iconPack?:IconPack;iconPackUnchanged?:boolean};
type Catalog={directory:string;sourceDirectory?:string|null;templates:TemplateInfo[];warnings:string[]};
type Snapshot=Catalog&{status:'idle'|'loading'|'ready'|'saving'|'error';error:string;iconWarning:string};
let snapshot:Snapshot={directory:'',templates:[],warnings:[],status:'idle',error:'',iconWarning:''};
const listeners=new Set<()=>void>();
let boot:Promise<void>|undefined,saving:Promise<boolean>|undefined,polling=false,pollTimer:ReturnType<typeof setInterval>|undefined;
let selection=0,selecting=0,iconRequest=0;
let appliedIconPack:{id:string;revision:string}|undefined;
const publish=(patch:Partial<Snapshot>)=>{snapshot={...snapshot,...patch};listeners.forEach(fn=>fn());};
export const getTemplateFilesSnapshot=()=>snapshot;
export function subscribeTemplateFiles(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export function useTemplateFiles(){return useSyncExternalStore(subscribeTemplateFiles,getTemplateFilesSnapshot,getTemplateFilesSnapshot);}
async function api<T>(url:string,body?:unknown):Promise<T>{
  const response=await fetch('/api/templates'+url,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'模板文件操作失败。');return data;
}
const route=(id:string)=>'/'+encodeURIComponent(id);
function bind(record:TemplateRecord,legacy=false){bindThemeTemplate(record.template,record.revision,record.defaultsRevision??record.revision,record.defaults??record.colors,legacy?record.colors:undefined);}
function publishIconWarning(iconWarning:string){if(snapshot.iconWarning!==iconWarning)publish({iconWarning});}
function applyIconPack(id:string,pack?:IconPack){
  setIconOverrides(pack?.icons);publishIconWarning(pack?.warning??'');
  appliedIconPack=pack?.packRevision?{id,revision:pack.packRevision}:undefined;
}
async function loadStartupIcons(id:string,selected:number){
  const request=++iconRequest;
  const isCurrent=()=>request===iconRequest&&selected===selection&&getThemeSnapshot().templateId===id;
  try{const pack=await api<IconPack>(route(id)+'/icons');if(isCurrent())applyIconPack(id,pack);}
  catch(error){if(isCurrent())publishIconWarning(`模板图标暂不可用：${(error as Error).message}`);}
}
export async function refreshTemplateCatalog(){const catalog=await api<Catalog>('');if(JSON.stringify(catalog)!==JSON.stringify({directory:snapshot.directory,sourceDirectory:snapshot.sourceDirectory,templates:snapshot.templates,warnings:snapshot.warnings}))publish(catalog);return catalog;}
export async function pollTemplateFiles(){
  if(polling||saving||selecting||snapshot.status==='idle'||snapshot.status==='loading')return;
  polling=true;const selected=selection;
  try{
    await refreshTemplateCatalog();if(selected!==selection||saving)return;
    const before=getThemeSnapshot(),id=before.templateId,request=++iconRequest;
    const query=appliedIconPack?.id===id?'?iconPackRevision='+encodeURIComponent(appliedIconPack.revision):'';
    const record=await api<TemplateRecord>(route(id)+query);
    const current=getThemeSnapshot();if(selected!==selection||current.templateId!==before.templateId)return;
    if(request===iconRequest&&!record.iconPackUnchanged)applyIconPack(id,record.iconPack);
    if(current.preferences!==before.preferences||current.defaultScheme!==before.defaultScheme||saving)return;
    if(record.revision!==current.templateRevision||(record.defaultsRevision??record.revision)!==current.templateDefaultRevision||record.template.name!==current.templateBinding?.name||JSON.stringify(record.template.bases)!==JSON.stringify(current.templateBinding?.bases))bind(record);
    if(snapshot.status==='error')publish({status:'ready',error:''});
  }catch(error){if(selected===selection)publish({status:'error',error:'模板自动同步暂不可用：'+(error as Error).message});}finally{polling=false;}
}
function startPolling(){if(pollTimer!==undefined)return;pollTimer=setInterval(()=>{void pollTemplateFiles();},1500);if(typeof window!=='undefined')window.addEventListener('focus',()=>{void pollTemplateFiles();});}
export function initializeThemeFiles(){
  if(boot)return boot;publish({status:'loading',error:''});const selected=selection;
  boot=(async()=>{
    const catalog=await refreshTemplateCatalog();if(selected!==selection||selecting)return;
    const before=getThemeSnapshot();
    const id=(catalog.templates.find(item=>item.id===before.templateId)??catalog.templates.find(item=>item.id===defaultTemplateId)??catalog.templates[0])?.id;
    if(!id)throw new Error('没有可用模板，请检查模板文件夹。');
    const record=await api<TemplateRecord>(route(id)+'?colorsOnly=1');if(selected!==selection)return;
    if(getThemeSnapshot().preferences!==before.preferences)throw new Error('读取期间配色已变化，当前调整已保留。');
    bind(record,true);flushThemePreferences();publish({status:'ready',error:''});startPolling();
    void loadStartupIcons(id,selected);
  })().catch(error=>{if(selected===selection){publish({status:'error',error:(error as Error).message});boot=undefined;}});return boot;
}
// Personal edits, reset and shutdown never write template files.
export async function flushThemeFiles(){return flushThemePreferences();}
export async function saveCurrentTemplate():Promise<boolean>{
  if(saving)return saving;if(!boot)await initializeThemeFiles();const before=getThemeSnapshot();if(!before.templateBinding)return false;publish({status:'saving',error:''});
  saving=(async()=>{try{const record=await api<TemplateRecord>(route(before.templateId),{revision:before.templateRevision,colors:normalizeTheme(before.preferences)});if(getThemeSnapshot().templateId===before.templateId)bind(record);publish({status:'ready',error:''});return true;}catch(error){publish({status:'error',error:(error as Error).message});return false;}})();
  try{return await saving;}finally{saving=undefined;}
}
export async function loadTemplateFile(id:string){
  const selected=++selection;selecting=selected;
  try{
    if(saving)await saving;if(selected!==selection)return;
    if(!flushThemePreferences())throw new Error('用户配色尚未保存，请先处理本机保存提示。');
    const before=getThemeSnapshot(),record=await api<TemplateRecord>(route(id));if(selected!==selection)return;
    if(getThemeSnapshot().preferences!==before.preferences||getThemeSnapshot().defaultScheme!==before.defaultScheme)throw new Error('读取期间配色已变化，当前调整已保留。');
    bind(record,true);applyIconPack(id,record.iconPack);flushThemePreferences();publish({status:'ready',error:''});startPolling();
  }catch(error){
    if(selected!==selection)return;
    if(snapshot.status==='loading'){boot=undefined;publish({status:'error',error:(error as Error).message});}
    throw error;
  }finally{if(selecting===selected)selecting=0;}
}
export async function openCurrentTemplateFolder(){await initializeThemeFiles();return api<{ok:true;directory:string}>(route(getThemeSnapshot().templateId)+'/open',{});}
