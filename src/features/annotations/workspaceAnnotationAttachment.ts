import type {ChatAttachment} from '../chat/chatAttachments';
import {flattenEntries,type Entry} from '../files/explorerState';
import {repositoryLabel,type RepositoryInfo} from '../files/WorkspaceContext';
import type {WorkspaceAnnotationTarget} from './windowAnnotations';

type WorkspaceAnnotationSource={
  workspaceId:string;
  entries:Entry[];
  repositories:readonly RepositoryInfo[];
  request:typeof fetch;
  findOpenDocument:(path:string)=>string|undefined;
};

export async function workspaceAnnotationAttachment(
  target:WorkspaceAnnotationTarget,
  {workspaceId,entries,repositories,request,findOpenDocument}:WorkspaceAnnotationSource,
):Promise<Omit<ChatAttachment,'id'>>{
  if(target.kind==='repository'){
    const repository=repositories.find(entry=>entry.id===target.repositoryId);
    if(!repository)throw new Error('这张仓库卡片已变化，请重新标注。');
    const name=repositoryLabel(repository);
    return {
      kind:'repository',file:'',label:'仓库 · '+name,
      text:'仓库：'+name+(repository.id===workspaceId?'（当前仓库）':''),
      reference:{workspaceId,repositoryId:repository.id},
    };
  }
  const entry=flattenEntries(entries).find(item=>item.path===target.path&&item.type===target.kind);
  if(!entry)throw new Error('所选文件或目录已变化，请重新标注。');
  const {path}=entry,reference={workspaceId,path};
  if(target.kind==='folder'){
    const paths=flattenEntries(entry.children??[]).map(child=>child.path+(child.type==='folder'?'/':''));
    return {kind:'folder',file:path,label:'文件夹 · '+path,reference,text:paths.join('\n')||'此文件夹为空。'};
  }
  if(!/\.md$/i.test(path))throw new Error('目前文件标注支持 Markdown 文稿。');
  const current=findOpenDocument(path);
  if(current!==undefined)return {kind:'document',file:path,label:'文件 · '+path,reference,text:current};
  const response=await request('/api/file?path='+encodeURIComponent(path));
  if(!response.ok)throw new Error('无法读取标注文件「'+path+'」，请检查文件是否仍存在。');
  const file=await response.json();
  if(file?.path!==path||typeof file.text!=='string')throw new Error('返回的文稿与标注文件不一致，请重新标注。');
  return {kind:'document',file:path,label:'文件 · '+path,reference,text:file.text};
}
