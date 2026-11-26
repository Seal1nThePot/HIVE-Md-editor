import {beforeEach,afterEach,it,expect} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {workspaceStore} from './workspace.mjs';
let temp,local,root,other,spaces;
beforeEach(async()=>{
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'hive-workspaces-'));
  local=path.join(temp,'state');root=path.join(temp,'A');other=path.join(temp,'B');
  await fs.mkdir(other);spaces=await workspaceStore(local,root);
});
afterEach(async()=>{await fs.rm(temp,{recursive:true,force:true});});
it('persists the chosen root and automatic-save preference across restart',async()=>{
  const initial=spaces.read();
  const changed=await spaces.update({root:other,autoSave:false,revision:initial.revision});
  const restarted=await workspaceStore(local,root);
  expect(restarted.read()).toEqual(changed);
  expect(changed.root).toBe(await fs.realpath(other));
});
it('projects repository changes into the application directory and repairs a stale manifest on restart',async()=>{
  const appData=path.join(temp,'appdata'),manifest=path.join(appData,'repositories.json');
  const store=await workspaceStore(local,root,{repositoryManifestDirectory:appData});
  try{
    const readManifest=async()=>JSON.parse(await fs.readFile(manifest,'utf8'));
    expect((await readManifest()).repositories).toEqual([{id:store.read().id,name:'A',path:await fs.realpath(root)}]);
    const added=await store.manage({action:'add',root:other,revision:0}),entry=added.repositories[1];
    await store.manage({action:'rename',id:entry.id,name:'项目乙',revision:1});
    expect((await readManifest()).repositories[1]).toEqual({id:entry.id,name:'项目乙',path:await fs.realpath(other)});
    await store.manage({action:'remove',id:entry.id,revision:2});
    expect((await readManifest()).repositories).toHaveLength(1);
    await fs.writeFile(manifest,JSON.stringify({revision:90,repositories:[{id:entry.id,name:'过期',path:other}]}));
    const reopened=await workspaceStore(local,root,{repositoryManifestDirectory:appData});
    try {expect(await readManifest()).toEqual(await reopened.readRepositoryManifest(reopened.read().id));}
    finally {await reopened.close();}
  }finally{await store.close();}
});
it('removes an unregistered empty folder after a failed write and retries without duplicated registration',async()=>{
  const config=path.join(local,'workspace.json'),folder=path.join(other,'甲仓库');
  const initial=spaces.read(),input={name:'甲仓库',parent:other,workspaceId:initial.id,revision:initial.revision};
  await fs.mkdir(config);
  await expect(spaces.createRepository(input)).rejects.toThrow();
  await expect(fs.access(folder)).rejects.toHaveProperty('code','ENOENT');
  expect(spaces.read()).toEqual(initial);
  const manifest=JSON.parse(await fs.readFile(path.join(local,'repositories.json'),'utf8'));
  expect(manifest).toMatchObject({revision:initial.revision,repositories:[{id:initial.id}]});
  await fs.rmdir(config);
  const created=await spaces.createRepository(input);
  expect(created.repository.root).toBe(await fs.realpath(folder));
  await fs.writeFile(path.join(folder,'继续写.md'),'保留原文');
  const retry=await spaces.createRepository({...input,revision:created.workspace.revision});
  expect(retry).toEqual(created);
  expect(await fs.readFile(path.join(folder,'继续写.md'),'utf8')).toBe('保留原文');
});
it('isolates same-name files and metadata and restores the original namespace',async()=>{
  const first=spaces.read(),old=spaces.capture(first.id);
  await old.files.save({path:'same.md',text:'A',baseline:null});
  await old.outlines.save('same.md','heading','A 的描述');
  await spaces.update({root:other,revision:0});
  const current=spaces.capture(spaces.read().id);
  await current.files.save({path:'same.md',text:'B',baseline:null});
  expect(await current.outlines.read('same.md')).toEqual({});
  await current.outlines.save('same.md','heading','B 的描述');
  await spaces.update({root,revision:1});
  const restored=spaces.capture(first.id);
  expect(restored).toBe(old);
  expect((await restored.files.read('same.md')).text).toBe('A');
  expect(await restored.outlines.read('same.md')).toEqual({heading:'A 的描述'});
});
it('rejects stale windows while captured requests remain bound to their original folder',async()=>{
  const first=spaces.read(),captured=spaces.capture(first.id);
  await spaces.update({root:other,revision:0});
  expect(()=>spaces.capture(first.id)).toThrow('其他窗口切换');
  await captured.files.save({path:'old-request.md',text:'old',baseline:null});
  await expect(spaces.capture().files.read('old-request.md')).rejects.toHaveProperty('code','ENOENT');
});
it('does not mutate the root or revision after invalid folder selection',async()=>{
  const before=spaces.read();
  await expect(spaces.update({root:path.join(temp,'missing'),revision:0})).rejects.toThrow('无法访问');
  await expect(spaces.update({root:'relative/path',revision:0})).rejects.toThrow('绝对路径');
  expect(spaces.read()).toEqual(before);
  await spaces.update({autoSave:false,revision:0});
  expect(spaces.read().autoSave).toBe(false);
});
it('serializes simultaneous changes and rejects an old revision',async()=>{
  const results=await Promise.allSettled([spaces.update({root:other,revision:0}),spaces.update({autoSave:false,revision:0})]);
  expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);
  expect(spaces.read().root).toBe(await fs.realpath(other));
  expect(spaces.read().revision).toBe(1);
});
it('does not copy or overwrite documents when switching folders',async()=>{
  await fs.writeFile(path.join(other,'自由草稿.md'),'B scratch');
  await spaces.capture().files.save({path:'only-A.md',text:'A',baseline:null});
  await spaces.update({root:other,revision:0});
  expect((await spaces.capture().files.read('自由草稿.md')).text).toBe('B scratch');
  await expect(fs.access(path.join(other,'only-A.md'))).rejects.toThrow();
});
it('migrates legacy scratch only for the original workspace',async()=>{
  const state=path.join(temp,'legacy-state'),docs=path.join(temp,'legacy-docs');
  await fs.mkdir(state);await fs.writeFile(path.join(state,'scratch.md'),'legacy scratch');
  const legacy=await workspaceStore(state,docs);
  expect((await legacy.capture().files.read('自由草稿.md')).text).toBe('legacy scratch');
  await legacy.update({root:other,revision:0});
  await expect(fs.access(path.join(other,'自由草稿.md'))).rejects.toThrow();
});
it('registers the default root alongside a legacy active workspace without changing its preferences',async()=>{
  await fs.writeFile(path.join(local,'workspace.json'),JSON.stringify({root:other,autoSave:false,revision:7}));
  const restarted=await workspaceStore(local,root),info=restarted.read();
  try{
    expect(info).toMatchObject({root:await fs.realpath(other),defaultRepositoryId:spaces.read().id,autoSave:false,revision:7});
    expect(info.repositories).toEqual([
      {id:info.id,root:info.root},
      {id:info.defaultRepositoryId,root:await fs.realpath(root)},
    ]);
    expect(await restarted.readRepositoryManifest(info.id)).toMatchObject({revision:7,repositories:[
      {id:info.id,path:info.root},{id:info.defaultRepositoryId,path:await fs.realpath(root)},
    ]});
  }finally{await restarted.close();}
});
it('adds many repositories without switching or allocating document state, and deduplicates canonical paths',async()=>{
  const initial=spaces.read();
  for(let index=0;index<24;index++) {
    const folder=path.join(temp,'project-'+index);await fs.mkdir(folder);
    await spaces.manage({action:'add',root:folder,revision:spaces.read().revision});
    expect(await fs.readdir(folder)).toEqual([]);
  }
  await spaces.manage({action:'add',root:path.join(temp,'project-0','.'),revision:spaces.read().revision});
  expect(spaces.read()).toMatchObject({id:initial.id,root:initial.root,autoSave:initial.autoSave});
  expect(spaces.read().repositories).toHaveLength(25);
  expect(await fs.readdir(local)).not.toContain('workspaces');
  expect((await workspaceStore(local,root)).read()).toEqual(spaces.read());
});
it('persists custom repository order and remembers previously opened folders',async()=>{
  const first=spaces.read();
  await spaces.update({root:other,autoSave:false,revision:0});
  const second=spaces.read(),order=[second.id,first.id];
  await spaces.manage({action:'reorder',order,revision:1});
  expect(spaces.read().repositories.map(item=>item.id)).toEqual(order);
  expect(spaces.read()).toMatchObject({id:second.id,autoSave:false});
  const restarted=await workspaceStore(local,root);
  expect(restarted.read()).toEqual(spaces.read());
  await restarted.update({root,revision:2});
  expect(restarted.read().repositories.map(item=>item.id)).toEqual(order);
});
it('removes only a repository listing and preserves its files and metadata for reopening',async()=>{
  await spaces.update({root:other,revision:0});const second=spaces.read();
  await spaces.capture().files.save({path:'kept.md',text:'keep me',baseline:null});
  await spaces.capture().outlines.save('kept.md','heading','keep outline');
  await spaces.update({root,revision:1});
  await spaces.manage({action:'remove',id:second.id,revision:2});
  expect(spaces.read().repositories).toHaveLength(1);
  expect(await fs.readFile(path.join(other,'kept.md'),'utf8')).toBe('keep me');
  const restarted=await workspaceStore(local,root);
  await restarted.update({root:other,revision:3});
  expect(await restarted.capture().outlines.read('kept.md')).toEqual({heading:'keep outline'});
  expect(restarted.read().repositories).toHaveLength(2);
});
it('protects the default repository while active and inactive',async()=>{
  const initial=spaces.read(),id=initial.defaultRepositoryId;
  expect(id).toBe(initial.id);
  await expect(spaces.manage({action:'remove',id,revision:0})).rejects.toThrow('默认根目录不能移出仓库列表');
  expect(spaces.read()).toEqual(initial);
  const switched=await spaces.update({root:other,revision:0});
  await expect(spaces.manage({action:'remove',id,revision:switched.revision})).rejects.toThrow('默认根目录不能移出仓库列表');
  expect(spaces.read()).toEqual(switched);
});
it('removes the active repository and selects the default root in one revision',async()=>{
  const first=spaces.read(),defaultId=first.defaultRepositoryId,third=path.join(temp,'C');
  await fs.mkdir(third);
  await spaces.capture().files.save({path:'same.md',text:'default text',baseline:null});
  const added=await spaces.manage({action:'add',root:third,revision:0});
  const thirdId=added.repositories[1].id;
  const active=await spaces.update({root:other,autoSave:false,revision:1});
  await spaces.capture().files.save({path:'same.md',text:'active text',baseline:null});
  await spaces.capture().outlines.save('same.md','heading','kept outline');
  const named=await spaces.manage({action:'rename',id:defaultId,name:'默认写作目录',revision:2});
  const ordered=await spaces.manage({action:'reorder',order:[thirdId,active.id,defaultId],revision:named.revision});
  const action={action:'remove',id:active.id,revision:ordered.revision};
  await expect(spaces.manage({...action,revision:active.revision})).rejects.toHaveProperty('status',409);
  expect(spaces.read()).toEqual(ordered);
  const removed=await spaces.manage(action);
  expect(removed).toEqual({
    ...ordered,id:defaultId,root:first.root,revision:ordered.revision+1,
    repositories:ordered.repositories.filter(entry=>entry.id!==active.id),
  });
  expect((await spaces.capture().files.read('same.md')).text).toBe('default text');
  expect(await fs.readFile(path.join(other,'same.md'),'utf8')).toBe('active text');
  expect(await spaces.readRepositoryManifest(defaultId)).toMatchObject({revision:removed.revision,repositories:[
    {id:thirdId},{id:defaultId,name:'默认写作目录'},
  ]});
  const restarted=await workspaceStore(local,root);
  try{
    expect(restarted.read()).toEqual(removed);
    await restarted.update({root:other,revision:removed.revision});
    expect(await restarted.capture().outlines.read('same.md')).toEqual({heading:'kept outline'});
  }finally{await restarted.close();}
});
it('keeps the active repository and registry if publishing its removal fails',async()=>{
  const active=await spaces.update({root:other,revision:0});
  const config=path.join(local,'workspace.json'),backup=config+'.backup';
  const manifest=await spaces.readRepositoryManifest(active.id);
  await fs.rename(config,backup);
  await fs.mkdir(config);
  try{
    await expect(spaces.manage({action:'remove',id:active.id,revision:active.revision})).rejects.toThrow();
    expect(spaces.read()).toEqual(active);
    const published=JSON.parse(await fs.readFile(path.join(local,'repositories.json'),'utf8'));
    expect(published).toEqual(manifest);
  }finally{
    await fs.rmdir(config);
    await fs.rename(backup,config);
  }
  expect((await spaces.manage({action:'remove',id:active.id,revision:active.revision})).id).toBe(active.defaultRepositoryId);
});
it('rejects invalid ordering and additions without changing the registry',async()=>{
  const initial=spaces.read();
  for(const action of [{action:'remove',id:'unknown'},{action:'reorder',order:[]},{action:'reorder',order:['unknown']},{action:'add',root:path.join(temp,'missing')},{action:'add',root:'relative'},{action:'unknown'}]) {
    await expect(spaces.manage({...action,revision:0})).rejects.toThrow();
    expect(spaces.read()).toEqual(initial);
  }
  await spaces.manage({action:'add',root:other,revision:0});const next=spaces.read();
  await expect(spaces.manage({action:'reorder',order:[initial.id,initial.id],revision:1})).rejects.toThrow();
  expect(spaces.read()).toEqual(next);
});
it('keeps unavailable inactive repositories in the list while a failed open preserves the current one',async()=>{
  await spaces.manage({action:'add',root:other,revision:0});
  await fs.rmdir(other);
  const restarted=await workspaceStore(local,root),before=restarted.read();
  expect(before.repositories).toHaveLength(2);
  await expect(restarted.update({root:other,revision:1})).rejects.toThrow('无法访问');
  expect(restarted.read()).toEqual(before);
});
it('serializes repository edits with workspace switching and rejects stale revisions',async()=>{
  const initial=spaces.read();
  const results=await Promise.allSettled([spaces.manage({action:'add',root:other,revision:0}),spaces.update({root:other,revision:0})]);
  expect(results.map(item=>item.status)).toEqual(['fulfilled','rejected']);
  expect(spaces.read()).toMatchObject({id:initial.id,revision:1});
  expect(spaces.read().repositories).toHaveLength(2);
});
it('persists a display name without renaming the folder or changing document and metadata identity',async()=>{
  const before=spaces.read();
  await spaces.capture().files.save({path:'保留.md',text:'original manuscript',baseline:null});
  await spaces.capture().outlines.save('保留.md','heading','original outline');
  await spaces.manage({action:'rename',id:before.id,name:'  我的长篇小说  ',revision:0});
  expect(spaces.read()).toMatchObject({id:before.id,root:before.root,repositories:[{id:before.id,root:before.root,name:'我的长篇小说'}]});
  const restarted=await workspaceStore(local,root);expect(restarted.read()).toEqual(spaces.read());
  expect(await fs.readFile(path.join(root,'保留.md'),'utf8')).toBe('original manuscript');
  expect(await restarted.capture().outlines.read('保留.md')).toEqual({heading:'original outline'});
  expect(await fs.readdir(temp)).not.toContain('我的长篇小说');
});
it('keeps inactive repository names through switching, duplicate additions and reordering',async()=>{
  await spaces.manage({action:'add',root:other,revision:0});const [first,second]=spaces.read().repositories;
  await spaces.manage({action:'rename',id:second.id,name:'参考资料',revision:1});
  await spaces.manage({action:'add',root:other,revision:2});
  await spaces.manage({action:'reorder',order:[second.id,first.id],revision:3});
  await spaces.update({root:other,revision:4});
  expect(spaces.read().repositories[0]).toEqual({...second,name:'参考资料'});
  expect((await workspaceStore(local,root)).read()).toEqual(spaces.read());
});
it('clears only the display name when the user submits a blank alias',async()=>{
  const original=spaces.read();
  await spaces.manage({action:'rename',id:original.id,name:'备注',revision:0});
  await spaces.manage({action:'rename',id:original.id,name:'   ',revision:1});
  expect(spaces.read().repositories).toEqual(original.repositories);
  expect((await workspaceStore(local,root)).read().repositories).toEqual(original.repositories);
});
it('rejects invalid or stale name edits without changing the repository registry',async()=>{
  const original=spaces.read();
  for(const name of [null,10,'x'.repeat(81),'line\nbreak','hidden\0character']) {
    await expect(spaces.manage({action:'rename',id:original.id,name,revision:0})).rejects.toThrow('备注名称');
    expect(spaces.read()).toEqual(original);
  }
  await expect(spaces.manage({action:'rename',id:'missing',name:'备注',revision:0})).rejects.toThrow('不在列表');
  await spaces.manage({action:'rename',id:original.id,name:'first',revision:0});
  await expect(spaces.manage({action:'rename',id:original.id,name:'stale',revision:0})).rejects.toThrow('设置已变化');
  expect(spaces.read().repositories[0].name).toBe('first');
});
