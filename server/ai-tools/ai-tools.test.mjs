import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {fork} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findInNote} from './find-note.mjs';

function structuredCall(args,name='find_note'){
  return {choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'fixture',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]};
}

let temp,documents,state,appData,server,backend,base,workspace,mockResponse,requests;
const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const instruction='查找“独有修改”。';
const target=()=>({workspaceId:workspace.id,file:'标注文稿.md',text:'# 未保存的正文\n这里有独有修改。'});
const search=(overrides={})=>post('/api/ai-tools/find-note',{instruction,target:target(),...overrides});

beforeAll(async()=>{
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'hive-ai-tools-'));
  documents=path.join(temp,'documents');
  state=path.join(temp,'state');
  appData=path.join(temp,'appdata');
  await fs.mkdir(documents);
  await Promise.all([
    fs.writeFile(path.join(documents,'标注文稿.md'),'目标笔记较早的磁盘快照。'),
    fs.writeFile(path.join(documents,'其他文稿.md'),'独有修改出现在另一篇，行号不同。'),
  ]);
  server=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    requests.push({body:JSON.parse(Buffer.concat(chunks).toString()),path:req.url,authorization:req.headers.authorization});
    res.writeHead(mockResponse.status??200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(mockResponse.body));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const project=fileURLToPath(new URL('../../',import.meta.url));
  backend=fork(path.join(project,'server/index.mjs'),['--production'],{cwd:project,silent:true,windowsHide:true,
    env:{...process.env,HIVE_PORT:'0',HIVE_DOCUMENTS:documents,HIVE_STATE_DIR:state,HIVE_APP_DATA_DIR:appData,HIVE_API_KEY:''}});
  backend.stdout.resume();backend.stderr.resume();
  base='http://127.0.0.1:'+await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('AI tools backend did not report ready')),10000);
    backend.once('error',reject);
    backend.once('exit',code=>reject(Error('AI tools backend exited '+code)));
    backend.on('message',message=>{
      if(message?.type==='hive-ready'){clearTimeout(timer);resolve(message.port);}
    });
  });
  const config=await post('/api/config',{endpoint:`http://127.0.0.1:${server.address().port}/v1`,model:'tools-test-model',key:'test-key',demo:false});
  expect(config.ok).toBe(true);
  workspace=await (await fetch(base+'/api/workspace')).json();
},15000);

beforeEach(()=>{
  requests=[];
  mockResponse={body:structuredCall({query:'独有修改'})};
});

describe('annotated repository management',()=>{
  const workspaceInfo=async()=>await (await fetch(base+'/api/workspace')).json();
  async function tool(instruction,pendingName){
    const {id:workspaceId,revision}=await workspaceInfo();
    return post('/api/ai-tools/repositories',{instruction,pendingName,target:{workspaceId,revision}});
  }
  const manifest=async()=>JSON.parse(await fs.readFile(path.join(appData,'repositories.json'),'utf8'));

  it('asks for a missing directory, continues with a directory-only reply, and lists the committed store',async()=>{
    mockResponse={body:structuredCall({name:'写作合集',parent:temp},'create_repository')};
    const missing=await tool('请创建仓库「写作合集」');
    expect(await missing.json()).toMatchObject({kind:'repository-location-required',name:'写作合集',question:expect.stringContaining('在哪个目录')});
    await expect(fs.access(path.join(temp,'写作合集'))).rejects.toHaveProperty('code','ENOENT');

    mockResponse={body:structuredCall({name:'模型改了名称',parent:temp},'create_repository')};
    const created=await tool(temp,'写作合集');
    expect(created.status).toBe(200);
    const next=await created.json(),directory=await fs.realpath(path.join(temp,'写作合集'));
    expect(next).toMatchObject({kind:'repository-created',repository:{root:directory},workspace:{id:workspace.id,revision:workspace.revision+1}});
    expect(requests.at(-1).body.messages[0].content).toContain('写作合集');
    await expect(fs.access(path.join(temp,'模型改了名称'))).rejects.toHaveProperty('code','ENOENT');

    mockResponse={body:structuredCall({},'list_repositories')};
    const listed=await (await tool('读出仓库清单')).json(),persisted=await manifest();
    expect(listed).toEqual({kind:'repository-list',repositories:persisted.repositories});
    expect(listed.repositories).toContainEqual({id:next.repository.id,name:'写作合集',path:directory});
    expect(requests.at(-1).body.tools.map(tool=>tool.function.name)).toEqual(['list_repositories','create_repository']);
    expect(requests.at(-1).body.messages[0].content).not.toContain(directory);
    await expect(fs.access(path.join(state,'repositories.json'))).rejects.toHaveProperty('code','ENOENT');
  });

  it('rejects an unregistered same-name directory without changing its files or the registry',async()=>{
    const name='已有目录',existing=path.join(temp,name);
    await fs.mkdir(existing);
    await fs.writeFile(path.join(existing,'保留.md'),'原始资料');
    const before=await workspaceInfo();
    mockResponse={body:structuredCall({name,parent:temp},'create_repository')};
    const wrongAncestor=await tool(`请在“${path.join(temp,'未选择的目录')}”下创建仓库「${name}」`);
    expect(await wrongAncestor.json()).toMatchObject({kind:'repository-location-required'});
    const duplicate=await tool(`请在“${temp}”下创建仓库「${name}」`);
    expect(duplicate.status).toBe(409);
    expect(await fs.readFile(path.join(existing,'保留.md'),'utf8')).toBe('原始资料');
    expect(await workspaceInfo()).toEqual(before);
  });
});

