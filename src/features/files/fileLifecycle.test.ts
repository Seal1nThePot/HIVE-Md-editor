import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {undoDepth,undo} from '@codemirror/commands';
import type {Transaction} from '@codemirror/state';
import {useFileActions} from './useFileActions';
import {useDocumentPersistence} from './useDocumentPersistence';
import {makeState} from '../editor/Editor';
import {applyStoredDocumentChange} from '../editor/storedDocumentChanges';
import {activeEditor} from '../editor/activeEditor';
import type {EditorSession} from '../editor/editorSessionTypes';
import type {DiskFile} from '../../shared/fileTypes';
import {workspaceTreeSync} from './workspaceSync';

function deferred<T=any>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const data=(path:string,text='original',hash='hash-'+path):DiskFile=>({path,text,hash,eol:'LF',bom:false});
async function tick(){await Promise.resolve();await Promise.resolve();}
function setup(){
  const callbacks=new Map<string,ReturnType<typeof vi.fn>>(),open=new Set(['editor']),busy:boolean[]=[],openingFile:boolean[]=[],errors:string[]=[];
  let confirm:any,dialog:any=null;
  const noop=()=>{};
  const opts:any={sessions:{current:new Map<string,EditorSession>([['editor',{id:'editor',disk:null,state:null,view:null,dirty:false}]])},activeSession:{current:'editor'},activeTextSource:{current:'document'},proposal:{current:null},undo:{current:[]},appAlive:{current:true},promptRef:{current:{value:''}},dialogRef:{current:null},prompt:'',dialog:null,
    running:{current:false},requestAnchor:{current:null},structuring:{current:false},switching:{current:false},viewApplying:{current:false},creatingNote:{current:false},savingPaths:{current:new Set()},fileWorkspace:{info:{id:'space',root:'synthetic'},flush:async()=>{},update:async()=>{}},annotations:{syncEditor:noop},references:{remap:noop},uid:(()=>{let value=0;return()=>String(++value);})(),stop:noop,redraw:noop,inform:noop,
    setFileBusy:(value:boolean,opening:boolean)=>{busy.push(value);openingFile.push(opening);},setError:(value:string)=>errors.push(value),setConfirm:(value:any)=>{confirm=value;},setDialog:(value:any)=>{dialog=value;opts.dialogRef.current=value;},bindings:(id:string)=>{if(!callbacks.has(id))callbacks.set(id,vi.fn());return {onUpdate:callbacks.get(id)!};}};
  for(const name of ['setNewNoteBusy','setEntries','reportTree','setFilter','setRenameRequest','setCollapsed','setTrashRevision','setInlineRequest','setOutline','setSelection','setWritingNodeId'])opts[name]=noop;
  const active=activeEditor(opts.sessions,opts.activeSession);
  const activate=(id:string)=>{opts.activeSession.current=id;};
  opts.workspace={isOpen:(id:string)=>open.has(id),open:(id:string)=>{open.add(id);activate(id);},openDocumentTab:(id:string)=>{open.add(id);activate(id);},close:(id:string)=>open.delete(id),openIds:['editor']};
  opts.finalizeTrashedSessions=(sessions:EditorSession[],safe:(session:EditorSession)=>boolean)=>{let kept=0;for(const session of sessions){const ok=safe(session);session.disk=null;if(ok){session.state=null;session.dirty=false;session.landing=true;if(session.id!=='editor')open.delete(session.id);}else{session.dirty=true;kept++;}}return kept;};
  let handler:(url:string,body?:unknown)=>Promise<any>=async(url)=>url.startsWith('/tree')?{root:'synthetic',entries:[]}:data(decodeURIComponent(url.split('=')[1]||'unknown'));
  opts.api=vi.fn((url:string,body?:unknown)=>handler(url,body));
  let persistence!:ReturnType<typeof useDocumentPersistence>;
  function Persistence(){persistence=useDocumentPersistence({...opts,fileBusy:false,tick:0,autoSave:false,onStoredChange:(id,transaction)=>opts.onStoredChange?.(id,transaction)});return null;}
  renderToStaticMarkup(React.createElement(Persistence));opts.saveSession=persistence.saveSession;opts.applyDiskFile=persistence.applyDiskFile;opts.savingPaths=persistence.savingPaths;
  const actions=()=>useFileActions(opts);
  function add(id:string,path:string,text='original'){
    const state=makeState(text,opts.bindings(id).onUpdate),session:EditorSession={id,disk:data(path,text),state,view:null,dirty:false};opts.sessions.current.set(id,session);open.add(id);return session;
  }
  function edit(session:EditorSession,text=' UNSAVED'){session.state=session.state!.update({changes:{from:session.state!.doc.length,insert:text},userEvent:'input.type'}).state;session.dirty=true;session.contentVersion=(session.contentVersion||0)+1;}
  return {opts,actions,add,edit,activate,active,open,busy,openingFile,errors,persistence,callbacks,setHandler:(value:typeof handler)=>{handler=value;},file:()=>active.session?.imagePath||active.disk.current?.path||'',confirm:()=>confirm,setDialog:(value:any)=>{dialog=value;opts.dialog=value;opts.dialogRef.current=value;},dialog:()=>dialog};
}

