import {afterEach,expect,it,vi} from 'vitest';
import type {DependencyList,EffectCallback} from 'react';
import {EditorState} from '@codemirror/state';
import {history,undo,undoDepth} from '@codemirror/commands';
import {useDocumentPersistence} from './useDocumentPersistence';
import type {EditorSession} from '../editor/editorSessionTypes';
import type {DiskFile} from '../../shared/fileTypes';
import {workspaceTreeSync} from './workspaceSync';

// Exercise the real hook's async work; replace only React's scheduling in this node test.
const hooks=vi.hoisted(()=>({slots:[] as any[],cursor:0,effects:[] as (()=>void)[]}));
vi.mock('react',async original=>({
    ...await original<typeof import('react')>(),
    useRef:(value:unknown)=>{const index=hooks.cursor++;return hooks.slots[index]??(hooks.slots[index]={current:value});},
    useState:(value:unknown)=>{
        const index=hooks.cursor++;if(!(index in hooks.slots))hooks.slots[index]=value;
        return [hooks.slots[index],(next:unknown)=>{hooks.slots[index]=typeof next==='function'?next(hooks.slots[index]):next;}];
    },
    useEffect:(create:EffectCallback,deps?:DependencyList)=>{
        const index=hooks.cursor++,previous=hooks.slots[index];
        if(previous&&deps&&previous.deps?.length===deps.length&&deps.every((value,i)=>Object.is(value,previous.deps[i])))return;
        const slot={deps,create,cleanup:undefined as undefined|(()=>void)};hooks.slots[index]=slot;
        hooks.effects.push(()=>{previous?.cleanup?.();slot.cleanup=create()||undefined;});
    },
}));

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
const disk=(text='original',hash='baseline'):DiskFile=>({path:'draft.md',text,hash,eol:'LF',bom:false});
function fixture(){
    vi.useFakeTimers();hooks.slots=[];hooks.cursor=0;hooks.effects=[];
    const session:EditorSession={id:'editor',disk:disk(),state:EditorState.create({doc:'original'}),view:null,dirty:false};
    const options={api:vi.fn<(...args:any[])=>Promise<any>>(),workspace:{id:'a',root:'first'},sessions:{current:new Map([['editor',session]])},switching:{current:false},structuring:{current:false},fileBusy:false,tick:0,autoSave:false,
        setFileBusy:vi.fn(),setEntries:vi.fn(),setError:vi.fn(),inform:vi.fn(),redraw:vi.fn(),appAlive:{current:true}};
    let result!:ReturnType<typeof useDocumentPersistence>;
    const render=()=>{hooks.cursor=0;hooks.effects=[];result=useDocumentPersistence(options);for(const effect of hooks.effects)effect();return result;};
    render();
    return {options,session,render,get result(){return result;},
        unmount:()=>{for(const slot of hooks.slots)slot?.cleanup?.();},
        replayEffects:()=>{for(const slot of hooks.slots)if(slot?.create){slot.cleanup?.();slot.cleanup=slot.create()||undefined;}},
        response:(files:unknown[],extra:object={})=>({workspace:options.workspace,treeVersion:'opaque',files,...extra})};
}
afterEach(()=>{for(const slot of hooks.slots)slot?.cleanup?.();vi.useRealTimers();vi.clearAllMocks();vi.unstubAllGlobals();});

it('adopts the committed baseline when only the file-time record failed', async () => {
    const t = fixture();
    t.session.state = EditorState.create({ doc: 'local edits' });
    t.session.dirty = true;
    const warning = '正文已保存，但未能更新文件时间记录。';
    t.options.api.mockResolvedValueOnce({ hash: 'committed', path: 'draft.md', warning });

    await expect(t.result.saveSession('editor', true)).resolves.toBe(true);
    expect(t.session.disk).toMatchObject({ text: 'local edits', hash: 'committed' });
    expect(t.session.dirty).toBe(false);
    expect(t.options.inform).toHaveBeenCalledWith(warning);
    expect(t.options.setError).not.toHaveBeenCalled();
});

