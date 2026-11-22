import {EditorState,StateEffect} from '@codemirror/state';
import {useMemo} from 'react';
import Editor,{makeState} from '../editor/Editor';
import './trash-panel.css';

export type TrashDocument={id:string;path:string;text:string};

export async function loadTrashDocument(request:typeof fetch,id:string,signal?:AbortSignal):Promise<TrashDocument>{
  const response=await request('/api/explorer/trash/document?id='+encodeURIComponent(id),{signal});
  const data=await response.json();
  if(!response.ok)throw new Error(data?.error||'无法读取回收站文稿。');
  if(!data||data.id!==id||typeof data.path!=='string'||typeof data.text!=='string')throw new Error('回收站文稿数据无效。');
  return {id:data.id,path:data.path,text:data.text};
}

const ignoreEditorUpdate=()=>{};

export function trashPreviewState(text:string){
  const preview=makeState(text,ignoreEditorUpdate,'回收站文稿预览','preview');
  return preview.update({effects:StateEffect.appendConfig.of(EditorState.changeFilter.of(()=>false))}).state;
}

export default function TrashDocumentPreview({preview}:{preview:TrashDocument}){
  const state=useMemo(()=>trashPreviewState(preview.text),[preview]);
  return <section className="trash-document-preview" aria-label="回收站文稿预览" data-trash-id={preview.id}>
    <Editor key={preview.id} initialState={state} displayMode="preview" onReady={ignoreEditorUpdate} onUpdate={ignoreEditorUpdate}/>
  </section>;
}
