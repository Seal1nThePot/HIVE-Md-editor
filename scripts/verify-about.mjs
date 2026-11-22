import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {fork,spawn} from 'node:child_process';

const project=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(project,'delivery/about-20261118');
const require=createRequire(import.meta.url);

async function worker(base,temporary){
  const {app,BrowserWindow,ipcMain,session}=require('electron');
  app.setPath('userData',path.join(temporary,'profile'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  // Permit only the isolated local server so expanded documents cannot depend on Internet access.
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith(base+'/')&&!details.url.startsWith('devtools:')}));
  const makeWindow=(preload)=>new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1280,height:900,webPreferences:{...(preload?{preload}:{}),offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  const window=makeWindow();
  const errors=[];
  window.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)errors.push(event.message);});
  let ipcWindow;
  try {
    await window.loadURL(base);
    const manifest=JSON.parse(await fs.readFile(path.join(project,'dist/build-info.json'),'utf8'));
    // UI checks are defined below once the about page is available.
    const ui=await validateUI(window,manifest);
    await fs.writeFile(path.join(output,'about-wide.png'),(await window.webContents.capturePage()).toPNG());
    await window.setSize(450,800);
    const narrow=await window.webContents.executeJavaScript(`(async()=>{await new Promise(r=>setTimeout(r,150));const panel=document.querySelector('.settings-floating');panel.style.left='0px';panel.style.width='450px';await new Promise(r=>setTimeout(r,150));const page=document.querySelector('.settings-page');const content=document.querySelector('.settings-content');const measure=()=>({viewport:innerWidth,panelWidth:panel.getBoundingClientRect().width,pageWidth:page.clientWidth,pageScroll:page.scrollWidth,contentWidth:content.clientWidth,contentScroll:content.scrollWidth});const first=measure();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {...measure(),stableAfterTwoFrames:JSON.stringify(first)===JSON.stringify(measure())};})()`);
    assert.equal(narrow.stableAfterTwoFrames,true,'Narrow layout dimensions change across two frames');
    assert.ok(narrow.panelWidth<=narrow.viewport+1,'Narrow panel exceeds viewport');
    assert.ok(narrow.pageScroll<=narrow.pageWidth+1,'Narrow settings page overflows');
    assert.ok(narrow.contentScroll<=narrow.contentWidth+1,'Narrow about content overflows');
    await fs.writeFile(path.join(output,'about-narrow.png'),(await window.webContents.capturePage()).toPNG());
    const {createAboutHandlers}=require(path.join(project,'desktop/about.cjs'));
    const calls=[];
    ipcWindow=makeWindow(path.join(project,'desktop/preload.cjs'));
    ipcMain.on('hive:preferences-read',event=>{event.returnValue=null;});
    const handlers=createAboutHandlers({isMainOrigin:event=>event.sender===ipcWindow.webContents&&event.senderFrame?.url.startsWith(base+'/'),app,shell:{openPath:async target=>{calls.push(target);return '';}},root:project,versions:process.versions,platform:process.platform,arch:process.arch,development:false});
    ipcMain.handle('hive:about-info',handlers.getAboutInfo);
    ipcMain.handle('hive:open-app-data-directory',handlers.openAppDataDirectory);
    await ipcWindow.loadURL(base);
    const info=await ipcWindow.webContents.executeJavaScript('window.hiveDesktop.getAboutInfo()');
    for(const key of ['appName','version','buildNumber','buildTime','channel'])assert.equal(info[key],manifest[key],`IPC ${key} matches manifest`);
    assert.equal(info.runtime.mode,'desktop-development');
    assert.equal(info.runtime.packaged,false);
    await ipcWindow.webContents.executeJavaScript('window.hiveDesktop.openAppDataDirectory()');
    assert.deepEqual(calls,[app.getPath('userData')]);
    const resizeNotifications=errors.filter(message=>message==='ResizeObserver loop completed with undelivered notifications.');
    const otherErrors=errors.filter(message=>message!=='ResizeObserver loop completed with undelivered notifications.');
    assert.equal(otherErrors.length,0,otherErrors.join('\n'));
    const report={passed:true,checkedAt:new Date().toISOString(),method:'Production browser build with isolated real backend; hidden nonfocusable offscreen Electron; DOM events only. Production sandbox preload and IPC factory use a shell stub; no OS open or real desktop input.',manifest,ui,narrow,ipc:{metadataMatchesManifest:true,desktopRuntime:info.runtime,directoryTargetMatchesUserData:true,shellStub:true},consoleErrors:errors,resizeNotifications};
    await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:true,checks:ui.checks.length,ipc:true,narrow}));
    ipcWindow.destroy();window.destroy();app.exit(0);
  }catch(error){console.error(error.stack);try{await fs.writeFile(path.join(output,'failure.png'),(await window.webContents.capturePage()).toPNG());}catch{}if(ipcWindow&&!ipcWindow.isDestroyed())ipcWindow.destroy();window.destroy();app.exit(1);}
}