it('writes a normalized snapshot and maps the stored selection and prior undo after success',async()=>{
    const t=fixture(),raw='1. Alpha\n3. Charlie\n';
    t.session.state=EditorState.create({doc:raw,extensions:history()}).update({
        changes:{from:raw.length,insert:'\nNew paragraph'},selection:{anchor:raw.length+6},userEvent:'input.type',
    }).state;
    t.session.dirty=true;
    const before=t.session.state,pending=deferred<unknown>();
    t.options.api.mockReturnValueOnce(pending.promise);
    const saving=t.result.saveSession('editor',true);
    expect(t.options.api).toHaveBeenCalledWith('/file',expect.objectContaining({text:'1. Alpha\n2. Charlie\n\nNew paragraph',baseline:'baseline'}));
    expect(t.session.state).toBe(before);
    pending.resolve({path:'draft.md',hash:'normalized'});
    await expect(saving).resolves.toBe(true);
    expect(t.session.state?.doc.toString()).toBe(t.session.disk?.text);
    expect(t.session.state?.selection.main.anchor).toBe(before.selection.main.anchor);
    expect(undoDepth(t.session.state!)).toBe(1);
    expect(t.session.dirty).toBe(false);
    expect(undo({state:t.session.state!,dispatch:tr=>{t.session.state=tr.state;}})).toBe(true);
    expect(t.session.state?.doc.toString()).toBe('1. Alpha\n2. Charlie\n');
});

it('keeps the editor and undo untouched after a save failure and preserves concurrent edits after a retry',async()=>{
    const t=fixture(),raw='1) First\n4) Second\n';
    t.session.state=EditorState.create({doc:raw,extensions:history()}).update({
        changes:{from:raw.length,insert:'\nBefore save'},userEvent:'input.type',
    }).state;
    t.session.dirty=true;
    const original=t.session.state;
    t.options.api.mockRejectedValueOnce(new Error('Disk conflict'));
    await expect(t.result.saveSession('editor',true)).resolves.toBe(false);
    expect(t.session.state).toBe(original);
    expect(t.session.disk?.hash).toBe('baseline');
    expect(undoDepth(t.session.state)).toBe(1);
    const pending=deferred<unknown>();
    t.options.api.mockReturnValueOnce(pending.promise);
    const saving=t.result.saveSession('editor',true);
    t.session.state=original.update({changes:{from:original.doc.length,insert:'\nWhile saving'},userEvent:'input.type'}).state;
    pending.resolve({path:'draft.md',hash:'normalized'});
    await expect(saving).resolves.toBe(true);
    expect(t.session.disk?.text).toBe('1) First\n2) Second\n\nBefore save');
    expect(t.session.state?.doc.toString()).toBe(raw+'\nBefore save\nWhile saving');
    expect(t.session.dirty).toBe(true);
});

it('autosaves and writes an editable external Markdown through the same normalization',async()=>{
    const t=fixture(),raw='9) First\n1) Second\n',expected='9) First\n10) Second\n';
    t.session.state=EditorState.create({doc:raw});t.session.dirty=true;
    t.options.autoSave=true;t.options.tick++;t.render();
    t.options.api.mockResolvedValueOnce({path:'draft.md',hash:'auto'});
    await vi.advanceTimersByTimeAsync(900);
    expect(t.session.state?.doc.toString()).toBe(expected);
    expect(t.session.disk?.text).toBe(expected);
    const external=vi.fn(async()=>({path:'D:/external.md',hash:'external'}));
    vi.stubGlobal('window',{hiveDesktop:{saveLocalMarkdown:external}});
    t.session.disk=null;
    t.session.external={editable:true,disk:{...disk(raw),path:'D:/external.md',eol:'CRLF',bom:true}};
    t.session.state=EditorState.create({doc:raw});t.session.dirty=true;
    await expect(t.result.saveSession('editor')).resolves.toBe(true);
    expect(external).toHaveBeenCalledWith({path:'D:/external.md',text:expected,baseline:'baseline',eol:'CRLF',bom:true});
    expect(t.session.external.disk.text).toBe(expected);
    expect(t.session.state?.doc.toString()).toBe(expected);
    expect(t.session.dirty).toBe(false);
});