describe('forced tree refresh lifecycle',()=>{
  it('opens an image in a separate read-only tab without saving or replacing an unsaved manuscript',async()=>{
    const t=setup(),draft=t.add('editor','draft.md');t.edit(draft);const state=draft.state,history=undoDepth(state!);
    t.opts.saveSession=vi.fn();await t.actions().openExplorerFile('资料/图.png');
    const image=[...t.opts.sessions.current.values()].find((session:any)=>session.imagePath==='资料/图.png') as EditorSession;
    expect(image).toMatchObject({disk:null,state:null,view:null,dirty:false});expect(draft.state).toBe(state);expect(draft.dirty).toBe(true);expect(undoDepth(draft.state!)).toBe(history);
    expect(t.opts.saveSession).not.toHaveBeenCalled();expect(t.opts.api.mock.calls.map((call:any[])=>call[0])).toEqual(['/image-file/info?path='+encodeURIComponent('资料/图.png')]);
    expect(await t.persistence.saveSession(image.id)).toBe(true);expect(t.opts.api).toHaveBeenCalledTimes(1);
    expect(t.active.editorState.current).toBeNull();
    t.activate('editor');expect(t.active.editorState.current).toBe(state);
  });
  it('does not commit a pending image open after the workspace changes',async()=>{
    const t=setup(),pending=deferred();t.setHandler(()=>pending.promise);const opening=t.actions().openExplorerFile('图.png');await tick();t.opts.switching.current=true;pending.resolve({});await opening;
    expect([...t.opts.sessions.current.values()].some((session:any)=>session.imagePath)).toBe(false);
  });
  it('forces a scan, retains its cursor, and supports repeated refreshes without a render',async()=>{
    const t=setup();t.opts.setEntries=vi.fn();
    const entries=[{path:'one.md',name:'one.md',type:'file'}];
    t.setHandler(async()=>({root:'synthetic',entries,treeVersion:'forced'}));
    const actions=t.actions();await actions.refresh();await actions.refresh();
    expect(t.opts.api.mock.calls.map((call:any[])=>call[0])).toEqual(['/tree?refresh=1','/tree?refresh=1']);
    expect(t.opts.setEntries).toHaveBeenCalledTimes(2);
    expect(workspaceTreeSync(t.opts.setEntries,t.opts.fileWorkspace.info).beginSync()?.treeVersion).toBe('forced');
  });
  it('drops a refresh from an earlier repository and rejects stale callbacks after a round trip',async()=>{
    const t=setup(),pending=deferred();t.opts.setEntries=vi.fn();t.opts.reportTree=vi.fn();t.setHandler(()=>pending.promise);
    const oldInfo=t.opts.fileWorkspace.info,oldActions=t.actions(),refresh=oldActions.refresh();
    t.opts.fileWorkspace.info={id:'another',root:'other'};t.actions();
    pending.resolve({root:'synthetic',entries:[],treeVersion:'old'});await refresh;
    expect(t.opts.setEntries).not.toHaveBeenCalled();expect(t.opts.reportTree).not.toHaveBeenCalled();
    t.opts.fileWorkspace.info=oldInfo;t.actions();await oldActions.refresh();
    expect(t.opts.api).toHaveBeenCalledTimes(1);
  });
  it('releases a failed refresh so regular polling can continue',async()=>{
    const t=setup();t.opts.reportTree=vi.fn();t.setHandler(async()=>{throw new Error('offline');});
    await expect(t.actions().refresh()).rejects.toThrow('offline');
    expect(t.opts.reportTree).toHaveBeenCalledExactlyOnceWith({error:'offline'});
    expect(workspaceTreeSync(t.opts.setEntries,t.opts.fileWorkspace.info).beginSync()).toEqual({epoch:expect.any(Number),treeVersion:undefined});
  });
});

