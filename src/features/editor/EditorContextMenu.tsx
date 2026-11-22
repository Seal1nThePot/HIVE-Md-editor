import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {EditorSelection,EditorState} from '@codemirror/state';
import type {EditorView} from '@codemirror/view';
import {selectAll} from '@codemirror/commands';
import {Scissors,Copy,ClipboardPaste,Clipboard,Icon,TextSelect,FileInput,Sparkles} from "../../shared/icons";
import {textForQuickAI} from '../chat/contextDraft';
import {previewPlan} from './markdownPresentation';
import {cellContent,tableSourceSelection} from './tableWidget';
import {tableCell} from './tableViewport';
import './editor-context-menu.css';
import {usePanelDocument} from '../../shared/panelDocument';
import {parseExternalHttpLink} from '../../shared/externalLinks';

export type AnnotationContext={ranges:{from:number;to:number}[];ids:string[]};
export function decodedOffsets(raw:string){const offsets=[0];let pos=0;while(pos<raw.length){const br=/^<br\s*\/?\s*>/i.exec(raw.slice(pos));if(br)pos+=br[0].length;else if(raw[pos]==='\\'&&(raw[pos+1]==='\\'||raw[pos+1]==='|'))pos+=2;else pos++;offsets.push(pos);}return offsets;}


export function clipboardChange(state:EditorState,selection:EditorSelection,inserted:string){const selected=state.update({selection}).state;return selected.changeByRange(range=>({changes:{from:range.from,to:range.to,insert:inserted},range:EditorSelection.cursor(range.from+inserted.length)}));}