it('ignores a save receipt after switching repositories with the same open path', async () => {
    const t = fixture();
    t.session.state = EditorState.create({ doc: 'first repository edits' });
    t.session.dirty = true;
    const pending = deferred<unknown>();
    t.options.api.mockReturnValueOnce(pending.promise);
    const saving = t.result.saveSession('editor', true);

    t.options.workspace = { id: 'b', root: 'second' };
    t.options.sessions.current.set('new-tab', { ...t.session, id: 'new-tab', disk: disk() });
    t.render();
    pending.resolve({ hash: 'committed', path: 'draft.md' });

    await expect(saving).resolves.toBe(true);
    expect(t.options.sessions.current.get('new-tab')?.disk?.hash).toBe('baseline');
    expect(t.result.savingPaths.current.size).toBe(0);
});

it('sends the learned tree version and processes disk updates without replacing unchanged entries',async()=>{
    const t=fixture(),entries=[{path:'draft.md',name:'draft.md',type:'file'}];
    t.options.api.mockResolvedValueOnce(t.response([{path:'draft.md',hash:'baseline',unchanged:true}],{entries,treeVersion:'v1'}));
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.options.api.mock.calls[0][1]).toEqual({paths:['draft.md'],baselines:{'draft.md':'baseline'}});
    expect(t.options.setEntries).toHaveBeenCalledExactlyOnceWith(entries);
    t.options.api.mockResolvedValueOnce(t.response([disk('external','new-hash')],{treeVersion:'v1'}));
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.options.api.mock.calls[1][1].treeVersion).toBe('v1');
    expect(t.options.setEntries).toHaveBeenCalledTimes(1);
    expect(t.session.state?.doc.toString()).toBe('external');expect(t.session.disk?.hash).toBe('new-hash');
});
it('preserves dirty local text and reports conflict when a response omits entries',async()=>{
    const t=fixture();t.session.state=EditorState.create({doc:'local edits'});t.session.dirty=true;
    t.options.api.mockResolvedValue(t.response([disk('external','new-hash')]));
    await vi.advanceTimersByTimeAsync(2000);t.render();
    expect(t.options.setEntries).not.toHaveBeenCalled();expect(t.session.state.doc.toString()).toBe('local edits');
    expect(t.session.disk?.hash).toBe('baseline');expect(t.session.dirty).toBe(true);
    expect(t.result.fileConflicts['draft.md']).toContain('磁盘和本地都有修改');
});
it('rejects late trees and file contents after switching repositories, even with identical file hashes',async()=>{
    const t=fixture(),pending=deferred<any>(),old=t.options.workspace;
    t.options.api.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);
    t.options.workspace={id:'b',root:'second'};
    const next:EditorSession={...t.session,disk:disk(),state:EditorState.create({doc:'original'})};
    t.options.sessions.current=new Map([['editor',next]]);t.render();
    pending.resolve({workspace:old,treeVersion:'old-version',entries:[{path:'stale'}],files:[disk('stale','old-hash')]});
    await vi.advanceTimersByTimeAsync(0);
    expect(t.options.setEntries).not.toHaveBeenCalled();expect(next.state?.doc.toString()).toBe('original');
    expect(t.options.setError).not.toHaveBeenCalled();
    t.options.api.mockResolvedValueOnce(t.response([]));await vi.advanceTimersByTimeAsync(2000);
    expect(t.options.api.mock.calls[1][1]).not.toHaveProperty('treeVersion');
});
it('rejects an old response after a repository round trip without replacing the sessions map',async()=>{
    const t=fixture(),pending=deferred<any>(),first=t.options.workspace;t.options.api.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);
    t.options.workspace={id:'b',root:'second'};t.render();t.options.workspace=first;t.render();
    pending.resolve(t.response([disk('stale','old')],{entries:[]}));await vi.advanceTimersByTimeAsync(0);
    expect(t.options.setEntries).not.toHaveBeenCalled();expect(t.session.state?.doc.toString()).toBe('original');
});
it('drops an in-flight response on unmount and does not recreate its polling timer',async()=>{
    const t=fixture(),pending=deferred<any>();t.options.api.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);t.unmount();
    pending.resolve(t.response([disk('late','new')],{entries:[]}));await vi.advanceTimersByTimeAsync(0);
    expect(t.options.setEntries).not.toHaveBeenCalled();expect(t.session.state?.doc.toString()).toBe('original');
    expect(vi.getTimerCount()).toBe(0);
});
it('lets a forced refresh supersede an older poll without accepting its tree or file content',async()=>{
    const t=fixture(),pending=deferred<any>();t.options.api.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);
    const cursor=workspaceTreeSync(t.options.setEntries,t.options.workspace),refresh=cursor.beginRefresh();
    pending.resolve(t.response([disk('stale','old')],{entries:[],treeVersion:'old-tree'}));await vi.advanceTimersByTimeAsync(0);
    expect(t.options.setEntries).not.toHaveBeenCalled();expect(t.session.state?.doc.toString()).toBe('original');
    cursor.finishRefresh(refresh,'forced-tree');
    t.options.api.mockResolvedValueOnce(t.response([],{treeVersion:'forced-tree'}));await vi.advanceTimersByTimeAsync(2000);
    expect(t.options.api.mock.calls[1][1].treeVersion).toBe('forced-tree');
});
it('keeps one timer after StrictMode effect replay and drops work from its prior effect lifetime',async()=>{
    const t=fixture(),pending=deferred<any>();t.options.api.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);t.replayEffects();expect(vi.getTimerCount()).toBe(1);
    pending.resolve(t.response([disk('late','new')],{entries:[]}));await vi.advanceTimersByTimeAsync(0);
    expect(t.options.setEntries).not.toHaveBeenCalled();expect(t.session.state?.doc.toString()).toBe('original');expect(vi.getTimerCount()).toBe(1);
    t.options.api.mockResolvedValueOnce(t.response([]));await vi.advanceTimersByTimeAsync(2000);
    expect(t.options.api).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(1);
    t.unmount();expect(vi.getTimerCount()).toBe(0);
});

