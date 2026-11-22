import {beforeEach,afterEach,it,expect} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileStore} from './files.mjs';
import {explorerStore} from './explorer.mjs';
let root,state,files,explorer,base;
beforeEach(async()=>{base=await fs.mkdtemp(path.join(os.tmpdir(),'hive-explorer-'));root=path.join(base,'docs');state=path.join(base,'state');await fs.mkdir(root);await fs.mkdir(state);files=fileStore(root);explorer=explorerStore({root,state,files});});
afterEach(async()=>{await fs.rm(base,{recursive:true,force:true});});
it('creates unique default notes and folders immediately, retaining existing content',async()=>{
  const values=await Promise.all(Array.from({length:3},()=>explorer.manage({action:'create',type:'file'})));
  expect(values.map(v=>v.path)).toEqual(['新建文档.md','新建文档 2.md','新建文档 3.md']);
  expect(await explorer.manage({action:'create',type:'folder'})).toMatchObject({path:'新建文件夹'});
  expect(await explorer.manage({action:'create',type:'file',parent:'新建文件夹'})).toMatchObject({path:'新建文件夹/新建文档.md'});
  expect((await files.list())[0].modifiedAt).toBeGreaterThan(0);
});
it('moves folders with their notes, annotations and outlines and restores them after deletion',async()=>{
  await files.save({path:'a/note.md',text:'body',baseline:null});await files.folder('b');
  await fs.writeFile(path.join(state,'text-annotations.json'),JSON.stringify({'document:a/note.md':{revision:1,items:[{id:'one',file:'a/note.md',order:2}]},'scratch:自由草稿':{items:[]}}));
  await fs.writeFile(path.join(state,'writing-outline-nodes.json'),JSON.stringify({'a/note.md':{revision:2,nodes:[{title:'Node'}]}}));
  await explorer.manage({action:'move',path:'a',parent:'b'});
  expect((await files.read('b/a/note.md')).text).toBe('body');
  const annotations=JSON.parse(await fs.readFile(path.join(state,'text-annotations.json')));
  expect(annotations['document:b/a/note.md'].items[0]).toMatchObject({file:'b/a/note.md',order:2});expect(annotations['document:a/note.md']).toBeUndefined();expect(annotations['scratch:自由草稿']).toBeDefined();
  const deleted=await explorer.manage({action:'trash',path:'b/a'});
  expect(await explorer.listTrash()).toHaveLength(1);expect(JSON.stringify(await files.list())).not.toContain('.hive-trash');
  await explorer.manage({action:'restore',id:deleted.id});
  expect((await files.read('b/a/note.md')).text).toBe('body');expect(await explorer.listTrash()).toHaveLength(0);
  const restoredAnnotations=JSON.parse(await fs.readFile(path.join(state,'text-annotations.json')));
  expect(restoredAnnotations['document:b/a/note.md'].items[0]).toMatchObject({file:'b/a/note.md',order:2});
  expect(Object.keys(restoredAnnotations).some(key=>key.startsWith('document:@trash/'+deleted.id))).toBe(false);
  expect(JSON.parse(await fs.readFile(path.join(state,'writing-outline-nodes.json')))['b/a/note.md'].nodes[0].title).toBe('Node');
});
it('does not overwrite a collision while renaming, moving or restoring',async()=>{
  await files.save({path:'a.md',text:'first',baseline:null});await files.save({path:'b.md',text:'second',baseline:null});
  await expect(explorer.manage({action:'rename',path:'a.md',name:'b.md'})).rejects.toMatchObject({status:409});
  const deleted=await explorer.manage({action:'trash',path:'a.md'});await files.save({path:'a.md',text:'new',baseline:null});
  await expect(explorer.manage({action:'restore',id:deleted.id})).rejects.toMatchObject({status:409});
  expect((await files.read('a.md')).text).toBe('new');expect(await explorer.listTrash()).toHaveLength(1);
});
it('reads a deleted Markdown snapshot by ID without restoring a file or replacing a same-name live note',async()=>{
  const pathName='notes/旧稿.MD', removed='# 旧稿\n带 **加粗** 的行。';
  await files.save({path:pathName,text:removed,baseline:null,eol:'CRLF',bom:true});
  const trashed=await explorer.manage({action:'trash',path:pathName});
  await expect(files.read(pathName)).rejects.toMatchObject({code:'ENOENT'});
  expect(await explorer.readTrashedDocument(trashed.id)).toEqual({id:trashed.id,path:pathName,text:removed});
  expect(await fs.readFile(path.join(root,'.hive-trash',trashed.id),'utf8')).toBe('\uFEFF'+removed.replace('\n','\r\n'));
  await files.save({path:pathName,text:'后来重建的文稿',baseline:null});
  expect((await explorer.readTrashedDocument(trashed.id)).text).toBe(removed);
  expect((await files.read(pathName)).text).toBe('后来重建的文稿');
  expect(await explorer.listTrash()).toEqual([trashed]);
});
it('validates trash preview ID, type, workspace, data identity and size',async()=>{
  await expect(explorer.readTrashedDocument('../notes/secret.md')).rejects.toMatchObject({status:400});
  await expect(explorer.readTrashedDocument(randomUUID())).rejects.toMatchObject({status:404});
  await expect(fs.lstat(path.join(root,'.hive-trash'))).rejects.toMatchObject({code:'ENOENT'});
  await files.folder('folder');
  const folder=await explorer.manage({action:'trash',path:'folder'});
  await expect(explorer.readTrashedDocument(folder.id)).rejects.toMatchObject({status:400});
  await fs.writeFile(path.join(root,'image.png'),'image');
  const image=await explorer.manage({action:'trash',path:'image.png'});
  await expect(explorer.readTrashedDocument(image.id)).rejects.toMatchObject({status:400});
  await fs.writeFile(path.join(root,'large.md'),Buffer.alloc(2_000_001));
  const large=await explorer.manage({action:'trash',path:'large.md'});
  await expect(explorer.readTrashedDocument(large.id)).rejects.toMatchObject({status:400});
  const otherRoot=path.join(base,'other');await fs.mkdir(otherRoot);
  const other=explorerStore({root:otherRoot,state,files:fileStore(otherRoot)});
  await expect(other.readTrashedDocument(large.id)).rejects.toMatchObject({status:404});
  const linked=path.join(root,'.hive-trash',large.id);
  await fs.rename(linked,linked+'.previous');
  await fs.symlink(otherRoot,linked,process.platform==='win32'?'junction':'dir');
  await expect(explorer.readTrashedDocument(large.id)).rejects.toMatchObject({status:409});
});
it('trashes the AI scratch note like any other document while keeping it out of rename and move',async()=>{
  await files.save({path:'自由草稿.md',text:'草稿正文',baseline:null});
  const deleted=await explorer.manage({action:'trash',path:'自由草稿.md'});
  expect(await explorer.listTrash()).toHaveLength(1);
  await expect(fs.access(path.join(root,'自由草稿.md'))).rejects.toThrow();
  await explorer.manage({action:'restore',id:deleted.id});
  expect((await files.read('自由草稿.md')).text).toBe('草稿正文');
  await expect(explorer.manage({action:'rename',path:'自由草稿.md',name:'改名.md'})).rejects.toThrow();
  await expect(explorer.manage({action:'move',path:'自由草稿.md',parent:''})).rejects.toThrow();
});
it('duplicates all ordinary folder contents without changing the source',async()=>{
  await files.save({path:'folder/a.md',text:'original',baseline:null});await fs.writeFile(path.join(root,'folder','image.png'),'image');
  await explorer.manage({action:'duplicate',path:'folder'});expect((await files.read('folder 副本/a.md')).text).toBe('original');expect(await fs.readFile(path.join(root,'folder 副本/image.png'),'utf8')).toBe('image');
});
it('rejects self-descendant moves, traversal, unsupported files and reserved names',async()=>{
  await files.save({path:'folder/sub/a.md',text:'x',baseline:null});await fs.writeFile(path.join(root,'data.txt'),'x');
  for(const input of [{action:'move',path:'folder',parent:'folder/sub'},{action:'create',parent:'../outside'},{action:'trash',path:'data.txt'},{action:'rename',path:'folder/sub/a.md',name:'NUL'},{action:'rename',path:'folder/sub/a.md',name:'x/y'}])await expect(explorer.manage(input)).rejects.toThrow();
  expect((await files.read('folder/sub/a.md')).text).toBe('x');
});
it('rolls a filesystem move back if metadata cannot be migrated',async()=>{
  await files.save({path:'a.md',text:'original',baseline:null});await fs.writeFile(path.join(state,'writing-outline-nodes.json'),'broken JSON');
  await expect(explorer.manage({action:'rename',path:'a.md',name:'new.md'})).rejects.toThrow();expect((await files.read('a.md')).text).toBe('original');
});
it('serializes saves with structural moves so an old save cannot recreate the source',async()=>{
  const result=await files.save({path:'a.md',text:'original',baseline:null});
  const moving=explorer.manage({action:'rename',path:'a.md',name:'new.md'}),saving=files.save({path:'a.md',text:'late',baseline:result.hash});
  await moving;await expect(saving).rejects.toMatchObject({status:409});expect((await files.read('new.md')).text).toBe('original');
});
it('passes an ordinary absolute file path to Windows Explorer without a shell',async()=>{
  if(process.platform!=='win32')return;await files.save({path:'a & b.md',text:'x',baseline:null});let args;
  const launcher=(...values)=>{args=values;const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;};
  await explorerStore({root,state,files},launcher).manage({action:'reveal',path:'a & b.md'});
  expect(args[0]).toBe('explorer.exe');expect(args[1]).toEqual([root]);expect(args[2]).toMatchObject({shell:false,windowsHide:false});
});

