import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {remapMetadata} from './metadata-paths.mjs';
import {trashRetention} from './trash-retention.mjs';
import {isDocumentPath,isImagePath} from './file-kinds.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const exists=async target=>{try{await fs.lstat(target);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
export function explorerStore({root,files,state},launch=spawn,opts={}) {
  const trash=path.join(root,'.hive-trash');
  const retention=trashRetention({root,state,files},opts.now || Date.now);
  async function trashRoot(){if(await exists(trash)){const stat=await fs.lstat(trash);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('回收站路径不可用。');}else await fs.mkdir(trash);}
  async function plain(target){const stat=await fs.lstat(target);if(stat.isSymbolicLink())throw fail('不能操作符号链接或目录联接。');if(stat.isDirectory())for(const name of await fs.readdir(target))await plain(path.join(target,name));}
  async function target(relative){const resolved=await files.resolve(relative,true),stat=await fs.lstat(resolved);if(!stat.isDirectory()&&(!stat.isFile()||!isDocumentPath(relative)))throw fail('仅处理 Markdown 和图片文件。');return {resolved,type:stat.isDirectory()?'folder':'file'};}
  async function parent(relative=''){if(!relative)return root;const dir=await files.resolve(relative,true);if(!(await fs.stat(dir)).isDirectory())throw fail('目标必须是文件夹。');return dir;}
  const nameCheck=name=>{if(typeof name!=='string'||!name.trim()||name!==name.trim()||/[\\/]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name))throw fail('文件名称无效。');};
  async function unique(dir,name,type){const ext=type==='file'?path.extname(name)||'.md':'';const stem=ext?name.slice(0,-ext.length):name;for(let n=1;n<10000;n++){const value=stem+(n===1?'':' '+n)+ext;if(!await exists(path.join(dir,value)))return value;}throw fail('同名文件过多。');}
  async function prepareCreate(input){
    const type=input.type==='folder'?'folder':'file',dir=await parent(input.parent);
    let name=input.name;
    if(name===undefined)name=await unique(dir,type==='folder'?'新建文件夹':'新建文档.md',type);
    else{
      nameCheck(name);
      if(type==='file'&&!/\.md$/i.test(name))name+='.md';
    }
    const relative=[input.parent,name].filter(Boolean).join('/');
    return {path:relative,name,type,destination:await files.resolve(relative,type==='folder')};
  }
  async function relocate(from,to,source,destination){if(await exists(destination))throw fail('目标已存在，请换一个名称。',409);await fs.rename(source,destination);try{await remapMetadata(state,from,to);}catch(error){await fs.rename(destination,source);throw error;}}
  async function manage(input){return files.transaction(async()=>{
    if(!input||typeof input!=='object')throw fail('文件操作无效。');
    const {action}=input;
    if(action==='create') {
      const {path:relative,type,destination}=await prepareCreate(input);
      if(type==='folder')await fs.mkdir(destination);else await fs.writeFile(destination,'',{flag:'wx'});
      return {path:relative,type};
    }
    if(action==='restore'){
      await trashRoot();if(typeof input.id!=='string'||! /^[a-f0-9-]{36}$/.test(input.id))throw fail('回收站记录无效。');
      const manifest=path.join(trash,input.id+'.json');if((await fs.lstat(manifest)).isSymbolicLink())throw fail('回收站记录不可用。');
      const record=JSON.parse(await fs.readFile(manifest,'utf8'));if(record.id!==input.id||!['file','folder'].includes(record.type))throw fail('回收站记录无效。');
      if(record.type==='file'&&!isDocumentPath(record.path))throw fail('回收站记录无效。');
      const destination=await files.resolve(record.path,true);await parent(path.posix.dirname(record.path)==='.'?'':path.posix.dirname(record.path));
      const source=path.join(trash,input.id);await plain(source);
      await relocate('@trash/'+input.id,record.path,source,destination);await fs.unlink(manifest);return {path:record.path,type:record.type};
    }
    const {resolved:source,type}=await target(input.path);
    if(action==='reveal'){
      if(process.platform!=='win32')throw fail('当前系统不支持 Windows 资源管理器。');
      if(opts.revealFile)await opts.revealFile(source);
      else{
        // Standalone server fallback opens the containing directory without shell syntax.
        const directory=type==='folder'?source:path.dirname(source);
        await new Promise((resolve,reject)=>{const child=launch('explorer.exe',[directory],{shell:false,windowsHide:false,detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
      }
      return {ok:true};
    }
    await plain(source);
    if(action==='trash'){
      await trashRoot();const id=randomUUID(),manifest=path.join(trash,id+'.json'),record={id,path:input.path,type,deletedAt:new Date().toISOString()};
      await fs.writeFile(manifest,JSON.stringify(record),{flag:'wx'});
      try{await relocate(input.path,'@trash/'+id,source,path.join(trash,id));}catch(error){await fs.unlink(manifest);throw error;}
      return record;
    }
    if(!['rename','move','duplicate'].includes(action))throw fail('文件操作无效。');
    if(input.path==='自由草稿.md'&&action!=='duplicate')throw fail('自由草稿的文件名和位置由草稿面板管理。');
    const parentPath=action==='move'?input.parent||'':path.posix.dirname(input.path)==='.'?'':path.posix.dirname(input.path);
    const dir=await parent(parentPath);
    let name=action==='rename'?input.name:path.basename(source);nameCheck(name);
    if(type==='file'){
      const extension=path.extname(input.path);
      if(isImagePath(input.path)){if(path.extname(name).toLowerCase()!==extension.toLowerCase())name+=extension;}
      else if(!/\.md$/i.test(name))name+='.md';
    }
    if(action==='duplicate'){const extension=type==='file'?path.extname(name):'';name=await unique(dir,type==='file'?name.slice(0,-extension.length)+' 副本'+extension:name+' 副本',type);}
    const relative=[parentPath,name].filter(Boolean).join('/'),destination=await files.resolve(relative,true);
    if(relative===input.path)return {path:relative,type};
    if(type==='folder'&&(destination.toLowerCase()+path.sep).startsWith(source.toLowerCase()+path.sep))throw fail('不能把文件夹放入自身或其子文件夹。');
    if(action==='duplicate'){if(await exists(destination))throw fail('目标已存在。',409);await fs.cp(source,destination,{recursive:type==='folder',errorOnExist:true,force:false});return {path:relative,type};}
    await relocate(input.path,relative,source,destination);return {path:relative,from:input.path,type};
  });}
  async function listTrash(){return files.transaction(()=>retention.list());}
  async function search(folder='',query=''){
    if(typeof query!=='string'||!query.trim()||query.length>200)throw fail('请填写 1–200 字的查找内容。');
    const dir=await parent(folder),tree=await files.list(dir,folder?folder+'/':'');
    const flatten=items=>items.flatMap(item=>item.type==='file'?[item]:flatten(item.children||[]));
    const matches=[],needle=query.toLocaleLowerCase();let truncated=false;
    for(const entry of flatten(tree)){
      if(isImagePath(entry.path)){if(entry.name.toLocaleLowerCase().includes(needle)){if(matches.length===200){truncated=true;break;}matches.push({path:entry.path,line:null,excerpt:''});}continue;}
      let data;try{data=await files.read(entry.path);}catch(error){if(error.code==='ENOENT'||error.message.includes('2 MB'))continue;throw error;}
      const index=data.text.toLocaleLowerCase().indexOf(needle);
      if(index<0&&!entry.name.toLocaleLowerCase().includes(needle))continue;
      if(matches.length===200){truncated=true;break;}
      const line=index<0?null:data.text.slice(0,index).split('\n').length;
      matches.push({path:entry.path,line,excerpt:index<0?'':data.text.slice(Math.max(0,index-25),index+query.length+60).replace(/\n/g,' ')});
    }
    return {matches,truncated};
  }
  return {manage,prepareCreate,listTrash,search,readTrashedDocument:retention.readDocument,previewTrash:retention.preview,purgeTrash:retention.purge,deleteTrash:retention.remove};
}

