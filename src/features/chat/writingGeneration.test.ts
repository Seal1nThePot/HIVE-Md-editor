import {describe,expect,it,vi} from 'vitest';
import {EditorState,type TransactionSpec} from '@codemirror/state';
import type {EditorView} from '@codemirror/view';
import {mapAnchor} from '../../shared/core';
import {initialConfig} from '../settings/modelConfig';
import type {EditorSession} from '../editor/editorSessionTypes';
import {generateWriting,stopWritingGeneration,type GenerationContext} from './writingGeneration';
import {createProposalActions,replayPolishProposal} from './proposalActions';
import {historyTextPatch,planHistoryText} from '../history/historyText';
import type {HistoryRecord} from '../history/historyTypes';

const response=(text='足够清楚')=>new Response('event: chunk\ndata: '+JSON.stringify('[1]\n'+text)+'\n\nevent: done\ndata: null\n\n');
function fixture(){
  const doc='# 正文\n\n很清楚。\n\n尾声。',from=doc.indexOf('很清楚');let state=EditorState.create({doc,selection:{anchor:from,head:from+3}}),prompt='把“很清楚”改成“足够清楚”';
  const session:EditorSession={id:'editor',disk:{path:'A.md',text:doc,hash:'hash-a',eol:'LF',bom:false},state,view:null,dirty:false};
  const lifecycle:GenerationContext['lifecycle']={running:{current:false},generation:{current:0},controller:{current:null},requestAnchor:{current:null},proposal:{current:null},origin:{current:null}};
  const undo:Parameters<typeof createProposalActions>[0]['undo']={current:[]};
  const editor={get state(){return state;},dispatch(spec:TransactionSpec){const tr=state.update(spec);state=tr.state;session.state=state;if(tr.docChanged){if(lifecycle.requestAnchor.current)lifecycle.requestAnchor.current=mapAnchor(lifecycle.requestAnchor.current,tr.changes);if(lifecycle.proposal.current)lifecycle.proposal.current=mapAnchor(lifecycle.proposal.current,tr.changes);undo.current=undo.current.map(a=>mapAnchor(a,tr.changes));}},focus:vi.fn()} as unknown as EditorView;session.view=editor;
  const context:GenerationContext={
    document:{view:{current:editor},disk:{current:session.disk},sessions:{current:new Map([['editor',session]])},activeSession:{current:'editor'},file:'A.md',outline:[]},
    model:{config:{...initialConfig,demo:false,selection:{serviceId:'test',modelId:'model-a'},model:'model-a'},reasoningEffort:'default'},
    conversation:{mode:'edit',prompt,messages:[],setPrompt:next=>{prompt=typeof next==='function'?next(prompt):next;},setLastRequest:vi.fn(),add:vi.fn()},
    lifecycle,references:{sources:[]},writingOutline:{ready:true,busy:false,nodes:[]},request:vi.fn<typeof fetch>().mockResolvedValue(response()),annotationResponded:vi.fn(),
    ui:{setError:vi.fn(),setBusy:vi.fn(),setStream:vi.fn(),openPanel:vi.fn(),inform:vi.fn(),redraw:vi.fn()},
  };
  const onAccepted=vi.fn<NonNullable<Parameters<typeof createProposalActions>[0]['onAccepted']>>(()=> 'accept-history');
  const onReverted=vi.fn();
  const actions=createProposalActions({view:context.document.view,disk:context.document.disk,proposal:lifecycle.proposal,undo,writingOutline:{nodes:[],save:vi.fn().mockResolvedValue(undefined)},add:context.conversation.add,setError:context.ui.setError,inform:context.ui.inform,redraw:context.ui.redraw,setMode:vi.fn(),openChat:vi.fn(),promptRef:{current:null},onAccepted,onReverted});
  return {context,editor,actions,doc,getPrompt:()=>prompt,onAccepted,onReverted};
}
describe('writing generation and review migration',()=>{
  it('stages the complete edit selection outside the document and restores the manually edited comparison on undo',async()=>{
    const f=fixture();await generateWriting(f.context);
    expect(f.editor.state.doc.toString()).toBe(f.doc);
    const from=f.doc.indexOf('很清楚');
    expect(f.context.lifecycle.proposal.current).toMatchObject({from,to:from+3,text:'足够清楚',original:'很清楚',placement:'comparison'});
    f.actions.editCandidate('人工核对的润色稿');
    expect(f.editor.state.doc.toString()).toBe(f.doc);
    f.actions.accept();
    expect(f.editor.state.doc.toString()).toBe(f.doc.replace('很清楚','人工核对的润色稿'));
    expect(f.context.lifecycle.proposal.current).toBeNull();
    const [accepted,acceptedDoc]=f.onAccepted.mock.calls[0];
    expect(acceptedDoc.sliceString(accepted.from,accepted.to)).toBe('人工核对的润色稿');
    f.editor.dispatch({changes:{from:0,insert:'手写前缀\n'}});
    f.actions.undoAI();
    expect(f.editor.state.doc.toString()).toBe('手写前缀\n'+f.doc);
    expect(f.onReverted).toHaveBeenCalledWith('accept-history');
    expect(f.context.lifecycle.proposal.current).toMatchObject({from:from+5,to:from+8,text:'人工核对的润色稿',original:'很清楚',historyId:'accept-history'});
  });
  it('drops the comparison and preserves the body when it is rejected',async()=>{
    const f=fixture();await generateWriting(f.context);
    f.actions.reject();expect(f.editor.state.doc.toString()).toBe(f.doc);expect(f.context.lifecycle.proposal.current).toBeNull();
  });
  it('uses the current candidate as the refinement target and keeps the preview until the response succeeds',async()=>{
    const f=fixture();await generateWriting(f.context);
    f.actions.editCandidate('给模型的人工版本');
    f.actions.editRefinementNote('再精简一点');
    f.context.conversation.setPrompt('另一个独立想法');
    const {proposal,origin}=f.context.lifecycle;
    const proposalId=proposal.current!.id;
    let resolve!:(value:Response)=>void;
    f.context.request=vi.fn<typeof fetch>().mockImplementation(()=>new Promise<Response>(done=>{resolve=done;}));
    const pending=generateWriting(f.context,{revision:{proposalId,instruction:'再精简一点'}});
    expect(proposal.current?.text).toBe('给模型的人工版本');
    expect(origin!.current).toMatchObject({proposalId});
    expect(f.context.conversation.setLastRequest).toHaveBeenLastCalledWith(expect.objectContaining({messages:expect.arrayContaining([expect.objectContaining({content:expect.stringContaining('给模型的人工版本\n→ 再精简一点')})])}));
    f.editor.dispatch({changes:{from:0,insert:'导语\n'}});
    resolve(response('第二次润色'));await pending;
    expect(f.editor.state.doc.toString()).toBe('导语\n'+f.doc);
    expect(proposal.current).toMatchObject({id:proposalId,text:'第二次润色',original:'很清楚',from:f.doc.indexOf('很清楚')+3});
    expect(proposal.current?.refinementNote).toBeUndefined();
    expect(f.getPrompt()).toBe('另一个独立想法');
  });
  it('keeps the live draft and annotation if it was edited while awaiting refinement',async()=>{
    const f=fixture();await generateWriting(f.context);
    const {proposal}=f.context.lifecycle;
    f.actions.editRefinementNote('增加细节');
    let resolve!:(value:Response)=>void;
    f.context.request=vi.fn<typeof fetch>().mockImplementation(()=>new Promise<Response>(done=>{resolve=done;}));
    const revision=generateWriting(f.context,{revision:{proposalId:proposal.current!.id,instruction:'增加细节'}});
    f.actions.editCandidate('等待期间修改');
    resolve(response('晚到的候选'));await revision;
    expect(proposal.current).toMatchObject({text:'等待期间修改',refinementNote:'增加细节'});
    expect(f.editor.state.doc.toString()).toBe(f.doc);
  });
  it('reopens the exact journaled comparison after undo at a position mapped by operation history',()=>{
    const f=fixture();const from=f.doc.indexOf('很清楚');
    const patch=historyTextPatch(f.editor.state.doc,from,from+3,'手工定稿');
    const record:HistoryRecord={id:'polish-history',actor:'ai',kind:'text',createdAt:'2026-11-23T00:00:00Z',label:'润色',status:'applied',file:'A.md',
      changes:{text:[patch],polish:{id:'comparison',reason:'精简',node:'正文',annotationIds:['source-note']}}};
    f.editor.dispatch({changes:[{from:0,insert:'后来加的前言\n'},{from,to:from+3,insert:'手工定稿'}]});
    const plan=planHistoryText(f.editor.state.doc,[patch],true);
    expect(plan.conflicts).toEqual([]);
    f.editor.dispatch({changes:plan.changes});
    const preview=replayPolishProposal(record,plan,true)!;
    expect(preview).toMatchObject({text:'手工定稿',original:'很清楚',historyId:'polish-history',annotationIds:['source-note']});
    expect(f.editor.state.sliceDoc(preview.from,preview.to)).toBe(preview.original);
    expect(replayPolishProposal(record,plan,false)).toBeNull();
  });
  it('refuses to accept a proposal after its target was edited by hand',async()=>{
    const f=fixture();await generateWriting(f.context);const proposal=f.context.lifecycle.proposal.current!;
    f.editor.dispatch({changes:{from:proposal.from,to:proposal.to,insert:'人工改写'}});const before=f.editor.state.doc.toString();f.actions.accept();expect(f.editor.state.doc.toString()).toBe(before);expect(f.context.ui.setError).toHaveBeenLastCalledWith(expect.stringContaining('手改'));
  });
  it('does not install a late response after switching documents or stopping',async()=>{
    const f=fixture();let resolve!:(response:Response)=>void;f.context.request=vi.fn<typeof fetch>().mockImplementation(()=>new Promise<Response>(done=>{resolve=done;}));
    const pending=generateWriting(f.context);stopWritingGeneration(f.context.lifecycle,f.context.ui);f.context.document.activeSession.current='editor:other';f.context.document.disk.current={...f.context.document.disk.current!,path:'B.md'};resolve(response());await pending;
    expect(f.context.lifecycle.proposal.current).toBeNull();expect(f.editor.state.doc.toString()).toBe(f.doc);expect(vi.mocked(f.context.conversation.add).mock.calls.some(([role])=>role==='assistant')).toBe(false);
  });
  it('finishes a discussion without a document after opening another editor',async()=>{
    const f=fixture(),{document,conversation,lifecycle}=f.context;
    document.file='';document.view.current=null;document.disk.current=null;
    conversation.mode='discuss';conversation.messages=[{id:'prior',role:'assistant',content:'Earlier in the conversation'}];
    let resolve!:(value:Response)=>void;f.context.request=vi.fn<typeof fetch>().mockImplementation(()=>new Promise<Response>(done=>{resolve=done;}));
    const pending=generateWriting(f.context);
    expect(lifecycle.running.current).toBe(true);
    expect(lifecycle.requestAnchor.current).toBeNull();
    document.activeSession.current='editor:other';document.disk.current={...document.sessions.current.get('editor')!.disk!,path:'B.md'};
    resolve(response());await pending;
    expect(conversation.setLastRequest).toHaveBeenCalledWith(expect.objectContaining({file:'未打开文档',messages:expect.arrayContaining([expect.objectContaining({content:'Earlier in the conversation'})])}));
    expect(conversation.add).toHaveBeenCalledWith('assistant',expect.any(String),{documentFile:undefined});
    expect(lifecycle.proposal.current).toBeNull();
  });
  it('preserves raw Markdown in a discussion stream and associates it with the original note',async()=>{
    const {context}=fixture();
    context.conversation.mode='discuss';
    const source='~~~md\n**标注 1｜原文与备注**\n~~~';
    vi.mocked(context.request).mockResolvedValue(new Response('event: chunk\ndata: '+JSON.stringify(source)+'\n\nevent: done\ndata: null\n\n'));
    await generateWriting(context);
    expect(context.ui.setStream).toHaveBeenCalledWith(source,'A.md');
    expect(context.conversation.add).toHaveBeenCalledWith('assistant',source,{documentFile:'A.md'});
  });
  it('keeps annotation data for compact display and original text in the next model history',async()=>{
    const {context}=fixture();
    const submitted={id:'one',source:'document' as const,file:'A.md',from:0,to:3,original:'正文选区',note:'略长的原文备注'};
    await generateWriting(context,{annotations:[submitted],instruction:'请解释'});
    const add=vi.mocked(context.conversation.add);
    const user=add.mock.calls.find(([role])=>role==='user')!;
    expect(user[1]).toContain('正文选区');
    expect(user[2]).toEqual({documentFile:'A.md',annotationBatch:{instruction:'请解释',items:[submitted]}});
    context.conversation.mode='discuss';
    context.conversation.messages=[{id:'prior',role:'user',content:user[1],...user[2]}];
    vi.mocked(context.request).mockResolvedValue(response());
    await generateWriting(context);
    expect(context.conversation.setLastRequest).toHaveBeenLastCalledWith(expect.objectContaining({messages:expect.arrayContaining([{role:'user',content:user[1]}])}));
  });
  it('does not publish late discussion results for a cancelled annotation',async()=>{
    const f=fixture(),{lifecycle,conversation,ui}=f.context;
    const submitted={id:'only-this-note',source:'document' as const,file:'A.md',from:0,to:3,original:'正文选区',note:'备注'};
    let resolve!:(value:Response)=>void;
    f.context.request=vi.fn<typeof fetch>().mockImplementation(()=>new Promise<Response>(done=>{resolve=done;}));
    const pending=generateWriting(f.context,{annotations:[submitted]});
    expect(lifecycle.origin?.current?.annotationIds).toEqual(['only-this-note']);
    stopWritingGeneration(lifecycle,ui);
    resolve(response('已失效的回应'));await pending;
    expect(lifecycle.origin?.current).toBeNull();
    expect(f.context.annotationResponded).not.toHaveBeenCalled();
    expect(vi.mocked(conversation.add).mock.calls.some(([role])=>role==='assistant')).toBe(false);
  });
  it('keeps a newer typed message when an in-flight request fails',async()=>{
    const f=fixture();let fail!:(error:Error)=>void;f.context.request=vi.fn<typeof fetch>().mockImplementation(()=>new Promise<Response>((_,reject)=>{fail=reject;}));
    const pending=generateWriting(f.context);f.context.conversation.setPrompt('下一轮的新输入');fail(new Error('网络失败'));await pending;expect(f.getPrompt()).toBe('下一轮的新输入');expect(f.context.lifecycle.running.current).toBe(false);expect(f.editor.state.doc.toString()).toBe(f.doc);
  });
});
