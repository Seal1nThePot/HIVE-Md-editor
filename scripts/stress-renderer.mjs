import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {launchBackend,workspaceBuildPaths} from '../desktop/backendProcess.mjs';

const require=createRequire(import.meta.url),project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const paths=workspaceBuildPaths(project);
const output=path.resolve(process.env.HIVE_STRESS_EVIDENCE||path.join(paths.work,'evidence','stress'));
const appRoot=path.join(paths.release,'win-unpacked'),appExe=path.join(appRoot,'HIVE markdown editor.exe'),asar=path.join(appRoot,'resources/app.asar');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const safeEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('HIVE_')&&k!=='ELECTRON_RUN_AS_NODE'));
const sha=text=>createHash('sha256').update(text).digest('hex');
async function counters(pids){
  const cmd=`$wanted=@(${pids.join(',')}); Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $wanted -contains $_.IDProcess } | Select-Object IDProcess,WorkingSetPrivate,PrivateBytes | ConvertTo-Json -Compress`;
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(cmd,'utf16le').toString('base64')],{windowsHide:true});const value=JSON.parse(stdout||'[]');return Array.isArray(value)?value:[value];
}
async function worker(){
  const {app,BrowserWindow}=require('electron'),[port,temp,backendPid,resultFile]=process.argv.slice(-4);app.setPath('userData',path.join(temp,'profile'));app.disableHardwareAcceleration();await app.whenReady();
  const win=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1600,height:1050,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const started=Date.now(),errors=[],crashes=[],samples=[],rounds=[];
  const result={passed:false,method:'Packaged asar production frontend and backend, isolated synthetic repository; hidden nonfocusable offscreen Electron, synthetic DOM controls and CodeMirror transactions; no OS input or forced GC.',electron:process.versions.electron,started:new Date(started).toISOString(),samples,rounds,errors,crashes};
  const save=()=>fs.writeFile(resultFile,JSON.stringify(result,null,2)+'\n');
  win.webContents.on('console-message',e=>{if(e.level==='error'||e.level===3)errors.push(e.message);});win.webContents.on('render-process-gone',(_event,details)=>crashes.push(details));
  try{
    await win.loadURL(`http://127.0.0.1:${port}`);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await win.webContents.debugger.sendCommand('Performance.enable');
    result.build=await win.webContents.executeJavaScript(`fetch('/build-info.json').then(r=>r.json())`);
    await win.webContents.executeJavaScript(`(async()=>{const wait=async(f,label)=>{for(let i=0;i<750;i++){if(f())return;await new Promise(r=>setTimeout(r,40));}throw Error('Timeout '+label)};await wait(()=>document.querySelector('.explorer-row[data-path="压力文稿.md"]'),'document row');document.querySelector('.explorer-row[data-path="压力文稿.md"]').click();await wait(()=>document.querySelector('.document-pane .cm-content')?.textContent.includes('压力测试固定标题'),'document contents');})()`);
    const sample=async(label)=>{
      const performance=Object.fromEntries((await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
      const dom=await win.webContents.debugger.sendCommand('Memory.getDOMCounters'),rendererPid=win.webContents.getOSProcessId(),os=await counters([rendererPid,Number(backendPid)]);
      assert(os.some(v=>Number(v.IDProcess)===rendererPid)&&os.some(v=>Number(v.IDProcess)===Number(backendPid)),'OS counters missing process');
      samples.push({label,elapsedSeconds:(Date.now()-started)/1000,time:new Date().toISOString(),rendererPid,backendPid:Number(backendPid),os,dom,metrics:Object.fromEntries(['JSHeapUsedSize','JSHeapTotalSize','Documents','Nodes','JSEventListeners'].map(k=>[k,performance[k]]))});await save();
    };
    await sample('initial');
    for(let i=1;i<=24;i++){
      const begin=Date.now();
      await win.webContents.executeJavaScript(`(async()=>{
        const q=s=>document.querySelector(s),pause=ms=>new Promise(r=>setTimeout(r,ms)),wait=async(f,label)=>{for(let i=0;i<400;i++){if(f())return;await pause(50)}throw Error('Timeout '+label)};
        const mode=async(text,selector)=>{q('[aria-label="正文 1显示模式"]').click();await wait(()=>q('.display-mode-menu'),'menu');const button=[...q('.display-mode-menu').querySelectorAll('button')].find(b=>b.textContent.includes(text));if(!button)throw Error('Missing mode '+text);button.click();await wait(()=>q(selector),'mode '+text);await pause(200)};
        await mode('代码模式','.document-pane .cm-editor[data-display-mode="source"]');
        await mode('实时预览','.document-pane .cm-editor[data-display-mode="live"]');
        await mode('左右分栏','.split-source .cm-content');
        const source=()=>q('.split-source .cm-content'),main=()=>q('.split-main .cm-content'),marker='STRESS-${String(i).padStart(3,'0')}-';
        const first=source()?.querySelector('.cm-line');if(!first)throw Error('Source line unavailable');source().focus();const range=document.createRange();range.setStart(first,0);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      })()`);
      await win.webContents.executeJavaScript(`(()=>{const content=document.querySelector('.split-source .cm-content'),view=content?.cmTile?.root?.view;if(!view)throw Error('CodeMirror view unavailable');view.dispatch({changes:{from:0,insert:'STRESS-${String(i).padStart(3,'0')}-'}});})()`);
      const info=await win.webContents.executeJavaScript(`(async()=>{
        const q=s=>document.querySelector(s),pause=ms=>new Promise(r=>setTimeout(r,ms)),wait=async(f,label)=>{for(let i=0;i<400;i++){if(f())return;await pause(50)}throw Error('Timeout '+label)};
        const source=()=>q('.split-source .cm-content'),main=()=>q('.split-main .cm-content'),marker='STRESS-${String(i).padStart(3,'0')}-';
        await wait(()=>source()?.textContent.includes(marker)&&main()?.textContent.includes(marker),'insert mirrored');
        const key=(shift=false)=>source().dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,shiftKey:shift,bubbles:true}));
        key();await wait(()=>!source()?.textContent.includes(marker)&&!main()?.textContent.includes(marker),'undo mirrored');key(true);await wait(()=>source()?.textContent.includes(marker)&&main()?.textContent.includes(marker),'redo mirrored');key();await wait(()=>!source()?.textContent.includes(marker)&&!main()?.textContent.includes(marker),'final undo');
        q('[aria-label="设置"]').click();await wait(()=>q('.settings-page'),'settings');q('[aria-label="关闭设置"]').click();await wait(()=>!q('.settings-page'),'settings close');
        q('[aria-label="面板"]').click();await wait(()=>q('[aria-label="草稿显示"]'),'panel');const sw=()=>q('[aria-label="草稿显示"]'),initial=sw().getAttribute('aria-checked');sw().click();await wait(()=>sw().getAttribute('aria-checked')!==initial,'panel toggle');sw().click();await wait(()=>sw().getAttribute('aria-checked')===initial,'panel restore');q('[aria-label="关闭面板管理"]').click();
        return {marker,editMethod:'CodeMirror transaction',insertUndoRedoUndo:true,settings:true,panelToggleRestore:true};
      })()`);
      rounds.push({round:i,elapsedSeconds:(Date.now()-started)/1000,operationSeconds:(Date.now()-begin)/1000,...info});console.log(`round ${i}/24 ${(Date.now()-begin)/1000}s`);await save();
      if(i%5===0||i===24)await sample(`round-${i}`);
      await sleep(Math.max(0,10000-(Date.now()-begin)));
    }
    await sample('idle-start');for(const seconds of [25,50,75]){await sleep(25000);await sample(`idle-${seconds}s`);console.log(`idle ${seconds}/75s`);}
    const finalText=await fs.readFile(path.join(temp,'documents','压力文稿.md'),'utf8');result.finalHash=sha(finalText);result.expectedHash=sha(await fs.readFile(path.join(temp,'expected.md'),'utf8'));result.textRestored=result.finalHash===result.expectedHash;
    assert(result.textRestored,'Final saved synthetic document differs from original');assert.deepEqual(errors,[],'Renderer console errors');assert.deepEqual(crashes,[],'Renderer process crashed');result.passed=true;result.finished=new Date().toISOString();result.elapsedSeconds=(Date.now()-started)/1000;await save();win.webContents.debugger.detach();win.destroy();app.exit(0);
  }catch(error){result.error=error.stack;result.finished=new Date().toISOString();result.elapsedSeconds=(Date.now()-started)/1000;await save();if(!win.isDestroyed())win.destroy();app.exit(1);}
}
async function main(){
  await fs.mkdir(output,{recursive:true});await fs.access(appExe);await fs.access(asar);
  const oldFiles=['renderer-stress.json','fixture.json','failure.log','worker.log','backend.log'];
  const existing=[];for(const name of oldFiles)try{await fs.access(path.join(output,name));existing.push(name);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(existing.length){const archive=await fs.mkdtemp(path.join(output,'run-'));for(const name of existing)await fs.rename(path.join(output,name),path.join(archive,name));}
  const temp=await fs.mkdtemp(path.join(output,'.stress-fixture-'));let server,child,serverLog='',workerLog='';
  try{
    const docs=path.join(temp,'documents'),state=path.join(temp,'state');await fs.mkdir(docs);await fs.mkdir(state);
    const block='这是一段隔离的合成压力文稿，包含中文、English words、标点与数字 123456789，用于持续编辑和预览。\n\n';
    const text='# 压力测试固定标题\n\n![合成图片](压力图片.png)\n\n| 项目 | 数值 | 说明 |\n| --- | ---: | --- |\n| 甲 | 123 | 固定内容 |\n| 乙 | 456 | 合成文本 |\n\n行内公式 $a^2+b^2=c^2$。\n\n$$\nE=mc^2\n$$\n\n'+block.repeat(2200);
    await fs.writeFile(path.join(docs,'压力文稿.md'),text);await fs.writeFile(path.join(temp,'expected.md'),text);await fs.writeFile(path.join(docs,'压力图片.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
    await fs.writeFile(path.join(output,'fixture.json'),JSON.stringify({characters:text.length,bytes:Buffer.byteLength(text),sha256:sha(text),formula:true,table:true,image:true,rounds:24,minimumRoundMs:10000,idleSeconds:75},null,2)+'\n');console.log(`fixture ${text.length} characters; using ${asar}`);
    server=launchBackend({root:project,resources:path.join(appRoot,'resources'),env:{...safeEnv(),HIVE_PORT:'0',HIVE_DOCUMENTS:docs,HIVE_STATE_DIR:state,HIVE_API_KEY:''},onLine:line=>serverLog+=line+'\n',onError:line=>serverLog+=line});
    const {port,pid}=await server.ready;
    child=spawn((await import('electron')).default,[fileURLToPath(import.meta.url),'--worker',String(port),temp,String(pid),path.join(output,'renderer-stress.json')],{cwd:project,windowsHide:true,env:safeEnv(),stdio:['ignore','pipe','pipe']});child.stdout.on('data',v=>{workerLog+=v;process.stdout.write(v);});child.stderr.on('data',v=>{workerLog+=v;process.stderr.write(v);});
    const code=await new Promise((resolve,reject)=>{const t=setTimeout(()=>{child.kill();reject(Error('Worker timeout'));},900000);child.once('error',reject);child.once('exit',code=>{clearTimeout(t);resolve(code);});});assert.equal(code,0,'Stress worker failed');
  }catch(error){await fs.writeFile(path.join(output,'failure.log'),error.stack+'\n'+workerLog+'\n'+serverLog);throw error;}
  finally{
    await fs.writeFile(path.join(output,'worker.log'),workerLog);await fs.writeFile(path.join(output,'backend.log'),serverLog);
    if(child&&child.exitCode===null&&!child.killed)child.kill();await server?.stop();
    const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),output);assert(path.basename(resolved).startsWith('.stress-fixture-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
if(process.argv.includes('--worker'))void worker().catch(error=>{console.error(error.stack);require('electron').app.exit(1);});else await main();