it.each(['unchanged','full'] as const)('resumes pending autosave after a transient read error recovers via %s',async recovered=>{
    const t=fixture();
    t.options.api.mockResolvedValueOnce(t.response([{path:'draft.md',error:'temporary read failure'}]));
    await vi.advanceTimersByTimeAsync(2000);t.render();
    expect(t.result.fileConflicts['draft.md']).toContain('temporary read failure');
    t.session.state=EditorState.create({doc:'pending local edits'});t.session.dirty=true;
    t.options.autoSave=true;t.options.tick++;t.render();
    await vi.advanceTimersByTimeAsync(900);
    expect(t.options.api.mock.calls.some(call=>call[0]==='/file')).toBe(false);
    t.options.api.mockResolvedValueOnce(t.response([recovered==='unchanged'?{path:'draft.md',hash:'baseline',unchanged:true}:disk()]));
    await vi.advanceTimersByTimeAsync(1100);t.render();
    expect(t.result.fileConflicts['draft.md']).toBe('');
    t.options.api.mockResolvedValueOnce({hash:'saved'});
    // Recovery itself must reschedule a blocked dirty document without another keystroke.
    await vi.advanceTimersByTimeAsync(900);
    expect(t.options.api.mock.calls.filter(call=>call[0]==='/file')).toEqual([['/file',expect.objectContaining({text:'pending local edits',baseline:'baseline'})]]);
    expect(t.session.disk?.hash).toBe('saved');expect(t.session.dirty).toBe(false);
});

