import assert from 'node:assert/strict';
import {fixtureImage} from './fixture-image.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {launchBackend,workspaceBuildPaths} from '../desktop/backendProcess.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const output=path.resolve(process.env.HIVE_EDITOR_OUTPUT||path.join(workspaceBuildPaths(project).work,'evidence','editor'));
const require=createRequire(import.meta.url),packaged=process.env.HIVE_EDITOR_PACKAGE;
const prefix=packaged?'packaged-app':'built-app';

if(process.argv.includes('--worker')){
  async function worker(){
  const {app,BrowserWindow}=require('electron');
  app.setPath('userData',path.join(process.argv.at(-1),'electron-profile'));
  app.disableHardwareAcceleration();await app.whenReady();
  console.log('Hidden editor worker ready');
  const window=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1600,height:1050,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const errors=[];window.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)errors.push(event.message);console.log('renderer:',event.message);});
  window.webContents.on('did-fail-load',(_event,code,description)=>console.log('Load failed',code,description));
  window.webContents.on('dom-ready',()=>console.log('DOM ready'));
  window.webContents.on('render-process-gone',(_event,detail)=>console.log('Renderer gone',JSON.stringify(detail)));
  try{
    await window.loadURL('http://127.0.0.1:'+process.argv.at(-2));
    console.log('Production page loaded');
    const result=await window.webContents.executeJavaScript(`(async()=>{
      const checks=[],get=s=>document.querySelector(s),pause=()=>new Promise(r=>setTimeout(r,120));
      const check=(label,value)=>{checks.push({label,passed:!!value});console.log('Editor check:',label,!!value);if(!value)throw new Error(label);};
      const wait=async(fn,label)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Timeout: '+label);};
      await wait(()=>get('.explorer-row[data-path="验收.md"]'),'file explorer');
      get('.explorer-row[data-path="验收.md"]').click();
      await wait(()=>get('.cm-preview-image img')?.naturalWidth>0,'wiki image decoded');
      check('complete built app decodes wiki image',get('.cm-preview-image img').naturalWidth>0);
      const mode=async name=>{get('[aria-label="正文 1显示模式"]').click();await wait(()=>get('.display-mode-menu'),'display mode menu');[...document.querySelectorAll('.display-mode-menu button')].find(b=>b.textContent.includes(name)).click();await pause();};
      await mode('左右分栏');
      await wait(()=>get('.split-source .cm-content'),'source pane');
      const source=()=>get('.split-source .cm-content');
      check('split option mounts two editors',!!source()&&!!get('.split-main .cm-content'));
      const left=get('.split-source').getBoundingClientRect(),right=get('.split-main').getBoundingClientRect();
      check('split panes are side by side with equal widths',right.left>=left.right-1&&Math.abs(right.width-left.width)<3&&left.width>250);
      get('.explorer-row[data-path="另一篇.md"]').click();await wait(()=>get('.split-main .cm-content').textContent.includes('第二篇独有内容'),'second document');
      check('opening another file replaces source pane',source().textContent.includes('第二篇独有内容')&&!source().textContent.includes('验收待办'));
      get('.explorer-row[data-path="验收.md"]').click();await wait(()=>source().textContent.includes('验收待办'),'return to original document');await pause();
      await wait(()=>get('.cm-preview-task'),'task control');get('.cm-preview-task').click();
      await wait(()=>get('.cm-preview-task')?.getAttribute('aria-checked')==='true','task check');
      check('complete app task checkbox toggles',true);
      check('task source is mirrored',source().textContent.includes('[x] 验收待办'));
      const table=()=>get('.split-main [data-table-widget]');
      await wait(()=>table()?.querySelector('[data-table-action="column-after"]'),'table toolbar');
      table().querySelector('textarea[data-row="1"][data-col="0"]').focus();
      table().querySelector('[data-table-action="column-after"]').click();await pause();
      check('table quick insert creates third column',table().querySelectorAll('th').length===3);
      table().querySelector('[data-cell="1:0"] .cm-table-cell-preview')?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await pause();
      const cell=table().querySelector('textarea[data-row="1"][data-col="0"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(cell,'联动内容');cell.dispatchEvent(new Event('input',{bubbles:true}));await pause();
      check('live table edits appear in source',source().textContent.includes('联动内容'));
      const content=source(),first=content.querySelector('.cm-line');content.focus();
      const range=document.createRange();range.setStart(first,0);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      document.execCommand('insertText',false,'源码输入');await pause();
      check('source typing appears in live pane',get('.split-main .cm-content').textContent.includes('源码输入'));
      source().dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true}));await pause();
      check('undo from source updates both panes',!source().textContent.includes('源码输入')&&!get('.split-main .cm-content').textContent.includes('源码输入'));
      await mode('实时预览');check('switching mode removes source editor',!get('.split-source .cm-content'));
      await mode('左右分栏');check('switching back retains current text',source().textContent.includes('联动内容')&&source().textContent.includes('[x] 验收待办'));
      await wait(()=>get('.cm-math-widget [class="katex"]'),'existing multiline math');
      check('existing aligned math still renders',!!get('.cm-math-widget .katex'));
      return {checks};
    })()`);
    await fs.writeFile(path.join(output,prefix+'-preview.png'),(await window.webContents.capturePage()).toPNG());
    assert.deepEqual(errors,[],'Renderer console errors');
    await fs.writeFile(path.join(output,prefix+'-validation.json'),JSON.stringify({passed:true,method:'Hidden nonfocusable Electron, complete production app and isolated real backend; synthetic DOM input, no desktop input.',...result,consoleErrors:errors},null,2)+'\n');
    console.log(JSON.stringify({passed:true,checks:result.checks.length}));window.destroy();app.exit(0);
  }catch(error){await fs.writeFile(path.join(output,prefix+'-failure.png'),(await window.webContents.capturePage()).toPNG());console.error(error.stack);window.destroy();app.exit(1);}
  }
  void worker().catch(error=>{console.error(error.stack);require('electron').app.exit(1);});
}else{
  await fs.mkdir(output,{recursive:true});const temporary=await fs.mkdtemp(path.join(output,'.app-check-'));let server,serverLog='';
  try{
    const root=path.join(temporary,'文稿');await fs.mkdir(root);
    await fs.writeFile(path.join(root,'图片 中文.png'),fixtureImage);
    await fs.writeFile(path.join(root,'另一篇.md'),'# 第二篇\n\n第二篇独有内容。\n');
    await fs.writeFile(path.join(root,'验收.md'),'# 正文功能验收\n\n![[图片 中文.png]]\n\n- [ ] 验收待办\n\n| 标题甲 | 标题乙 |\n| :--- | ---: |\n| 内容甲 | 内容乙 |\n\n$$\n\\begin{aligned}\na &= b + c \\\\\n  &= d + e\n\\end{aligned}\n$$\n\n验收结束。\n');
    const packageRoot=packaged?path.resolve(packaged,'win-unpacked'):null;
    const resources=packageRoot?path.join(packageRoot,'resources'):undefined;
    server=launchBackend({root:project,resources,env:{HIVE_PORT:'0',HIVE_DOCUMENTS:root,HIVE_STATE_DIR:path.join(temporary,'state'),HIVE_API_KEY:''},onLine:line=>serverLog+=line+'\n',onError:line=>serverLog+=line});
    const {port}=await server.ready;
    const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
    const child=spawn((await import('electron')).default,[fileURLToPath(import.meta.url),'--worker',String(port),temporary],{cwd:project,windowsHide:true,env:environment,stdio:['ignore','pipe','pipe']});
    let log='';child.stdout.on('data',data=>{log+=data;process.stdout.write(data);});child.stderr.on('data',data=>{log+=data;process.stderr.write(data);});
    let code;try{code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('App validation timeout'));},45000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});}
    finally{await fs.writeFile(path.join(output,prefix+'.log'),log);await fs.writeFile(path.join(output,prefix+'-server.log'),serverLog);}
    assert.equal(code,0,'Complete app validation failed');
  }finally{
    await fs.writeFile(path.join(output,prefix+'-server.log'),serverLog);
    await server?.stop();
    const resolved=path.resolve(temporary);assert.equal(path.dirname(resolved),path.resolve(output));assert.ok(path.basename(resolved).startsWith('.app-check-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
