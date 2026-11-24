import {beginFileActivity,beginFileRead,type FileActivityUpdate} from './fileOperations';
import {checkFileOperations} from './fileOperationChecks';
import {documentMatchesText} from '../editor/documentText';
import {diskSyncDecision} from './fileSync';
import {workspaceTreeSync} from './workspaceSync';
import {isImagePath} from './fileKinds';
import {localDocumentError,writeDocument} from './writeDocument';
import {isDrivePath} from './localDocumentPath';
import type { Dispatch, FormEvent, RefObject, SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import type { ApiClient } from '../../shared/api';
import type { DiskFile } from '../../shared/fileTypes';
import type { EditorSession } from '../editor/editorSessionTypes';
import type { Dialog } from '../editor/editorDialogTypes';
import type { Anchor, Proposal, UndoEdit } from '../../shared/core';
import { headings } from '../../shared/core';
import { makeState } from '../editor/Editor';
import { mapEntryPath, type Entry } from './explorerState';
import type { FileAction, FileResult } from './FileExplorer';
import type { PanelWorkspaceApi } from '../workspace/PanelFrame';
import type { useFileWorkspace } from './WorkspaceContext';
import type { useTextAnnotations } from '../annotations/useTextAnnotations';
import type { useReferenceSources } from '../chat/referenceSources';

type FileActionsOptions = {
    api: ApiClient;
    appAlive?:RefObject<boolean>;
    promptRef?:RefObject<HTMLTextAreaElement|null>;
    hasUnsentChatDraft?:()=>boolean;
    dialogRef?:RefObject<Dialog|null>;
    uid: () => string;
    workspace: PanelWorkspaceApi;
    sessions: RefObject<Map<string, EditorSession>>;
    activeSession: RefObject<string>;
    activeTextSource: RefObject<'document' | 'scratch'>;
    proposal: RefObject<Proposal | null>;
    undo: RefObject<UndoEdit[]>;
    prompt: string;
    dialog: Dialog | null;
    running: RefObject<boolean>;
    requestAnchor: RefObject<Anchor | null>;
    structuring: RefObject<boolean>;
    switching: RefObject<boolean>;
    viewApplying: RefObject<boolean>;
    creatingNote: RefObject<boolean>;
    savingPaths: RefObject<Set<string>>;
    fileWorkspace: ReturnType<typeof useFileWorkspace>;
    saveSession: (id: string, quiet?: boolean) => Promise<boolean>;
    finalizeTrashedSessions: (sessions: EditorSession[], safe: (session: EditorSession) => boolean) => number;
    applyDiskFile: (data: DiskFile) => void;
    annotations: ReturnType<typeof useTextAnnotations>;
    references: ReturnType<typeof useReferenceSources>;
    bindings: (id: string) => { onUpdate: any };
    stop: () => void;
    redraw: () => void;
    inform: (message: string) => void;
    setError: (message: string) => void;
    setFileBusy: FileActivityUpdate;
    setNewNoteBusy: (busy: boolean) => void;
    setEntries: Dispatch<SetStateAction<Entry[]>>;
    setRoot: (root: string) => void;
    setConfirm: (value: { text: string; action: () => void }) => void;
    setDialog: (value: Dialog | null) => void;
    setFilter: (value: string) => void;
    setRenameRequest: (value: { path: string; key: string }) => void;
    setCollapsed: (updater: (old: Set<string>) => Set<string>) => void;
    setTrashRevision: (updater: (old: number) => number) => void;
    setInlineRequest: (value: null) => void;
    setOutline: (value: ReturnType<typeof headings>) => void;
    setSelection: (value: { from: number; to: number; text: string }) => void;
    setWritingNodeId: (value: null) => void;
    onApplied?: (action:FileAction,result:FileResult,actor:'human'|'ai')=>void;
};

/**
 * 文件动作：打开 / 另存 / 新建标签 / 导入 / 整理文件树 / 切换写作空间 / 弹窗提交。
 * 固定目标与请求世代，保留同文件状态/历史；磁盘变化沿用冲突与事务规则。
 */
export function useFileActions(options: FileActionsOptions) {
    const {
        api, uid, workspace, sessions, activeSession, activeTextSource, proposal, undo, prompt, dialog,
        running, requestAnchor, structuring, switching, viewApplying, creatingNote, savingPaths,
        fileWorkspace, saveSession, applyDiskFile, annotations, references, bindings, stop, redraw, inform,
        setError, setFileBusy, setNewNoteBusy, setEntries, setRoot, setConfirm, setDialog, setFilter,
        setRenameRequest, setCollapsed, setTrashRevision, setInlineRequest, setOutline, setSelection, setWritingNodeId,
    } = options;
    const treeSync=workspaceTreeSync(setEntries,fileWorkspace.info),treeOwner=treeSync.owner();

    const scope=()=>options.appAlive?.current!==false&&!switching.current;
    const loading:FileActivityUpdate=(busy,openingFile)=>{if(options.appAlive?.current!==false)setFileBusy(busy,openingFile);};
    const proposalFor=(id:string)=>id===activeSession.current?proposal.current:sessions.current.get(id)?.context?.proposal??null;
    const pendingReview=(path:string)=>[...sessions.current.values()].find(session=>session.disk?.path===path&&proposalFor(session.id));
    const writing=()=>running.current&&!!requestAnchor.current;
    function openPendingReview(path:string){
        const pending=pendingReview(path);
        if(!pending)return false;
        if(workspace.isOpen(pending.id))workspace.open(pending.id);
        else if(workspace.openDocumentTab(pending.id)!=='succeeded')throw new Error('无法打开待审建议，请完成输入法组词或当前窗口操作后重试。');
        return true;
    }
    const beginRead=(id=activeSession.current,openingFile=true)=>{
        const identity=fileWorkspace?.info?.id,root=fileWorkspace?.info?.root,pending=proposalFor(id);
        const ticket=beginFileRead(sessions,id,()=>scope()&&fileWorkspace?.info?.id===identity&&fileWorkspace?.info?.root===root,loading,workspace.isOpen?.bind(workspace),openingFile);
        return {...ticket,valid:()=>ticket.valid()&&proposalFor(id)===pending};
    };
    const requireRead=(ticket:ReturnType<typeof beginRead>)=>{if(ticket.valid())return true;if(ticket.current())setError('等待读取时标签或正文已变化，当前内容仍保留，请重新打开。');return false;};
    const refresh = async () => {
        if(!scope()||!treeSync.owns(fileWorkspace.info,treeOwner))return;
        const identity=fileWorkspace.info.id,root=fileWorkspace.info.root,owner=sessions.current;
        const ticket=treeSync.beginRefresh();
        try {
            const data = await api<{ root: string; entries: Entry[];treeVersion?:string }>('/tree?refresh=1');
            if(!scope()||sessions.current!==owner||fileWorkspace.info.id!==identity||fileWorkspace.info.root!==root)return;
            if(!treeSync.finishRefresh(ticket,data.treeVersion))return;
            setEntries(data.entries);
            setRoot(data.root);
        } finally {treeSync.finishRefresh(ticket);}
    };
    function reconcileKnownFile(data:DiskFile){
        const matching=[...sessions.current.values()].filter(session=>session.disk?.path===data.path&&(session.view?.state||session.state));
        if(!matching.length)return true;
        const decision=diskSyncDecision(matching.map(session=>({baseline:session.disk!,text:(session.view?.state||session.state)!.doc})),data);
        if(decision==='conflict'){setError('磁盘和本地都有修改，当前本地内容和历史仍保留。请核对后重新读取或另存副本。');return false;}
        if(decision==='adopt')applyDiskFile(data);
        return true;
    }
    function showFile(data: DiskFile, targetId = activeSession.current) {
        let session=sessions.current.get(targetId);if(!session)return;
        if(session.trashPreview||session.external){
            const parent=targetId;
            targetId='editor:'+uid();
            session={id:targetId,disk:null,state:null,view:null,dirty:false};
            sessions.current.set(targetId,session);
            if(workspace.openDocumentTab(targetId,parent)!=='succeeded'){
                sessions.current.delete(targetId);
                setError('无法打开文稿，请完成当前窗口操作后重试。');
                return false;
            }
        }
        const same=session.disk?.path===data.path&&(session.view?.state||session.state);
        if(same){
            if(!reconcileKnownFile(data))return false;
            if(!workspace.isOpen?.(targetId))workspace.open(targetId);
            redraw();return;
        }
        if(proposalFor(targetId)){setError('请先审阅当前文档的建议，或在新标签页打开其他文档。');return false;}
        const shared=[...sessions.current.values()].find(value=>value.id!==targetId&&value.disk?.path===data.path&&(value.view?.state||value.state));
        if(shared&&!reconcileKnownFile(data))return false;
        const nextDisk=shared?.disk?{...shared.disk}:data;
        const content=shared?(shared.view?.state||shared.state)!.doc:data.text;
        const nextState=makeState(content,bindings(targetId).onUpdate,undefined,session.displayMode);
        session.imagePath=undefined;session.landing=false;session.disk=nextDisk;session.state=nextState;session.dirty=!documentMatchesText(nextState.doc,nextDisk.text);session.context=undefined;session.contentVersion=(session.contentVersion||0)+1;
        // Set the new viewport before CodeMirror measures and anchors the replacement document.
        session.restoreScroll=undefined;session.restoreScrollLeft=undefined;session.restoreScrollTarget=undefined;
        if(session.view){
            session.view.scrollDOM.scrollTop=0;
            session.view.scrollDOM.scrollLeft=0;
            session.view.setState(nextState);
        }
        if(targetId!==activeSession.current){if(!workspace.isOpen?.(targetId))workspace.open(targetId);redraw();return;}
        if(writing())stop();
        proposal.current=null;undo.current=[];
        workspace.open(targetId);annotations.syncEditor('document',session.view,data.path);
        setWritingNodeId(null);setInlineRequest(null);setOutline(headings(nextState));
        setSelection({from:0,to:0,text:''});activeTextSource.current='document';setError('');
        // CodeMirror replaces the body synchronously. Commit its active file label in the same frame.
        if(session.view)flushSync(redraw);else redraw();
    }
    async function readFile(path:string,targetId:string,ticket:ReturnType<typeof beginRead>){
        if(!requireRead(ticket))return;
        const data=await api<DiskFile>('/file?path='+encodeURIComponent(path));
        if(requireRead(ticket))showFile(data,targetId);
    }
    async function openFile(path: string,targetId=activeSession.current) {
        const ticket=beginRead(targetId);
        try{await readFile(path,targetId,ticket);}
        catch(error){if(ticket.current())setError((error as Error).message);}
        finally{ticket.cancel();}
    }
    function safeSwitch(action: () => void) {
        if (sessions.current.get(activeSession.current)?.dirty)
            setConfirm({
                text: '当前文档尚未保存。继续会放弃本次手改；也可以取消后先按 Ctrl+S 保存。',
                action,
            });
        else
            action();
    }
    function openSaveAs(path?: string) {
        const current = sessions.current.get(activeSession.current);
        if(current?.trashPreview||current?.external)return;
        const name = path ?? (current?.imagePath || current?.disk?.path || '未命名.md');
        if (name)
            setDialog({ kind: 'saveAs', title: '另存为 Markdown', value: name.replace(/\.md$/i, '-副本.md') });
    }
    async function save() {
        await saveSession(activeSession.current);
    }
    function openBlankTab(sourceId: string) {
        if (structuring.current || switching.current || viewApplying.current || creatingNote.current || writing()) {
            setError('请等待当前操作完成后再新建标签页。');
            return;
        }
        if (workspace.openIds.filter(id => sessions.current.has(id)).length >= 48) {
            setError('打开的文档标签已达 48 个，请先关闭不再使用的标签页。');
            return;
        }
        const source = sessions.current.get(sourceId), id = 'editor:' + uid();
        sessions.current.set(id, { id, disk: null, state: null, view: null, dirty: false, landing: true, typewriter: source?.typewriter, displayMode: source?.displayMode });
        activeTextSource.current = 'document';
        workspace.openDocumentTab(id, sourceId);
        redraw();
    }
    async function openInLanding(path:string,id:string){
        if(!sessions.current.get(id)?.landing)throw new Error('这个新标签页已经打开文档，请重新选择标签页。');
        if(structuring.current||switching.current||viewApplying.current||writing())throw new Error('请等待当前操作完成后再打开文件。');
        if(openPendingReview(path))return;
        if(isImagePath(path)){await openExplorerFile(path);return;}
        const ticket=beginRead(id);
        try{await fileWorkspace.flush();if(!requireRead(ticket))return;await readFile(path,id,ticket);}
        catch(error){if(ticket.current())throw error;}
        finally{ticket.cancel();}
    }
    async function createQuickNote(id = activeSession.current) {
        if (creatingNote.current) return;
        const landing = sessions.current.get(id)?.landing && workspace.isOpen(id);
        if (!landing && workspace.openIds.filter(id => sessions.current.has(id)).length >= 48) {
            setError('打开的文档标签已达 48 个，请先关闭不再使用的标签页。');
            return;
        }
        creatingNote.current = true;
        setNewNoteBusy(true);
        try {
            const result = await manageFile({ action: 'create', parent: '', type: 'file' });
            if(!scope())return;
            if(landing&&sessions.current.get(id)?.landing&&workspace.isOpen(id))await openInLanding(result.path,id);
            else await openExplorerFile(result.path,true);
            workspace.open('files');
            setFilter('');
            setRenameRequest({ path: result.path, key: uid() });
        }
        catch (error) {
            if(scope())setError((error as Error).message);
        }
        finally {
            creatingNote.current = false;
            if(options.appAlive?.current!==false)setNewNoteBusy(false);
        }
    }
    async function openExplorerFile(path:string,newTab=false,reuseExisting=false){
        if(structuring.current||writing()||switching.current||viewApplying.current)throw new Error('请等待文件操作完成或停止正文生成后再打开。');
        if(openPendingReview(path))return;
        const focusExisting=()=> {
            if(!reuseExisting)return false;
            const existing=[...sessions.current.values()].find(session=>session.disk?.path.toLowerCase()===path.toLowerCase()&&workspace.isOpen(session.id));
            if(!existing)return false;
            workspace.open(existing.id);
            return true;
        };
        if(focusExisting())return;
        const active=sessions.current.get(activeSession.current);
        newTab ||= !!(active?.trashPreview||active?.external);
        if(isImagePath(path)){
            const existing=[...sessions.current.values()].find(session=>session.imagePath===path);
            if(existing&&!newTab){workspace.open(existing.id);return;}
            // Images get a separate read-only tab. Opening one cannot replace an
            // unsaved manuscript, its history, or an in-progress chat.
            const current=sessions.current.get(activeSession.current)!,targetId=current.landing&&!newTab?current.id:'editor:'+uid(),ticket=beginRead(targetId);
            try{
                await fileWorkspace.flush();if(!requireRead(ticket))return;
                await api('/image-file/info?path='+encodeURIComponent(path));if(!requireRead(ticket))return;
                const session:EditorSession={id:targetId,imagePath:path,disk:null,state:null,view:null,dirty:false};
                sessions.current.set(targetId,session);
                if(targetId===activeSession.current){setOutline([]);setSelection({from:0,to:0,text:''});}
                workspace.openDocumentTab(targetId);redraw();
            }finally{ticket.cancel();}
            return;
        }
        const targetId=newTab?'editor:'+uid():activeSession.current,ticket=beginRead(targetId);
        try{
            await fileWorkspace.flush();if(!requireRead(ticket))return;
            if(!newTab){
                const current=sessions.current.get(targetId)!;
                if(proposalFor(targetId))throw new Error('请先审阅当前文档的建议，或在新标签页打开其他文档。');
                if(current.dirty&&!await saveSession(targetId,true))throw new Error('当前文档尚未保存，请先处理保存冲突或另存未命名稿。');
                if(!requireRead(ticket))return;
                await readFile(path,targetId,ticket);return;
            }
            const data=await api<DiskFile>('/file?path='+encodeURIComponent(path));if(!requireRead(ticket))return;
            if(focusExisting()||!reconcileKnownFile(data))return;
            sessions.current.set(targetId,{id:targetId,disk:null,state:null,view:null,dirty:false});showFile(data,targetId);workspace.openDocumentTab(targetId);redraw();
        }catch(error){if(ticket.current())throw error;}
        finally{ticket.cancel();}
    }
    async function readLocalDocument(path:string){
        if(!window.hiveDesktop?.openLocalMarkdown)throw new Error('请在 HIVE 桌面应用中打开绝对路径。');
        try{return await window.hiveDesktop.openLocalMarkdown(path,fileWorkspace.info.root);}
        catch(error){throw new Error(localDocumentError(error));}
    }
    async function openDocumentPath(path:string){
        if(!isDrivePath(path)){await openExplorerFile(path,true);return;}
        if(structuring.current||writing()||switching.current||viewApplying.current)throw new Error('请等待文件操作完成或停止正文生成后再打开。');
        const parent=activeSession.current,id='editor:'+uid(),ticket=beginRead(id);
        try{
            await fileWorkspace.flush();if(!requireRead(ticket))return;
            const target=await readLocalDocument(path);if(!requireRead(ticket)||!treeSync.owns(fileWorkspace.info,treeOwner))return;
            if('relative' in target){await openExplorerFile(target.relative,true,true);return;}
            const existing=[...sessions.current.values()].find(session=>session.external?.disk.path===target.external.path);
            if(existing){workspace.open(existing.id);return;}
            if(workspace.openIds.filter(id=>sessions.current.has(id)).length>=48)
                throw new Error('打开的文档标签已达 48 个，请先关闭不再使用的标签页。');
            const state=makeState(target.external.text,bindings(id).onUpdate,undefined,'preview');
            sessions.current.set(id,{id,disk:null,external:{disk:target.external,editable:false},state,view:null,dirty:false});
            if(workspace.openDocumentTab(id,parent)!=='succeeded'){
                sessions.current.delete(id);
                throw new Error('无法打开文稿，请完成当前窗口操作后重试。');
            }
            redraw();
        }finally{ticket.cancel();}
    }
    function requireFileActionStart() {
        if (structuring.current || switching.current || viewApplying.current || savingPaths.current.size)
            throw new Error('正在保存或切换工作区，请稍后重试。');
    }
    function prepareFileActions(actions:FileAction[]) {
        const identity=fileWorkspace.info.id,root=fileWorkspace.info.root,owner=sessions.current;
        return checkFileOperations({actions,sessions:()=>sessions.current,proposalFor,flush:()=>fileWorkspace.flush(),saveSession,
            assertAvailable:()=>{
                if(options.appAlive?.current===false||sessions.current!==owner||fileWorkspace.info.id!==identity||fileWorkspace.info.root!==root)
                    throw new Error('写作空间已变化，文件操作已取消。');
                if(switching.current||viewApplying.current||savingPaths.current.size)throw new Error('正在保存或切换工作区，请稍后重试。');
                if(running.current)throw new Error('请先停止 AI 生成，再整理文件。');
            }});
    }
    async function preflightFileActions(actions:FileAction[]):Promise<void> {
        if(!actions.length)return;
        requireFileActionStart();
        if(actions.every(action=>action.action==='reveal'))return;
        structuring.current=true;
        const release=beginFileActivity(sessions,loading);
        try{await prepareFileActions(actions);}
        finally{structuring.current=false;release();}
    }
    async function manageFile(action: FileAction, actionOptions?:{quiet?:boolean;actor?:'human'|'ai'|null}): Promise<FileResult> {
        requireFileActionStart();
        if (action.action === 'reveal')return api<FileResult>('/explorer', action);
        structuring.current = true;
        const release=beginFileActivity(sessions,loading);
        try {
            const checked=await prepareFileActions([action]);
            checked.validate();
            const affected=checked.affected;
            if(action.action==='basis')return {path:action.path||'',type:action.type||'file'};
            const snapshots=affected.map(session=>({session,path:session.imagePath||session.disk?.path,doc:(session.view?.state||session.state)?.doc,version:session.contentVersion||0,proposal:proposalFor(session.id)}));
            const result = await api<FileResult>('/explorer', action);
            if(!scope())return result;
            if(actionOptions?.actor!==null)options.onApplied?.(action,result,actionOptions?.actor||'human');
            if (action.path && ['move', 'rename'].includes(action.action)) {
                references.remap(action.path, result.path);
                for (const session of affected) {
                    if(session.imagePath){session.imagePath=mapEntryPath(session.imagePath,action.path,result.path);session.contentVersion=(session.contentVersion||0)+1;continue;}
                    session.disk = { ...session.disk!, path: mapEntryPath(session.disk!.path, action.path, result.path) };
                    if (session.context) {
                        session.context.proposal = null;
                        session.context.undo = [];
                    }
                }
                setCollapsed(old => new Set([...old].map(path => mapEntryPath(path, action.path!, result.path))));
                if(affected.some(session=>session.id===activeSession.current)){
                    setInlineRequest(null);
                    undo.current = [];
                    proposal.current = null;
                }
            }
            if (action.action === 'trash') {
                const current=[...sessions.current.values()].filter(session=>action.path&&((session.imagePath||session.disk?.path)===action.path||(session.imagePath||session.disk?.path)?.startsWith(action.path+'/')));
                const retained=options.finalizeTrashedSessions(current,session=>{
                    const snapshot=snapshots.find(item=>item.session===session);
                    return !!snapshot&&sessions.current.get(session.id)===session&&(session.imagePath||session.disk?.path)===snapshot.path&&
                        (session.view?.state||session.state)?.doc===snapshot.doc&&(session.contentVersion||0)===snapshot.version&&
                        proposalFor(session.id)===snapshot.proposal;
                });
                setTrashRevision(value => value + 1);
                if(retained)inform('已移到回收站。尚有正文需要保留，已转为未命名稿，请另存。');
                else if(!actionOptions?.quiet)inform('已移到回收站，可从文档列表的回收站恢复。');
            }
            redraw();
            try{await refresh();}
            catch(error){
                const warning='文件操作已完成，但列表刷新失败：'+(error instanceof Error?error.message:String(error));
                if(!actionOptions?.quiet)inform(warning);
                return {...result,warning};
            }
            return result;
        }
        finally {
            structuring.current = false;
            release();
        }
    }
    function reloadFromDisk(id:string){
        const external=sessions.current.get(id)?.external;
        if(external){
            const path=external.disk.path;
            setConfirm({text:'重新读取会放弃这个文稿中尚未保存的修改。',action:()=>{
                if(sessions.current.get(id)?.external!==external)return;
                if(savingPaths.current.has(path)){setError('文件正在保存，请稍后再重新读取。');return;}
                const ticket=beginRead(id);
                void readLocalDocument(path).then(data=>{
                    if(!requireRead(ticket))return;
                    if(!('external' in data)||data.external.path!==path)throw new Error('目标路径已变化，请重新打开。');
                    applyDiskFile(data.external);
                }).catch(error=>{if(ticket.current())setError(error.message);}).finally(ticket.cancel);
            }});
            return;
        }
        const original=sessions.current.get(id);if(!original?.disk)return;
        const path=original.disk.path;
        setConfirm({text:'重新读取会放弃这个文件在所有正文区中尚未保存的修改。可先另存本地副本。',action:()=>{
            if(sessions.current.get(id)!==original||original.disk?.path!==path){setError('目标标签已经变化，请重新选择文件。');return;}
            if(savingPaths.current.has(path)){setError('文件正在保存，请稍后再重新读取。');return;}
            const ticket=beginRead(id);
            const snapshots=[...sessions.current.values()].filter(session=>session.disk?.path===path).map(session=>({session,doc:(session.view?.state||session.state)?.doc,version:session.contentVersion||0}));
            void (async()=>{
                try{
                    const data=await api<DiskFile>('/file?path='+encodeURIComponent(path));
                    const current=[...sessions.current.values()].filter(session=>session.disk?.path===path);
                    const unchanged=current.length===snapshots.length&&snapshots.every(snapshot=>sessions.current.get(snapshot.session.id)===snapshot.session&&snapshot.session.disk?.path===path&&(snapshot.session.view?.state||snapshot.session.state)?.doc===snapshot.doc&&(snapshot.session.contentVersion||0)===snapshot.version);
                    if(!requireRead(ticket)||!unchanged){if(ticket.current()&&!unchanged)setError('等待读取时有正文区发生修改，所有本地内容仍保留，请重新确认。');return;}
                    applyDiskFile(data);
                }catch(error){if(ticket.current())setError((error as Error).message);}
                finally{ticket.cancel();}
            })();
        }});
    }
    async function switchWorkspace(root: string) {
        if(structuring.current)throw new Error('文件正在整理，请稍后再切换写作空间。');
        if (viewApplying.current)
            throw new Error('视图正在应用，请稍后再切换写作空间。');
        if (switching.current)
            return;
        switching.current = true;
        try {
            const checkDrafts=()=>{
                if (options.hasUnsentChatDraft?.()||(options.promptRef?.current?.value||prompt).trim()||[...sessions.current.values()].some(session=>proposalFor(session.id)))
                    throw new Error('请先处理未发送的消息和待审建议，再切换写作空间。');
            };
            checkDrafts();
            if (running.current)
                throw new Error('请先停止当前 AI 生成，再切换写作空间。');
            if (savingPaths.current.size)
                throw new Error('文件正在保存，请稍后再切换。');
            await fileWorkspace.flush();
            for (const session of sessions.current.values())
                if (session.dirty && !await saveSession(session.id, true))
                    throw new Error('有文件未能保存，请先处理冲突或另存副本，再切换文件夹。');
            checkDrafts();
            await fileWorkspace.update({ root });
        }
        finally {
            switching.current = false;
        }
    }
    function bindSavedFile(data:DiskFile,targetId:string){
        const session=sessions.current.get(targetId)!;
        session.disk=data;session.dirty=false;session.landing=false;session.contentVersion=(session.contentVersion||0)+1;
        redraw();
    }
    async function submitDialog(event:FormEvent){
        event.preventDefault();
        if(!dialog||dialog.kind==='image'||dialog.kind==='table'||dialog.kind==='properties')return;
        let path=dialog.value.trim().replace(/\\/g,'/');if(!path)return;
        const targetId=activeSession.current,target=sessions.current.get(targetId),source=target?.disk;
        const dialogUnchanged=()=>!options.dialogRef||options.dialogRef.current===dialog;
        const ticket=dialog.kind==='folder'?null:beginRead(targetId,false),release=ticket?()=>ticket.cancel():beginFileActivity(sessions,loading);
        const allowed=()=>dialogUnchanged()&&requireRead(ticket!);
        let completed = dialog.kind === 'folder' ? '文件夹已建立。' : '已完成。';
        setError('');
        try{
            if((dialog.kind==='saveAs'||dialog.kind==='rename')&&source&&pendingReview(source.path))throw new Error('请先审阅这个文件的建议，再另存或重命名。');
            if(dialog.kind==='folder'){await api('/folder',{path});}
            else if(dialog.kind==='rename'){
                if(!source)throw new Error('请先打开文档。');
                if(!allowed())return;
                const data=await api<DiskFile>('/rename',{from:source.path,to:path.endsWith('.md')?path:path+'.md',baseline:source.hash});
                if(!scope())return;
                // The rename already happened on disk. Retain every local text/history even
                // if a view was edited while the server was moving the original file.
                for(const session of sessions.current.values())if(session.disk?.path===source.path){session.disk={...session.disk,path:data.path,hash:data.hash};session.contentVersion=(session.contentVersion||0)+1;}
                redraw();
            }else{
                if(!path.endsWith('.md'))path+='.md';
                const state=target?.view?.state ?? target?.state;
                if(dialog.kind==='saveAs'&&!state)throw new Error('没有可另存的正文，当前内容仍保留。');
                const text=dialog.kind==='saveAs'?state!.doc.toString():`# ${path.split('/').at(-1)!.replace(/\.md$/i,'')}\n\n`;
                if(!allowed())return;
                const saved=await writeDocument(api,{path,text,baseline:null,eol:source?.eol||'LF',bom:false});
                completed = saved.warning ?? completed;
                if(!allowed())return;
                const data=await api<DiskFile>('/file?path='+encodeURIComponent(path));
                if(!allowed())return;
                if(data.hash!==saved.hash)throw new Error('新文件在读取前发生外部变化，当前正文未替换，请从文件列表核对。');
                if(dialog.kind==='saveAs')bindSavedFile(data,targetId);else showFile(data,targetId);
            }
            if(!scope())return;
            await refresh();if(!scope()||!dialogUnchanged())return;setDialog(null);inform(completed);
        }catch(error){if(scope()&&dialogUnchanged()&&(!ticket||ticket.current()))setError((error as Error).message);}
        finally{release();}
    }
    async function importFile(source:File){
        if(!/\.md$/i.test(source.name)){setError('请选择 Markdown（.md）文件。');return;}
        if(source.size>2000000){setError('文件超过 2 MB。');return;}
        const targetId=activeSession.current,ticket=beginRead(targetId,false);
        try{
            const raw=await source.text();if(!requireRead(ticket))return;
            const saved=await writeDocument(api,{path:source.name,text:raw.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n'),baseline:null,eol:raw.includes('\r\n')?'CRLF':'LF',bom:raw.startsWith('\uFEFF')});
            if(!requireRead(ticket))return;
            const data=await api<DiskFile>('/file?path='+encodeURIComponent(source.name));if(!requireRead(ticket))return;
            if(data.hash!==saved.hash)throw new Error('导入副本在读取前发生外部变化，当前正文未替换。');
            showFile(data,targetId);await refresh();if(scope())inform(saved.warning ?? '已将文件副本导入工作空间。');
        }catch(error){if(ticket.current())setError((error as Error).message);}
        finally{ticket.cancel();}
    }
    return { beginRead,refresh, showFile, openFile, safeSwitch, openSaveAs, save, openBlankTab, openInLanding, createQuickNote, openExplorerFile, openDocumentPath, preflightFileActions, manageFile, reloadFromDisk, switchWorkspace, submitDialog, importFile };
}
