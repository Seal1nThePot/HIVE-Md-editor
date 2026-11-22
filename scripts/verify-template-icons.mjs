import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import builtins from '../shared/icons.json' with {type:'json'};
import bundled from '../templates/icons.json' with {type:'json'};

const require=createRequire(import.meta.url);
const project=fileURLToPath(new URL('../',import.meta.url));
const output=path.resolve(process.env.HIVE_VERIFY_OUTPUT||path.join(project,'.runtime/checks'));
const packaged=process.argv.includes('--package');
const bundle=path.resolve(process.env.HIVE_VERIFY_BUNDLE||path.join(project,'release'));
const runtime=packaged?path.join(bundle,'win-unpacked/resources/app.asar'):project;
const mode=packaged?'packaged':'source';
const olive='claude-olive-gold',blue='hive-mediterranean-blue-study';
const historyButton='button[aria-label="历史记录"]';
const historyIcon=historyButton+' svg[data-hive-icon="history.open"]';
const annotationButton='.global-toolbar-native .dock-annotation-button';
const annotationIcon=annotationButton+' svg[data-hive-icon="annotation.markSelection"]';
const searchIcon='.settings-search svg[data-hive-icon="settings.search"]';
const taskRow='.explorer-row[data-path="icon-check.md"]';
const checkedTask='.cm-preview-task[aria-checked="true"]';
const taskIcon=checkedTask+' svg[data-hive-icon="SquareCheck"]';
const management='.theme-template-management';
const warningText='模板 JSON 无法解析';
const trace=n=>`M2 2h${n}v12H2z`;
const override=n=>({viewBox:'0 0 24 24',shapes:[{tag:'path',attrs:{d:trace(n),stroke:'var(--icon-accent,currentColor)'}}]});
const firstPath=icon=>icon.shapes.find(shape=>shape.tag==='path').attrs.d;
const writePack=(file,icons)=>fs.writeFile(file,JSON.stringify({version:1,icons}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitFor(check,label){
  const until=Date.now()+8000;
  do{const value=await check();if(value)return value;await pause(60);}while(Date.now()<until);
  throw new Error(`Timed out waiting for ${label}`);
}

async function worker(fixture){
  const {app,BrowserWindow,dialog,session}=require('electron');
  process.env.HIVE_DESKTOP_USER_DATA=fixture;
  process.env.HIVE_TEMPLATES_SOURCE=path.join(fixture,'template-source');
  process.env.HIVE_API_KEY='';
  app.setPath('userData',fixture);
  app.disableHardwareAcceleration();
  const evidence={mode,checkedAt:new Date().toISOString(),checks:[]};
  const held=[];
  let main,attemptedPresentation=false,allowIcons=false;
  const releaseIcons=()=>{allowIcons=true;for(const callback of held.splice(0))callback({});};
  const record=(name,value)=>{evidence.checks.push({name,value});console.log('PASS '+name);};
  dialog.showErrorBox=(title,message)=>{console.error(title,message);};
  app.on('browser-window-created',(_event,window)=>{
    main??=window;
    window.setFocusable(false);
    window.setSkipTaskbar(true);
    window.focus=()=>{};
    window.show=()=>{if(window===main)attemptedPresentation=true;};
    window.showInactive=()=>{};
  });
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://127.0.0.1/*']},(details,callback)=>{
    const url=new URL(details.url);
    if(!allowIcons&&url.pathname===`/api/templates/${olive}/icons`){held.push(callback);return;}
    if(!allowIcons&&url.pathname===`/api/templates/${olive}`&&url.searchParams.get('colorsOnly')!=='1'){held.push(callback);return;}
    callback({});
  });
  try{
    await import(pathToFileURL(path.join(runtime,'desktop/main.mjs')).href);
    const run=(window,expression)=>window.webContents.executeJavaScript(expression);
    const exists=(window,selector)=>run(window,`!!document.querySelector(${JSON.stringify(selector)})`);
    const getPath=(window,selector)=>run(window,`document.querySelector(${JSON.stringify(selector+' path')})?.getAttribute('d')`);
    const click=(window,selector)=>run(window,`document.querySelector(${JSON.stringify(selector)}).click()`);
    const clickNamed=(window,selector,label)=>run(window,`[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.textContent.trim()===${JSON.stringify(label)}).click()`);
    const status=(window,text)=>run(window,`[...document.querySelectorAll('[role="status"]')].some(node=>node.textContent.includes(${JSON.stringify(text)}))`);
    const waitPath=async(window,selector,expected,label)=>{
      await waitFor(async()=>await getPath(window,selector)===expected,label);
      record(label,expected);
    };

    await waitFor(()=>attemptedPresentation&&held.length>0,'theme startup while icon reads are held');
    assert.ok(!main.isVisible());
    const toolbar=await waitFor(async()=>{
      for(const window of BrowserWindow.getAllWindows()){
        const url=window.webContents.getURL();
        if(url.startsWith('http://127.0.0.1:')&&new URL(url).searchParams.get('panelWindow')==='global-toolbar'&&await exists(window,annotationButton))return window;
      }
    },'the native writing toolbar');
    await waitPath(main,historyIcon,firstPath(builtins['history.open']),'startup shows the built-in glyph during a held icon request');
    await waitPath(toolbar,annotationIcon,firstPath(builtins['annotation.markSelection']),'native annotation toolbar shows the built-in glyph during a held icon request');
    releaseIcons();
    await waitPath(main,historyIcon,trace(10),'startup loads the selected template glyph');
    await waitPath(toolbar,annotationIcon,trace(11),'native annotation toolbar loads the selected template glyph');
    await waitFor(()=>exists(main,taskRow),'the fixture file in the explorer');
    await click(main,taskRow);
    await waitFor(()=>exists(main,taskIcon),'a rendered CodeMirror task glyph');
    const toolbarPressed=()=>run(toolbar,`document.querySelector(${JSON.stringify(annotationButton)}).getAttribute('aria-pressed')==='true'`);
    const editorInAnnotationMode=()=>exists(main,'.document-pane:not([inert]) .editor-host.annotation-tool-active');
    await click(toolbar,annotationButton);
    await waitFor(async()=>await toolbarPressed()&&await editorInAnnotationMode(),'native toolbar marking mode');
    record('native annotation toolbar still enables marking mode',true);

    await click(main,'button[aria-label="设置"]');
    const settings=await waitFor(async()=>{
      for(const window of BrowserWindow.getAllWindows()){
        const url=window.webContents.getURL();
        if(url.startsWith('http://127.0.0.1:')&&new URL(url).searchParams.get('panelWindow')==='settings'&&await exists(window,'.settings-page'))return window;
      }
    },'the settings panel');
    assert.ok(!settings.isVisible());
    await clickNamed(settings,'.settings-sidebar nav button','外观');
    await waitFor(()=>exists(settings,'.theme-settings'),'theme settings');
    await clickNamed(settings,'.theme-settings button','管理');
    const origin=new URL(main.webContents.getURL()).origin;
    async function get(url){const response=await fetch(origin+url);assert.equal(response.status,200,url);return response.json();}
    const route='/api/templates/'+blue;
    const initial=await get(route);
    const blueName=initial.template.name;
    await waitFor(()=>exists(settings,management),'template management');
    const switchToBlue=`[...document.querySelectorAll('${management} .setting-row')].find(row=>row.querySelector('.setting-row-title')?.textContent===${JSON.stringify(blueName)}).querySelector('button').click()`;
    await run(settings,switchToBlue);
    await waitPath(main,historyIcon,trace(12),'template selection updates the mounted history glyph');
    await waitPath(toolbar,annotationIcon,trace(13),'template selection updates the native annotation toolbar glyph');
    await waitPath(settings,searchIcon,trace(8),'missing template key uses the external root pack');
    const unchanged=await get(route+'?iconPackRevision='+initial.iconPack.packRevision);
    assert.equal(unchanged.iconPackUnchanged,true);
    assert.ok(!Object.hasOwn(unchanged,'iconPack'));
    record('matching pack revision omits the duplicate payload',true);

    const blueFile=path.join(fixture,'templates',blue,'icons.json');
    await run(main,`window.templateTestTaskSvg=document.querySelector(${JSON.stringify(taskIcon)})`);
    await writePack(blueFile,{'history.open':override(14),SquareCheck:override(15),'annotation.markSelection':override(17)});
    await waitPath(main,historyIcon,trace(14),'hot edit updates the mounted glyph');
    await waitPath(main,taskIcon,trace(15),'hot edit updates the mounted CodeMirror glyph');
    await waitPath(toolbar,annotationIcon,trace(17),'hot edit updates the native annotation toolbar glyph');
    assert.ok(await toolbarPressed()&&await editorInAnnotationMode());
    record('hot edit preserves annotation mode in the toolbar and editor',true);
    assert.equal(await run(main,`window.templateTestTaskSvg===document.querySelector(${JSON.stringify(taskIcon)})`),true);
    record('the CodeMirror widget retains its original SVG node during the hot edit',true);
    assert.equal((await get(route)).revision,initial.revision);
    record('hot icon edit preserves the color revision',initial.revision);

    await fs.writeFile(blueFile,'{"version":');
    const fallback=firstPath(bundled.icons['history.open']);
    await waitPath(main,historyIcon,fallback,'malformed pack falls back to the bundled glyph');
    await waitFor(()=>status(settings,warningText),'malformed pack warning in settings');
    record('malformed pack leaves a visible warning in settings',true);
    await waitPath(settings,searchIcon,trace(8),'malformed pack preserves the unrelated glyph');

    await writePack(blueFile,{'history.open':override(16)});
    await waitPath(main,historyIcon,trace(16),'corrected file recovers the custom glyph');
    await waitFor(async()=>!await status(settings,warningText),'cleared warning after repair');
    await fs.unlink(blueFile);
    await waitPath(main,historyIcon,fallback,'deleted file restores the bundled glyph');
    assert.equal((await get(route)).iconPack.warning,'');
    await run(settings,`setTimeout(()=>document.querySelector('button[aria-label="关闭设置"]').click(),30); true`);
    await waitFor(()=>settings.isDestroyed(),'the settings window closes');
    await click(main,checkedTask);
    await waitFor(()=>exists(main,'.cm-preview-task[aria-checked="false"]'),'the task toggles after icon recovery');
    record('the CodeMirror task control remains operable',true);
    await waitPath(toolbar,annotationIcon,firstPath(bundled.icons['annotation.markSelection']),'missing override restores the bundled annotation glyph');
    await click(toolbar,annotationButton);
    await waitFor(async()=>!await toolbarPressed()&&!await editorInAnnotationMode(),'native toolbar marking mode off');
    record('native annotation toolbar still disables marking mode',true);
    await click(main,historyButton);
    await waitFor(()=>exists(main,'.history-page'),'history button still opens its page');
    record('history remains operable after template damage and recovery',true);
    assert.ok(BrowserWindow.getAllWindows().every(window=>!window.isVisible()));
    const screenshot=await main.capturePage(undefined,{stayHidden:true});
    assert.ok(!screenshot.isEmpty());
    await fs.writeFile(path.join(output,`template-icons-${mode}.png`),screenshot.toPNG());
    await fs.writeFile(path.join(fixture,'result.json'),JSON.stringify({...evidence,passed:true},null,2)+'\n');
  }finally{
    releaseIcons();
    app.quit();
  }
}