describe('repository switching preserves save guards',()=>{
  it('flushes pending work and saves dirty sessions before opening another repository',async()=>{
    const t=setup(),session=t.add('editor','draft.md');t.edit(session);const events:string[]=[];
    t.opts.fileWorkspace.flush=async()=>{events.push('flush');};
    t.opts.saveSession=async(id:string,required:boolean)=>{expect(id).toBe('editor');expect(required).toBe(true);events.push('save');session.dirty=false;return true;};
    t.opts.fileWorkspace.update=async(patch:unknown)=>{expect(patch).toEqual({root:'other'});events.push('switch');};
    await t.actions().switchWorkspace('other');expect(events).toEqual(['flush','save','switch']);expect(t.opts.switching.current).toBe(false);
  });
  it('does not switch after a save failure or while AI content still needs attention',async()=>{
    for(const reason of ['save','generation','proposal','prompt']) {
      const t=setup(),session=t.add('editor','draft.md');t.edit(session);t.opts.fileWorkspace.update=vi.fn();
      if(reason==='save')t.opts.saveSession=async()=>false;
      if(reason==='generation')t.opts.running.current=true;
      if(reason==='proposal')t.opts.proposal.current={id:'pending'};
      if(reason==='prompt')t.opts.prompt='unsent';
      await expect(t.actions().switchWorkspace('other')).rejects.toThrow();
      expect(t.opts.fileWorkspace.update).not.toHaveBeenCalled();expect(session.dirty).toBe(true);expect(t.opts.switching.current).toBe(false);
    }
  });
  it('saves the current manuscript before removing its repository through a single request',async()=>{
    const t=setup(),session=t.add('editor','draft.md');t.edit(session);const events:string[]=[];
    t.opts.fileWorkspace.flush=async()=>{events.push('flush');};
    t.opts.saveSession=async()=>{events.push('save');session.dirty=false;return true;};
    t.opts.fileWorkspace.update=vi.fn();
    t.opts.fileWorkspace.manage=async(action:unknown)=>{expect(action).toEqual({action:'remove',id:'space'});events.push('remove');};
    await t.actions().removeRepository('space');
    expect(events).toEqual(['flush','save','remove']);
    expect(t.opts.fileWorkspace.update).not.toHaveBeenCalled();
  });
  it('leaves the current repository intact when removing it fails a switch guard',async()=>{
    for(const reason of ['disk conflict','pending edits','unsent AI draft','composition']){
      const t=setup(),session=t.add('editor','draft.md');t.edit(session);
      t.opts.fileWorkspace.manage=vi.fn();
      if(reason==='disk conflict')t.opts.saveSession=async()=>false;
      if(reason==='pending edits')t.opts.saveSession=async()=>true;
      if(reason==='unsent AI draft')t.opts.hasUnsentChatDraft=()=>true;
      if(reason==='composition')t.opts.fileWorkspace.flush=async()=>{throw new Error('请先完成当前输入法组词');};
      await expect(t.actions().removeRepository('space')).rejects.toThrow();
      expect(t.opts.fileWorkspace.manage).not.toHaveBeenCalled();
      expect(session.dirty).toBe(true);
      expect(t.opts.switching.current).toBe(false);
    }
  });
  it('removes an inactive repository without saving or flushing the active one',async()=>{
    const t=setup(),session=t.add('editor','draft.md');t.edit(session);
    t.opts.fileWorkspace.flush=vi.fn();t.opts.saveSession=vi.fn();t.opts.fileWorkspace.manage=vi.fn();
    await t.actions().removeRepository('inactive');
    expect(t.opts.fileWorkspace.manage).toHaveBeenCalledWith({action:'remove',id:'inactive'});
    expect(t.opts.fileWorkspace.flush).not.toHaveBeenCalled();
    expect(t.opts.saveSession).not.toHaveBeenCalled();
    expect(session.dirty).toBe(true);
  });
});

