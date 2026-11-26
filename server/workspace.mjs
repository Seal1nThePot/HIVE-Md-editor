import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileStore } from './files.mjs';
import { annotationStore } from './annotations.mjs';
import { writingNodeStore } from './writing-nodes.mjs';
import { outlineStore } from './outlines.mjs';
import { explorerStore } from './explorer.mjs';
import {discardStage,repositoryManifestStore,stageJson} from './repository-manifest.mjs';
import {readStateObject} from './state-json.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
export async function workspaceStore(local, defaultRoot, {revealFile,repositoryManifestDirectory=local}={}) {
  await fs.mkdir(local, {recursive:true});
  const configPath = path.join(local, 'workspace.json');
  const synchronizeManifest=await repositoryManifestStore(repositoryManifestDirectory);
  const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const idFor = root => createHash('sha256').update(canonical(root)).digest('hex').slice(0,24);
  const saved = await readStateObject(configPath, '工作区配置');
  const initialRoot = path.resolve(defaultRoot);
  await fs.mkdir(initialRoot,{recursive:true});
  const defaultRepositoryRoot = await fs.realpath(initialRoot);
  const defaultRepositoryId = idFor(defaultRepositoryRoot);
  const contexts=new Map();
  async function resolveRoot(input) {
    if(typeof input !== 'string' || !path.isAbsolute(input.trim()) || input.includes('\0')) throw fail('请填写现有文件夹的绝对路径。');
    let root;
    try {
      const stat = await fs.lstat(input.trim());
      if(!stat.isDirectory() || stat.isSymbolicLink()) throw fail('请选择普通文件夹，不使用目录联接或符号链接。');
      root = await fs.realpath(input.trim());
      await fs.access(root, fs.constants.R_OK | fs.constants.W_OK);
    } catch(error) { if(error.status) throw error; throw fail('无法访问这个文件夹，请检查路径和读写权限。'); }
    return root;
  }
  async function prepare(input, migrate = false) {
    const root = await resolveRoot(input);
    const id = idFor(root), state = id === defaultRepositoryId ? local : path.join(local,'workspaces',id);
    if(contexts.has(id))return contexts.get(id);
    await fs.mkdir(state,{recursive:true});
    const files = fileStore(root, state);
    // Existing scratch files always win. Only migrate the original workspace's legacy scratch.
    if(migrate) {
      try { await files.read('自由草稿.md'); }
      catch(error) {
        if(error.code !== 'ENOENT') throw error;
        let old;
        try {old=await fileStore(local).read('scratch.md');} catch(error) {if(error.code!=='ENOENT')throw error;}
        if(old)await files.save({path:'自由草稿.md',text:old.text,eol:old.eol,bom:old.bom,baseline:null});
      }
    }
    const context={id,root,state,files,annotations:annotationStore(state),nodes:writingNodeStore(state),outlines:outlineStore(state)};
    context.explorer=explorerStore(context,undefined,{revealFile});
    files.suspend();
    contexts.set(id,context);return context;
  }
  let current = await prepare(saved?.root || initialRoot, !saved?.root || idFor(path.resolve(saved.root)) === defaultRepositoryId);
  let autoSave = saved?.autoSave !== false, revision = Number.isInteger(saved?.revision) ? saved.revision : 0;
  const validName = value => typeof value==='string' && value.trim().length<=80 && !/[\u0000-\u001f\u007f]/.test(value);
  const entryFor = (root,name) => ({id:idFor(root),root,...(validName(name)&&name.trim()?{name:name.trim()}:{})});
  let repositories = [];
  for(const entry of Array.isArray(saved?.repositories) ? saved.repositories : []) {
    if(!entry || typeof entry.root !== 'string' || !path.isAbsolute(entry.root) || entry.root.includes('\0')) continue;
    const registeredRoot = path.resolve(entry.root);
    const normalized = entryFor(canonical(registeredRoot)===canonical(initialRoot)?defaultRepositoryRoot:registeredRoot,entry.name);
    if(!repositories.some(item=>item.id===normalized.id)) repositories.push(normalized);
  }
  if(!repositories.some(item=>item.id===current.id)) repositories.push(entryFor(current.root));
  if(!repositories.some(item=>item.id===defaultRepositoryId)) repositories.push(entryFor(defaultRepositoryRoot));
  await synchronizeManifest(revision,repositories);
  current.files.resume();
  let queue = Promise.resolve();
  const read = () => ({id:current.id,root:current.root,defaultRepositoryId,autoSave,revision,repositories:repositories.map(item=>({...item}))});
  function capture(id){
    if(id && id !== current.id) throw fail('写作空间已在其他窗口切换。请刷新页面后继续；当前内容尚未覆盖磁盘。',409);
    return current;
  }
  function schedule(operation){
    const task=queue.catch(()=>{}).then(operation);
    queue=task;
    return task;
  }
  function enqueue(input,change) {
    return schedule(async()=>{
      if(input.revision !== revision) throw fail('写作空间设置已变化，请刷新后重试。',409);
      const next = await change();
      if(next.unchanged)return read();
      const value={root:next.current.root,autoSave:next.autoSave,revision:revision+1,repositories:next.repositories};
      let temp,manifestPublished=false;
      try {
        temp=await stageJson(configPath,value);
        await synchronizeManifest(value.revision,value.repositories);
        manifestPublished=true;
        await fs.rename(temp,configPath);
      }catch(error){
        // The workspace file is authoritative. If publication is interrupted,
        // opening the store or reading the list derives the manifest from it again.
        if(manifestPublished)await synchronizeManifest(revision,repositories).catch(()=>{});
        await next.rollback?.();
        throw error;
      }finally{
        if(temp)await discardStage(temp);
      }
      if (current !== next.current) {current.files.suspend(); next.current.files.resume();}
      current=next.current;autoSave=next.autoSave;repositories=next.repositories;revision=value.revision;
      return read();
    });
  }
  function createRepository(input){
    let repository;
    return enqueue(input,async()=>{
      capture(input.workspaceId);
      const name=input.name;
      if(!validName(name)||!name.trim()||name!==name.trim()||name.startsWith('.')||/[\\/:*?"<>|]|[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)){
        throw fail('仓库名称需为有效的单个文件夹名称。');
      }
      const parent=await resolveRoot(input.parent),candidate=path.join(parent,name);
      repository=repositories.find(item=>item.id===idFor(candidate));
      if(repository){
        await resolveRoot(candidate);
        return {unchanged:true};
      }
      await fs.mkdir(candidate);
      repository=entryFor(candidate,name);
      return {current,autoSave,repositories:[...repositories,repository],rollback:()=>fs.rmdir(candidate).catch(()=>{})};
    }).then(workspace=>({workspace,repository}));
  }
  return {
    read,
    capture,
    createRepository,
    readRepositoryManifest:id=>schedule(()=>{capture(id);return synchronizeManifest(revision,repositories);}),
    async close() {
      await queue.catch(()=>{});
      await Promise.all([...contexts.values()].map(context => context.files.close()));
    },
    update(input) {
      return enqueue(input,async()=>{
        if(input.autoSave !== undefined && typeof input.autoSave !== 'boolean') throw fail('自动保存设置无效。');
        const next=input.root === undefined ? current : await prepare(input.root);
        return {current:next,autoSave:input.autoSave ?? autoSave,repositories:repositories.some(item=>item.id===next.id)?repositories:[...repositories,entryFor(next.root)]};
      });
    },
    manage(input) {
      return enqueue(input,async()=>{
        let next=repositories,nextCurrent=current;
        if(input.action==='add') {
          const entry=entryFor(await resolveRoot(input.root));
          if(!next.some(item=>item.id===entry.id)) next=[...next,entry];
        } else if(input.action==='rename') {
          if(!validName(input.name)) throw fail('备注名称请使用 80 个字以内的单行文字。');
          if(!next.some(item=>item.id===input.id)) throw fail('这个仓库已不在列表中，请刷新后重试。',409);
          next=next.map(item=>{
            if(item.id!==input.id)return item;
            const {name:previousName,...entry}=item;
            return input.name.trim()?{...entry,name:input.name.trim()}:entry;
          });
        } else if(input.action==='remove') {
          if(input.id===defaultRepositoryId) throw fail('默认根目录不能移出仓库列表。');
          if(!next.some(item=>item.id===input.id)) throw fail('这个仓库已不在列表中，请刷新后重试。',409);
          if(input.id===current.id) nextCurrent=await prepare(defaultRepositoryRoot);
          next=next.filter(item=>item.id!==input.id);
        } else if(input.action==='reorder') {
          const order=input.order;
          if(!Array.isArray(order)||order.length!==next.length||new Set(order).size!==next.length||order.some(id=>!next.some(item=>item.id===id))) throw fail('仓库排列已变化，请刷新后重试。',409);
          const entries=new Map(next.map(item=>[item.id,item]));next=order.map(id=>entries.get(id));
        } else throw fail('仓库管理操作无效。');
        return {current:nextCurrent,autoSave,repositories:next};
      });
    }
  };
}
