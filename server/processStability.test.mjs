import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {promises as fs} from 'node:fs';
import {request} from 'node:http';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {launchBackend} from '../desktop/backendProcess.mjs';

let directory;const children=new Set();
beforeEach(async()=>{directory=await fs.mkdtemp(path.join(os.tmpdir(),'hive-process-stability-'));});
async function terminate(child){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL');});children.delete(child);}
afterEach(async()=>{
  await Promise.all([...children].map(terminate));
  if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('hive-process-stability-'))throw new Error('Unsafe cleanup target');
  await fs.rm(directory,{recursive:true,force:true});
});
async function start(){
  const backend=launchBackend({
    root:fileURLToPath(new URL('../',import.meta.url)),
    env:{HIVE_PORT:'0',HIVE_DOCUMENTS:path.join(directory,'documents'),HIVE_STATE_DIR:path.join(directory,'state'),HIVE_API_KEY:''},
  });
  const {child}=backend;children.add(child);
  const {port}=await backend.ready;
  const base='http://127.0.0.1:'+port,workspace=await(await fetch(base+'/api/workspace')).json();return {child,base,workspace};
}
describe('real isolated backend process failures',()=>{
  it('preserves a committed document across three kills during incomplete save uploads',async()=>{
    let running=await start();
    const initial=await fetch(running.base+'/api/file',{method:'POST',headers:{'Content-Type':'application/json','X-Hive-Workspace':running.workspace.id},body:JSON.stringify({path:'draft.md',text:'committed original',baseline:null})});expect(initial.ok).toBe(true);const baseline=await initial.json();
    for(let round=0;round<3;round++){
      const partial=request(running.base+'/api/file',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':'10000','X-Hive-Workspace':running.workspace.id}});partial.on('error',()=>{});
      await new Promise((resolve,reject)=>{partial.once('error',reject);partial.write('{"path":"draft.md","text":"incomplete',resolve);});
      await terminate(running.child);partial.destroy();running=await start();
      const restored=await(await fetch(running.base+'/api/file?path=draft.md')).json();expect(restored.text).toBe('committed original');expect(restored.hash).toBe(baseline.hash);
    }
    const result=await fetch(running.base+'/api/file',{method:'POST',headers:{'Content-Type':'application/json','X-Hive-Workspace':running.workspace.id},body:JSON.stringify({path:'draft.md',text:'recovered after crashes',baseline:baseline.hash})});expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(directory,'documents','draft.md'),'utf8')).toBe('recovered after crashes');
  },20000);
  it('keeps serving after malformed JSON, oversized input, stale workspace and invalid paths',async()=>{
    const running=await start(),headers={'Content-Type':'application/json','X-Hive-Workspace':running.workspace.id};
    const cases=[{headers,body:'{truncated'},{headers,body:JSON.stringify({path:'draft.md',text:'x'.repeat(2000001),baseline:null})},{headers:{...headers,'X-Hive-Workspace':'stale'},body:JSON.stringify({path:'draft.md',text:'x',baseline:null})},{headers,body:JSON.stringify({path:'../outside.md',text:'x',baseline:null})}];
    for(const input of cases){const result=await fetch(running.base+'/api/file',{method:'POST',...input});expect(result.status).toBeGreaterThanOrEqual(400);expect((await fetch(running.base+'/api/health')).ok).toBe(true);}
    expect(await fs.readdir(path.join(directory,'documents'))).toEqual([]);
  },15000);
});
