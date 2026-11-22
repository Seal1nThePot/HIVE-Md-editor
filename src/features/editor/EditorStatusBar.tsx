import {useEffect,useMemo,useState} from 'react';
import type {EditorState} from '@codemirror/state';
import {Settings2} from "../../shared/icons";
import {countDescription,defaultStatus,documentStatistics,emptyDocumentStatistics,normalizeStatusOptions,paragraphDescription,readStatusOptions,statusLabel,textStatistics,type CountMode,type DocumentStatistics,type StatusKey,type StatusOptions} from './statusModel';
import './status-bar-settings.css';
import {cachedDocumentStatistics} from './statusModel';
import {requestDocumentStatistics,requestSelectionStatistics} from './statisticsService';
import {usePanelActivity} from '../../shared/panelActivity';
export {defaultStatus,normalizeStatus,statusItems,type StatusKey} from './statusModel';
export {default as StatusBarSettings} from './StatusBarSettings';

export function useStatusPreferences(){
  const [items,setItems]=useState<StatusOptions>(()=>{try{return readStatusOptions(localStorage);}catch{return normalizeStatusOptions(null);}}),[error,setError]=useState('');
  // Accept the earlier array-shaped state retained by React's live update.
  const options=normalizeStatusOptions(items);
  function setOptions(next:StatusOptions){const normalized=normalizeStatusOptions(next);setItems(normalized);try{localStorage.setItem('hive.editor-status.v3',JSON.stringify({version:3,...normalized}));setError('');}catch{setError('底部栏设置暂时无法保存，当前调整仍生效。');}}
  return {...options,error,setOptions,setItems:(items:StatusKey[])=>setOptions({...options,items}),setCountMode:(countMode:CountMode)=>setOptions({...options,countMode}),reset:()=>setOptions({items:[...defaultStatus],countMode:'characters'})};
}
export type StatusPreferences=ReturnType<typeof useStatusPreferences>;
function useDocumentStatistics(state:EditorState|null,enabled:boolean){
  const doc=state?.doc,background=!!doc&&doc.length>100000;
  const [result,setResult]=useState<{doc:typeof doc;value?:DocumentStatistics;error?:string}>({doc:undefined});
  useEffect(()=>{if(!doc||!enabled||!background)return;return requestDocumentStatistics(doc,next=>setResult({doc,...next}));},[doc,enabled,background]);
  if(!doc||!enabled)return {value:emptyDocumentStatistics};
  if(!background)return {value:documentStatistics(doc)};
  return {value:cachedDocumentStatistics(doc)||(result.doc===doc?result.value:undefined),error:result.doc===doc?result.error:undefined};
}
function useSelectedStatistics(state:EditorState|null,enabled:boolean){
  const doc=state?.doc,selection=state?.selection;
  const ranges=useMemo(()=>enabled?selection?.ranges.filter(range=>!range.empty)||[]:[],[selection,enabled]);
  const background=ranges.reduce((sum,range)=>sum+range.to-range.from,0)>100000;
  const parts=useMemo(()=>background&&doc?ranges.map(range=>doc.slice(range.from,range.to)):[],[doc,ranges,background]);
  const full=!!doc&&ranges.length===1&&ranges[0].from===0&&ranges[0].to===doc.length;
  const [result,setResult]=useState<{parts:typeof parts;value?:ReturnType<typeof textStatistics>;error?:string}>({parts:[]});
  useEffect(()=>{
    if(!background||!doc)return;
    const listener=(next:{value?:ReturnType<typeof textStatistics>;error?:string})=>setResult({parts,...next});
    return full?requestDocumentStatistics(doc,listener):requestSelectionStatistics(parts,listener);
  },[doc,parts,background,full]);
  const immediate=useMemo(()=>{
    if(background||!doc)return undefined;
    return ranges.reduce((sum,range)=>{const part=textStatistics(doc.sliceString(range.from,range.to));return {characters:sum.characters+part.characters,pureCount:sum.pureCount+part.pureCount,paragraphs:sum.paragraphs+part.paragraphs};},{characters:0,pureCount:0,paragraphs:0});
  },[doc,ranges,background]);
  return background?{value:full?cachedDocumentStatistics(doc!)||(result.parts===parts?result.value:undefined):result.parts===parts?result.value:undefined,error:result.parts===parts?result.error:undefined}:{value:immediate};
}
export default function EditorStatusBar({state,eol,bom,status,aiStatus,preferences,onSettings}:{status:string;aiStatus?:string;state:EditorState|null;eol?:string;bom?:boolean;preferences:StatusPreferences;onSettings:()=>void}){
  const active=usePanelActivity();
  const {value:statistics,error:statisticsError}=useDocumentStatistics(state,active&&(preferences.items.includes('count')||preferences.items.includes('paragraphs')||preferences.items.includes('narrationDialogue')||preferences.items.includes('averageParagraphLength'))),mode=preferences.countMode;
  const selected=useSelectedStatistics(state,active&&preferences.items.includes('selection'));
  const pos=state?.selection.main.head||0,line=state?.doc.lineAt(pos);
  const pending=statisticsError||'统计中…';
  const narrationTotal=statistics?statistics.narrationCount+statistics.dialogueCount:0,narrationShare=statistics&&narrationTotal>0?Math.round(statistics.narrationCount/narrationTotal*100):null;
  const narrationValue=!statistics?pending:narrationShare===null?'—':`叙述 ${narrationShare}% / 对话 ${100-narrationShare}%`;
  const averageParagraphValue=!statistics?pending:statistics.averageParagraphLength===null?'—':`平均 ${statistics.averageParagraphLength.toLocaleString(undefined,{maximumFractionDigits:1})} 字/段`;
  const values:Record<StatusKey,string>={save:status,count:'',selection:selected.value?`已选 ${mode==='text'?selected.value.pureCount:selected.value.characters} ${mode==='text'?'字':'字符'}`:selected.error||'选中统计中…',position:`行 ${line?.number||1}，列 ${pos-(line?.from||0)+1}`,lines:`${state?.doc.lines||1} 行`,paragraphs:statistics?`${statistics.paragraphs.toLocaleString()} 段`:pending,narrationDialogue:narrationValue,averageParagraphLength:averageParagraphValue,eol:eol||'LF',encoding:bom?'UTF-8 BOM':'UTF-8',format:'Markdown'};
  return <div className="editor-status-bar panel-status-footer" aria-label="写作区底部栏" onContextMenu={event=>{event.preventDefault();onSettings();}}><div className="editor-status-items">{preferences.items.map(key=>key==='save'?<span key={key} className="editor-save-status" role="status" aria-label="写作与保存状态"><i className="status-dot"/>{status}{aiStatus&&<span> · {aiStatus}</span>}</span>:key==='count'?<select key={key} className="editor-count-mode" aria-label="字数统计方式" title={countDescription} value={mode} onChange={event=>preferences.setCountMode(event.target.value==='text'?'text':'characters')}><option value="characters">{statistics?`${statistics.characters.toLocaleString()} 字符`:pending}</option><option value="text">{statistics?`${statistics.pureCount.toLocaleString()} 字`:pending}</option></select>:<span key={key} title={key==='paragraphs'?paragraphDescription:statusLabel(key)} aria-label={key==='narrationDialogue'||key==='averageParagraphLength'?`${statusLabel(key)}：${values[key]}`:undefined}>{values[key]}</span>)}</div><button type="button" aria-label="自定义写作区底部栏" title="自定义底部栏" onClick={onSettings}><Settings2 size={12}/></button></div>;
}
