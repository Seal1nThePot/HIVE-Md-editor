import {useSyncExternalStore} from 'react';
import {defaultTheme,isHex,normalizeTheme,readDefaultTheme,readTheme,themeStorageKey,type ThemePreferences} from './themePreferences';
import {applyUserProfile,createTemplateBinding,normalizeWithinTemplate,templateBaseDefaults,userProfileFor,type TemplateBinding,type TemplateIdentity,type TemplateUserProfile} from './templateBinding';
type LegacyTemplateSettings=Record<string,{preferences:ThemePreferences;defaultScheme:ThemePreferences}>;
type Snapshot={preferences:ThemePreferences;defaultScheme:ThemePreferences;saveError:string;templateId:string;templateRevision:string|null;templateDirty:boolean;hadStoredTheme:boolean;hasCachedPalette:boolean;hasSavedTemplateSelection:boolean;oliveGrayRevision:number;oliveGrayBackup?:unknown;templateBinding?:TemplateBinding;templateDefaultRevision?:string|null;templateUsers:Record<string,TemplateUserProfile>;legacyDefaultSchemeBackup?:ThemePreferences;legacyTemplateSettings:LegacyTemplateSettings};
export const defaultTemplateId='claude-olive-gold';
let snapshot:Snapshot|undefined,timer:ReturnType<typeof setTimeout>|undefined;
const listeners=new Set<()=>void>();
export function getThemeSnapshot(){
  if(!snapshot){let value:string|null=null;try{value=localStorage.getItem(themeStorageKey);}catch{}
    let metadata:{version?:unknown;base?:unknown;colors?:{accent?:unknown};colorProfiles?:Record<string,{accent?:unknown}>;templateId?:unknown;templateRevision?:unknown;templateDirty?:unknown;oliveGrayRevision?:unknown;oliveGrayBackup?:unknown;templateBinding?:TemplateBinding;templateDefaultRevision?:string;templateUsers?:Record<string,TemplateUserProfile>;legacyDefaultSchemeBackup?:ThemePreferences;legacyTemplateSettings?:LegacyTemplateSettings}={};try{metadata=JSON.parse(value||'{}')||{};}catch{}
    const base=metadata.base,hasCachedPalette=metadata.version===1&&typeof base==='string'&&['black','white','gray','custom'].includes(base)&&isHex(metadata.colorProfiles?.[base]?.accent??metadata.colors?.accent);
    const savedTemplateId=typeof metadata.templateId==='string'&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(metadata.templateId)?metadata.templateId:undefined;
    snapshot={preferences:readTheme(value),defaultScheme:readDefaultTheme(value),saveError:'',templateId:savedTemplateId??(metadata.version===1?'olive-gold':defaultTemplateId),templateRevision:typeof metadata.templateRevision==='string'&&/^[a-f0-9]{64}$/.test(metadata.templateRevision)?metadata.templateRevision:null,templateDirty:metadata.templateDirty===true,hadStoredTheme:metadata.version===1,hasCachedPalette,hasSavedTemplateSelection:savedTemplateId!==undefined,oliveGrayRevision:metadata.oliveGrayRevision===2?2:0,oliveGrayBackup:metadata.oliveGrayBackup,templateUsers:metadata.templateUsers&&typeof metadata.templateUsers==='object'?metadata.templateUsers:{},templateDefaultRevision:metadata.templateDefaultRevision,legacyDefaultSchemeBackup:metadata.legacyDefaultSchemeBackup,legacyTemplateSettings:metadata.legacyTemplateSettings&&typeof metadata.legacyTemplateSettings==='object'&&!Array.isArray(metadata.legacyTemplateSettings)?metadata.legacyTemplateSettings:{}};
    try{if(metadata.templateBinding?.id===snapshot.templateId){snapshot.templateBinding=createTemplateBinding(metadata.templateBinding,metadata.templateBinding.defaults);snapshot.preferences=normalizeWithinTemplate(snapshot.preferences,snapshot.templateBinding);snapshot.defaultScheme=normalizeWithinTemplate(snapshot.defaultScheme,snapshot.templateBinding);}}catch{/* Keep the previous raw preference available until a valid template is read. */}
  }
  return snapshot;
}
export function subscribeTheme(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};}
function publish(){listeners.forEach(fn=>fn());}
function captureUser(current:Snapshot):Snapshot{return current.templateBinding?{...current,templateUsers:{...current.templateUsers,[current.templateId]:userProfileFor(current.templateBinding,current.preferences,current.defaultScheme)}}:current;}
export function flushThemePreferences(){
  clearTimeout(timer);timer=undefined;
  const current=captureUser(getThemeSnapshot());let saveError='';
  try{localStorage.setItem(themeStorageKey,JSON.stringify({...current.preferences,defaultScheme:current.defaultScheme,templateId:current.templateId,templateRevision:current.templateRevision,templateDirty:false,oliveGrayRevision:current.oliveGrayRevision,oliveGrayBackup:current.oliveGrayBackup,templateBinding:current.templateBinding,templateDefaultRevision:current.templateDefaultRevision,templateUsers:current.templateUsers,legacyDefaultSchemeBackup:current.legacyDefaultSchemeBackup,legacyTemplateSettings:current.legacyTemplateSettings}));}
  catch{saveError='配色已应用，但无法保存到本机。';}
  snapshot={...current,saveError,templateDirty:!!saveError};if(saveError!==current.saveError||current.templateDirty!==snapshot.templateDirty)publish();
  return !saveError;
}
export function setTheme(next:ThemePreferences|((old:ThemePreferences)=>ThemePreferences)){
  const old=getThemeSnapshot(),previous=old.preferences,candidate=typeof next==='function'?next(previous):next;
  const dockEdited=candidate.base===previous.base&&candidate.writingDock!==previous.writingDock&&candidate.writingDockProfiles===previous.writingDockProfiles;
  const colorsEdited=candidate.base===previous.base&&candidate.colors!==previous.colors&&candidate.colorProfiles===previous.colorProfiles;
  const withColors=colorsEdited?{...candidate,colorProfiles:{...candidate.colorProfiles,[candidate.base]:candidate.colors}}:candidate;
  let preferences=normalizeTheme(dockEdited?{...withColors,writingDockProfiles:{...candidate.writingDockProfiles,[candidate.base]:candidate.writingDock}}:withColors);
  if(old.templateBinding)preferences=normalizeWithinTemplate(preferences,old.templateBinding);
  snapshot={...old,preferences,saveError:'',templateDirty:true};publish();
  // Native color pickers emit many input events; persist the latest after a pause.
  clearTimeout(timer);timer=setTimeout(flushThemePreferences,200);
}
export function saveDefaultTheme(){
  const current=getThemeSnapshot();snapshot={...current,defaultScheme:normalizeTheme(current.preferences),templateDirty:true};publish();
  return flushThemePreferences();
}
export function restoreDefaultTheme(){setTheme(getThemeSnapshot().defaultScheme);flushThemePreferences();}
export function adoptThemeTemplate(id:string,revision:string|null,preferences:ThemePreferences,defaultScheme?:ThemePreferences){
  const current=getThemeSnapshot();snapshot={...current,templateId:id,templateRevision:revision,templateDirty:revision===null,preferences:normalizeTheme(preferences),defaultScheme:normalizeTheme(defaultScheme??preferences),saveError:''};publish();flushThemePreferences();
}
export function acknowledgeThemeFile(id:string,revision:string,preferences:ThemePreferences,defaultScheme:ThemePreferences){
  const current=getThemeSnapshot();if(current.templateId!==id)return;
  snapshot={...current,templateRevision:revision,templateDirty:current.preferences!==preferences||current.defaultScheme!==defaultScheme};publish();flushThemePreferences();
}
export function bindThemeTemplate(identity:TemplateIdentity,revision:string|null,defaultsRevision:string|null,defaults:ThemePreferences,legacy?:ThemePreferences){
  const previous=captureUser(getThemeSnapshot()),binding=createTemplateBinding(identity,defaults);
  let legacyTemplateSettings=previous.legacyTemplateSettings;
  if(!previous.templateBinding&&previous.hadStoredTheme&&previous.templateId!==identity.id){
    legacyTemplateSettings={...legacyTemplateSettings,[previous.templateId]:{preferences:previous.preferences,defaultScheme:previous.defaultScheme}};
  }
  let profile=Object.hasOwn(previous.templateUsers,identity.id)?previous.templateUsers[identity.id]:undefined;
  const priorPalette=Object.hasOwn(legacyTemplateSettings,identity.id)?legacyTemplateSettings[identity.id]:undefined;
  if(!profile&&previous.templateId===identity.id&&previous.hadStoredTheme){
    const preferences=normalizeWithinTemplate(previous.preferences,binding),saved=templateBaseDefaults(binding,preferences.base);
    profile=userProfileFor(binding,preferences,saved);
  }else if(!profile&&priorPalette?.preferences&&priorPalette.defaultScheme){
    profile=userProfileFor(binding,normalizeTheme(priorPalette.preferences),normalizeTheme(priorPalette.defaultScheme));
  }else if(!profile&&legacy){const preferences=normalizeWithinTemplate(legacy,binding);profile=userProfileFor(binding,preferences,templateBaseDefaults(binding,preferences.base));}
  const applied=applyUserProfile(binding,profile);
  snapshot={...previous,...applied,templateId:identity.id,templateBinding:binding,templateRevision:revision,templateDefaultRevision:defaultsRevision,templateDirty:false,saveError:'',legacyDefaultSchemeBackup:previous.legacyDefaultSchemeBackup??(!previous.templateBinding?previous.defaultScheme:undefined),legacyTemplateSettings};publish();flushThemePreferences();
}
export function restoreTemplateBase(){
  const current=getThemeSnapshot();if(!current.templateBinding)throw new Error('模板尚未读取完成，请稍后重试。');
  const base=current.preferences.base,reference=templateBaseDefaults(current.templateBinding,base);
  setTheme(old=>({...old,reasoningTrackProfiles:Object.fromEntries(Object.entries({...old.reasoningTrackProfiles,[base]:reference.reasoningTrackProfiles?.[base]}).filter(([,value])=>value!==undefined)),colors:reference.colors,colorProfiles:{...old.colorProfiles,[base]:reference.colors},surfaceColors:{...old.surfaceColors,[base]:reference.surfaceColors[base]},writingDock:reference.writingDock,writingDockProfiles:{...old.writingDockProfiles,[base]:reference.writingDock},editorProfiles:Object.fromEntries(Object.entries({...old.editorProfiles,[base]:reference.editorProfiles[base]}).filter(([,value])=>value!==undefined)),dockingProfiles:Object.fromEntries(Object.entries({...old.dockingProfiles,[base]:reference.dockingProfiles[base]}).filter(([,value])=>value!==undefined))}));
  return flushThemePreferences();
}
if(typeof window!=='undefined'){
  window.addEventListener('pagehide',()=>{if(timer!==undefined)flushThemePreferences();});
  window.addEventListener('blur',()=>{if(timer!==undefined)flushThemePreferences();});
}
const serverSnapshot:Snapshot={preferences:defaultTheme,defaultScheme:defaultTheme,saveError:'',templateId:'',templateRevision:null,templateDirty:false,hadStoredTheme:false,hasCachedPalette:false,hasSavedTemplateSelection:false,oliveGrayRevision:2,templateUsers:{},legacyTemplateSettings:{}};
export function useTheme(){return {...useSyncExternalStore(subscribeTheme,getThemeSnapshot,()=>serverSnapshot),setTheme,saveDefaultTheme,restoreDefaultTheme,restoreTemplateBase};}