it('reveals the validated file through the desktop bridge and surfaces failures',async()=>{
  await files.save({path:'中文 & 空格.md',text:'x',baseline:null});const targets=[];
  const desktop=explorerStore({root,state,files},()=>{throw Error('Legacy launcher must not run');},{revealFile:async target=>{targets.push(target);}});
  await expect(desktop.manage({action:'reveal',path:'中文 & 空格.md'})).resolves.toEqual({ok:true});expect(targets).toEqual([path.join(root,'中文 & 空格.md')]);
  await expect(desktop.manage({action:'reveal',path:'../outside.md'})).rejects.toThrow();expect(targets).toHaveLength(1);
  const failure=explorerStore({root,state,files},undefined,{revealFile:async()=>{throw Error('Explorer unavailable');}});
  await expect(failure.manage({action:'reveal',path:'中文 & 空格.md'})).rejects.toThrow('Explorer unavailable');
});

it('searches names and body text only in the selected folder and its descendants',async()=>{
  await files.save({path:'one/nested/a.md',text:'# Title\nA unique needle here.',baseline:null});
  await files.save({path:'other/b.md',text:'needle outside',baseline:null});
  const found=await explorer.search('one','needle');expect(found.matches).toEqual([{path:'one/nested/a.md',line:2,excerpt:'# Title A unique needle here.'}]);
  expect((await explorer.search('one','a.md')).matches).toHaveLength(1);
  await expect(explorer.search('../outside','needle')).rejects.toThrow();
});
