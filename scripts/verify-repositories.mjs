import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {fork,spawn} from 'node:child_process';

const project=fileURLToPath(new URL('../',import.meta.url)),output=path.resolve(process.env.HIVE_REPOSITORY_EVIDENCE||path.join(project,'delivery/repository-picker-20261118'));
const artifactPrefix=process.env.HIVE_REPOSITORY_EXECUTABLE?'packaged-':'';
const require=createRequire(import.meta.url);
async function worker(base,temporary) {
  const {app,BrowserWindow}=require('electron');
  app.setPath('userData',path.join(temporary,'electron-profile'));app.disableHardwareAcceleration();
  await app.whenReady();
  const window=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1280,height:900,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const errors=[];window.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)errors.push(event.message);});
  try {
    await window.loadURL(base);
    const blue=JSON.parse(await fs.readFile(path.join(project,'templates/claude-mediterranean-blue/colors.json'),'utf8'));
    const lightTheme={...blue,base:'white',colors:blue.colorProfiles.white,templateId:'claude-mediterranean-blue'};
    await window.webContents.executeJavaScript(`localStorage.setItem('hive.theme.v1',${JSON.stringify(JSON.stringify(lightTheme))});`);
    const themed=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));window.reload();await themed;
    // Keep browser-mode layout while exercising the desktop chooser result flow.
    // The production preload / IPC boundary is verified separately.
    await window.webContents.executeJavaScript(`(()=>{const noop=()=>{},subscribe=()=>noop;window.repositoryPickerCalls=0;window.repositoryPickerResult=null;window.hiveDesktop={isDesktop:false,platform:'win32',chooseRepositoryDirectory:async()=>{window.repositoryPickerCalls++;return window.repositoryPickerResult;},onCloseRequested:subscribe,onServiceError:subscribe,onPanelCloseRequested:subscribe,onPanelMove:subscribe,windowCommand:noop,finishClose:noop,closePanel:noop,dockOverlay:noop,dockTooltip:noop};})()`);
    if(process.env.HIVE_REPOSITORY_PREVIEW_DEMO==='1') {
      const preview=await window.webContents.executeJavaScript(`(async()=>{
        const wait=async(test)=>{for(let count=0;count<150;count++){if(test())return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('Demo preview timeout');};
        await wait(()=>document.querySelector('.workspace-switcher'));document.querySelector('.workspace-switcher').click();
        await wait(()=>document.querySelector('.recent-repositories-manage'));document.querySelector('.recent-repositories-manage').click();
        await wait(()=>document.querySelectorAll('.repository-card').length===10);
        const panel=document.querySelector('[data-panel-id="repositories"]');Object.assign(panel.style,{width:'1100px',height:'760px',left:'70px',top:'20px'});
        await new Promise(resolve=>setTimeout(resolve,150));document.querySelector('.repository-page').scrollTop=0;
        const rect=panel.getBoundingClientRect(),cards=[...document.querySelectorAll('.repository-card')],page=document.querySelector('.repository-page').getBoundingClientRect();
        return {repositoryCount:cards.length,names:cards.map(card=>card.querySelector('h3').textContent),columns:getComputedStyle(document.querySelector('.repository-grid')).gridTemplateColumns,allCardsVisible:cards.every(card=>card.getBoundingClientRect().bottom<=page.bottom),capture:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)}};
      })()`);
      assert.equal(preview.repositoryCount,10);assert.equal(preview.allCardsVisible,true);
      await fs.writeFile(path.join(output,artifactPrefix+'ten-repositories.png'),(await window.webContents.capturePage(preview.capture)).toPNG());
      await fs.writeFile(path.join(output,artifactPrefix+'demo-preview.json'),JSON.stringify(preview,null,2));
      console.log(JSON.stringify({demoPreview:true,...preview}));window.destroy();app.exit(0);return;
    }
    const extra=path.join(temporary,'新项目'),missing=path.join(temporary,'不存在的目录');
    const result=await window.webContents.executeJavaScript(`(async()=>{
      const checks=[];
      const check=(label,value)=>{checks.push({label,passed:!!value});if(!value)throw new Error(label);};
      const wait=async(test,label)=>{for(let count=0;count<150;count++){if(test())return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('Timeout: '+label);};
      const get=selector=>document.querySelector(selector);
      const cards=()=>[...document.querySelectorAll('.repository-card')];
      const input=(selector,value)=>{const element=get(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));};
      const click=selector=>{const element=get(selector);if(!element)throw new Error('Missing '+selector);element.click();};
      const openManager=async()=>{click('.workspace-switcher');await wait(()=>get('.recent-repositories-manage'),'recent repositories');click('.recent-repositories-manage');};
      const info=async()=>await(await fetch('/api/workspace')).json();
      await wait(()=>get('.workspace-switcher'),'app header');
      check('header shows current folder name',get('.workspace-switcher b').textContent==='初始仓库');
      click('button[aria-label="设置"]');await wait(()=>get('.settings-page'),'settings');
      check('settings no longer contains repository management',![...document.querySelectorAll('.settings-sidebar nav button')].some(button=>button.textContent.includes('仓库管理')));
      click('button[aria-label="关闭设置"]');await wait(()=>!get('.settings-page'),'close settings');
      await openManager();await wait(()=>get('.repository-page'),'repository panel');
      await wait(()=>cards().length===10,'initial repository cards');
      check('management is a separate workspace panel',!!get('[data-panel-id="repositories"] .repository-page')&&!get('.settings-page'));
      check('current repository cannot be removed',get('.repository-current .repository-order button:last-child').disabled);
      check('header contains total count and no duplicate list heading',get('.repository-count')?.textContent==='10'&&!get('.repository-page').textContent.includes('我的仓库'));
      check('auto save controls removed from repository panel',!get('.repository-autosave')&&!get('.repository-page [aria-label="自动保存文稿"]'));
      check('add button works without a typed path',!get('.repository-add-button').disabled&&!get('#repository-root'));
      const initialAutoSave=(await info()).autoSave,initialRevision=(await info()).revision;
      click('.repository-add-button');await wait(()=>window.repositoryPickerCalls===1&&get('.repository-page').getAttribute('aria-busy')==='false','cancel chooser');
      check('cancel leaves repository list and revision unchanged',cards().length===10&&(await info()).revision===initialRevision);
      window.repositoryPickerResult=${JSON.stringify(extra)};click('.repository-add-button');
      await wait(()=>cards().length===11&&!get('.repository-page').ariaBusy.includes('true'),'select and add repository');
      check('selected folder is shown without manual entry',cards().some(card=>card.querySelector('.repository-path')?.title===${JSON.stringify(extra)}));
      check('adding does not switch current repository',(await info()).root.endsWith('初始仓库'));
      click('.repository-add-button');await wait(()=>window.repositoryPickerCalls===3&&get('.repository-feedback')?.textContent.includes('已在列表')&&get('.repository-page').getAttribute('aria-busy')==='false','duplicate selection');
      check('choosing an existing repository does not duplicate it',cards().length===11);
      const newCard=cards().at(-1);newCard.querySelector('.repository-order button').click();
      await wait(()=>cards().at(-2).querySelector('h3').textContent==='新项目','reorder');
      check('reorder saved to backend',(await info()).repositories.at(-2).root===${JSON.stringify(extra)});
      input('.repository-search input','新项目');await wait(()=>cards().length===1,'search');
      check('search finds repository by name',cards()[0].querySelector('h3').textContent==='新项目');
      input('.repository-search input','');await wait(()=>cards().length===11,'clear search');
      window.repositoryPickerResult=${JSON.stringify(missing)};click('.repository-add-button');
      await wait(()=>get('.repository-error'),'invalid folder');check('invalid path keeps all repositories',cards().length===11);
      check('removing the switch preserves automatic save preference',(await info()).autoSave===initialAutoSave);
      const target=cards().find(card=>card.querySelector('h3').textContent==='新项目');target.querySelector('.repository-card-actions > button').click();
      await wait(()=>get('.workspace-switcher b')?.textContent==='新项目','open repository');
      await openManager();await wait(()=>get('.repository-page')&&cards().length===11,'reopen manager');
      check('opened repository is marked current',get('.repository-current h3').textContent==='新项目');
      get('.repository-current .repository-rename').click();await wait(()=>get('.repository-name-editor input'),'edit display name');
      input('.repository-name-editor input','我的新书');get('.repository-name-editor').requestSubmit();
      await wait(()=>get('.workspace-switcher b')?.textContent==='我的新书'&&!get('.repository-name-editor'),'save alias');
      check('current alias updates card and header',get('.repository-current h3').textContent==='我的新书');
      check('alias leaves root unchanged',(await info()).root===${JSON.stringify(extra)});
      input('.repository-search input','我的新书');await wait(()=>cards().length===1,'search alias');
      check('display names are searchable',cards()[0].querySelector('h3').textContent==='我的新书');
      input('.repository-search input','');await wait(()=>cards().length===11,'clear alias search');
      get('.repository-current .repository-rename').click();await wait(()=>get('.repository-name-editor input'),'cancel alias edit');
      input('.repository-name-editor input','未保存的名字');get('.repository-name-editor').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await wait(()=>!get('.repository-name-editor'),'escape cancels');check('cancel preserves original alias',get('.repository-current h3').textContent==='我的新书');
      const old=cards().find(card=>card.querySelector('h3').textContent==='项目 01');old.querySelector('.repository-order button:last-child').click();
      await wait(()=>cards().length===10,'remove listing');
      check('remove listing persisted',!(await info()).repositories.some(item=>item.root.endsWith('项目 01')));
      const page=get('.repository-page'),grid=get('.repository-grid');await new Promise(resolve=>setTimeout(resolve,120));page.scrollTop=0;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      check('wide panel displays multiple columns',getComputedStyle(grid).gridTemplateColumns.split(' ').length>=2);
      check('no horizontal panel overflow',page.scrollWidth<=page.clientWidth+1);
      const heading=get('.repository-heading').getBoundingClientRect(),add=get('.repository-add-button').getBoundingClientRect(),card=cards()[0].getBoundingClientRect();
      check('add repository button is in the upper right',add.left>=heading.right&&add.top<heading.bottom);
      check('compact cards stay under 150px tall',card.height<150);
      check('repository icons use readable UI foreground',getComputedStyle(get('.repository-card-icon')).color===getComputedStyle(get('.repository-card h3')).color);
      check('icon strokes are clear',parseFloat(getComputedStyle(get('.repository-card-icon svg')).strokeWidth)>=2.2);
      return {checks,repositoryCount:cards().length,cardHeight:card.height,gridColumns:getComputedStyle(grid).gridTemplateColumns,workspace:await info()};
    })()`);
    const capture=await window.webContents.executeJavaScript(`(()=>{const rect=document.querySelector('[data-panel-id="repositories"]').getBoundingClientRect();return {x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)};})()`);
    await fs.writeFile(path.join(output,artifactPrefix+'repository-panel.png'),(await window.webContents.capturePage(capture)).toPNG());
    const small=await window.webContents.executeJavaScript(`(async()=>{const panel=document.querySelector('[data-panel-id="repositories"]');panel.style.width='340px';panel.style.left='10px';await new Promise(resolve=>setTimeout(resolve,100));const page=document.querySelector('.repository-page');return {width:page.clientWidth,scrollWidth:page.scrollWidth,columns:getComputedStyle(document.querySelector('.repository-grid')).gridTemplateColumns};})()`);
    assert.ok(small.scrollWidth<=small.width+1,'Narrow repository panel overflows');
    await fs.writeFile(path.join(output,artifactPrefix+'repository-panel-narrow.png'),(await window.webContents.capturePage()).toPNG());
    const reloaded=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));window.reload();await reloaded;
    const restored=await window.webContents.executeJavaScript(`(async()=>{for(let n=0;n<150;n++){const header=document.querySelector('.workspace-switcher b');if(header)return header.textContent;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('Reload failed');})()`);
    assert.equal(restored,'我的新书');assert.equal(errors.length,0,errors.join('\n'));
    const report={passed:true,checkedAt:new Date().toISOString(),method:'Hidden nonfocusable Electron loading the built app and isolated real backend; DOM events only, no desktop input.',backend:process.env.HIVE_REPOSITORY_SERVER||path.join(project,'server/index.mjs'),...result,narrow:small,reloadHeader:restored,consoleErrors:errors};
    await fs.writeFile(path.join(output,artifactPrefix+'ui-validation.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:true,checks:result.checks.length+3,repositoryCount:result.repositoryCount,narrow:small}));
    window.destroy();app.exit(0);
  } catch(error) {console.error(error.stack);await fs.writeFile(path.join(output,artifactPrefix+'failure.png'),(await window.webContents.capturePage()).toPNG());window.destroy();app.exit(1);}
}