async function validateUI(window,manifest){
  return window.webContents.executeJavaScript(`(async()=>{
    const checks=[];
    const check=(label,value)=>{checks.push({label,passed:!!value});if(!value)throw new Error(label);};
    const wait=async(test,label)=>{for(let i=0;i<150;i++){if(test())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+label);};
    const get=selector=>document.querySelector(selector);
    const button=(scope,text)=>[...scope.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
    const click=(scope,text)=>{const el=button(scope,text);if(!el)throw new Error('Missing button '+text);el.click();};
    await wait(()=>get('.explorer-row[data-path="canary.md"]'),'canary file');
    get('.explorer-row[data-path="canary.md"]').click();
    await wait(()=>get('.document-pane .cm-content')?.textContent.includes('HIVE_WRITING_CANARY_28c7'),'open canary document');
    get('button[aria-label="设置"]').click();await wait(()=>get('.settings-page'),'settings');
    const search=get('[aria-label="搜索设置"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'诊断');search.dispatchEvent(new Event('input',{bubbles:true}));
    check('diagnostic keyword finds about category',!!button(get('.settings-sidebar nav'),'关于'));
    click(get('.settings-sidebar nav'),'关于');await wait(()=>get('.about-settings'),'about');
    check('category search resets after navigation',search.value===''&&!!button(get('.settings-sidebar nav'),'界面'));
    const metadata=get('.about-metadata');
    const values=Object.fromEntries([...metadata.querySelectorAll('dl div')].map(row=>[row.querySelector('dt').textContent,row.querySelector('dd').textContent]));
    const manifest=${JSON.stringify(manifest)};
    check('browser fallback identifies production browser build',metadata.textContent.includes('浏览器本地构建'));
    const displayVersion=${JSON.stringify(manifest.version.replace(/^(\d+\.\d+\.\d+)-r(\d+)$/, '$1r$2'))};
    check('visible build metadata matches manifest',metadata.querySelector('h2').textContent===manifest.appName&&values['版本']===displayVersion&&values['构建编号']===manifest.buildNumber&&values['构建时间（UTC）']===manifest.buildTime&&values['发行渠道']===manifest.channel);
    check('no update check button',[...get('.about-settings').querySelectorAll('button')].every(el=>!el.textContent.includes('检查更新')));
    const docs=[...get('.about-documents').querySelectorAll('details')];
    check('three local documents available',docs.length===3&&docs.every(el=>el.querySelector('pre')?.textContent.trim().length>100));
    docs.forEach(el=>el.open=true);
    check('offline documents expand as text',docs.every(el=>el.open&&el.querySelector('pre')));
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedDiagnostic=value;}}});
    const preview=()=>get('[aria-label="诊断信息预览"]').textContent;
    click(get('.about-diagnostics'),'复制诊断信息');await wait(()=>get('.about-feedback')?.textContent.includes('已复制'),'copy success');
    check('copy equals visible preview exactly',window.copiedDiagnostic===preview());
    const browser=JSON.parse(preview());
    check('diagnostic excludes writing, key and path canaries',!['HIVE_WRITING_CANARY_28c7','HIVE_KEY_CANARY_28c7','canary.md'].some(value=>preview().includes(value)));
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied');}}});
    click(get('.about-diagnostics'),'复制诊断信息');await wait(()=>get('.about-feedback')?.textContent.includes('复制失败'),'copy failure');
    check('clipboard rejection reports failure',get('.about-feedback').textContent.includes('复制失败'));
    click(get('.settings-sidebar nav'),'界面');await wait(()=>!get('.about-settings'),'leave about');
    window.hiveDesktop={isDesktop:true,getAboutInfo:async()=>{throw new Error('C:/SECRET_CANARY_28c7');},openAppDataDirectory:async()=>{throw new Error('fail');}};
    click(get('.settings-sidebar nav'),'关于');await wait(()=>get('.about-metadata [role="alert"]'),'bridge failure');
    check('desktop bridge failure states fallback without exposing error',get('.about-metadata [role="alert"]').textContent.includes('无法读取')&&!get('.about-settings').textContent.includes('SECRET_CANARY_28c7')&&JSON.parse(preview()).runtime===null&&JSON.parse(preview()).metadataSource==='renderer-build-fallback');
    click(get('.settings-sidebar nav'),'界面');await wait(()=>!get('.about-settings'),'leave failed bridge');
    window.hiveDesktop.getAboutInfo=async()=>({...manifest,buildNumber:'unavailable',buildTime:'unavailable',channel:'unavailable',runtime:{mode:'desktop-package',platform:'win32',arch:'x64',packaged:true}});
    click(get('.settings-sidebar nav'),'关于');await wait(()=>get('.about-metadata [role="status"]')?.textContent.includes('构建记录缺失'),'missing build notice');
    check('missing packaged build record is visibly identified',get('.about-metadata [role="status"]').textContent.includes('无法确认')&&get('.about-metadata').textContent.includes('未记录'));
    click(get('.settings-sidebar nav'),'界面');await wait(()=>!get('.about-settings'),'leave missing build');
    window.hiveDesktop.getAboutInfo=async()=>({...manifest,runtime:{mode:'desktop-development',platform:'win32',arch:'x64',packaged:false,chat:'HIVE_CHAT_CANARY_28c7',key:'HIVE_KEY_CANARY_28c7',path:'C:/SECRET_CANARY_28c7'},writing:'HIVE_WRITING_CANARY_28c7'});
    click(get('.settings-sidebar nav'),'关于');await wait(()=>get('.about-mode')?.textContent.includes('桌面开发运行'),'desktop info');
    check('unexpected bridge data excluded from preview',!['HIVE_CHAT_CANARY_28c7','HIVE_KEY_CANARY_28c7','SECRET_CANARY_28c7','HIVE_WRITING_CANARY_28c7'].some(value=>preview().includes(value)));
    click(get('.about-diagnostics'),'打开应用数据目录');await wait(()=>get('.about-feedback')?.textContent.includes('无法打开'),'directory failure');
    check('directory failure reports feedback',get('.about-feedback').textContent.includes('无法打开'));
    delete window.hiveDesktop;
    get('button[aria-label="关闭设置"]').click();await wait(()=>!get('.settings-page'),'close settings');
    check('closing settings preserves document session',get('.document-pane .cm-content')?.textContent.includes('HIVE_WRITING_CANARY_28c7'));
    get('button[aria-label="设置"]').click();await wait(()=>get('.settings-page'),'reopen settings');click(get('.settings-sidebar nav'),'关于');await wait(()=>get('.about-settings'),'reopen about');
    return {checks,browserDiagnostic:browser,documents:docs.map(el=>el.querySelector('summary').textContent)};
  })()`);
}