describe('annotated document and trash tools',()=>{
  async function plan(panel,name,args,instruction,workspaceId=workspace.id){
    mockResponse={body:structuredCall(args,name)};
    return post('/api/ai-tools/'+panel,{instruction,target:{workspaceId}});
  }
  const documentPlan=(name,args,instruction)=>plan('documents',name,args,instruction);
  const trashPlan=(name,args,instruction)=>plan('trash',name,args,instruction);
  async function explorer(input){
    const result=await post('/api/explorer',input);
    expect(result.status).toBe(200);
    return result.json();
  }
  async function trashEntries(){return await (await fetch(base+'/api/explorer/trash')).json();}

  it('lists one folder and plans named create and trash against the bound repository',async()=>{
    const external=path.join(temp,'another-workspace');
    await Promise.all([fs.mkdir(external),fs.mkdir(path.join(documents,'章节'))]);
    await fs.writeFile(path.join(external,'新标题.md'),'另一仓库的同名文件');
    const newFolder=await documentPlan('create_folder',{parent:'章节',name:'二章'},'在章节中新建文件夹「二章」。');
    expect(newFolder.status).toBe(200);
    expect(await newFolder.json()).toEqual({kind:'document-create',parent:'章节',name:'二章',type:'folder'});
    await expect(fs.access(path.join(documents,'章节','二章'))).rejects.toHaveProperty('code','ENOENT');
    await explorer({action:'create',parent:'章节',name:'二章',type:'folder'});
    const newFile=await documentPlan('create_file',{parent:'章节/二章',name:'新标题'},'新建章节/二章/新标题。');
    expect(await newFile.json()).toEqual({kind:'document-create',parent:'章节/二章',name:'新标题.md',type:'file'});
    const created=await explorer({action:'create',parent:'章节/二章',name:'新标题.md',type:'file'});
    expect(created.path).toBe('章节/二章/新标题.md');
    await fs.writeFile(path.join(documents,created.path),'保留同名原文');
    expect((await post('/api/explorer',{action:'create',parent:'章节/二章',name:'新标题.md',type:'file'})).status).toBe(409);
    expect(await fs.readFile(path.join(documents,created.path),'utf8')).toBe('保留同名原文');

    const list=await documentPlan('list_folder',{folder:'章节'},'查看章节目录。');
    expect(await list.json()).toEqual({kind:'folder-list',folder:'章节',entries:[{name:'二章',path:'章节/二章',type:'folder'}]});
    expect(requests.at(-1).body.tools.map(tool=>tool.function.name)).toEqual(['list_folder','create_file','create_folder','trash_file']);
    const escape=await documentPlan('list_folder',{folder:'../another-workspace'},'查看仓库外面。');
    expect(escape.status).toBe(400);

    const undeleted=await documentPlan('trash_file',{path:created.path},'把指定文稿移到回收站。');
    expect(await undeleted.json()).toEqual({kind:'document-trash',path:created.path});
    expect(await fs.readFile(path.join(documents,created.path),'utf8')).toBe('保留同名原文');
    await explorer({action:'trash',path:created.path});
    await expect(fs.access(path.join(documents,created.path))).rejects.toHaveProperty('code','ENOENT');
    expect(await fs.readFile(path.join(external,'新标题.md'),'utf8')).toBe('另一仓库的同名文件');
  });

  it('lists the marked workspace trash without exposing file contents or mutation IDs',async()=>{
    const file='查看标注回收站.md';
    await fs.writeFile(path.join(documents,file),'回收站正文不属于列表');
    const record=await explorer({action:'trash',path:file});
    const listing=await trashPlan('list_trash',{},'查看回收站。');
    expect(listing.status).toBe(200);
    const data=await listing.json();
    expect(data).toMatchObject({kind:'trash-list',offset:0,total:(await trashEntries()).length});
    expect(data.entries).toContainEqual({path:file,type:'file',deletedAt:record.deletedAt});
    expect(JSON.stringify(data)).not.toContain(record.id);
    expect(JSON.stringify(data)).not.toContain('回收站正文不属于列表');
    expect((await trashEntries()).map(item=>item.id)).toContain(record.id);
    const stale=await plan('trash','list_trash',{},'查看另一仓库。','0'.repeat(24));
    expect(stale.status).toBe(409);
  });

  it('plans restore and requires the existing confirmation flow for an exactly resolved permanent deletion',async()=>{
    const names=['保留甲.md','恢复乙.md','确认丙.md'];
    const records=[];
    for(const name of names){
      await fs.writeFile(path.join(documents,name),name);
      records.push(await explorer({action:'trash',path:name}));
    }
    const restored=await trashPlan('restore_trash',{targets:['恢复乙.md']},'恢复回收站的恢复乙.md。');
    expect(await restored.json()).toEqual({kind:'trash-restore',items:[records[1]]});
    expect((await trashEntries()).map(item=>item.id)).toContain(records[1].id);
    await explorer({action:'restore',id:records[1].id});
    expect(await fs.readFile(path.join(documents,names[1]),'utf8')).toBe(names[1]);

    const exact=await trashPlan('confirm_trash_delete',{targets:['确认丙.md',records[2].id]},'请求永久删除确认丙.md。');
    expect(await exact.json()).toEqual({kind:'trash-confirm-delete',items:[records[2]]});
    for(const id of [records[0].id,records[2].id])expect((await trashEntries()).map(item=>item.id)).toContain(id);
    const confirmation=await post('/api/explorer/trash/delete',{ids:[records[2].id]});
    expect(await confirmation.json()).toMatchObject({deletedIds:[records[2].id]});
    const remains=(await trashEntries()).map(item=>item.id);
    expect(remains).toContain(records[0].id);
    expect(remains).not.toContain(records[2].id);
  });

  it('rejects ambiguous trash filenames, stale windows, and offers no direct deletion tool',async()=>{
    const name='重复名称.md',dirs=['重复甲','重复乙'];
    for(const directory of dirs){
      await fs.mkdir(path.join(documents,directory));
      await fs.writeFile(path.join(documents,directory,name),directory);
      await explorer({action:'trash',path:directory+'/'+name});
    }
    const repeated=await trashPlan('confirm_trash_delete',{targets:[name]},'请求删除同名文件。');
    expect(repeated.status).toBe(409);
    expect(requests.at(-1).body.tools.map(tool=>tool.function.name)).toEqual(['list_trash','restore_trash','confirm_trash_delete']);
    const wrong=await plan('trash','confirm_trash_delete',{targets:[name]},'来自另一仓库。','0'.repeat(24));
    expect(wrong.status).toBe(409);
    expect(requests).toHaveLength(1);
    const unsupported=await trashPlan('delete_trash',{targets:[name]},'删除同名文件。');
    expect(unsupported.status).toBe(502);
    expect((await trashEntries()).filter(record=>record.path.endsWith(name))).toHaveLength(2);
  });
});

