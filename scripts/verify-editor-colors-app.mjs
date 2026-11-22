import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {fork,spawn} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'delivery/editor-colors-20261118'),require=createRequire(import.meta.url);

async function worker(){
  const {app,BrowserWindow}=require('electron');app.setPath('userData',path.join(process.argv.at(-1),'profile'));app.disableHardwareAcceleration();await app.whenReady();
  const win=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1600,height:1050,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  try{
    await win.loadURL('http://127.0.0.1:'+process.argv.at(-2));
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const checks=[],get=s=>document.querySelector(s),pause=()=>new Promise(r=>setTimeout(r,250));
      const check=(label,value)=>{checks.push({label,passed:!!value});if(!value)throw new Error(label);};
      const wait=async(fn,label)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Timeout '+label);};
      await wait(()=>get('.explorer-row[data-path="配色验收.md"]'),'explorer');get('.explorer-row[data-path="配色验收.md"]').click();await wait(()=>get('.document-pane .cm-content')?.textContent.includes('隔离测试文稿'),'document');
      get('[aria-label="设置"]').click();await wait(()=>get('.settings-page'),'settings');[...document.querySelectorAll('[aria-label="设置分类"] button')].find(b=>b.textContent==='外观').click();await wait(()=>get('.theme-settings'),'appearance settings');
      const button=(text,scope=document)=>[...scope.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
      async function openColors(){
        const entry=[...document.querySelectorAll('.theme-settings button')].find(b=>b.textContent.includes('进入自定义配色'));
        entry.click();await wait(()=>get('.editor-color-settings'),'editor color section');
        const section=get('.editor-color-settings');const group=section.closest('details');if(group)group.open=true;
      }
      async function closeColors(){
        (get('[aria-label="关闭自定义配色"]')||get('.theme-back')).click();
        await wait(()=>!get('.editor-color-settings'),'color settings close');
      }
      await openColors();await pause();
      check('complete app has dedicated editor color section',get('#editor-colors-title').textContent==='文本编辑页面');
      check('complete app exposes 17 colors and 10 alpha controls',get('.editor-color-settings').querySelectorAll('input[type=color]').length===17&&get('.editor-color-settings').querySelectorAll('input[type=range]').length===10);
      const set=(label,value)=>{const node=get('[aria-label="'+label+'颜色值"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));};
      const css=(node,property,pseudo)=>getComputedStyle(node,pseudo).getPropertyValue(property);
      const beforeSelection=css(document.documentElement,'--hive-selection-bg').trim();
      set('页面背景','#203047');set('正文文字','#dae6f8');set('选区底色','#bc6de577');set('选区线框','#4433ccbb');set('选中文字颜色','#102030');set('失去焦点的选区','#75b8d955');set('当前行高亮','#efba3233');set('输入光标','#ee7799');set('搜索结果高亮','#33bb8855');set('当前搜索结果','#e9923377');set('文本标注底色','#4477bb55');set('文本标注边框','#66ccdd');await pause();
      check('page background changes immediately',css(get('.document-pane'),'background-color')==='rgb(32, 48, 71)');
      check('document text changes immediately',css(get('.document-pane .cm-line'),'color')==='rgb(218, 230, 248)');
      check('selection alpha is independent of interface selection',css(document.documentElement,'--hive-editor-selection-background').trim()==='#bc6de577'&&css(document.documentElement,'--hive-selection-bg').trim()===beforeSelection);
      check('native selection text uses editor color',css(get('.document-pane .cm-line'),'color','::selection')==='rgb(16, 32, 48)');
      check('native selection background avoids double alpha',css(get('.document-pane .cm-line'),'background-color','::selection')==='rgba(0, 0, 0, 0)');
      check('search and annotation colors update',css(document.documentElement,'--hive-editor-search-match-background').trim()==='#33bb8855'&&css(document.documentElement,'--hive-editor-annotation-underline').trim()==='#66ccdd');
      await closeColors();button('设为默认').click();
      await openColors();set('选区底色','#abcdef44');await pause();await closeColors();
      button('恢复默认').click();await pause();check('restoring personal default restores editor colors',css(document.documentElement,'--hive-editor-selection-background').trim()==='#bc6de577');
      await openColors();
      const stored=JSON.parse(localStorage.getItem('hive.theme.v1'));check('editor colors persist under current base',stored.editorProfiles[stored.base].selectionBackground==='#bc6de577'&&stored.editorProfiles[stored.base].selectionBorder==='#4433ccbb');
      get('.editor-color-settings').scrollIntoView({block:'start'});await pause();
      check('color group has no horizontal overflow',get('.editor-color-settings').scrollWidth<=get('.editor-color-settings').clientWidth+1);
      return {checks,base:stored.base};
    })()`);
    await fs.writeFile(path.join(out,'app-preview.png'),(await win.webContents.capturePage()).toPNG());
    const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.reload();await loaded;
    const reload=await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<150;i++){if(document.documentElement.style.getPropertyValue('--hive-editor-selection-background')==='#bc6de577')return true;await new Promise(r=>setTimeout(r,30));}return false;})()`);assert.equal(reload,true,'reloaded editor colors');result.checks.push({label:'complete app reload restores editor colors',passed:true});
    await fs.writeFile(path.join(out,'app-validation.json'),JSON.stringify({passed:true,method:'Internal verification only. Hidden nonfocusable Electron, complete production app and isolated real backend; DOM settings input, no desktop input.',...result},null,2)+'\n');console.log(JSON.stringify({passed:true,checks:result.checks.length}));win.destroy();app.exit(0);
  }catch(error){await fs.writeFile(path.join(out,'app-failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error.stack);win.destroy();app.exit(1);}
}
if(process.argv.includes('--editor-colors-app-worker'))void worker().catch(error=>{console.error(error.stack);require('electron').app.exit(1);});
else{
  await fs.mkdir(out,{recursive:true});const temporary=await fs.mkdtemp(path.join(out,'.internal-app-'));let server,serverLog='';
  try{
    const docs=path.join(temporary,'documents');await fs.mkdir(docs);await fs.writeFile(path.join(docs,'配色验收.md'),'# HIVE 0.1.4 编辑页面配色\n\n这是本轮创建的隔离测试文稿。可用来体验选区高亮，不含原用户资料。\n\n搜索结果与文本标注可使用不同的颜色。\n');
    server=fork(path.join(root,'server/index.mjs'),['--production'],{cwd:root,silent:true,windowsHide:true,env:{...process.env,HIVE_PORT:'0',HIVE_DOCUMENTS:docs,HIVE_STATE_DIR:path.join(temporary,'state'),HIVE_API_KEY:''}});server.stdout.on('data',v=>serverLog+=v);server.stderr.on('data',v=>serverLog+=v);
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Backend timeout')),12000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(new Error('Backend exited '+code+' '+serverLog));});server.on('message',m=>{if(m?.type==='hive-ready'){clearTimeout(timer);resolve(m.port);}});});
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn((await import('electron')).default,[fileURLToPath(import.meta.url),'--editor-colors-app-worker',String(port),temporary],{cwd:root,windowsHide:true,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Color app timeout'));},40000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});await fs.writeFile(path.join(out,'app.log'),log);console.log(log);assert.equal(code,0);
  }finally{await fs.writeFile(path.join(out,'app-server.log'),serverLog);if(server&&server.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill();});const resolved=path.resolve(temporary);assert.equal(path.dirname(resolved),path.resolve(out));assert.ok(path.basename(resolved).startsWith('.internal-app-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