describe('shared file preflight and mutation outcomes',()=>{
  it('preflights every selected path before mutation, saving an overlapping descendant once',async()=>{
    const t=setup(),one=t.add('editor','notes/one.md'),two=t.add('other','two.md');t.edit(one);t.edit(two);
    const events:string[]=[];t.opts.fileWorkspace.flush=async()=>{events.push('flush');};
    t.opts.saveSession=async(id:string)=>{events.push(id);t.opts.sessions.current.get(id).dirty=false;return true;};
    await t.actions().preflightFileActions([{action:'move',path:'notes'},{action:'move',path:'notes/one.md'},{action:'move',path:'two.md'}]);
    expect(events).toEqual(['flush','editor','other']);expect(t.opts.api).not.toHaveBeenCalled();expect(t.opts.structuring.current).toBe(false);
  });
  it('blocks a whole batch for any protected member and still checks each later single action',async()=>{
    const t=setup();t.add('editor','one.md');t.add('other','two.md');t.opts.sessions.current.get('other').context={proposal:{id:'pending'},prompt:''};
    await expect(t.actions().preflightFileActions([{action:'trash',path:'one.md'},{action:'trash',path:'two.md'}])).rejects.toThrow('待审建议');
    expect(t.opts.api).not.toHaveBeenCalled();
    t.opts.sessions.current.get('other').context.proposal=null;
    await t.actions().preflightFileActions([{action:'trash',path:'one.md'}]);
    t.opts.proposal.current={id:'new pending'};
    await expect(t.actions().manageFile({action:'trash',path:'one.md'})).rejects.toThrow('待审建议');
    expect(t.opts.api).not.toHaveBeenCalled();expect(t.opts.structuring.current).toBe(false);
  });
  it('rechecks workspace, AI, context and text after a flush without issuing a mutation',async()=>{
    for(const change of ['workspace','unmount','generation','proposal','text','session','switching','saving']){
      const t=setup(),session=t.add('editor','one.md'),flush=deferred();t.opts.fileWorkspace.flush=()=>flush.promise;
      const pending=t.actions().manageFile({action:'move',path:'one.md',parent:'destination'});
      if(change==='workspace')t.opts.fileWorkspace.info={id:'another',root:'other'};
      else if(change==='unmount')t.opts.appAlive.current=false;
      else if(change==='generation')t.opts.running.current=true;
      else if(change==='proposal')t.opts.proposal.current={id:'new'};
      else if(change==='text')t.edit(session);
      else if(change==='session')t.add('editor','one.md','replacement');
      else if(change==='switching')t.opts.switching.current=true;
      else t.opts.savingPaths.current.add('one.md');
      flush.resolve(undefined);await expect(pending).rejects.toThrow();expect(t.opts.api).not.toHaveBeenCalled();
      expect(session.disk?.path).toBe('one.md');expect(t.opts.structuring.current).toBe(false);
    }
  });
  it('rechecks after saves and preserves new text or pending AI before any structural operation',async()=>{
    for(const change of ['text','proposal','workspace']){
      const t=setup(),session=t.add('editor','one.md'),save=deferred<boolean>();t.edit(session);
      t.opts.saveSession=async()=>save.promise;
      const pending=t.actions().manageFile({action:'trash',path:'one.md'});await tick();
      if(change==='text')t.edit(session,' later');
      else if(change==='proposal')t.opts.proposal.current={id:'pending'};
      else t.opts.fileWorkspace.info.id='new workspace';
      session.dirty=false;save.resolve(true);await expect(pending).rejects.toThrow();
      expect(t.opts.api).not.toHaveBeenCalled();expect(session.disk?.path).toBe('one.md');
    }
  });
  it('supports basis checks without explorer mutation and preserves an existing proposal and history',async()=>{
    const t=setup(),session=t.add('editor','one.md');t.edit(session);const state=session.state,proposal={id:'pending'};
    t.opts.proposal.current=proposal;t.opts.saveSession=async()=>{session.dirty=false;return true;};
    await t.actions().preflightFileActions([{action:'basis',path:'one.md'}]);
    await expect(t.actions().manageFile({action:'basis',path:'one.md'})).resolves.toEqual({path:'one.md',type:'file'});
    expect(t.opts.api).not.toHaveBeenCalled();expect(session.state).toBe(state);expect(t.opts.proposal.current).toBe(proposal);expect(undoDepth(state!)).toBeGreaterThan(0);
  });
  it('reports a successful mutation with a refresh warning and preserves remapped sessions and references',async()=>{
    const t=setup(),session=t.add('editor','one.md');t.activate('editor');
    t.opts.references.remap=vi.fn();t.opts.inform=vi.fn();
    t.setHandler(async(url,body:any)=>{if(url==='/explorer')return {path:'new/one.md',type:'file'};throw new Error('tree unavailable');});
    const result=await t.actions().manageFile({action:'move',path:'one.md',parent:'new'},{quiet:true});
    expect(result.path).toBe('new/one.md');expect(result.warning).toContain('操作已完成');
    expect(session.disk?.path).toBe('new/one.md');expect(t.file()).toBe('new/one.md');
    expect(t.opts.references.remap).toHaveBeenCalledWith('one.md','new/one.md');expect(t.opts.inform).not.toHaveBeenCalled();
  });
  it('suppresses single-item trash notices in batch mode and clears the deleted session',async()=>{
    const t=setup(),session=t.add('editor','one.md');t.opts.inform=vi.fn();
    t.setHandler(async(url)=>url.startsWith('/tree')?{root:'synthetic',entries:[]}:{path:'one.md',type:'file'});
    await t.actions().manageFile({action:'trash',path:'one.md'},{quiet:true});
    expect(session.disk).toBeNull();expect(session.state).toBeNull();expect(session.dirty).toBe(false);expect(session.landing).toBe(true);expect(t.opts.inform).not.toHaveBeenCalled();
  });
  it('preserves text edited while the trash request is in flight as an independent draft',async()=>{
    const t=setup(),session=t.add('editor','one.md'),pending=deferred();t.opts.inform=vi.fn();
    t.setHandler(url=>url==='/explorer'?pending.promise:Promise.resolve({root:'synthetic',entries:[]}));
    const action=t.actions().manageFile({action:'trash',path:'one.md'},{quiet:true});await tick();await tick();
    t.edit(session,' later');pending.resolve({path:'one.md',type:'file'});await action;
    expect(session.disk).toBeNull();expect(session.state!.doc.toString()).toBe('original later');expect(session.dirty).toBe(true);expect(t.opts.inform).toHaveBeenCalledWith(expect.stringContaining('未命名稿'));
  });
  it('retains an unrelated current session proposal and AI undo while another file moves',async()=>{
    const t=setup(),current=t.add('editor','current.md'),other=t.add('other','one.md');
    const proposal={id:'pending'},undo=[{file:'current.md',before:'text'}];t.opts.proposal.current=proposal;t.opts.undo.current=undo;
    t.setHandler(async(url)=>url.startsWith('/tree')?{root:'synthetic',entries:[]}:{path:'moved.md',type:'file'});
    await t.actions().manageFile({action:'move',path:'one.md',parent:''});
    expect(other.disk?.path).toBe('moved.md');expect(current.disk?.path).toBe('current.md');
    expect(t.opts.proposal.current).toBe(proposal);expect(t.opts.undo.current).toBe(undo);
  });
});