if(process.argv.includes('--about-worker'))void worker('http://127.0.0.1:'+process.argv.at(-2),process.argv.at(-1)).catch(error=>{console.error(error.stack);require('electron').app.exit(1);});
else {
  await fs.mkdir(output,{recursive:true});
  const temporary=await fs.mkdtemp(path.join(output,'.about-check-'));
  let server;
  try {
    const root=path.join(temporary,'documents'),state=path.join(temporary,'state');
    await fs.mkdir(root,{recursive:true});
    await fs.writeFile(path.join(root,'canary.md'),'HIVE_WRITING_CANARY_28c7');
    server=fork(path.join(project,'server/index.mjs'),['--production'],{cwd:project,silent:true,windowsHide:true,env:{...process.env,HIVE_PORT:'0',HIVE_DOCUMENTS:root,HIVE_STATE_DIR:state,HIVE_API_KEY:'HIVE_KEY_CANARY_28c7'}});
    let serverLog='';server.stdout.on('data',data=>serverLog+=data);server.stderr.on('data',data=>serverLog+=data);
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timeout')),15000);server.once('error',error=>{clearTimeout(timer);reject(error);});server.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code));});server.on('message',message=>{if(message?.type==='hive-ready'){clearTimeout(timer);resolve(message.port);}});});
    const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
    const child=spawn((await import('electron')).default,[fileURLToPath(import.meta.url),'--about-worker',String(port),temporary],{cwd:project,windowsHide:true,env:environment,stdio:['ignore','pipe','pipe']});
    let log='';child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('UI validation timeout'));},60000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
    await fs.writeFile(path.join(output,'validation.log'),log);await fs.writeFile(path.join(output,'server.log'),serverLog);
    console.log(log);assert.equal(code,0,'About validation failed');
    assert.equal(await fs.readFile(path.join(root,'canary.md'),'utf8'),'HIVE_WRITING_CANARY_28c7');
  }finally{
    if(server&&server.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill();});
    const resolved=path.resolve(temporary);assert.equal(path.dirname(resolved),path.resolve(output));assert.ok(path.basename(resolved).startsWith('.about-check-'));
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
