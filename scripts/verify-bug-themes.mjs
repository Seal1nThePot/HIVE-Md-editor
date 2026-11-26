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
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const get=s=>document.querySelector(s),pause=()=>new Promise(r=>setTimeout(r,250)),wait=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await pause();}throw Error('timeout');};
      await wait(()=>get('.explorer-row[data-path="整合验收.md"]'));
      const file='整合验收.md',text=(await(await fetch('/api/file?path='+encodeURIComponent(file))).json()).text,at=text.indexOf('普通 Regular'),original='普通 Regular';const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)),fingerprint=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
      await fetch('/api/annotations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'document',file,revision:0,fingerprint,items:[{id:'one',source:'document',file,from:at,to:at+original.length,original,note:'测试标注颜色',stale:false,createdAt:'2026-11-18T00:00:00Z'}]})});get('.explorer-row[data-path="整合验收.md"]').click();await wait(()=>get('.cm-preview-strong'));
      const style=s=>{let e=get(s),v=e&&getComputedStyle(e);return e?{text:e.textContent,weight:v.fontWeight,style:v.fontStyle,synthesis:v.fontSynthesis,family:v.fontFamily}:null};
      const fold=get('.cm-heading-fold'),line=fold?.closest('.cm-line'),a=fold?.getBoundingClientRect(),b=line?.getBoundingClientRect();
      const result={strong:style('.cm-preview-strong'),italic:style('.cm-preview-emphasis'),tableStrong:style('.cm-table-cell-preview strong'),tableItalic:style('.cm-table-cell-preview em'),code:style('.cm-preview-code-line'),ruleColor:(()=>{const e=get('.cm-preview-rule'),s=e&&getComputedStyle(e);return s?{border:s.borderTopColor,marginLeft:s.marginLeft,marginRight:s.marginRight}:null;})(),fold:a&&b?{buttonCenter:a.top+a.height/2,lineCenter:b.top+b.height/2}:null};
      return result;
    })()`);
    await fs.writeFile(path.join(output,'theme-black-document.png'),(await win.webContents.capturePage()).toPNG());
    result.properties=await win.webContents.executeJavaScript(`(async()=>{const p=()=>new Promise(r=>setTimeout(r,250));document.querySelector('[aria-label="面板"]').click();await p();[...document.querySelectorAll('.panel-manager-reveal')].find(e=>e.textContent.includes('笔记属性')).click();await p();const row=document.querySelector('.note-property-row'),a=row.querySelector('.property-name').getBoundingClientRect(),b=row.querySelector(':scope > textarea,:scope > select,:scope > input').getBoundingClientRect();return {nameBottom:a.bottom,valueTop:b.top};})()`);
    await fs.writeFile(path.join(output,'theme-properties.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭笔记属性面板"]')?.click()`);

    await win.webContents.executeJavaScript(`(async()=>{const p=()=>new Promise(r=>setTimeout(r,300));document.querySelector('[aria-label="面板"]').click();await p();[...document.querySelectorAll('.panel-manager-reveal')].find(e=>e.textContent.includes('标注')).click();await p();})()`);
    await fs.writeFile(path.join(output,'theme-black-annotation.png'),(await win.webContents.capturePage()).toPNG());
    result.white=await win.webContents.executeJavaScript(`(async()=>{const pause=()=>new Promise(r=>setTimeout(r,250));document.querySelector('[aria-label="设置"]').click();await pause();[...document.querySelectorAll('[aria-label="设置分类"] button')].find(x=>x.textContent==='外观')?.click();await pause();const select=document.querySelector('#theme-base');if(!select)return {error:'missing base selector'};select.value='white';select.dispatchEvent(new Event('change',{bubbles:true}));await pause();document.querySelector('[aria-label="关闭设置"]').click();await pause();const e=document.querySelector('.cm-preview-emphasis'),s=document.querySelector('.cm-preview-strong');return {base:select.value,italic:getComputedStyle(e).fontStyle,strong:getComputedStyle(s).fontWeight,color:getComputedStyle(e).color,background:getComputedStyle(e.closest('.cm-editor')).backgroundColor};})()`);
    await fs.writeFile(path.join(output,'theme-white-annotation.png'),(await win.webContents.capturePage()).toPNG());
    result.outline=await win.webContents.executeJavaScript(`(async()=>{const p=()=>new Promise(r=>setTimeout(r,250));for(const label of ['标题目录','大纲']){document.querySelector('[aria-label="面板"]').click();await p();[...document.querySelectorAll('.panel-manager-reveal')].find(e=>e.textContent.includes(label)).click();await p();}const toc=document.querySelector('.toc-heading'),node=document.querySelector('.node-title > button:not(.icon-button)');return {tocFont:toc&&getComputedStyle(toc).fontSize,nodeFont:node&&getComputedStyle(node).fontSize};})()`);
    await fs.writeFile(path.join(output,'theme-outline.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(300,700);await new Promise(resolve=>setTimeout(resolve,500));
    result.model300=await win.webContents.executeJavaScript(`(async()=>{const p=document.querySelector('.model-picker-trigger');if(!p)return {error:'missing trigger'};p.click();await new Promise(r=>setTimeout(r,300));const e=document.querySelector('.model-picker');if(!e)return {error:'picker did not open',disabled:p.disabled};const r=e.getBoundingClientRect();return {viewport:innerWidth,left:r.left,right:r.right,width:r.width,height:r.height,search:!!e.querySelector('input[aria-label="搜索模型"]'),range:!!e.querySelector('input[aria-label="推理强度"]')};})()`);
    await fs.writeFile(path.join(output,'theme-model-300.png'),(await win.webContents.capturePage()).toPNG());

    await fs.writeFile(path.join(output,prefix+'-app-preview.png'),(await win.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(output,prefix+'-themes.json'),JSON.stringify({completed:true,method:'Hidden nonfocusable Electron, complete frozen integrated frontend and isolated real backend; synthetic DOM events, no desktop input.',...result,consoleErrors:errors},null,2)+'\n');console.log(JSON.stringify({completed:true,details:result}));win.destroy();app.exit(0);
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
    await fs.writeFile(path.join(docs,'整合验收.md'),'---\n类型: 示例属性\n---\n# 整合验收\n\n普通 Regular **加粗 Bold** *斜体 Italic*\n\n---\n\n> **最终入口：** '+paragraph.repeat(2)+'\n\n![[示例 图.png]]\n\n- [ ] 整合待办\n\n| 标题甲 | 标题乙 |\n| :--- | ---: |\n| **加粗 Bold** | *斜体 Italic* |\n\n```powershell\nWrite-Output hello\n```\n\n这是本轮合成资料，不含用户文稿。\n');
    const resources=packaged?path.join(bundle,'win-unpacked','resources'):undefined;
    server=launchBackend({root:project,resources,env:{HIVE_PORT:'0',HIVE_DOCUMENTS:docs,HIVE_STATE_DIR:path.join(temp,'state'),HIVE_API_KEY:''},onLine:line=>serverLog+=line+'\n',onError:line=>serverLog+=line});
    const backend=await server.ready;
    const {port}=backend;
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn((await import('electron')).default,[fileURLToPath(import.meta.url),...(packaged?['--package']:[]),'--integrated-worker',String(port),temp],{cwd:project,windowsHide:true,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Integrated UI timeout'));},45000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});await fs.writeFile(path.join(output,prefix+'-app.log'),log);console.log(log);assert.equal(code,0);
  }finally{await fs.writeFile(path.join(output,prefix+'-server.log'),serverLog);await server?.stop();const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(output));assert.ok(path.basename(resolved).startsWith('.app-check-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