it('does not replace or clear a content conflict when reads fail temporarily and recover unchanged',async()=>{
    const t=fixture();t.session.state=EditorState.create({doc:'local edits'});t.session.dirty=true;
    t.options.api.mockResolvedValueOnce(t.response([disk('external edits','external')]));
    await vi.advanceTimersByTimeAsync(2000);t.render();
    const conflict=t.result.fileConflicts['draft.md'];expect(conflict).toContain('磁盘和本地都有修改');
    t.options.api.mockResolvedValueOnce(t.response([{path:'draft.md',error:'temporary read failure'}]));
    await vi.advanceTimersByTimeAsync(2000);t.render();expect(t.result.fileConflicts['draft.md']).toBe(conflict);
    t.options.api.mockResolvedValueOnce(t.response([{path:'draft.md',hash:'baseline',unchanged:true}]));
    await vi.advanceTimersByTimeAsync(2000);t.render();expect(t.result.fileConflicts['draft.md']).toBe(conflict);
    expect(t.session.state.doc.toString()).toBe('local edits');expect(t.session.disk?.hash).toBe('baseline');
});

it('upgrades a transient read failure to a content conflict and preserves that conflict on later unchanged reads',async()=>{
    const t=fixture();t.session.state=EditorState.create({doc:'local edits'});t.session.dirty=true;
    t.options.api.mockResolvedValueOnce(t.response([{path:'draft.md',error:'temporary read failure'}]));
    await vi.advanceTimersByTimeAsync(2000);t.render();
    t.options.api.mockResolvedValueOnce(t.response([disk('external edits','external')]));
    await vi.advanceTimersByTimeAsync(2000);t.render();
    const conflict=t.result.fileConflicts['draft.md'];expect(conflict).toContain('磁盘和本地都有修改');
    t.options.api.mockResolvedValueOnce(t.response([{path:'draft.md',hash:'baseline',unchanged:true}]));
    await vi.advanceTimersByTimeAsync(2000);t.render();expect(t.result.fileConflicts['draft.md']).toBe(conflict);
});

it('keeps a save failure above transient read errors and unchanged recovery',async()=>{
    const t=fixture();t.session.state=EditorState.create({doc:'local edits'});t.session.dirty=true;
    t.options.api.mockResolvedValueOnce(t.response([{path:'draft.md',error:'temporary read failure'}]));
    await vi.advanceTimersByTimeAsync(2000);t.render();
    t.options.api.mockRejectedValueOnce(new Error('save conflict must remain'));
    await expect(t.result.saveSession('editor',true)).resolves.toBe(false);t.render();
    t.options.api.mockResolvedValueOnce(t.response([{path:'draft.md',error:'another read failure'}]));
    await vi.advanceTimersByTimeAsync(2000);t.render();expect(t.result.fileConflicts['draft.md']).toBe('save conflict must remain');
    t.options.api.mockResolvedValueOnce(t.response([{path:'draft.md',hash:'baseline',unchanged:true}]));
    await vi.advanceTimersByTimeAsync(2000);t.render();expect(t.result.fileConflicts['draft.md']).toBe('save conflict must remain');
});

it.each(['unchanged','error'] as const)('ignores a late %s response from an earlier repository when the new repository has a conflict',async kind=>{
    const t=fixture(),pending=deferred<any>(),old=t.options.workspace;
    t.options.api.mockResolvedValueOnce(t.response([{path:'draft.md',error:'old repository read failure'}]));
    await vi.advanceTimersByTimeAsync(2000);t.render();
    t.options.api.mockReturnValueOnce(pending.promise);await vi.advanceTimersByTimeAsync(2000);
    t.options.workspace={id:'b',root:'second'};
    t.options.sessions.current=new Map([['editor',{...t.session,disk:disk(),state:EditorState.create({doc:'new repository text'}),dirty:true}]]);t.render();
    t.options.api.mockRejectedValueOnce(new Error('new repository save conflict'));
    await t.result.saveSession('editor',true);t.render();
    const remote=kind==='unchanged'?{path:'draft.md',hash:'baseline',unchanged:true}:{path:'draft.md',error:'late old read error'};
    pending.resolve({workspace:old,treeVersion:'old',files:[remote]});await vi.advanceTimersByTimeAsync(0);t.render();
    expect(t.result.fileConflicts['draft.md']).toBe('new repository save conflict');
    expect(t.options.sessions.current.get('editor')?.state?.doc.toString()).toBe('new repository text');
});
