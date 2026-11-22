import {promises as fs,createReadStream,constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {removeMetadata} from './metadata-paths.mjs';
import {isDocumentPath} from './file-kinds.mjs';
import {MAX_MARKDOWN_BYTES,markdownText} from './files.mjs';

const conflict=()=>Object.assign(new Error('回收站内容已变化或预览已过期，请重新预览并确认。'),{status:409});
const invalid=()=>Object.assign(new Error('回收站记录或数据不可用。'),{status:409});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const absent=async p=>{try{return await fs.lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export function trashRetention({root,state,files},now=Date.now) {
  const trash=path.resolve(root,'.hive-trash'), tokens=new Map();
  async function rootCheck(create=true){const s=await absent(trash);if(!s){if(!create)throw Object.assign(new Error('此回收站没有文稿。'),{status:404});await fs.mkdir(trash);return rootCheck();}if(s.isSymbolicLink()||!s.isDirectory())throw invalid();return s;}
  function inside(target){const rel=path.relative(trash,path.resolve(target));if(!rel||rel.startsWith('..'+path.sep)||rel==='..'||path.isAbsolute(rel))throw invalid();}
  const identity=s=>JSON.stringify([s.dev,s.ino,s.mode]);
  async function tree(target,hash,plan){
    inside(target);const s=await fs.lstat(target);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))throw invalid();
    const relative=path.relative(trash,target),type=s.isDirectory()?'folder':'file';
    const node={relative,type,identity:identity(s)};
    hash.update(JSON.stringify([relative,s.dev,s.ino,s.mode,s.size,s.mtimeMs,s.ctimeMs]));
    if(type==='folder')for(const n of (await fs.readdir(target)).sort())await tree(path.join(target,n),hash,plan);
    else {const content=createHash('sha256');for await(const chunk of createReadStream(target)){hash.update(chunk);content.update(chunk);}node.fingerprint=content.digest('hex');node.stat=JSON.stringify([s.size,s.mtimeMs,s.ctimeMs]);}
    plan.push(node);
  }
  async function deletePlan(entry){
    let removed=0;const planned=new Map(entry.plan.map(node=>[node.relative,node]));
    try {
      for(const node of entry.plan){
        await rootCheck();const target=path.resolve(trash,node.relative);inside(target);
        const relativeParts=node.relative.split(path.sep);let current=trash;
        for(let i=0;i<relativeParts.length-1;i++){current=path.join(current,relativeParts[i]);const expected=planned.get(path.relative(trash,current));const stat=await fs.lstat(current);if(!expected||expected.type!=='folder'||stat.isSymbolicLink()||!stat.isDirectory()||identity(stat)!==expected.identity)throw conflict();}
        const stat=await fs.lstat(target);if(stat.isSymbolicLink()||identity(stat)!==node.identity||(node.type==='folder'?!stat.isDirectory():!stat.isFile()))throw conflict();
        if(node.type==='file'){
          if(JSON.stringify([stat.size,stat.mtimeMs,stat.ctimeMs])!==node.stat)throw conflict();
          const hash=createHash('sha256');for await(const chunk of createReadStream(target))hash.update(chunk);if(hash.digest('hex')!==node.fingerprint)throw conflict();
          const final=await fs.lstat(target);if(final.isSymbolicLink()||identity(final)!==node.identity||JSON.stringify([final.size,final.mtimeMs,final.ctimeMs])!==node.stat)throw conflict();
          await fs.unlink(target);
        }else await fs.rmdir(target);
        removed++;
      }
    }catch(error){error.partialDataDeleted=removed>0;throw error;}
  }
  async function manifestInfo(id, createRoot=true){
    if(!uuid.test(id))throw invalid();await rootCheck(createRoot);const manifest=path.join(trash,id+'.json'),data=path.join(trash,id);inside(manifest);inside(data);
    const stat=await fs.lstat(manifest);if(stat.isSymbolicLink()||!stat.isFile())throw invalid();
    const raw=await fs.readFile(manifest,'utf8');let record;try{record=JSON.parse(raw);}catch{throw invalid();}
    if(record.id!==id||!['file','folder'].includes(record.type)||typeof record.path!=='string'||!record.path||record.path.includes('\\')||record.path.split('/').some(p=>!p||p==='..'||p.startsWith('.')||/[:*?"<>|\0]/.test(p))||!Number.isFinite(Date.parse(record.deletedAt))||typeof record.deletedAt!=='string'||(record.type==='file'&&!isDocumentPath(record.path)))throw invalid();
    const dataStat=await absent(data);
    if(dataStat&&(dataStat.isSymbolicLink()||(record.type==='file'&&!dataStat.isFile())||(record.type==='folder'&&!dataStat.isDirectory())))throw invalid();
    return {item:{id,path:record.path,type:record.type,deletedAt:record.deletedAt,...(!dataStat?{missing:true}:{})},manifestFingerprint:JSON.stringify([stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeMs,stat.ctimeMs,raw]),data,dataStat};
  }
  async function snapshot(id){
    const info=await manifestInfo(id),hash=createHash('sha256'),plan=[];hash.update(info.manifestFingerprint);
    if(!info.item.missing)await tree(info.data,hash,plan);else hash.update('missing');
    return {item:info.item,fingerprint:hash.digest('hex'),plan};
  }
  async function records(){await rootCheck();const result=[];for(const name of await fs.readdir(trash)){if(!/\.json$/i.test(name))continue;const id=name.slice(0,-5);if(!uuid.test(id))continue;result.push(await manifestInfo(id));}return result;}
  async function list(){return (await records()).map(x=>x.item).sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt));}
  function changedFile(a,b){return !b.isFile()||identity(a)!==identity(b)||a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs;}
  async function readDocument(id){return files.transaction(async()=>{
    if(typeof id!=='string'||!uuid.test(id))throw Object.assign(new Error('回收站记录无效。'),{status:400});
    try{
      const {item,data,dataStat}=await manifestInfo(id,false);
      if(item.type!=='file'||! /\.md$/i.test(item.path))throw Object.assign(new Error('回收站仅预览 Markdown 文稿。'),{status:400});
      if(!dataStat)throw Object.assign(new Error('文稿内容已不在回收站中。'),{status:404});
      if(dataStat.size>MAX_MARKDOWN_BYTES)throw Object.assign(new Error('仅支持预览 2 MB 以内的 Markdown 文稿。'),{status:400});
      const file=await fs.open(data,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
      try{
        if(changedFile(dataStat,await file.stat()))throw invalid();
        const buffer=Buffer.alloc(dataStat.size+1);
        let used=0;
        while(used<buffer.length){
          const {bytesRead}=await file.read(buffer,used,buffer.length-used,used);
          if(!bytesRead)break;
          used+=bytesRead;
        }
        await rootCheck(false);
        if(used!==dataStat.size||changedFile(dataStat,await file.stat())||changedFile(dataStat,await fs.lstat(data)))throw invalid();
        return {id:item.id,path:item.path,text:markdownText(buffer.toString('utf8',0,used))};
      }finally{await file.close();}
    }catch(error){
      if(error.code==='ENOENT')throw Object.assign(new Error('文稿内容已不在回收站中。'),{status:404});
      throw error;
    }
  });}
  async function preview(days){return files.transaction(async()=>{if(![0,7,15,30,90].includes(days))throw Object.assign(new Error('清理天数无效。'),{status:400});const time=now(),cutoff=days===0?Infinity:time-days*86400000, candidates=(await records()).filter(x=>Date.parse(x.item.deletedAt)<cutoff),selected=[];for(const candidate of candidates){const entry=await snapshot(candidate.item.id);if(Date.parse(entry.item.deletedAt)>=cutoff||JSON.stringify(entry.item)!==JSON.stringify(candidate.item))throw conflict();selected.push(entry);}for(const [key,value] of tokens)if(time>=value.expiresAt)tokens.delete(key);while(tokens.size>=32)tokens.delete(tokens.keys().next().value);const token=randomUUID(),expiresAt=time+300000;tokens.set(token,{selected,expiresAt});return {token,days,cutoff:days===0?new Date(time).toISOString():new Date(cutoff).toISOString(),expiresAt:new Date(expiresAt).toISOString(),items:selected.map(x=>x.item),count:selected.length};});}
  async function purge(token){return files.transaction(async()=>{const saved=tokens.get(token);tokens.delete(token);if(!saved||now()>=saved.expiresAt)throw conflict();
    try{for(const entry of saved.selected){const latest=await snapshot(entry.item.id);if(latest.fingerprint!==entry.fingerprint)throw conflict();}}catch{throw conflict();}
    const deletedIds=[],failed=[];
    for(const entry of saved.selected){const {id}=entry.item;let dataDeleted=false;try{const latest=await snapshot(id);if(latest.fingerprint!==entry.fingerprint)throw conflict();if(!entry.item.missing)await deletePlan(entry);dataDeleted=true;await removeMetadata(state,'@trash/'+id);await fs.unlink(path.join(trash,id+'.json'));deletedIds.push(id);}catch(error){const detail=dataDeleted?'内容已永久删除，但记录或元数据清理失败：'+error.message:error.partialDataDeleted?'文件夹内容可能已部分永久删除，剩余内容和记录已保留：'+error.message:error.message;failed.push({id,path:entry.item.path,error:detail,...(dataDeleted?{dataDeleted:true}:{}),...(error.partialDataDeleted?{partialDataDeleted:true}:{})});}}

    return {deletedIds,failed};});}
  // Deletes confirmed entries by id (no preview token). Unknown ids are skipped;
  // a request where nothing exists at all is reported as 404 so the panel can refresh.
  async function remove(input){return files.transaction(async()=>{
    if(!Array.isArray(input)||!input.length||input.length>100)throw Object.assign(new Error('请选择要删除的回收站条目。'),{status:400});
    const ids=[...new Set(input)];
    if(ids.some(id=>typeof id!=='string'||!uuid.test(id)))throw Object.assign(new Error('回收站记录无效。'),{status:400});
    await rootCheck();
    const deletedIds=[],failed=[];
    for(const id of ids){
      const manifest=path.join(trash,id+'.json');
      if(!(await absent(manifest)))continue;
      let entry,dataDeleted=false;
      try{
        entry=await snapshot(id);
        if(!entry.item.missing)await deletePlan(entry);
        dataDeleted=true;
        await removeMetadata(state,'@trash/'+id);
        await fs.unlink(manifest);
        deletedIds.push(id);
      }catch(error){
        if(!dataDeleted&&error.code==='ENOENT')continue;
        const detail=dataDeleted?'内容已永久删除，但记录或元数据清理失败：'+error.message:error.partialDataDeleted?'文件夹内容可能已部分永久删除，剩余内容和记录已保留：'+error.message:error.message;
        failed.push({id,path:entry?.item.path||'',error:detail,...(dataDeleted?{dataDeleted:true}:{}),...(error.partialDataDeleted?{partialDataDeleted:true}:{})});
      }
    }
    if(!deletedIds.length&&!failed.length)throw Object.assign(new Error('这些条目已不在回收站中。'),{status:404});
    return {deletedIds,failed};
  });}
  return {list,preview,purge,remove,readDocument};
}
