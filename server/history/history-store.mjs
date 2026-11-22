import {promises as fs} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {discardStage,stageJson} from '../repository-manifest.mjs';

const id=z.string().min(1);
const actor=z.enum(['human','ai']);
const status=z.enum(['applied','reverted']);
const revision=z.number().int().nonnegative();
const limit=z.number().int().min(0).max(1000);
const limitsSchema=z.strictObject({human:limit,ai:limit});
const outline=z.strictObject({revision,initialized:z.boolean().optional(),nodes:z.array(z.record(z.string(),z.json()))});
const base={id,actor,createdAt:z.iso.datetime({offset:true}),label:z.string().min(1)};
const textPatch=z.strictObject({from:revision,before:z.string(),after:z.string(),contextBefore:z.string(),contextAfter:z.string()});
const recordSchema=z.strictObject({...base,file:z.string().min(1).optional(),status,
  kind:z.enum(['text','properties','outline','file','snapshot-restore']),
  changes:z.strictObject({text:z.array(textPatch).optional(),polish:z.strictObject({id,reason:z.string(),node:z.string(),annotationIds:z.array(id).optional()}).optional(),outline:z.strictObject({before:outline,after:outline}).optional(),
    file:z.strictObject({action:z.string().min(1),path:z.string().min(1),id:id.optional(),from:z.string().min(1).optional()}).optional()}),
});
const snapshotSchema=z.strictObject({...base,file:z.string().min(1),text:z.string(),outline:outline.required({initialized:true})});
const statusSchema=z.strictObject({id,status,expectedStatus:status,fileId:id.optional()});
const historySchema=z.strictObject({revision,limits:limitsSchema,entries:z.array(recordSchema),snapshots:z.array(snapshotSchema)});
const failure=(message,status=400)=>Object.assign(new Error(message),{status});

function parse(schema,input,message){
  const result=schema.safeParse(input);
  if(!result.success)throw failure(message);
  return result.data;
}

function newestFirst(a,b){return Date.parse(b.createdAt)-Date.parse(a.createdAt);}

function keepRecent(entries,limits){
  const remaining={...limits};
  return entries.filter(({actor})=>{
    if(remaining[actor]===0)return false;
    remaining[actor]--;
    return true;
  });
}

export async function createHistoryStore(directory){
  const file=path.join(directory,'history.json');
  await fs.mkdir(directory,{recursive:true});
  let state;
  try{
    const text=await fs.readFile(file,'utf8');
    try{state=historySchema.parse(JSON.parse(text));}
    catch{throw failure('历史记录文件无法读取，请保留原文件后检查内容。',500);}
  }catch(error){
    if(error.code!=='ENOENT')throw error;
    state={revision:0,limits:{human:100,ai:100},entries:[],snapshots:[]};
  }
  let queue=Promise.resolve();
  const read=()=>structuredClone(state);
  function update(change){
    const result=queue.catch(()=>{}).then(async()=>{
      const next=change(state);
      if(next===state)return read();
      const committed={...next,revision:state.revision+1};
      const temp=await stageJson(file,committed);
      try{await fs.rename(temp,file);}
      finally{await discardStage(temp);}
      state=committed;
      return read();
    });
    queue=result;
    return result;
  }
  return {
    read,
    async append(input){
      const record=parse(recordSchema,input,'操作历史格式无效。');
      return update(current=>{
        if(current.limits[record.actor]===0||current.entries.some(entry=>entry.id===record.id))return current;
        const entries=keepRecent([record,...current.entries].sort(newestFirst),current.limits);
        return entries.includes(record)?{...current,entries}:current;
      });
    },
    async saveSnapshot(input){
      const snapshot=parse(snapshotSchema,input,'文件快照格式无效。');
      return update(current=>current.snapshots.some(item=>item.id===snapshot.id)
        ?current:{...current,snapshots:[snapshot,...current.snapshots].sort(newestFirst)});
    },
    async setLimits(input){
      const limits=parse(limitsSchema,input,'人工和 AI 历史保留条数应为 0 到 1000 的整数。');
      return update(current=>limits.human===current.limits.human&&limits.ai===current.limits.ai
        ?current:{...current,limits,entries:keepRecent(current.entries,limits)});
    },
    async setStatus(input){
      const {id,status,expectedStatus,fileId}=parse(statusSchema,input,'历史状态请求无效。');
      return update(current=>{
        const index=current.entries.findIndex(entry=>entry.id===id);
        if(index<0)throw failure('操作历史已不存在。',404);
        const entry=current.entries[index];
        if(entry.status!==expectedStatus)throw failure('操作历史状态已变化，请刷新后重试。',409);
        if(fileId&&!entry.changes.file)throw failure('这条历史没有回收站目标。');
        if(entry.status===status&&(!fileId||fileId===entry.changes.file?.id))return current;
        const entries=current.entries.slice();
        entries[index]={...entry,status,...(fileId?{changes:{...entry.changes,file:{...entry.changes.file,id:fileId}}}:{})};
        return {...current,entries};
      });
    },
  };
}
