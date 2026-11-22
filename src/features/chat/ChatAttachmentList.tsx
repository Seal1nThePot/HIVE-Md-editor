import {useLayoutEffect,useRef,useState} from 'react';
import {FileText,Table2,X} from '../../shared/icons';
import type {ChatAttachment} from './chatAttachments';

export function ChatAttachmentList({attachments,onRemove}:{
  attachments:readonly ChatAttachment[];
  onRemove?:(id:string)=>void;
}) {
  const [selected,setSelected]=useState<ChatAttachment|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  useLayoutEffect(()=>{
    if(selected&&!dialog.current?.open)dialog.current?.showModal();
  },[selected]);
  if(!attachments.length&&!selected)return null;
  return <>
    <div className="chat-attachments" aria-label={onRemove?'待发送附件':'已发送附件'}>
      {attachments.map(item=><div className="chat-attachment-chip" key={item.id}>
        <button type="button" className="chat-attachment-open" data-attachment-kind={item.kind} title={item.file||item.label} aria-label={`查看附件 ${item.label}`} onClick={()=>setSelected(item)}>
          {item.kind==='table'?<Table2 size={13}/>:<FileText size={13}/>}<span>{item.label}</span>
        </button>
        {onRemove&&<button type="button" className="chat-attachment-remove" aria-label={`移除附件 ${item.label}`} onClick={()=>onRemove(item.id)}><X size={12}/></button>}
      </div>)}
    </div>
    {selected&&<dialog className="chat-attachment-preview" ref={dialog} aria-label={`附件预览 ${selected.label}`} onClose={()=>setSelected(null)}>
      <header><strong>{selected.label}</strong><button type="button" className="icon-button" aria-label="关闭附件预览" onClick={()=>dialog.current?.close()}><X size={16}/></button></header>
      <pre>{selected.text}</pre>
    </dialog>}
  </>;
}