if(process.argv.includes('--repository-worker'))void worker('http://127.0.0.1:'+process.argv.at(-2),process.argv.at(-1)).catch(error=>{console.error(error.stack);require('electron').app.exit(1);});
else {
  const {workspaceStore}=await import('../server/workspace.mjs');
  await fs.mkdir(output,{recursive:true});const temporary=await fs.mkdtemp(path.join(output,'.repositories-check-'));
  let server;
  try {
    const demoPreview=process.env.HIVE_REPOSITORY_PREVIEW_DEMO==='1',profile=path.resolve(process.env.HIVE_REPOSITORY_DEMO_PROFILE||path.join(project,'delivery/repository-refinement-20261118/demo-profile'));
    const root=demoPreview?path.join(profile,'documents'):path.join(temporary,'初始仓库'),state=demoPreview?path.join(profile,'state'):path.join(temporary,'state');
    if(!demoPreview){
      const store=await workspaceStore(state,root);
      for(let i=1;i<=9;i++){const folder=path.join(temporary,'项目 '+String(i).padStart(2,'0'));await fs.mkdir(folder);await fs.writeFile(path.join(folder,'保留.md'),'仓库原始文稿');await store.manage({action:'add',root:folder,revision:store.read().revision});}
      await fs.mkdir(path.join(temporary,'新项目'));
    }
    const executable=process.env.HIVE_REPOSITORY_EXECUTABLE;
    server=fork(process.env.HIVE_REPOSITORY_SERVER||path.join(project,'server/index.mjs'),['--production'],{execPath:executable||process.execPath,cwd:project,silent:true,windowsHide:true,env:{...process.env,...(executable?{ELECTRON_RUN_AS_NODE:'1'}:{}),HIVE_PORT:'0',HIVE_DOCUMENTS:root,HIVE_STATE_DIR:state,HIVE_API_KEY:''}});
    let serverLog='';server.stdout.on('data',data=>serverLog+=data);server.stderr.on('data',data=>serverLog+=data);
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timeout')),10000);server.once('error',error=>{clearTimeout(timer);reject(error);});server.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code));});server.on('message',message=>{if(message?.type==='hive-ready'){clearTimeout(timer);resolve(message.port);}});});
    const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
    const electron=(await import('electron')).default;
    const child=spawn(electron,[fileURLToPath(import.meta.url),'--repository-worker',String(port),temporary],{cwd:project,windowsHide:true,env:environment,stdio:['ignore','pipe','pipe']});
    let log='';child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('UI validation timeout'));},60000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
    await fs.writeFile(path.join(output,artifactPrefix+(demoPreview?'demo-preview.log':'ui.log')),log);console.log(log);assert.equal(code,0,'UI validation failed');
    if(!demoPreview)assert.equal(await fs.readFile(path.join(temporary,'项目 01','保留.md'),'utf8'),'仓库原始文稿');
    await new Promise(resolve=>{server.once('exit',resolve);server.send({type:'hive-shutdown'});});server=null;
    if(!demoPreview){
      const restarted=await workspaceStore(state,root),report=JSON.parse(await fs.readFile(path.join(output,artifactPrefix+'ui-validation.json'),'utf8'));
      assert.deepEqual(restarted.read(),report.workspace);report.restartPersisted=true;report.removedRepositoryDocumentPreserved=true;
      await fs.writeFile(path.join(output,artifactPrefix+'ui-validation.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(output,artifactPrefix+'ui-server.log'),serverLog);
    }
  } finally {
    if(server&&server.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill();});
    const resolved=path.resolve(temporary);assert.equal(path.dirname(resolved),path.resolve(output));assert.ok(path.basename(resolved).startsWith('.repositories-check-'));
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
