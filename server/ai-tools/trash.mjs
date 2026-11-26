import path from 'node:path';
import {z} from 'zod';
import {modelTool,toolError} from './model-tools.mjs';

const list=modelTool('list_trash','查看已标注仓库的回收站条目。默认从第一项开始，读取下一页时传入返回的偏移量。',z.strictObject({
  offset:z.number().int().nonnegative().optional().describe('从零开始的条目偏移量。'),
}));
const targets=z.strictObject({targets:z.array(z.string().trim().min(1).max(4096)).min(1).max(100)
  .describe('用户指定的回收站文件。填写原路径、唯一文件名或回收站条目 ID。')});
const restore=modelTool('restore_trash','恢复回收站的指定文件。',targets);
const confirmDelete=modelTool('confirm_trash_delete','请求用户确认永久删除回收站的指定文件，实际删除需由用户确认。',targets);
export const trashTools=[list,restore,confirmDelete];

export async function runTrashTool(workspace,{name,args}){
  const trash=await workspace.explorer.listTrash();
  if(name===list.name){
    const offset=args.offset??0,end=offset+100;
    const entries=trash.slice(offset,end).map(({path,type,deletedAt,missing})=>({path,type,deletedAt,...(missing?{missing}:{} )}));
    return {kind:'trash-list',entries,total:trash.length,offset,...(end<trash.length?{nextOffset:end}:{})};
  }
  const records=trash.filter(item=>item.type==='file');
  const canonical=value=>process.platform==='win32'?value.replace(/\\/g,'/').toLowerCase():value;
  const items=new Map();
  for(const target of args.targets){
    const key=canonical(target),id=records.find(item=>item.id===key);
    const found=id?[id]:key.includes('/')
      ? records.filter(item=>canonical(item.path)===key.replace(/^\.\//,''))
      : records.filter(item=>canonical(path.posix.basename(item.path))===key);
    if(!found.length)throw toolError(`回收站中找不到「${target}」。`,404);
    if(found.length!==1)throw toolError(`回收站中有多项匹配「${target}」，请提供原路径或在回收站选择具体条目。`,409);
    const item=found[0];
    if(name===restore.name&&item.missing)throw toolError(`回收站中「${target}」的数据已缺失。`,409);
    items.set(item.id,item);
  }
  return {kind:name===restore.name?'trash-restore':'trash-confirm-delete',items:[...items.values()]};
}
