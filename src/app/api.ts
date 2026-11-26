import { requestJson } from '../shared/api';
import { normalizeConfig, type Config, type ModelSelection } from '../features/settings/modelConfig';
import type { TrashRecord } from '../features/files/TrashPanel';
import type { WorkspaceInfo, RepositoryInfo } from '../features/files/WorkspaceContext';
import type {PropertyType} from '../features/editor/noteProperties';
import type {WritingNode} from '../features/outline/writingNodes';
import type {HistoryOutline} from '../features/history/historyTypes';
// Application-specific response compatibility stays outside the shared JSON client.
export async function requestApi<T>(request: typeof fetch, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const data = await requestJson<unknown>(request, url, body, signal);
    const settingsMutation = url === '/model-services' || url === '/model-services/remove' || url === '/model-services/reorder';
    return (url === '/config' || settingsMutation ? normalizeConfig(data as Config) : data) as T;
}

export type NoteFindRequest = {
    instruction: string;
    selection?: ModelSelection;
    target: {workspaceId: string; file: string; text: string};
};
export type NoteFindResult = {
    kind: 'find-note';
    file: string;
    query: string;
    matches: {line: number; column: number; from: number; to: number; snippet: string}[];
    truncated: boolean;
};
export function findAnnotatedNote(request: typeof fetch, input: NoteFindRequest, signal: AbortSignal) {
    return requestApi<NoteFindResult>(request, '/ai-tools/find-note', input, signal);
}

type WorkspaceToolRequest = {instruction:string;selection?:ModelSelection;target:{workspaceId:string}};
export type TrashToolResult =
    | {kind:'trash-list';entries:Pick<TrashRecord,'path'|'type'|'deletedAt'|'missing'>[];total:number;offset:number;nextOffset?:number}
    | {kind:'trash-restore'|'trash-confirm-delete';items:TrashRecord[]};
export type DocumentsToolResult =
    | {kind:'folder-list';folder:string;entries:{path:string;name:string;type:'file'|'folder'}[]}
    | {kind:'document-create';parent:string;name:string;type:'file'|'folder'}
    | {kind:'document-trash';path:string};
type RepositoriesToolRequest = WorkspaceToolRequest & {target:{workspaceId:string;revision:number};pendingName?:string};
export type RepositoriesToolResult =
    | {kind:'repository-list';repositories:{id:string;name:string;path:string}[]}
    | {kind:'repository-created';repository:RepositoryInfo;workspace:WorkspaceInfo}
    | {kind:'repository-location-required';name:string;question:string};

export function planAnnotatedTrash(request: typeof fetch, input: WorkspaceToolRequest, signal: AbortSignal) {
    return requestApi<TrashToolResult>(request, '/ai-tools/trash', input, signal);
}
export function planAnnotatedDocuments(request: typeof fetch, input: WorkspaceToolRequest, signal: AbortSignal) {
    return requestApi<DocumentsToolResult>(request, '/ai-tools/documents', input, signal);
}
export function runAnnotatedRepositories(request: typeof fetch, input: RepositoriesToolRequest, signal: AbortSignal) {
    return requestApi<RepositoriesToolResult>(request, '/ai-tools/repositories', input, signal);
}

export type PropertyOperation = {op:'set';key:string;type?:PropertyType;value:string}|{op:'remove';key:string};
export type NotePropertiesToolResult = {kind:'note-properties';file:string;operations:PropertyOperation[]};
export type NoteOutlineToolResult = {kind:'note-outline';file:string;before:HistoryOutline;nodes:(Omit<WritingNode,'id'> & {id?:string})[]};
export type NoteSnapshotToolResult = {kind:'create-note-snapshot';file:string};
type NoteToolRequest = WorkspaceToolRequest & {target:{workspaceId:string;file:string}};
export function planNoteProperties(request:typeof fetch,input:NoteToolRequest & {fields:{key:string;type:PropertyType}[]},signal:AbortSignal){
    return requestApi<NotePropertiesToolResult|NoteSnapshotToolResult>(request,'/ai-tools/note-properties',input,signal);
}
export function planNoteOutline(request:typeof fetch,input:NoteToolRequest & {text:string},signal:AbortSignal){
    return requestApi<NoteOutlineToolResult|NoteSnapshotToolResult>(request,'/ai-tools/note-outline',input,signal);
}