describe('file read authority and local history',()=>{
  it('keeps the newest open and its loading lease when an older response or error arrives',async()=>{
    const t=setup(),a=deferred(),b=deferred();t.setHandler(url=>url.includes('A.md')?a.promise:b.promise);
    const first=t.actions().openFile('A.md'),second=t.actions().openFile('B.md');a.reject(new Error('old failure'));await first;
    expect(t.busy.at(-1)).toBe(true);expect(t.errors).not.toContain('old failure');b.resolve(data('B.md'));await second;
    expect(t.file()).toBe('B.md');expect(t.busy.at(-1)).toBe(false);
  });
  it('rejects a late response after editing, closing/reopening, or unmounting the workspace',async()=>{
    for(const change of ['edit','close','unmount']){
      const t=setup(),session=t.add('editor','old.md'),read=deferred();t.setHandler(()=>read.promise);const pending=t.actions().openFile('A.md');
      if(change==='edit')t.edit(session);else if(change==='close'){t.open.delete('editor');session.contentVersion=1;t.open.add('editor');}else t.opts.appAlive.current=false;
      const prior=session.state;read.resolve(data('A.md'));await pending;expect(session.state).toBe(prior);expect(session.disk?.path).toBe('old.md');
    }
  });
  it('fixes the target before flush, permits selection/sleep changes, and does not steal another editor',async()=>{
    const t=setup(),first=t.add('editor','old.md'),other=t.add('other','other.md'),flush=deferred(),read=deferred();t.opts.fileWorkspace.flush=()=>flush.promise;t.setHandler(()=>read.promise);
    const pending=t.actions().openExplorerFile('A.md');t.activate('other');first.state=first.state!.update({selection:{anchor:2}}).state;flush.resolve(undefined);await tick();read.resolve(data('A.md'));await pending;
    expect(first.disk?.path).toBe('A.md');expect(other.disk?.path).toBe('other.md');expect(t.opts.activeSession.current).toBe('other');expect(t.file()).toBe('other.md');
  });
  it('does not issue the read when text changes during a flush or save',async()=>{
    const t=setup(),session=t.add('editor','old.md'),flush=deferred();t.opts.fileWorkspace.flush=()=>flush.promise;
    const pending=t.actions().openExplorerFile('A.md');t.edit(session);flush.resolve(undefined);await pending;expect(t.opts.api).not.toHaveBeenCalled();expect(session.dirty).toBe(true);
  });
  it('guards a landing read whose target is filled while waiting',async()=>{
    const t=setup(),session=t.opts.sessions.current.get('editor')!;session.landing=true;const read=deferred();t.setHandler(()=>read.promise);
    const pending=t.actions().openInLanding('A.md','editor');await tick();session.landing=false;session.state=makeState('NEW LOCAL',()=>{});read.resolve(data('A.md'));await pending;
    expect(session.state.doc.toString()).toBe('NEW LOCAL');expect(session.disk).toBeNull();
  });
  it('reopening the same saved or dirty path retains state, history, selection and pending context',()=>{
    const t=setup(),session=t.add('editor','same.md');t.edit(session);session.state=session.state!.update({selection:{anchor:3}}).state;
    const state=session.state,proposal={id:'pending'};t.opts.proposal.current=proposal;t.actions().showFile(data('same.md'));
    expect(session.state).toBe(state);expect(session.dirty).toBe(true);expect(undoDepth(session.state!)).toBeGreaterThan(0);expect(t.opts.proposal.current).toBe(proposal);
    session.disk={...session.disk!,text:session.state!.doc.toString(),hash:'saved'};session.dirty=false;t.actions().showFile(session.disk);
    expect(session.state).toBe(state);expect(session.state!.selection.main.head).toBe(3);expect(undoDepth(session.state!)).toBeGreaterThan(0);
  });
  it('adopts a real clean disk change by transaction but preserves conflicting local text and its final error',async()=>{
    const t=setup(),session=t.add('editor','same.md');t.actions().showFile(data('same.md','remote','new-hash'));
    expect(session.state!.doc.toString()).toBe('remote');expect(undoDepth(session.state!)).toBeGreaterThan(0);
    t.edit(session);const prior=session.state,count=t.opts.sessions.current.size;
    t.setHandler(async()=>data('same.md','different remote','external'));await t.actions().openExplorerFile('same.md',true);
    expect(session.state).toBe(prior);expect(t.opts.sessions.current.size).toBe(count);expect(t.errors.at(-1)).toContain('磁盘和本地都有修改');
  });
  it('resets the old viewport before installing a different file in the same tab',()=>{
    const t=setup(),session=t.add('editor','old.md');
    session.restoreScroll=380;session.restoreScrollLeft=70;
    const scrollDOM={scrollTop:380,scrollLeft:70};
    const setState=vi.fn(()=>expect(scrollDOM).toEqual({scrollTop:0,scrollLeft:0}));
    session.view={state:session.state,scrollDOM,setState} as unknown as EditorView;
    t.actions().showFile(data('old.md'));
    expect(setState).not.toHaveBeenCalled();
    expect([session.restoreScroll,session.restoreScrollLeft]).toEqual([380,70]);
    t.actions().showFile(data('next.md','next note'));
    expect(setState).toHaveBeenCalledExactlyOnceWith(session.state);
    expect([session.restoreScroll,session.restoreScrollLeft]).toEqual([undefined,undefined]);
    expect(session.state!.doc.toString()).toBe('next note');
  });
  it('shares Text in a new view while keeping independent history and the new callback',async()=>{
    const t=setup(),source=t.add('editor','same.md');t.edit(source);const doc=source.state!.doc,read=vi.spyOn(doc,'toString');
    t.setHandler(async()=>source.disk);await t.actions().openExplorerFile('same.md',true);
    const created=[...t.opts.sessions.current.values()].find((session:any)=>session.id!=='editor') as EditorSession;
    expect(created.state!.doc).toBe(doc);expect(created.dirty).toBe(true);expect(undoDepth(created.state!)).toBe(0);expect(undoDepth(source.state!)).toBeGreaterThan(0);
    expect(created.state!.facet(EditorView.updateListener)).toContain(t.callbacks.get(created.id));expect(created.state!.facet(EditorView.updateListener)).not.toContain(t.callbacks.get(source.id));expect(read).not.toHaveBeenCalled();
  });
  it('protects every same-path view during explicit reload, not only the invoking view',async()=>{
    const t=setup(),first=t.add('editor','same.md'),other=t.add('other','same.md'),read=deferred();t.setHandler(()=>read.promise);
    t.actions().reloadFromDisk('editor');t.confirm().action();t.edit(other);read.resolve(data('same.md','disk','new'));await tick();await tick();
    expect(first.state!.doc.toString()).toBe('original');expect(other.state!.doc.toString()).toBe('original UNSAVED');expect(t.errors.at(-1)).toContain('所有本地内容仍保留');
  });
  it('saves an asleep target as a copy without flattening/replacing another active target or its history',async()=>{
    const t=setup(),first=t.add('editor','same.md'),other=t.add('other','other.md');t.edit(first);const state=first.state,write=deferred();t.setDialog({kind:'saveAs',value:'copy.md',title:'copy'});
    t.setHandler(async(url,body:any)=>{if(url==='/file'){expect(body.text).toBe('original UNSAVED');return write.promise;}if(url.startsWith('/file?'))return data('copy.md','original UNSAVED','copy-hash');return {root:'synthetic',entries:[]};});
    const pending=t.actions().submitDialog({preventDefault(){}} as any);t.activate('other');write.resolve({hash:'copy-hash'});await pending;
    expect(first.disk?.path).toBe('copy.md');expect(first.state).toBe(state);expect(undoDepth(first.state!)).toBeGreaterThan(0);expect(other.disk?.path).toBe('other.md');expect(t.file()).toBe('other.md');
  });
  it('retains later edits when a save-as write completes and does not read back over them',async()=>{
    const t=setup(),session=t.add('editor','same.md'),write=deferred();t.setDialog({kind:'saveAs',value:'copy.md',title:'copy'});t.setHandler(()=>write.promise);
    const pending=t.actions().submitDialog({preventDefault(){}} as any);t.edit(session);write.resolve({hash:'copy-hash'});await pending;
    expect(session.disk?.path).toBe('same.md');expect(session.state!.doc.toString()).toBe('original UNSAVED');expect(t.opts.api).toHaveBeenCalledTimes(1);
  });
  it('normalizes an accepted save-as copy only in its target session and preserves its prior undo',async()=>{
    const t=setup(),original='1. First\n4. Second\n',formatted='1. First\n2. Second\n';
    const session=t.add('editor','original.md',original),sibling=t.add('other','original.md',original);
    t.edit(session,'\nDone');
    t.setDialog({kind:'saveAs',value:'copy.md',title:'copy'});
    const write=deferred();
    t.setHandler(async(url,body:any)=>{
      if(url==='/file'){expect(body.text).toBe(formatted+'\nDone');return write.promise;}
      if(url.startsWith('/file?'))return data('copy.md',formatted+'\nDone','copy-hash');
      return {root:'synthetic',entries:[]};
    });
    const pending=t.actions().submitDialog({preventDefault(){}} as any);
    expect(session.state!.doc.toString()).toBe(original+'\nDone');
    write.resolve({hash:'copy-hash'});await pending;
    expect(session.state!.doc.toString()).toBe(formatted+'\nDone');
    expect(session.disk?.path).toBe('copy.md');expect(session.dirty).toBe(false);
    expect(sibling.state!.doc.toString()).toBe(original);expect(sibling.disk?.path).toBe('original.md');
    expect(undo({state:session.state!,dispatch:tr=>{session.state=tr.state;}})).toBe(true);
    expect(session.state!.doc.toString()).toBe(formatted);
  });
  it('captures an import target before File.text resolves and keeps the newly active editor intact',async()=>{
    const t=setup(),first=t.add('editor','old.md'),other=t.add('other','other.md'),fileText=deferred<string>();
    t.setHandler(async(url)=>url==='/file'?{hash:'imported'}:url.startsWith('/file?')?data('import.md','IMPORTED','imported'):{root:'synthetic',entries:[]});
    const pending=t.actions().importFile({name:'import.md',size:8,text:()=>fileText.promise} as File);t.activate('other');fileText.resolve('IMPORTED');await pending;
    expect(first.disk?.path).toBe('import.md');expect(first.state!.doc.toString()).toBe('IMPORTED');expect(other.disk?.path).toBe('other.md');expect(t.file()).toBe('other.md');
  });
  it('does not let an old save clear the loading indicator of a pending open',async()=>{
    const t=setup(),session=t.add('editor','old.md'),write=deferred(),read=deferred();t.edit(session);
    t.setHandler(url=>url==='/file'?write.promise:read.promise);const saving=t.persistence.saveSession('editor'),opening=t.actions().openFile('next.md');
    expect(t.openingFile.at(-1)).toBe(false);
    write.resolve({hash:'saved'});await saving;expect(t.busy.at(-1)).toBe(true);read.resolve(data('next.md'));await opening;expect(t.busy.at(-1)).toBe(false);
    expect(t.openingFile.slice(-2)).toEqual([true,false]);
  });
  it('maps inactive pending AI anchors through disk changes instead of discarding them',()=>{
    const t=setup(),session=t.add('editor','same.md','one target three');session.context={proposal:{id:'proposal',from:4,to:10,original:'target',file:'same.md',stale:false,text:'new',reason:'reason',mode:'edit',count:3,node:'node'},undo:[],writingNodeId:null};
    t.persistence.applyDiskFile(data('same.md','one changed three','new'));
    expect(session.context.proposal?.id).toBe('proposal');expect(session.context.proposal?.stale).toBe(true);expect(session.state!.doc.toString()).toBe('one changed three');
  });
});

