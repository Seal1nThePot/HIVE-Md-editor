import {describe,expect,it} from 'vitest';
import {appendChatAttachments,type ChatAttachment} from './chatAttachments';
import {consumeChatDraft,forkChatReply,newConversation,restoreParkedDraft,retractChatReply,withoutRetriedPrompt,type ChatDraft} from './chatConversations';
import type {Message} from './chatTypes';
import {resolveChatTarget} from './chatTarget';

const attachment:ChatAttachment={id:'attachment',kind:'table',label:'Selected table',file:'notes/B.md',text:'| Header |\n| --- |\n| second |'};
const first:ChatDraft={text:'first question',attachments:[attachment]};
const localDraft:ChatDraft={text:'new unsent draft',attachments:[]};
const messages:Message[]=[
  {id:'ask-1',role:'user',content:first.text,turnId:'turn-1',draft:first},
  {id:'answer-1',role:'assistant',content:'first answer',turnId:'turn-1'},
  {id:'ask-2',role:'user',content:'second question',turnId:'turn-2'},
  {id:'answer-2',role:'assistant',content:'second answer',turnId:'turn-2'},
];

describe('chat turn identity and snapshots',()=>{
  it('retracts one middle reply, preserves the other turn and parks the current draft',()=>{
    const chat={...newConversation('original','对话 1',messages),draft:localDraft};
    const updated=retractChatReply(chat,'answer-1');
    expect(updated.messages.map(message=>message.id)).toEqual(['ask-1','ask-2','answer-2']);
    expect(updated.draft).toEqual({...first,retryTurnId:'turn-1'});
    expect(updated.draft.attachments[0]).toBe(attachment);
    expect(withoutRetriedPrompt(updated.messages,updated.draft.retryTurnId).map(message=>message.id)).toEqual(['ask-2','answer-2']);
    expect(restoreParkedDraft(updated).draft).toBe(localDraft);
    expect(chat.messages).toHaveLength(4);
  });

  it('forks exactly through the chosen reply and clears only the sent draft data',()=>{
    const base={...newConversation('original','对话 1',messages),draft:localDraft};
    const branch=forkChatReply(base,'answer-1','branch','对话 2')!;
    expect(branch.messages.map(message=>message.id)).toEqual(['ask-1','answer-1']);
    expect(branch.draft).toMatchObject({text:'',attachments:[]});
    expect(base.draft).toBe(localDraft);
    const extra={...attachment,id:'next'};
    expect(consumeChatDraft({text:'next question',attachments:[attachment,extra]},first)).toMatchObject({text:'next question',attachments:[extra]});
  });

  it('serializes unchanged Markdown while resolving the actual operation independently',()=>{
    const data=appendChatAttachments('read', [attachment]);
    expect(JSON.parse(data.split('\n').at(-1)!)).toEqual([{kind:attachment.kind,file:attachment.file,label:attachment.label,text:attachment.text}]);
    const context={workspaceId:'fixture',documentFile:'notes/A.md',hasDocument:true,lookupNote:()=>undefined,
      panelLabel:(id:string)=>({files:'文档',trash:'回收站'}[id]||id)};
    expect(resolveChatTarget({...context,marks:[]})).toMatchObject({label:'A.md',file:'notes/A.md'});
    for(const [id,label] of [['files','文档'],['trash','回收站']]){
      expect(resolveChatTarget({...context,marks:[{id,workspaceId:'fixture'}]})).toMatchObject({kind:'window',label});
    }
  });
});