export default function EditorContextMenu({editor,point,input,onClose,onMark,onUnmark,annotationId,onShowAnnotations,onError,link,onOpenLink,onDraftSelection}:{
  link?:string;onOpenLink?:(target:string)=>void;editor:EditorView;point:{x:number;y:number;position?:number|null};input?:HTMLTextAreaElement;onClose:()=>void;onMark:()=>void;onUnmark?:(id?:string)=>void;annotationId?:string;onShowAnnotations?:(context:AnnotationContext)=>void;onError?:(message:string)=>void;onDraftSelection?:(text:string,table?:{ordinal:number})=>void;
}){
  const menu=useRef<HTMLDivElement>(null),[position,setPosition]=useState(point);
  const document=usePanelDocument(),window=document.defaultView!;
  const snapshot=useRef(editor.state).current;
  const inputSnapshot=useRef({value:input?.value,start:input?.selectionStart??0,end:input?.selectionEnd??0}).current;
  const {start,end,value:inputValue}=inputSnapshot;
  const tableRange=!input&&onDraftSelection?snapshot.field(tableSourceSelection,false):null;
  const table=tableRange?previewPlan(snapshot).replacements.find(item=>item.kind==='table'&&item.from===tableRange.from&&item.to===tableRange.to):undefined;
  const hasSelection=input?start!==end:snapshot.selection.ranges.some(range=>!range.empty);
  const draftSelection=table?snapshot.sliceDoc(table.from,table.to):!input&&onDraftSelection?textForQuickAI(snapshot,snapshot.selection,point.position):'';
  const readOnly=editor.state.readOnly||!!input?.readOnly;
  const focusTarget=()=>input?.isConnected?input.focus():editor.focus();
  useLayoutEffect(()=>{
    const rect=menu.current?.getBoundingClientRect();if(!rect)return;
    const scale=Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))||1;
    setPosition({x:Math.max(8,Math.min(point.x,window.innerWidth-rect.width-8)),y:Math.max(8,Math.min(point.y,window.innerHeight-rect.height-90*scale))});
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  },[point,document,window]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node))onClose();};
    const close=()=>onClose();
    document.addEventListener('pointerdown',outside,true);window.addEventListener('resize',close);window.addEventListener('blur',close);
    return()=>{document.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',close);window.removeEventListener('blur',close);};
  },[onClose,document,window]);
  function run(action:()=>void){onClose();action();}
  function showLocal(){
    if(!valid()){onError?.('选区或正文已变化，请重新选择。');return;}
    if(!input){onShowAnnotations?.({ranges:snapshot.selection.ranges.map(range=>({from:range.from,to:range.to})),ids:annotationId?[annotationId]:[]});return;}
    const root=input.closest<HTMLElement>('[data-table-widget]'),cell=input.closest<HTMLElement>('[data-cell]');
    const ordinal=Number(root?.dataset.tableOrdinal);
    const table=Number.isFinite(ordinal)?previewPlan(editor.state).replacements.find(item=>item.kind==='table'&&item.tableOrdinal===ordinal):undefined;
    const row=Number(input.dataset.row),col=Number(input.dataset.col),source=table&&tableCell(table,row,col);
    if(!source||source.virtual!==undefined){onError?.('请先选中单元格中的文字。');return;}
    const part=cellContent(source,editor.state.doc),offsets=decodedOffsets(part.raw);
    const from=part.from+(offsets[start]??part.raw.length),to=part.from+(offsets[end]??part.raw.length);
    let ids:string[]=[];try{const parsed=JSON.parse(cell?.dataset.tableAnnotationIds||'[]');if(Array.isArray(parsed))ids=parsed.filter(value=>typeof value==='string');}catch{/* ignore invalid metadata */}
    onShowAnnotations?.({ranges:[{from,to}],ids});
  }
  const valid=()=>editor.dom.isConnected&&editor.state.doc===snapshot.doc&&(!input||input.isConnected&&input.value===inputValue);
  async function clipboard(action:'cut'|'copy'|'paste'|'plain'){
    onClose();
    if(!valid()||action!=='copy'&&(readOnly||editor.state.readOnly||!!input?.readOnly)){onError?.('选区或正文已变化，无法完成操作，请重新选择。');return;}
    const text=input?inputValue!.slice(start,end):snapshot.selection.ranges.filter(range=>!range.empty).map(range=>snapshot.doc.sliceString(range.from,range.to)).join('\n');
    try{
      if(action==='copy'||action==='cut')await window.navigator.clipboard.writeText(text);
      const inserted=action==='paste'||action==='plain'?await window.navigator.clipboard.readText():'';
      if(action!=='copy'){
        if(!valid()||editor.state.readOnly||!!input?.readOnly){onError?.('剪贴板操作期间正文已变化，请重新选择。');return;}
        if(input){input.focus();input.setRangeText(inserted,start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));}
        else {const transaction=clipboardChange(editor.state,snapshot.selection,inserted);editor.dispatch({...transaction,userEvent:action==='cut'?'delete.cut':'input.paste'});editor.focus();}
      }else focusTarget();
    }catch{onError?.(action==='paste'||action==='plain'?'无法读取剪贴板，请检查浏览器权限或使用 Ctrl+V。':'无法写入剪贴板，请检查浏览器权限或使用键盘快捷键。');focusTarget();}
  }
  return createPortal(<div ref={menu} className="editor-context-menu" role="menu" aria-label="文本操作" style={{left:position.x,top:position.y}} onContextMenu={event=>event.preventDefault()}
    onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();focusTarget();return;}
      if(event.key==='Tab'){onClose();return;}
      if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'||event.key==='ArrowRight'?1:buttons.length-1))%buttons.length]?.focus();
    }}>
    <div className="editor-clipboard-toolbar" role="group" aria-label="剪贴板操作">
      <button type="button" role="menuitem" title="剪切" aria-label="剪切" disabled={!hasSelection||readOnly} onClick={()=>void clipboard('cut')}><Scissors size={16}/><span>剪切</span></button>
      <button type="button" role="menuitem" title="复制" aria-label="复制" disabled={!hasSelection} onClick={()=>void clipboard('copy')}><Copy size={16}/><span>复制</span></button>
      <button type="button" role="menuitem" title="粘贴" aria-label="粘贴" disabled={readOnly} onClick={()=>void clipboard('paste')}><ClipboardPaste size={16}/><span>粘贴</span></button>
      <button type="button" role="menuitem" title="纯文本粘贴" aria-label="纯文本粘贴" disabled={readOnly} onClick={()=>void clipboard('plain')}><Clipboard size={16}/><span>纯文本</span></button>
    </div>
    <hr/>
    {link&&onOpenLink&&<button type="button" role="menuitem" onClick={()=>run(()=>onOpenLink(link))}><FileInput size={15}/><span>{parseExternalHttpLink(link)?'在浏览器中打开':'跳转至文件'}</span></button>}
    {!!draftSelection.trim()&&<button type="button" role="menuitem" onClick={()=>run(()=>{if(!valid()){onError?.('正文或选区已变化，请再次打开右键菜单。');return;}onDraftSelection?.(draftSelection,table?{ordinal:table.tableOrdinal??0}:undefined);})}><Sparkles size={15}/><span>添加到 AI 输入框</span></button>}
    {!input&&<button type="button" role="menuitem" disabled={!hasSelection} onClick={()=>run(onMark)}><Icon name="annotation.markSelection" size={15}/><span>标注选区</span><kbd>Ctrl + 单击</kbd></button>}
    {!input&&onUnmark&&<button type="button" role="menuitem" disabled={!hasSelection&&!annotationId} onClick={()=>run(()=>onUnmark(annotationId))}><Icon name="annotation.unmarkSelection" size={15}/><span>取消标注</span></button>}
    {onShowAnnotations&&<button type="button" role="menuitem" onClick={()=>run(showLocal)}><Icon name="annotation.showLocal" size={15}/><span>查看文本标注</span></button>}
    <button type="button" role="menuitem" onClick={()=>run(()=>{if(input){input.focus();input.select();}else{selectAll(editor);editor.focus();}})}><TextSelect size={15}/><span>全选</span><kbd>Ctrl+A</kbd></button>
  </div>,document.body);
}
