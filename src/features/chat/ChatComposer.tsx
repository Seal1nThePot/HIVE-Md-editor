import { useLayoutEffect, useRef, type RefObject } from "react";
import { ArrowUp, Square } from "../../shared/icons";
import { type Config } from '../settings/modelConfig';
import ModelPicker from './ModelPicker';
import type { ReasoningEffort } from './modelReasoning';
import {useShortcutPreferences} from '../settings/ShortcutPreferences';
import {shortcutLabel} from '../settings/shortcuts';
import { composerKeyAction } from './composerKeys';
import {ChatAttachmentList} from './ChatAttachmentList';
import type {ChatAttachment} from './chatAttachments';
export default function ChatComposer({inputRef,value,onChange,onSend,onStop,busy,disabled,placeholder,config,modelBusy,onModelChange,reasoningEffort,onReasoningChange,attachments,onRemoveAttachment,allowAttachmentOnly}: {
  inputRef:RefObject<HTMLTextAreaElement|null>;value:string;onChange:(value:string)=>void;onSend:()=>void;onStop:()=>void;
  busy:boolean;disabled:boolean;placeholder:string;config:Config;modelBusy:boolean;
  onModelChange:(choice:string)=>void; reasoningEffort?:ReasoningEffort; onReasoningChange?:(effort:ReasoningEffort)=>void;
  attachments:readonly ChatAttachment[];onRemoveAttachment:(id:string)=>void;allowAttachmentOnly:boolean;
}){
  const {bindings}=useShortcutPreferences();
  const box=useRef<HTMLFormElement>(null);
  const measure=()=>{
    const input=inputRef.current;if(!input)return;
    input.style.height='0px';const height=Math.max(36,Math.min(128,input.scrollHeight));
    input.style.height=height+'px';input.style.overflowY=input.scrollHeight>128?'auto':'hidden';
  };
  useLayoutEffect(()=>{measure();},[value]);
  useLayoutEffect(()=>{
    let previous=-1;const observer=new ResizeObserver(entries=>{
      const width=entries[0]?.contentRect.width??0;if(Math.abs(width-previous)<1)return;previous=width;measure();
    });if(box.current)observer.observe(box.current);return()=>observer.disconnect();
  },[]);
  const sendable=!disabled&&!busy&&(!!value.trim()||allowAttachmentOnly&&attachments.length>0);
  return <form ref={box} className="composer compact-composer" onSubmit={event=>{event.preventDefault();if(sendable)onSend();}}>
    <ChatAttachmentList attachments={attachments} onRemove={onRemoveAttachment}/>
    <textarea ref={inputRef} aria-label="向 AI 描述想法或修改要求" placeholder={placeholder} value={value} onChange={event=>onChange(event.target.value)}
      onKeyDown={event=>{const action=composerKeyAction({key:event.key,shiftKey:event.shiftKey,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,isComposing:event.nativeEvent.isComposing||event.nativeEvent.keyCode===229,disabled:!sendable,text:value,hasAttachments:allowAttachmentOnly&&attachments.length>0},bindings);if(action!=='send')return;event.preventDefault();onSend();}}/>
    <div className="composer-actions compact-composer-actions">
      <ModelPicker config={config} disabled={modelBusy||busy} onModelChange={onModelChange} reasoningEffort={reasoningEffort} onReasoningChange={onReasoningChange}/>
      {busy?<button type="button" className="send-button stop" aria-label="停止生成" onClick={onStop}><Square size={14}/></button>
        :<button type="submit" className="send-button" aria-label="发送给 AI" title={`发送 · ${shortcutLabel(bindings,'sendMessage')}（Shift + Enter 换行）`} disabled={!sendable}><ArrowUp size={17}/></button>}
    </div>
  </form>;
}

