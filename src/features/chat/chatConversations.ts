import type {Dispatch,SetStateAction} from 'react';
import type {SubmittedAnnotation} from '../annotations/annotations';
import type {WindowMark} from '../annotations/windowAnnotations';
import type {ChatAttachment} from './chatAttachments';
import {hello,type Message} from './chatTypes';
import type {InputBasisRequest} from './InputBasisPanel';

export type ChatRoute = {kind:'annotations';items:SubmittedAnnotation[]} | {kind:'window';mark:WindowMark};
export type ChatDraft = {
  text:string;
  attachments:readonly ChatAttachment[];
  route?:ChatRoute;
  retryTurnId?:string;
};
export type Conversation = {
  id:string;
  label:string;
  messages:Message[];
  draft:ChatDraft;
  parked:ChatDraft[];
  lastRequest:InputBasisRequest|null;
};

export const emptyDraft:ChatDraft={text:'',attachments:[]};
export const hasChatDraft=({text,attachments,route}:ChatDraft)=>!!(text.trim()||attachments.length||route);

export function newConversation(id:string,label:string,messages:Message[]=[hello]):Conversation {
  return {id,label,messages,draft:emptyDraft,parked:[],lastRequest:null};
}

export function updateDraftText(draft:ChatDraft,action:SetStateAction<string>):ChatDraft {
  return {...draft,text:typeof action==='function'?action(draft.text):action};
}

export function consumeChatDraft(current:ChatDraft,sent:ChatDraft):ChatDraft {
  if(current===sent)return emptyDraft;
  return {
    text:current.text===sent.text?'':current.text,
    attachments:current.attachments.filter(item=>!sent.attachments.includes(item)),
    route:current.route===sent.route?undefined:current.route,
    retryTurnId:current.retryTurnId===sent.retryTurnId?undefined:current.retryTurnId,
  };
}

export function recoverChatDraft(chat:Conversation,draft:ChatDraft):Conversation {
  if(chat.draft===draft)return chat;
  return {...chat,draft,parked:hasChatDraft(chat.draft)?[chat.draft,...chat.parked]:chat.parked};
}

export function restoreParkedDraft(chat:Conversation):Conversation {
  const [draft,...rest]=chat.parked;
  if(!draft)return chat;
  return {...chat,draft,parked:hasChatDraft(chat.draft)?[...rest,chat.draft]:rest};
}

export function retractChatReply(chat:Conversation,replyId:string):Conversation {
  const reply=chat.messages.find(message=>message.id===replyId&&message.role==='assistant');
  if(!reply?.turnId)return chat;
  const prompt=chat.messages.find(message=>message.role==='user'&&message.turnId===reply.turnId);
  if(!prompt?.draft)return chat;
  return recoverChatDraft({...chat,messages:chat.messages.filter(message=>message.id!==replyId)},{...prompt.draft,retryTurnId:reply.turnId});
}

export function withoutRetriedPrompt(messages:Message[],retryTurnId?:string):Message[] {
  return retryTurnId?messages.filter(message=>message.role!=='user'||message.turnId!==retryTurnId):messages;
}

export function forkChatReply(chat:Conversation,replyId:string,id:string,label:string):Conversation|null {
  const end=chat.messages.findIndex(message=>message.id===replyId&&message.role==='assistant'&&!!message.turnId);
  return end<0?null:newConversation(id,label,chat.messages.slice(0,end+1));
}

export function chatPromptSetter(update:(update:(chat:Conversation)=>Conversation)=>void):Dispatch<SetStateAction<string>> {
  return action=>update(chat=>({...chat,draft:updateDraftText(chat.draft,action)}));
}
