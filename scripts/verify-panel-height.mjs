import assert from 'node:assert/strict';
import {fixtureImage} from './fixture-image.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {launchBackend,workspaceBuildPaths} from '../desktop/backendProcess.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const pkg=JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8'));
const paths=workspaceBuildPaths(project);
const output=path.resolve(process.env.HIVE_VERIFY_OUTPUT||path.join(paths.work,'evidence','ui'));
const packaged=process.argv.includes('--package'),bundle=path.resolve(process.env.HIVE_VERIFY_BUNDLE||paths.release),prefix=packaged?'packaged':'source';
async function worker(){
  const {app,BrowserWindow}=require('electron');app.setPath('userData',path.join(process.argv.at(-1),'profile'));app.disableHardwareAcceleration();await app.whenReady();
  const win=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1600,height:1050,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'||e.level===3)errors.push(e.message);});
  try{
    await win.loadURL('http://127.0.0.1:'+process.argv.at(-2));
    if(!process.env.HIVE_PANEL_SKIP_CSS){const css=await fs.readFile(path.join(project,'src/app/styles.css'),'utf8');await win.webContents.insertCSS(css.slice(css.indexOf('/* Preserve a reachable scroll area')));}
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const get=s=>document.querySelector(s),pause=()=>new Promise(r=>setTimeout(r,150));
      const wait=async(fn,label)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timeout '+label);};
      await wait(()=>get('.explorer-row[data-path="整合验收.md"]'),'fixture');get('.explorer-row[data-path="整合验收.md"]').click();await pause();
      const items=[['files','文档（文件列表）'],['editor','整合验收'],['conversation','对话'],['trash','回收站'],['annotations','标注'],['outline','大纲'],['properties','笔记属性'],['toc','标题目录'],['scratch','草稿'],['basis','依据'],['search','查找替换'],['repositories','仓库管理']];
      const measurements=[];
      for(const [id,label] of items){
        get('[aria-label="面板"]').click();await wait(()=>get('.panel-manager'),'manager');
        const row=[...document.querySelectorAll('.panel-manager-row')].find(x=>x.querySelector('.panel-manager-reveal span')?.textContent.startsWith(label));
        if(!row){measurements.push({id,error:'missing manager row'});get('.panel-manager-close')?.click();await pause();continue;}
        row.querySelector('.panel-manager-reveal').click();await pause();
        const panel=get('[data-panel-id="'+id+'"]');if(!panel){measurements.push({id,error:'missing panel'});continue;}
        if(id==='properties'){panel.querySelector('.property-add')?.click();await pause();}
        if(id==='basis'){panel.querySelector('.reference-heading button')?.click();await pause();[...panel.querySelectorAll('.reference-picker-list button')].find(b=>b.textContent.includes('这是一个很长'))?.click();await pause();}
        const original=panel.getAttribute('style');
        for(const height of [400,160,100]){
          panel.style.setProperty('width','320px','important');panel.style.setProperty('height',height+'px','important');panel.style.setProperty('left','20px','important');panel.style.setProperty('top','20px','important');panel.style.setProperty('z-index','9999','important');await pause();
          const rect=panel.getBoundingClientRect(),controls=[...panel.querySelectorAll('button,input,select,textarea')].filter(x=>{const r=x.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(x).visibility!=='hidden'});
          const clipped=controls.filter(x=>{const r=x.getBoundingClientRect();return r.top<rect.top-1||r.bottom>rect.bottom+1}).map(x=>({label:x.getAttribute('aria-label')||x.textContent.trim().slice(0,30)||x.tagName,scrollCheck:(()=>{let n=x.parentElement,scrolled=[];while(n){if(n.scrollHeight>n.clientHeight&&['auto','scroll'].includes(getComputedStyle(n).overflowY)){const previous=n.scrollTop,before=x.getBoundingClientRect(),viewport=n.getBoundingClientRect();n.scrollTop+=(before.top+before.bottom-viewport.top-viewport.bottom)/2;scrolled.push([n,previous]);}if(n===panel)break;n=n.parentElement;}const a=x.getBoundingClientRect(),b=panel.getBoundingClientRect(),reachable=a.top>=b.top-1&&a.bottom<=b.bottom+1;scrolled.reverse().forEach(([node,value])=>node.scrollTop=value);return {reachable,containers:scrolled.map(([node])=>node.className)};})()}));
          measurements.push({id,width:Math.round(rect.width),height:Math.round(rect.height),controlCount:controls.length,panelScrollHeight:panel.scrollHeight,panelClientHeight:panel.clientHeight,clipped});
        }
        if(original===null)panel.removeAttribute('style');else panel.setAttribute('style',original);
      }
      return {measurements};
    })()`);
    await fs.writeFile(path.join(output,prefix+'-app-preview.png'),(await win.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(output,prefix+'-panel-height.json'),JSON.stringify({completed:true,method:'Hidden nonfocusable Electron, complete frozen integrated frontend and isolated real backend; synthetic DOM events, no desktop input.',...result,consoleErrors:errors},null,2)+'\n');console.log(JSON.stringify({completed:true,measurements:result.measurements}));win.destroy();app.exit(0);
  }catch(error){await fs.writeFile(path.join(output,prefix+'-app-failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error.stack);win.destroy();app.exit(1);}
}
if(process.argv.includes('--integrated-worker'))void worker().catch(error=>{console.error(error.stack);require('electron').app.exit(1);});
else{
  await fs.mkdir(output,{recursive:true});const temp=await fs.mkdtemp(path.join(output,'.app-check-'));let server,serverLog='';
  try{
    const docs=path.join(temp,'documents');await fs.mkdir(path.join(docs,'章节'),{recursive:true});
    await fs.writeFile(path.join(docs,'章节/一.md'),'内部验证文稿。');await fs.writeFile(path.join(docs,'这是一个很长的中文文件名称用于验证依据面板在狭窄尺寸的显示效果.md'),'示例');
    await fs.writeFile(path.join(docs,'删除当前.md'),'删除当前唯一内容。');await fs.writeFile(path.join(docs,'删除其他.md'),'删除其他唯一内容。');await fs.mkdir(path.join(docs,'删除文件夹'));await fs.writeFile(path.join(docs,'删除文件夹/子稿.md'),'后代删除唯一内容。');
    await fs.writeFile(path.join(docs,'示例 图.png'),fixtureImage);
    const paragraph='这是用于整合验证的中文与 English mixed text，数字 12345、标点和很长的网址 https://example.org/research/2026/notes?language=English&version=12345 都保持原文。';
    await fs.writeFile(path.join(docs,'整合验收.md'),'---\n类型: 示例属性\n---\n# 整合验收\n\n普通 Regular **加粗 Bold** *斜体 Italic*\n\n> **最终入口：** '+paragraph.repeat(2)+'\n\n![[示例 图.png]]\n\n- [ ] 整合待办\n\n| 标题甲 | 标题乙 |\n| :--- | ---: |\n| 内容甲 | 内容乙 |\n\n这是本轮合成资料，不含用户文稿。\n');
    const resources=packaged?path.join(bundle,'win-unpacked','resources'):undefined;
    server=launchBackend({root:project,resources,env:{HIVE_PORT:'0',HIVE_DOCUMENTS:docs,HIVE_STATE_DIR:path.join(temp,'state'),HIVE_API_KEY:''},onLine:line=>serverLog+=line+'\n',onError:line=>serverLog+=line});
    const backend=await server.ready;
    const {port}=backend;
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn((await import('electron')).default,[fileURLToPath(import.meta.url),...(packaged?['--package']:[]),'--integrated-worker',String(port),temp],{cwd:project,windowsHide:true,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Integrated UI timeout'));},45000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});await fs.writeFile(path.join(output,prefix+'-app.log'),log);console.log(log);assert.equal(code,0);
  }finally{await fs.writeFile(path.join(output,prefix+'-server.log'),serverLog);await server?.stop();const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(output));assert.ok(path.basename(resolved).startsWith('.app-check-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