afterAll(async()=>{
  if(backend&&backend.exitCode===null&&backend.signalCode===null)await new Promise(resolve=>{backend.once('exit',resolve);backend.send({type:'hive-shutdown'});});
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(temp&&path.dirname(temp)===os.tmpdir()&&path.basename(temp).startsWith('hive-ai-tools-'))await fs.rm(temp,{recursive:true,force:true});
});

describe('annotated note search',()=>{
  it('searches the bound unsaved snapshot and sends no local file or text to the model',async()=>{
    const response=await search();
    expect(response.status).toBe(200);
    const offset=target().text.indexOf('独有修改');
    expect(await response.json()).toEqual({kind:'find-note',file:'标注文稿.md',query:'独有修改',truncated:false,
      matches:[{line:2,column:4,from:offset,to:offset+4,snippet:'这里有独有修改。'}]});
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({path:'/v1/chat/completions',authorization:'Bearer test-key',body:{model:'tools-test-model',stream:false}});
    const sent=requests[0].body;
    expect(sent.tools.map(tool=>tool.function.name)).toEqual(['find_note']);
    expect(sent.tools[0].function.parameters.additionalProperties).toBe(false);
    expect(JSON.stringify(sent)).not.toMatch(/未保存的正文|标注文稿|其他文稿/);
    expect(await fs.readFile(path.join(documents,'标注文稿.md'),'utf8')).toBe('目标笔记较早的磁盘快照。');
    expect(await fs.readFile(path.join(documents,'其他文稿.md'),'utf8')).toBe('独有修改出现在另一篇，行号不同。');
  });

  it('rejects an expired workspace or path outside the bound workspace before model invocation',async()=>{
    expect((await search({target:{...target(),workspaceId:'0'.repeat(24)}})).status).toBe(409);
    expect((await search({target:{...target(),file:'../其他文稿.md'}})).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('rejects a model-provided replacement target and an unoffered tool',async()=>{
    mockResponse={body:structuredCall({query:'独有修改',file:'其他文稿.md'})};
    const extra=await search();
    expect(extra.status).toBe(502);
    expect(await extra.json()).toEqual({error:'模型返回了无效的工具参数，请重试。'});
    mockResponse={body:structuredCall({query:'独有修改'},'delete_file')};
    const unknown=await search();
    expect(unknown.status).toBe(502);
    expect((await unknown.json()).error).toContain('当前标注窗口不支持');
  });

  it('reports unsupported structured tool calls without interpreting a plain-text response',async()=>{
    mockResponse={body:{choices:[{finish_reason:'stop',message:{content:'{"query":"独有修改"}'}}]}};
    const plain=await search();
    expect(plain.status).toBe(502);
    expect((await plain.json()).error).toContain('换用支持工具调用的模型');
    mockResponse={status:400,body:{error:{message:'private provider response'}}};
    const rejection=await search();
    expect(rejection.status).toBe(502);
    const result=await rejection.json();
    expect(result.error).toContain('拒绝了结构化工具请求');
    expect(result.error).not.toContain('private');
  });

  it('returns literal Unicode offsets, whole-word matches and a bounded result',()=>{
    expect(findInNote('🍯\r\n a.b A.B aXb aa.b_a',{query:'a.b',wholeWord:true}).matches).toEqual([
      {line:2,column:2,from:5,to:8,snippet:' a.b A.B aXb aa.b_a'},
      {line:2,column:6,from:9,to:12,snippet:' a.b A.B aXb aa.b_a'},
    ]);
    const capped=findInNote('同 '.repeat(101),{query:'同'});
    expect(capped.matches).toHaveLength(100);
    expect(capped.truncated).toBe(true);
  });

  it('plans only the selected note properties without sending their values',async()=>{
    const operations=[{op:'set',key:'status',value:'draft',type:'text'}];
    mockResponse={body:structuredCall({operations},'change_note_properties')};
    const body={instruction:'设置 status 属性',target:{workspaceId:workspace.id,file:'标注文稿.md'},fields:[{key:'status',type:'text'}]};
    const response=await post('/api/ai-tools/note-properties',body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({kind:'note-properties',file:'标注文稿.md',operations});
    expect(JSON.stringify(requests[0].body)).not.toContain('标注文稿');
    expect(await fs.readFile(path.join(documents,'标注文稿.md'),'utf8')).toBe('目标笔记较早的磁盘快照。');
  });

  it('returns ordered outline changes against the captured revision without saving them',async()=>{
    const file='标注文稿.md',node={id:'original',title:'原节点',level:2,description:'',targetHeading:'原节点 @1'};
    expect((await post('/api/writing-outline',{file,nodes:[node],revision:0})).ok).toBe(true);
    const nodes=[{id:'original',title:'修改节点',level:2,description:'新的方向'},{title:'第二节点',level:2,description:''}];
    mockResponse={body:structuredCall({nodes},'write_note_outline')};
    const response=await post('/api/ai-tools/note-outline',{instruction:'调整大纲',target:{workspaceId:workspace.id,file},text:'当前未保存正文'});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({kind:'note-outline',file,before:{revision:1,initialized:true,nodes:[node]},
      nodes:[{...nodes[0],targetHeading:'原节点 @1'},{...nodes[1],targetHeading:null}]});
    expect(JSON.stringify(requests[0].body)).toContain('当前未保存正文');
    expect(await (await fetch(base+'/api/writing-outline?file='+encodeURIComponent(file))).json()).toEqual({revision:1,initialized:true,nodes:[node]});
    mockResponse={body:structuredCall({nodes:[nodes[1]]},'write_note_outline')};
    expect((await post('/api/ai-tools/note-outline',{instruction:'新增一个节点',target:{workspaceId:workspace.id,file},text:'当前未保存正文'})).status).toBe(502);
    expect(await (await fetch(base+'/api/writing-outline?file='+encodeURIComponent(file))).json()).toEqual({revision:1,initialized:true,nodes:[node]});
  });
});
