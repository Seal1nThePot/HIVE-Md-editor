import {describe,expect,it,vi} from 'vitest';
import {EditorState,type TransactionSpec} from '@codemirror/state';
import type {EditorView} from '@codemirror/view';
import {mapAnchor} from '../../shared/core';
import {initialConfig} from '../settings/modelConfig';
import type {EditorSession} from '../editor/editorSessionTypes';
import {generateWriting,stopWritingGeneration,type GenerationContext} from './writingGeneration';
import {createProposalActions} from './proposalActions';

const response=()=>new Response('event: chunk\ndata: '+JSON.stringify('[1]\n足够清楚')+'\n\nevent: done\ndata: null\n\n');
function fixture(){
  const doc='# 正文\n\n很清楚。\n\n尾声。',from=doc.indexOf('很清楚');let state=EditorState.create({doc,selection:{anchor:from,head:from+3}}),prompt='把“很清楚”改成“足够清楚”';
  const session:EditorSession={id:'editor',disk:{path:'A.md',text:doc,hash:'hash-a',eol:'LF',bom:false},state,view:null,dirty:false};
  const lifecycle:GenerationContext['lifecycle']={running:{current:false},generation:{current:0},controller:{current:null},requestAnchor:{current:null},proposal:{current:null}};
  const undo:Parameters<typeof createProposalActions>[0]['undo']={current:[]};
  const editor={get state(){return state;},dispatch(spec:TransactionSpec){const tr=state.update(spec);state=tr.state;session.state=state;if(tr.docChanged){if(lifecycle.requestAnchor.current)lifecycle.requestAnchor.current=mapAnchor(lifecycle.requestAnchor.current,tr.changes);if(lifecycle.proposal.current)lifecycle.proposal.current=mapAnchor(lifecycle.proposal.current,tr.changes);undo.current=undo.current.map(a=>mapAnchor(a,tr.changes));}},focus:vi.fn()} as unknown as EditorView;session.view=editor;
  const context:GenerationContext={
    document:{view:{current:editor},disk:{current:session.disk},sessions:{current:new Map([['editor',session]])},activeSession:{current:'editor'},file:'A.md',outline:[]},
    model:{config:{...initialConfig,demo:false,selection:{serviceId:'test',modelId:'model-a'},model:'model-a'},reasoningEffort:'default'},
    conversation:{mode:'edit',prompt,messages:[],setPrompt:next=>{prompt=typeof next==='function'?next(prompt):next;},setLastRequest:vi.fn(),add:vi.fn()},
    lifecycle,references:{sources:[]},writingOutline:{ready:true,busy:false,nodes:[]},request:vi.fn<typeof fetch>().mockResolvedValue(response()),annotationResponded:vi.fn(),
    ui:{setError:vi.fn(),setBusy:vi.fn(),setStream:vi.fn(),openPanel:vi.fn(),inform:vi.fn(),redraw:vi.fn()},
  };
  const actions=createProposalActions({view:context.document.view,disk:context.document.disk,proposal:lifecycle.proposal,undo,writingOutline:{nodes:[],save:vi.fn().mockResolvedValue(undefined)},add:context.conversation.add,setError:context.ui.setError,inform:context.ui.inform,redraw:context.ui.redraw,setMode:vi.fn(),openChat:vi.fn(),promptRef:{current:null}});
  return {context,editor,actions,doc,getPrompt:()=>prompt};
}
describe('writing generation and review migration',()=>{
  it('writes the suggestion into the document as a preview, keeps it on accept and undoes it while preserving outside edits',async()=>{
    const f=fixture();await generateWriting(f.context);
    // 建议直接成为正文（还在内存里）：用户看到的就是渲染后的成稿。
    expect(f.editor.state.doc.toString()).toBe(f.doc.replace('很清楚','足够清楚'));
    const proposal=f.context.lifecycle.proposal.current!;expect(proposal.from).toBeGreaterThanOrEqual(f.doc.indexOf('很清楚'));expect(proposal.to).toBeLessThanOrEqual(f.doc.indexOf('很清楚')+3);
    f.actions.accept();expect(f.editor.state.doc.toString()).toBe(f.doc.replace('很清楚','足够清楚'));
    f.editor.dispatch({changes:{from:f.editor.state.doc.length,insert:'\n手写补充。'}});f.actions.undoAI();expect(f.editor.state.doc.toString()).toBe(f.doc+'\n手写补充。');
  });
  it('puts the text back when the preview is rejected',async()=>{
    const f=fixture();await generateWriting(f.context);
    f.actions.reject();expect(f.editor.state.doc.toString()).toBe(f.doc);expect(f.context.lifecycle.proposal.current).toBeNull();
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
  it('keeps a newer typed message when an in-flight request fails',async()=>{
    const f=fixture();let fail!:(error:Error)=>void;f.context.request=vi.fn<typeof fetch>().mockImplementation(()=>new Promise<Response>((_,reject)=>{fail=reject;}));
    const pending=generateWriting(f.context);f.context.conversation.setPrompt('下一轮的新输入');fail(new Error('网络失败'));await pending;expect(f.getPrompt()).toBe('下一轮的新输入');expect(f.context.lifecycle.running.current).toBe(false);expect(f.editor.state.doc.toString()).toBe(f.doc);
  });
});
