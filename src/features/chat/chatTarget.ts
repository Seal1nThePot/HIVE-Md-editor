import type {EditorState} from '@codemirror/state';
import type {SubmittedAnnotation} from '../annotations/annotations';
import type {WindowMark} from '../annotations/windowAnnotations';

const noteTools=['search','properties','outline'];
export const isNoteTool=(id:string)=>noteTools.includes(id);
export const isWindowTool=(id:string)=>isNoteTool(id)||['files','trash','repositories'].includes(id);
const fileLabel=(file:string)=>file.split('/').at(-1)||file;

export type ChatTarget =
  | {kind:'document';label:string;file?:string}
  | {kind:'annotations';label:string;file?:string;items:SubmittedAnnotation[]}
  | {kind:'window';label:string;file?:string;mark:WindowMark;noteState?:EditorState}
  | {kind:'invalid';label:string;file?:never;error:string};

export function resolveChatTarget({marks,workspaceId,documentFile,hasDocument,annotations,lookupNote,panelLabel}: {
  marks:readonly WindowMark[];
  workspaceId:string;
  documentFile?:string;
  hasDocument:boolean;
  annotations?:SubmittedAnnotation[];
  lookupNote:(id:string,file:string)=>EditorState|undefined;
  panelLabel:(id:string)=>string;
}):ChatTarget {
  if(annotations){
    const files=[...new Set(annotations.map(item=>item.source==='scratch'?'':item.file))];
    const [file]=files;
    return {kind:'annotations',label:files.length===1?(file?fileLabel(file):'草稿'):'多处文本标注',file:files.length===1?file||undefined:undefined,items:annotations};
  }
  if(!marks.length)return {kind:'document',label:documentFile?fileLabel(documentFile):hasDocument?'未命名稿':'未打开文档',file:documentFile};
  if(marks.length!==1)return {kind:'invalid',label:'多个窗口标注',error:'请在本轮保留一个需要操作的窗口标注。'};
  const [mark]=marks, label=panelLabel(mark.id), file=mark.document?.file;
  if(mark.workspaceId!==workspaceId)return {kind:'invalid',label,error:'标注的仓库已切换，请重新标注。'};
  if(!isNoteTool(mark.id))return {kind:'window',label,mark};
  if(!mark.document||!file)return {kind:'invalid',label,error:'请先让窗口对应一篇已打开的 Markdown 笔记，再重新标注。'};
  const noteState=lookupNote(mark.document.sessionId,file);
  if(!noteState)return {kind:'invalid',label,error:'这条'+label+'标注的笔记已关闭或变更，请重新标注。'};
  return {kind:'window',label:`${label} · ${fileLabel(file)}`,file,mark,noteState};
}