async function verify(){
  await fs.mkdir(output,{recursive:true});
  const fixture=await fs.mkdtemp(path.join(output,'.template-icons-'));
  try{
    await fs.writeFile(path.join(fixture,'ui-preferences.json'),JSON.stringify({'hive.theme.v1':JSON.stringify({templateId:olive})}));
    const documents=path.join(fixture,'documents');
    await fs.mkdir(documents);
    await fs.writeFile(path.join(documents,'icon-check.md'),'# 图标验收\n\n- [x] 图标刷新后仍可切换这个待办。\n');
    const templateSource=path.join(fixture,'template-source');
    await fs.mkdir(templateSource);
    await writePack(path.join(templateSource,'icons.json'),{'settings.search':override(8)});
    for(const [id,width] of [[olive,10],[blue,12]]){
      const template=path.join(fixture,'templates',id);
      await fs.mkdir(template,{recursive:true});
      await writePack(path.join(template,'icons.json'),{'history.open':override(width),'annotation.markSelection':override(width+1)});
    }
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const executable=(await import('electron')).default;
    const child=spawn(executable,[fileURLToPath(import.meta.url),'--worker',...(packaged?['--package']:[]),fixture],{cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let log='';
    child.stdout.on('data',data=>{log+=data;});
    child.stderr.on('data',data=>{log+=data;});
    const exit=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>child.kill(),45000);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('close',(code,signal)=>{clearTimeout(timeout);resolve(code??signal);});
    });
    await fs.writeFile(path.join(output,`template-icons-${mode}.log`),log);
    assert.equal(exit,0,log);
    const result=await fs.readFile(path.join(fixture,'result.json'),'utf8').catch(()=>{throw new Error(log||'Icon validation did not write a report');});
    await fs.writeFile(path.join(output,`template-icons-${mode}.json`),result);
    console.log(result.trim());
  }finally{
    const resolved=await fs.realpath(fixture);
    assert.equal(path.dirname(resolved),await fs.realpath(output));
    assert.ok(path.basename(resolved).startsWith('.template-icons-'));
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  }
}

if(process.argv.includes('--worker'))void worker(process.argv.at(-1)).catch(error=>{console.error(error.stack);require('electron').app.quit();});
else await verify();