describe('stored persistence notifications',()=>{
  it('notifies the App owner with the actual no-View transaction and never revives an overlapped pending result',()=>{
    const t=setup(),session=t.add('editor','same.md','one target three');
    const anchor={from:4,to:10,original:'target',file:'same.md',stale:false};
    const owners:any={proposal:{current:{...anchor,id:'pending',text:'next',reason:'reason',mode:'edit',count:4,node:'node'}},requestAnchor:{current:{...anchor}},undo:{current:[]}};
    t.opts.onStoredChange=vi.fn((id:string,transaction:Transaction)=>{expect(id).toBe('editor');expect(session.view).toBeNull();expect(session.state).toBe(transaction.state);applyStoredDocumentChange(owners,transaction);});
    t.persistence.applyDiskFile(data('same.md','one changed three','new'));
    t.persistence.applyDiskFile(data('same.md','one target three','restored'));
    expect(t.opts.onStoredChange).toHaveBeenCalledTimes(2);expect(t.active.editorState.current).toBe(session.state);expect(owners.proposal.current.stale).toBe(true);expect(owners.requestAnchor.current.stale).toBe(true);
  });
});

describe('save snapshot authority',()=>{
  it('serializes once, keeps later edits dirty and never overwrites a rebound save baseline',async()=>{
    const t=setup(),one=t.add('editor','same.md'),two=t.add('other','same.md');t.edit(one);two.state=one.state;
    const snapshot=one.state!.doc,read=vi.spyOn(snapshot,'toString'),pending=deferred();t.setHandler(()=>pending.promise);
    const saving=t.persistence.saveSession('editor');t.edit(one,' later');two.disk={...two.disk!,text:'fresh reload',hash:'fresh'};pending.resolve({hash:'saved'});await saving;
    expect(read).toHaveBeenCalledOnce();expect(one.disk?.text).toBe('original UNSAVED');expect(one.dirty).toBe(true);expect(two.disk?.hash).toBe('fresh');expect(two.disk?.text).toBe('fresh reload');
  });
  it('keeps unchanged views clean and preserves undo history after a successful save',async()=>{
    const t=setup(),session=t.add('editor','same.md');t.edit(session);const state=session.state!;t.setHandler(async()=>({hash:'saved'}));await t.persistence.saveSession('editor');
    expect(session.state).toBe(state);expect(session.dirty).toBe(false);let restored=state;const dispatch=(tr:Transaction)=>{restored=tr.state;};expect(undo({state:restored,dispatch})).toBe(true);expect(restored.doc.toString()).toBe('original');
  });
  it('does not apply a completed save to an unmounted workspace owner',async()=>{
    const t=setup(),session=t.add('editor','same.md'),pending=deferred();t.edit(session);const baseline=session.disk;t.setHandler(()=>pending.promise);
    const saving=t.persistence.saveSession('editor');t.opts.appAlive.current=false;pending.resolve({hash:'saved'});expect(await saving).toBe(true);expect(session.disk).toBe(baseline);expect(session.dirty).toBe(true);
  });
});
