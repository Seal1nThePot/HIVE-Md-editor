import {afterEach,beforeEach,expect,it} from 'vitest';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHistoryStore} from './history-store.mjs';

const instant=second=>new Date(Date.UTC(2026,10,19,12,0,second)).toISOString();
const record=(id,actor,second)=>({id,actor,file:'章节一.md',createdAt:instant(second),label:'正文编辑',kind:'text',status:'applied',changes:{
  text:[{from:3,before:'旧',after:'新',contextBefore:'前文',contextAfter:'后文'}],
}});
const checkpoint=(id,actor,second)=>({id,actor,file:'章节一.md',createdAt:instant(second),label:'草稿检查点',
  text:'---\n标题: 章节一\n---\n\n未保存的正文。',outline:{revision:3,initialized:true,nodes:[{id:'node1',title:'第一幕',description:'场景目标',level:1,targetHeading:null}]},
});
let directory,store;
const disk=async()=>JSON.parse(await fs.readFile(path.join(directory,'history.json'),'utf8'));

beforeEach(async()=>{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'hive-history-store-'));
  store=await createHistoryStore(directory);
});

afterEach(async()=>{
  if(directory&&path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('hive-history-store-')){
    await fs.rm(directory,{recursive:true,force:true});
  }
});

it('persists operation history and full snapshots across a new store instance',async()=>{
  expect(store.read()).toEqual({revision:0,limits:{human:100,ai:100},entries:[],snapshots:[]});
  const text=record('text-ai','ai',1),snapshot=checkpoint('checkpoint-human','human',2);
  const outline={...record('outline-human','human',3),kind:'outline',changes:{outline:{
    before:{revision:1,nodes:[]},after:{revision:2,initialized:true,nodes:snapshot.outline.nodes},
  }}};
  const moved={...record('file-ai','ai',4),kind:'file',changes:{file:{action:'trash',path:'章节一.md',id:'trash-entry'}}};
  await store.append(text);
  await store.saveSnapshot(snapshot);
  await store.append(outline);
  const latest=await store.append(moved);
  expect(latest).toEqual({revision:4,limits:{human:100,ai:100},entries:[moved,outline,text],snapshots:[snapshot]});
  expect(await disk()).toEqual(latest);
  expect((await createHistoryStore(directory)).read()).toEqual(latest);
  expect(await fs.readdir(directory)).toEqual(['history.json']);
});

it('applies separate bounds by newest timestamp and leaves snapshots independent',async()=>{
  await store.setLimits({human:2,ai:1});
  const entries=[record('human-3','human',3),record('ai-1','ai',2),record('human-1','human',1),
    record('ai-2','ai',5),record('human-2','human',4),record('ai-old','ai',0)];
  for(const entry of entries)await store.append(entry);
  const checkpoints=[checkpoint('checkpoint-ai','ai',4),checkpoint('checkpoint-human','human',3)];
  for(const snapshot of checkpoints)await store.saveSnapshot(snapshot);
  expect(store.read().entries.map(entry=>entry.id)).toEqual(['ai-2','human-2','human-3']);
  const shrunk=await store.setLimits({human:1,ai:0});
  expect(shrunk.entries.map(entry=>entry.id)).toEqual(['human-2']);
  expect(shrunk.snapshots).toEqual(checkpoints);
  expect(await store.append(record('ignored-ai','ai',9))).toEqual(shrunk);
  expect(await store.setLimits(shrunk.limits)).toEqual(shrunk);
  await expect(store.setLimits({human:1001,ai:1})).rejects.toHaveProperty('status',400);
  expect((await createHistoryStore(directory)).read()).toEqual(shrunk);
});

it('persists optional polish metadata with the original and accepted candidate',async()=>{
  const initial=record('polish','ai',1);
  const polish={...initial,changes:{...initial.changes,polish:{id:'comparison',reason:'精简',node:'正文',annotationIds:['selection']}}};
  await store.append(polish);
  await store.setStatus({id:'polish',status:'reverted',expectedStatus:'applied'});
  expect((await createHistoryStore(directory)).read().entries).toEqual([{...polish,status:'reverted'}]);
});

it('serializes concurrent operations, ignores duplicate IDs, and shields internal snapshots from callers',async()=>{
  const records=Array.from({length:15},(_,index)=>record('record-'+index,index%2===0?'human':'ai',index));
  const snapshot=checkpoint('once','ai',3);
  await Promise.all([...records.map(item=>store.append(item)),store.append({...records[0],label:'重复提交'}),
    store.saveSnapshot(snapshot),store.saveSnapshot({...snapshot,label:'重复快照'})]);
  const latest=store.read();
  expect(latest.entries).toEqual(records.toReversed());
  expect(latest.snapshots).toEqual([snapshot]);
  expect(latest.revision).toBe(16);
  latest.entries[0].changes.text[0].after='外部误改';
  latest.snapshots[0].outline.nodes[0].title='外部误改';
  expect(store.read().entries).toEqual(records.toReversed());
  expect(store.read().snapshots).toEqual([snapshot]);
  expect(await disk()).toEqual(store.read());
});

it('compares statuses in the write queue and persists undo and redo',async()=>{
  await store.append(record('edit','ai',1));
  const undo={id:'edit',expectedStatus:'applied',status:'reverted'};
  const results=await Promise.allSettled([store.setStatus(undo),store.setStatus(undo)]);
  expect(results[0]).toMatchObject({status:'fulfilled',value:{revision:2,entries:[{id:'edit',status:'reverted'}]}});
  expect(results[1]).toMatchObject({status:'rejected',reason:{status:409}});
  await expect(store.setStatus({...undo,id:'missing'})).rejects.toHaveProperty('status',404);
  const redo=await store.setStatus({id:'edit',expectedStatus:'reverted',status:'applied'});
  expect(redo.entries[0].status).toBe('applied');
  expect(await disk()).toEqual(redo);
});

it('records a new trash identity when a replay moves a file back into the trash',async()=>{
  const moved={...record('file-replay','ai',1),kind:'file',changes:{file:{action:'trash',path:'章节一.md',id:'previous'}}};
  await store.append(moved);
  await store.setStatus({id:moved.id,expectedStatus:'applied',status:'reverted'});
  const next=await store.setStatus({id:moved.id,expectedStatus:'reverted',status:'applied',fileId:'replayed'});
  expect(next.entries[0].changes.file.id).toBe('replayed');
  expect((await createHistoryStore(directory)).read()).toEqual(next);
});

it('preserves the last successful snapshot after a write failure and permits retry',async()=>{
  const target=path.join(directory,'history.json');
  await fs.mkdir(target);
  const initial=store.read(),entry=record('retry','human',1);
  await expect(store.append(entry)).rejects.toThrow();
  expect(store.read()).toEqual(initial);
  expect(await fs.readdir(directory)).toEqual(['history.json']);
  await fs.rmdir(target);
  const retried=await store.append(entry);
  expect(retried.revision).toBe(1);
  expect(await disk()).toEqual(retried);
});

it('rejects malformed records and keeps an unreadable history file intact',async()=>{
  await expect(store.append({...record('invalid','human',1),createdAt:'not ISO'})).rejects.toHaveProperty('status',400);
  await expect(store.saveSnapshot({...checkpoint('invalid','ai',1),outline:{revision:1,nodes:[]}})).rejects.toHaveProperty('status',400);
  const target=path.join(directory,'history.json'),corrupt='{未完成的 JSON';
  await fs.writeFile(target,corrupt,'utf8');
  await expect(createHistoryStore(directory)).rejects.toHaveProperty('status',500);
  expect(await fs.readFile(target,'utf8')).toBe(corrupt);
});
