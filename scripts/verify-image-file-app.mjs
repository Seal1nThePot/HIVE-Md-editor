import assert from 'node:assert/strict';
import {fixtureImage} from './fixture-image.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {launchBackend,workspaceBuildPaths} from '../desktop/backendProcess.mjs';
import {devFrontend} from './devFrontend.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const pkg=JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8'));
const paths=workspaceBuildPaths(project);
const output=path.resolve(process.env.HIVE_VERIFY_OUTPUT||path.join(paths.work,'evidence','ui'));
const packaged=process.argv.includes('--package'),development=process.argv.includes('--dev'),bundle=path.resolve(process.env.HIVE_VERIFY_BUNDLE||paths.release),prefix=(packaged?'packaged':'source')+'-image-file';
async function worker(){
  const {app,BrowserWindow}=require('electron');app.setPath('userData',path.join(process.argv.at(-1),'profile'));app.disableHardwareAcceleration();await app.whenReady();
  const win=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1600,height:1050,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const errors=[],devWarnings=[];win.webContents.on('console-message',e=>{if(e.level==='error'||e.level===3){if(e.message.includes('WebSocket closed without opened'))devWarnings.push(e.message);else {errors.push(e.message);console.error(e.message);}}});
  try{
    const origin='http://127.0.0.1:'+process.argv.at(-2),initial=await(await fetch(origin+'/api/workspace')).json();await fetch(origin+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json','X-Hive-Workspace':initial.id},body:JSON.stringify({autoSave:false,revision:initial.revision})});
    await win.loadURL(origin);
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const checks=[],get=s=>document.querySelector(s),pause=()=>new Promise(r=>setTimeout(r,200));
      const check=(label,value,detail)=>{checks.push({label,passed:!!value,detail});if(!value)throw new Error(label+' '+JSON.stringify(detail));};
      const wait=async(fn,label)=>{for(let i=0;i<220;i++){if(fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Timeout '+label);};
      await wait(()=>get('.explorer-row[data-path="示例 图.png"]'),'image in file tree');
      const workspace=await(await fetch('/api/workspace')).json();
      const calls=window.imageCalls=[],originalFetch=window.fetch;window.fetch=(input,init)=>{calls.push({url:String(input),body:init?.body,method:init?.method});const response=originalFetch(input,init);if(window.holdImageDelete&&String(input).endsWith('/api/explorer')&&JSON.parse(init?.body||'{}').action==='trash')return response.then(value=>new Promise(resolve=>{window.releaseImageDelete=()=>resolve(value);}));return response;};
      get('.explorer-row[data-path="整合验收.md"]').click();await wait(()=>get('.active-editor .cm-content')?.textContent.includes('整合验收'),'markdown');
      const EditorView={findFromDOM:dom=>(dom.querySelector('.cm-content')?.cmTile||dom.cmTile)?.root?.view||null};let originalView=EditorView.findFromDOM(get('.active-editor .cm-editor'));
      check('integration fixture has real CodeMirror view',!!originalView);const before=originalView.state.doc.toString();originalView.dispatch({changes:{from:before.length,insert:'\\n保留的未保存正文'},userEvent:'input.type'});await pause();const dirtyState=originalView.state;
      get('.explorer-row[data-path="示例 图.png"]').click();await wait(()=>get('.active-editor .image-file-view img')?.naturalWidth>0,'direct image');
      check('image opens as a read-only main-area viewer',!get('.active-editor .cm-editor')&&get('.active-editor .image-file-heading').textContent.includes('PNG'));
      check('image opening preserves dirty Markdown state and undo history',originalView.state===dirtyState&&document.querySelector('[data-panel-id="editor"] .dirty-dot'));
      window.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'s',ctrlKey:true}));await pause();check('saving active image never writes Markdown or binary content',!calls.some(call=>call.method==='POST'&&call.url.endsWith('/api/file')));
      [...document.querySelectorAll('.ribbon-tabs button')].find(b=>b.textContent==='视图')?.click();await pause();await wait(()=>get('.view-controls'),'view controls');
      [...get('.view-controls').querySelectorAll('button')].find(b=>b.textContent.includes('保存为新视图')).click();await wait(()=>get('[aria-label="保存当前视图"]'),'save view');get('[aria-label="保存当前视图"] form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(()=>!get('[aria-label="保存当前视图"]'),'view saved');
      const stored=JSON.parse(localStorage.getItem('hive.views.v1:'+workspace.id));check('image descriptor persists separately from text baselines',stored.views[0].editors.some(e=>e.imagePath==='示例 图.png'&&e.file===null));
      const closeImage=()=>{const id=get('.active-editor').dataset.panelId,tab=[...document.querySelectorAll('[data-panel-tab]')].find(n=>n.dataset.panelTab===id);(tab?.closest('.workspace-tab-item')?.querySelector('.document-tab-close')||get('.active-editor .document-tab-close')).click();};
      closeImage();await wait(()=>!get('.active-editor .image-file-view'),'close image');check('closing image returns to the retained unsaved manuscript',originalView.state===dirtyState&&originalView.state.doc.toString().endsWith('保留的未保存正文'));
      [...get('.view-controls').querySelectorAll('button')].find(b=>b.textContent.includes('应用视图')).click();await wait(()=>get('.active-editor .image-file-view img')?.naturalWidth>0,'restore image tab');check('saved view restores image without replacing dirty Markdown',originalView.state===dirtyState);
      closeImage();await wait(()=>get('.active-editor .cm-editor'),'return markdown');originalView=EditorView.findFromDOM(get('.active-editor .cm-editor'));originalView.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'z',code:'KeyZ',ctrlKey:true}));await pause();check('Markdown undo remains usable after image open close and view restore',originalView.state.doc.toString()===before);
      originalView.dispatch({changes:{from:before.length,insert:'\\n保存验证'},userEvent:'input.type'});await pause();window.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'s',ctrlKey:true}));await pause();check('text can still save after image lifecycle',calls.some(call=>call.method==='POST'&&call.url.endsWith('/api/file')&&JSON.parse(call.body).path==='整合验收.md'));
      const image=await originalFetch('/api/image-file?workspace='+workspace.id+'&path='+encodeURIComponent('示例 图.png'));check('binary image remains intact and decodes after text save',image.ok&&image.headers.get('content-type').includes('image/png'));
      get('.explorer-row[data-path="示例 图.png"]').click();await wait(()=>get('.active-editor .image-file-view img')?.naturalWidth>0,'image for all-session save');
      originalView.dispatch({changes:{from:originalView.state.doc.length,insert:'ALL_SESSION_SAVE'},userEvent:'input.type'});const saveBefore=calls.filter(call=>call.method==='POST'&&call.url.endsWith('/api/file')).length;
      get('[aria-label="自动保存正文"]').click();await wait(()=>calls.filter(call=>call.method==='POST'&&call.url.endsWith('/api/file')).length>saveBefore,'all-session autosave');await pause();check('all-session autosave saves dirty Markdown while active image remains read-only',!calls.some(call=>call.method==='POST'&&call.url.endsWith('/api/file')&&JSON.parse(call.body).path.endsWith('.png'))&&get('.active-editor .image-file-view img').naturalWidth>0);
      get('[aria-label="自动保存正文"]').click();await pause();document.querySelector('[data-panel-tab="editor"]').click();await wait(()=>get('.active-editor .cm-editor'),'composition manuscript');originalView=EditorView.findFromDOM(get('.active-editor .cm-editor'));originalView.dispatch({changes:{from:originalView.state.doc.length,insert:'COMPOSING_DRAFT_RETAINED'},userEvent:'input.type'});await pause();const composingState=originalView.state,imagePanelId=[...document.querySelectorAll('.document-pane')].find(panel=>panel.querySelector('.image-file-view')).dataset.panelId;window.holdImageDelete=true;const imageRow=get('.explorer-row[data-path="示例 图.png"]');imageRow.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:80,clientY:220}));await wait(()=>get('.explorer-menu'),'image file menu');[...get('.explorer-menu').querySelectorAll('button')].find(b=>b.textContent.includes('删除到回收站')).click();await wait(()=>get('dialog[aria-label="删除到回收站"]'),'image trash confirmation');[...get('dialog[aria-label="删除到回收站"]').querySelectorAll('button')].find(b=>b.textContent==='移到回收站').click();await wait(()=>window.releaseImageDelete,'pending image delete');originalView.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));document.querySelector('[data-panel-tab=\"editor\"]').closest('.workspace-tab-item').querySelector('.document-tab-close').click();await pause();check('real composition guard blocks manuscript close before delayed trash response',originalView.dom.isConnected&&!!document.querySelector('[data-panel-tab=\"editor\"]')&&document.body.textContent.includes('请先完成当前输入法组词，再关闭标签页'));window.releaseImageDelete();await wait(()=>!get('.explorer-row[data-path="示例 图.png"]'),'image trashed');await pause();
      const retainedTab=[...document.querySelectorAll('[data-panel-tab]')].find(tab=>tab.dataset.panelTab===imagePanelId);check('composition keeps the image tab open instead of only leaving hidden DOM',!!retainedTab);retainedTab.click();await pause();check('blocked image close during another panel composition produces a clean landing tab',get('.active-editor')?.dataset.panelId===imagePanelId&&get('.active-editor').getClientRects().length>0&&!!get('[data-panel-id=\"'+imagePanelId+'\"] .document-new-page')&&!get('[data-panel-id=\"'+imagePanelId+'\"] .dirty-dot')&&!get('[data-panel-id=\"'+imagePanelId+'\"] .image-file-view'));
      check('composing manuscript state and unsaved content survive image deletion',originalView.state.doc===composingState.doc&&originalView.state.doc.toString().endsWith('COMPOSING_DRAFT_RETAINED'));
      originalView.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));await pause();originalView.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'z',code:'KeyZ',ctrlKey:true}));await pause();check('composing manuscript undo remains valid after delayed image deletion',originalView.state.doc.toString().endsWith('ALL_SESSION_SAVE'));
      check('images never request a Markdown writing outline',!calls.some(call=>(call.url.includes('/writing-outline')||call.url.includes('/outline?'))&&decodeURIComponent(call.url).includes('.png')));const build=await(await fetch('/build-info.json')).json();return {checks,build};
    })()`);
    assert.deepEqual(errors,[],'Renderer console errors');await fs.writeFile(path.join(output,prefix+'-app-preview.png'),(await win.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(output,prefix+'-app-validation.json'),JSON.stringify({passed:true,method:'Hidden nonfocusable Electron, complete frozen integrated frontend and isolated real backend; synthetic DOM events, no desktop input.',...result,consoleErrors:errors,devWarnings},null,2)+'\n');console.log(JSON.stringify({passed:true,checks:result.checks.length,build:result.build}));win.destroy();app.exit(0);
  }catch(error){console.error(JSON.stringify(await win.webContents.executeJavaScript(`({calls:window.imageCalls,autoSave:document.querySelector('[aria-label="自动保存正文"]')?.checked})`)));await fs.writeFile(path.join(output,prefix+'-app-failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error.stack);win.destroy();app.exit(1);}
}
if(process.argv.includes('--integrated-worker'))void worker().catch(error=>{console.error(error.stack);require('electron').app.exit(1);});
else{
  await fs.mkdir(output,{recursive:true});const temp=await fs.mkdtemp(path.join(output,'.app-check-'));let server,serverLog='';
  try{
    const docs=path.join(temp,'documents');await fs.mkdir(path.join(docs,'章节'),{recursive:true});
    await fs.writeFile(path.join(docs,'章节/一.md'),'内部验证文稿。');
    await fs.writeFile(path.join(docs,'删除当前.md'),'删除当前唯一内容。');await fs.writeFile(path.join(docs,'删除其他.md'),'删除其他唯一内容。');await fs.mkdir(path.join(docs,'删除文件夹'));await fs.writeFile(path.join(docs,'删除文件夹/子稿.md'),'后代删除唯一内容。');
    await fs.writeFile(path.join(docs,'示例 图.png'),fixtureImage);
    const paragraph='这是用于整合验证的中文与 English mixed text，数字 12345、标点和很长的网址 https://example.org/research/2026/notes?language=English&version=12345 都保持原文。';
    await fs.writeFile(path.join(docs,'整合验收.md'),'# 整合验收\n\n> **最终入口：** '+paragraph.repeat(2)+'\n\n![[示例 图.png]]\n\n- [ ] 整合待办\n\n| 标题甲 | 标题乙 |\n| :--- | ---: |\n| 内容甲 | 内容乙 |\n\n这是本轮合成资料，不含用户文稿。\n');
    const resources=packaged?path.join(bundle,'win-unpacked','resources'):undefined;
    server=launchBackend({root:project,resources,env:{HIVE_PORT:'0',HIVE_DOCUMENTS:docs,HIVE_STATE_DIR:path.join(temp,'state'),HIVE_API_KEY:''},onLine:line=>serverLog+=line+'\n',onError:line=>serverLog+=line});
    const backend=await server.ready;
    const dev=development?await devFrontend(project,backend.port,0):undefined;
    if(dev){const stop=server.stop;server.stop=()=>Promise.all([dev.close(),stop()]);}
    const port=dev?.port??backend.port;
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn((await import('electron')).default,[fileURLToPath(import.meta.url),'--integrated-worker',...(packaged?['--package']:[]),...(development?['--dev']:[]),String(port),temp],{cwd:project,windowsHide:true,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Integrated UI timeout'));},45000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});await fs.writeFile(path.join(output,prefix+'-app.log'),log);console.log(log);assert.equal(code,0);
  }finally{await fs.writeFile(path.join(output,prefix+'-server.log'),serverLog);await server?.stop();const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(output));assert.ok(path.basename(resolved).startsWith('.app-check-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
