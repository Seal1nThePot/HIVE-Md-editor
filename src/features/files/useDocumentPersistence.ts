import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { minimalReplacement } from '../../shared/core';
import {mapStoredSessionContext} from '../editor/storedDocumentChanges';
import type { ApiClient } from '../../shared/api';
import type { DiskFile } from '../../shared/fileTypes';
import type { EditorSession } from '../editor/editorSessionTypes';
import type { Entry } from './explorerState';
import type { WorkspaceInfo } from './WorkspaceContext';
import { diskSyncDecision } from './fileSync';
import {documentMatchesText} from '../editor/documentText';
import {beginFileActivity,type FileActivityUpdate} from './fileOperations';
import {Transaction} from '@codemirror/state';
import {documentSyncBaselines,pollAfterCompletion,workspaceTreeSync,type WorkspaceTreeReport,type WorkspaceTreeWarning} from './workspaceSync';
import { writeDocument,writeExternalDocument } from './writeDocument';
import {listNormalizationEvent,normalizeOrderedLists} from '../editor/normalizeOrderedLists';

const sessionDisk = (session?: EditorSession) => session?.external?.disk ?? session?.disk;

type PersistenceOptions = {
    api: ApiClient;
    workspace?:Pick<WorkspaceInfo,'id'|'root'>;
    sessions: RefObject<Map<string, EditorSession>>;
    switching: RefObject<boolean>;
    structuring: RefObject<boolean>;
    fileBusy: boolean;
    tick: number;
    autoSave: boolean;
    /** 这个会话里还有没被用户确认的 AI 建议（预览已在正文里），此时不允许写盘。 */
    pendingProposal?: (id: string) => boolean;
    setFileBusy: FileActivityUpdate;
    setEntries: Dispatch<SetStateAction<Entry[]>>;
    reportTree: (report: WorkspaceTreeReport) => void;
    setError: (message: string) => void;
    inform: (message: string) => void;
    redraw: () => void;
    appAlive?:RefObject<boolean>;
    onStoredChange?:(id:string,transaction:Transaction)=>void;
    applyFormatting?:(session:EditorSession,transaction:Transaction)=>void;
};
export function useDocumentPersistence({
    api, workspace, sessions, switching, structuring, fileBusy, tick, autoSave,
    pendingProposal, setFileBusy, setEntries, reportTree, setError, inform, redraw, appAlive, onStoredChange, applyFormatting,
}: PersistenceOptions) {
    const savingPaths = useRef(new Set<string>()), syncRunning = useRef(false);
    const treeSync=workspaceTreeSync(setEntries,workspace),lifecycle=useRef(0);
    const [fileConflicts, setFileConflicts] = useState<Record<string, string>>({});
    const conflicts = useRef<Record<string, string>>({});
    const readFailures=useRef(new Map<string,{message:string;owner:number}>());
    function setConflict(path: string, message: string) { readFailures.current.delete(path); if (conflicts.current[path] === message)
        return; conflicts.current = { ...conflicts.current, [path]: message }; setFileConflicts(conflicts.current); }
    function setReadFailure(path:string,message:string) {
        const previous=readFailures.current.get(path),owner=treeSync.owner();
        // A failed read must not hide a save failure or an unresolved content conflict.
        if(conflicts.current[path]&&(!previous||previous.owner!==owner||previous.message!==conflicts.current[path]))return;
        setConflict(path,message);readFailures.current.set(path,{message,owner});
    }
    function clearReadFailure(path:string) {
        const failure=readFailures.current.get(path);
        if(failure?.owner===treeSync.owner()&&conflicts.current[path]===failure.message)setConflict(path,'');
    }
    function applySavedFormatting(session:EditorSession,transaction:Transaction,baseline:string){
        if(applyFormatting)applyFormatting(session,transaction);
        else if(session.view)session.view.dispatch(transaction);
        else {
            session.state=transaction.state;
            session.contentVersion=(session.contentVersion||0)+1;
            session.dirty=!documentMatchesText(transaction.newDoc,baseline);
            mapStoredSessionContext(session.context,transaction);
            if(!session.external)onStoredChange?.(session.id,transaction);
        }
    }
    async function saveSession(id: string, quiet = false): Promise<boolean> {
        const session = sessions.current.get(id);
        const source = sessionDisk(session);
        const state = session?.view?.state ?? session?.state;
        if (!session || !state)
            return true;
        if (!source)
            return !session.dirty;
        if (session.external && (!session.external.editable || !session.dirty))
            return true;
        // 预览建议还没被确认，写盘就等于替用户采纳了它。
        if (pendingProposal?.(id)) {
            if (!quiet)
                setError('这段 AI 建议还没确认：请先点 ✓ 保留或 ✗ 撤掉，再保存。');
            return false;
        }
        if (savingPaths.current.has(source.path))
            return false;
        const owner = sessions.current;
        const workspaceEpoch = treeSync.owner();
        const isCurrentWorkspace = () =>
            appAlive?.current !== false && sessions.current === owner && treeSync.owner() === workspaceEpoch;
        const owners = new Map([...owner.values()]
            .filter(other => sessionDisk(other)?.path === source.path)
            .map(other => [other.id, { session: other, disk: sessionDisk(other) }]));
        savingPaths.current.add(source.path);
        const release=quiet?()=>{}:beginFileActivity(sessions,(busy,openingFile)=>{if(appAlive?.current!==false)setFileBusy(busy,openingFile);});
        try {
            const {changes,skipped}=normalizeOrderedLists(state);
            if(!changes.empty&&[...owners.values()].some(other=>other.session.view?.composing)){
                if(!quiet)setError('请先完成输入法组词，再保存有序列表。');
                return false;
            }
            const savedDoc=changes.apply(state.doc);
            const snapshot=savedDoc.toString();
            const document = {
                path: source.path, text: snapshot, baseline: source.hash, eol: source.eol, bom: source.bom,
            };
            const result = await (session.external ? writeExternalDocument(document) : writeDocument(api, document));
            if (!isCurrentWorkspace())
                return true;

            const matching:EditorSession[]=[];
            for (const other of owner.values()) {
                const disk = sessionDisk(other);
                if (disk?.path !== source.path)
                    continue;
                const captured = owners.get(other.id);
                const sameBaseline = captured
                    ? captured.session === other && captured.disk === disk
                    : disk.hash === source.hash && disk.text === source.text;
                if (!sameBaseline)
                    continue;
                matching.push(other);
            }
            let formatFailed=false;
            // Publish formatting only after the write succeeds, using each latest
            // selection and history. New edits and ongoing IME stay in the buffer.
            if(!changes.empty&&!matching.some(other=>other.view?.composing||pendingProposal?.(other.id))){
                for(const other of matching){
                    const current=other.view?.state??other.state;
                    if(!current?.doc.eq(state.doc))continue;
                    try{
                        applySavedFormatting(other,current.update({
                            changes,userEvent:listNormalizationEvent,annotations:Transaction.addToHistory.of(false),
                        }),source.text);
                    }catch{formatFailed=true;}
                }
            }
            // Always adopt the committed snapshot. Edits made while saving stay dirty.
            for(const other of matching){
                const saved = { ...source, text: snapshot, hash: result.hash };
                if(other.external)other.external.disk=saved;
                else other.disk=saved;
                other.dirty = !(other.view?.state ?? other.state)?.doc.eq(savedDoc);
            }
            if (matching.length)
                setConflict(source.path, '');
            redraw();
            const formattingNote=skipped?'部分有序列表保留原编号，以维持 Markdown 层级和语法。':'';
            const currentNote=formatFailed?'序号已保存，编辑器中的文稿仍待同步。':'';
            const warning=[result.warning,formattingNote,currentNote].filter(Boolean).join(' ');
            if(warning||!quiet)inform(warning||'已保存到本机。');
            return true;
        }
        catch (error) {
            if (!isCurrentWorkspace())
                return false;
            const relevant = [...owners.values()].some(captured =>
                owner.get(captured.session.id) === captured.session && sessionDisk(captured.session) === captured.disk);
            if (!relevant)
                return false;
            setConflict(source.path, (error as Error).message);
            if (!quiet)
                setError((error as Error).message);
            return false;
        }
        finally {
            savingPaths.current.delete(source.path);
            release();
        }
    }
    function applyDiskFile(data: DiskFile) {
        if(appAlive?.current===false)return;
        const changesByDocument=new Map<NonNullable<EditorSession['state']>['doc'],{from:number;to:number;insert:string}>();
        for (const session of sessions.current.values()) {
            if (sessionDisk(session)?.path !== data.path)
                continue;
            const state = session.view?.state || session.state;
            if (!state)
                continue;
            const unchanged=documentMatchesText(state.doc,data.text);
            if(session.external)session.external.disk={...data};
            else session.disk = { ...data };
            session.dirty = false;
            if (!unchanged) {
                let changes=changesByDocument.get(state.doc);
                if(!changes){
                    const before=state.doc.toString();
                    const change = minimalReplacement({ from: 0, to: before.length, original: before, file: data.path, stale: false }, data.text);
                    changes={from:change.from,to:change.to,insert:change.text};changesByDocument.set(state.doc,changes);
                }
                if (session.view)
                    session.view.dispatch({ changes, userEvent: 'input.disk-sync' });
                else {
                    const transaction=state.update({changes,userEvent:'input.disk-sync'});session.state=transaction.state;
                    session.contentVersion=(session.contentVersion||0)+1;
                    mapStoredSessionContext(session.context,transaction);
                    if(!session.external)onStoredChange?.(session.id,transaction);
                }
            }
        }
        setConflict(data.path, '');
        redraw();
    }
    const syncLatest = useRef(async () => { });
    syncLatest.current = async () => {
        const ticket=treeSync.beginSync();
        if (!ticket || syncRunning.current || switching.current || fileBusy || structuring.current || appAlive?.current===false)
            return;
        syncRunning.current = true;
        const owner=sessions.current,generation=lifecycle.current;
        const valid=()=>lifecycle.current===generation&&sessions.current===owner&&appAlive?.current!==false&&!switching.current&&!structuring.current&&treeSync.current(ticket);
        type SyncResponse = {
            entries?: Entry[];
            treeVersion: string;
            warnings?: WorkspaceTreeWarning[];
            workspace: WorkspaceInfo;
            files: (DiskFile | { path: string; error: string } | { path: string; hash: string; unchanged: true })[];
        };
        try {
            const {paths,baselines,knownBaselines}=documentSyncBaselines(owner.values());
            let data: SyncResponse;
            try {
                data = await api<SyncResponse>('/workspace/sync', { paths, baselines: knownBaselines,...(ticket.treeVersion===undefined?{}:{treeVersion:ticket.treeVersion}) });
            } catch(error) {
                if(valid())reportTree({error:(error as Error).message});
                return;
            }
            if(!valid()||!treeSync.current(ticket,data.workspace))return;
            treeSync.accept(ticket,data.treeVersion);
            if(data.entries!==undefined&&(ticket.treeVersion===undefined||data.treeVersion!==ticket.treeVersion))setEntries(data.entries);
            reportTree({warnings:data.warnings});
            for (const remote of data.files) {
                if (savingPaths.current.has(remote.path))
                    continue;
                const matching = [...sessions.current.values()].filter(session => session.disk?.path === remote.path);
                if (matching.some(session => session.disk?.hash !== baselines.get(remote.path)))
                    continue;
                if ('error' in remote) {
                    if (matching.length)
                        setReadFailure(remote.path, remote.error + ' 本地内容仍保留，可另存副本。');
                    continue;
                }
                if ('unchanged' in remote) {
                    clearReadFailure(remote.path);
                    continue;
                }
                const decision = diskSyncDecision(matching.map(session => ({ baseline: session.disk!, text: (session.view?.state || session.state)?.doc || '' })), remote);
                if (decision === 'unchanged') {
                    clearReadFailure(remote.path);
                    continue;
                }
                if (decision === 'conflict') {
                    setConflict(remote.path, '磁盘和本地都有修改，已暂停自动保存。请核对后重新读取，或另存本地副本。');
                    continue;
                }
                applyDiskFile(remote);
            }
        }
        catch (error) {
            if(valid())setError((error as Error).message);
        }
        finally {
            syncRunning.current = false;
        }
    };
    useEffect(() => {
        lifecycle.current++;
        const stop=pollAfterCompletion(()=>syncLatest.current(),2000);
        return ()=>{lifecycle.current++;stop();};
    }, []);
    useEffect(() => {
        if (!autoSave || switching.current || structuring.current)
            return;
        const timer = setTimeout(() => {
            for (const session of sessions.current.values())
                if (session.dirty && session.disk && !conflicts.current[session.disk.path])
                    void saveSession(session.id, true);
        }, 900);
        return () => clearTimeout(timer);
    }, [tick, autoSave,fileConflicts]);
    return { savingPaths, fileConflicts, saveSession, applyDiskFile };
}
