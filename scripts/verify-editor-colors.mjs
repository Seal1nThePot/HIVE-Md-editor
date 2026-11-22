import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const project=fileURLToPath(new URL('../',import.meta.url)),output=path.resolve(project,process.env.HIVE_EDITOR_COLORS_OUTPUT||'delivery/editor-colors-20261118'),require=createRequire(import.meta.url);

async function worker(){
  const {app,BrowserWindow}=require('electron');app.setPath('userData',path.join(output,'render-profile'));app.disableHardwareAcceleration();await app.whenReady();
  const win=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1400,height:1000,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  try{
    await win.loadFile(path.join(output,'color-fixture.html'));
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const t=window.testColors,checks=[],pause=()=>new Promise(r=>setTimeout(r,180));
      const check=(label,value,detail)=>{checks.push({label,passed:!!value,detail});if(!value)throw new Error(label+' '+JSON.stringify(detail));};
      const css=(color)=>{const n=document.createElement('span');n.style.backgroundColor=color;document.body.append(n);const value=getComputedStyle(n).backgroundColor;n.remove();return value;};
      const eq=(label,node,property,color,pseudo)=>{if(!node)throw new Error(label+' element missing');const actual=getComputedStyle(node,pseudo)[property],expected=css(color);check(label,actual===expected,{actual,expected});};
      const controls=document.querySelector('.editor-color-settings');check('dedicated editor color section exists',controls.querySelector('h2').textContent==='文本编辑页面');
      check('17 editable color fields and 10 alpha sliders',controls.querySelectorAll('input[type=color]').length===17&&controls.querySelectorAll('input[type=range]').length===10);
      check('document text has one settings control',document.querySelectorAll('[aria-label="正文文字颜色值"]').length===1);
      const palettes=[['black',{document:'#182634',documentText:'#dbeafe',selection:'#164a28'}],['white',{document:'#fff7ed',documentText:'#233344',selection:'#d5eacc'}]];
      for(const [base,surfaces] of palettes){
        t.theme(base,surfaces,{});await pause();
        const defaultView=t.main();defaultView.dispatch({selection:{anchor:t.word}});defaultView.focus();defaultView.dom.classList.add('cm-focused');await pause();
        const cursor=getComputedStyle(defaultView.dom.querySelector('.cm-cursor')),line=getComputedStyle(defaultView.dom.querySelector('.cm-activeLine'));
        check(base+' default caret has a visible two-pixel stroke',parseFloat(cursor.borderLeftWidth)>=2,{width:cursor.borderLeftWidth});
        const rgba=line.backgroundColor.match(/[\\d.]+/g).map(Number);
        check(base+' current line uses a visible tint',rgba.length===4&&rgba[3]>=.09,{background:line.backgroundColor});
        check(base+' current line has an inset edge without layout movement',line.boxShadow!=='none'&&line.borderLeftWidth==='0px',{shadow:line.boxShadow});
        const profile={cursor:'#de3366',selectionBackground:'#ad7bdf88',selectionText:'#102030',inactiveSelectionBackground:'#248acf44',activeLineBackground:'#edbb2255',selectionMatchBackground:'#22ac8855',searchMatchBackground:'#d4832255',searchCurrentBackground:'#cc445599',annotationBackground:'#47b5cc66',annotationUnderline:'#6f3fa9',tableSelectionBackground:'#4477cc77',tableSelectionBorder:'#e36825'};
        t.theme(base,surfaces,profile);await pause();
        const view=t.main();view.dispatch({selection:{anchor:t.word,head:t.word+2}});view.focus();await pause();view.dom.classList.add('cm-focused');
        eq(base+' page background',view.dom.closest('.document-pane'),'backgroundColor',surfaces.document);eq(base+' document text',view.contentDOM.querySelector('.cm-line'),'color',surfaces.documentText);
        eq(base+' focused selection background',view.dom.querySelector('.cm-selectionBackground'),'backgroundColor',profile.selectionBackground);
        eq(base+' native selection is transparent',view.contentDOM.querySelector('.cm-line'),'backgroundColor','#00000000','::selection');
        eq(base+' selected text color',view.contentDOM.querySelector('.cm-line'),'color',profile.selectionText,'::selection');
        view.dispatch({selection:{anchor:t.word}});await pause();eq(base+' cursor color',view.dom.querySelector('.cm-cursor'),'borderLeftColor',profile.cursor);view.dispatch({selection:{anchor:t.word,head:t.word+2}});await pause();
        eq(base+' native line caret honors editor color',view.contentDOM.querySelector('.cm-line'),'caretColor',profile.cursor);
        eq(base+' active line',view.dom.querySelector('.cm-activeLine'),'backgroundColor',profile.activeLineBackground);
        eq(base+' global item selection unchanged',document.querySelector('.outside-selection'),'backgroundColor',surfaces.selection);
        const source=t.source();source.contentDOM.focus();await pause();view.dom.classList.remove('cm-focused');source.dom.classList.add('cm-focused');
        eq(base+' inactive live selection',view.dom.querySelector('.cm-selectionBackground'),'backgroundColor',profile.inactiveSelectionBackground);
        eq(base+' source focused selection',source.dom.querySelector('.cm-selectionBackground'),'backgroundColor',profile.selectionBackground);
        for(const [className,key,property] of [['cm-selectionMatch','selectionMatchBackground','backgroundColor'],['cm-searchMatch','searchMatchBackground','backgroundColor'],['cm-searchMatch cm-searchMatch-selected','searchCurrentBackground','backgroundColor'],['cm-table-selected','tableSelectionBackground','backgroundColor'],['cm-table-select-top','tableSelectionBorder','borderTopColor']]){
          const sample=document.createElement('span');sample.className=className;sample.textContent='高亮样例';sample.style.borderStyle='solid';view.contentDOM.append(sample);eq(base+' '+key,sample,property,profile[key]);sample.remove();
        }
        t.mark();await pause();
        const frames=view.dom.querySelectorAll('.cm-text-annotation-frame'),textMarks=view.contentDOM.querySelectorAll('.cm-text-annotation');
        check(base+' one rounded frame spans all rendered annotation fragments',frames.length===1&&textMarks.length>1&&frames[0].getBoundingClientRect().height>textMarks[0].getBoundingClientRect().height&&parseFloat(getComputedStyle(frames[0]).borderRadius)>0);
        eq(base+' annotation frame has very faint fill',frames[0],'backgroundColor','color-mix(in srgb, '+profile.annotationBackground+' 40%, transparent)');
        eq(base+' annotation outline color',frames[0],'borderTopColor',profile.annotationUnderline);
        eq(base+' annotation text fragments have no individual fill',textMarks[0],'backgroundColor','#00000000');
        check(base+' annotation text fragments have no underline',getComputedStyle(textMarks[0]).borderBottomWidth==='0px');
      }
      const color=document.querySelector('[aria-label="选区底色颜色值"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(color,'#ef339977');color.dispatchEvent(new Event('input',{bubbles:true}));await pause();
      check('changing settings updates live preference',t.snapshot().preferences.editorProfiles.white.selectionBackground==='#ef339977');
      t.main().focus();await pause();t.main().dom.classList.add('cm-focused');eq('changing settings updates selection paint',t.main().dom.querySelector('.cm-selectionBackground'),'backgroundColor','#ef339977');
      t.flush();check('alpha color persisted',JSON.parse(localStorage.getItem('hive.theme.v1')).editorProfiles.white.selectionBackground==='#ef339977');
      document.querySelector('.settings-content').scrollTop=document.querySelector('.editor-color-settings').offsetTop-40;
      return {checks};
    })()`);
    await fs.writeFile(path.join(output,'render-validation.json'),JSON.stringify({passed:true,method:'Hidden nonfocusable Electron; actual Editor in split mode and reactive EditorColorSettings, current source CSS plus compatibility compiler. Synthetic input and focused CSS state, no desktop input.',...result},null,2)+'\n');
    await fs.writeFile(path.join(output,'preview.png'),(await win.webContents.capturePage()).toPNG());console.log(JSON.stringify({passed:true,checks:result.checks.length}));win.destroy();app.exit(0);
  }catch(error){await fs.writeFile(path.join(output,'render-failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error.stack);win.destroy();app.exit(1);}
}
if(process.argv.includes('--editor-color-worker'))void worker().catch(error=>{console.error(error.stack);require('electron').app.exit(1);});
else{
  await fs.mkdir(output,{recursive:true});
  const fixture=`import React,{useCallback} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {EditorView} from '@codemirror/view';
import Editor,{makeState} from './src/features/editor/Editor';import EditorColorSettings from './src/features/theme/EditorColorSettings';import {setAnnotationMarks} from './src/features/annotations/annotationDecorations';import {WorkspaceProvider} from './src/features/files/WorkspaceContext';
import {applyThemeTokens} from './src/features/theme/applyTheme';import {compileThemeRules,legacyColorVariables} from './src/features/theme/themeStyles';import {setTheme,subscribeTheme,getThemeSnapshot,flushThemePreferences,bindThemeTemplate,useTheme} from './src/features/theme/themeStore';import {switchThemeBase} from './src/features/theme/themePreferences';import olive from './templates/hive-moss-gold-study/colors.json';
import './src/app/styles.css';import './src/features/workspace/workbench-v3.css';import './src/features/annotations/annotations.css';
bindThemeTemplate({id:'hive-moss-gold-study',name:'青苔鎏金 · 配色试验',bases:['black','gray','white']},null,null,olive as any);
const text='# HIVE 0.1.4 编辑区配色\\n\\n这是本轮创建的隔离测试文稿。可用来体验选区高亮，不含原用户资料。\\n\\n同一段文字可以有不同的高亮颜色。';let main:EditorView;const state=makeState(text,()=>{});
function Harness(){const {preferences,setTheme}=useTheme();const ready=useCallback((v:EditorView|null)=>{if(v)main=v;},[]);return <WorkspaceProvider info={{id:'test',root:'',autoSave:false,revision:0,repositories:[]}} onChange={()=>{}}><main className="app-shell"><div className="document-pane" style={{width:'50%',height:900,flex:'none'}}><Editor initialState={state} displayMode="split" onReady={ready} onUpdate={()=>{}}/></div><div className="settings-page" style={{position:'static',width:'50%',height:950,display:'block'}}><div className="settings-content" style={{height:'100%',overflow:'auto'}}><EditorColorSettings preferences={preferences} onChange={setTheme}/></div></div></main><span className="outside-selection" style={{background:'var(--hive-selection-bg)'}}>界面选中项目</span></WorkspaceProvider>;}
flushSync(()=>createRoot(document.getElementById('root')!).render(<Harness/>));
const overrides=document.createElement('style'),legacy=new Map();document.head.append(overrides);for(const sheet of document.styleSheets)if(sheet.ownerNode!==overrides)overrides.textContent+=compileThemeRules(sheet.cssRules,legacy,true);
function apply(){const theme=getThemeSnapshot().preferences;applyThemeTokens(document.documentElement,theme);for(const [key,value] of Object.entries(legacyColorVariables(legacy,theme)))document.documentElement.style.setProperty(key,value);}
subscribeTheme(apply);apply();(window as any).testColors={main:()=>main,source:()=>EditorView.findFromDOM(document.querySelector('.split-source .cm-editor')!),word:text.indexOf('隔离'),mark:()=>main.dispatch({effects:setAnnotationMarks.of([{id:'test-annotation',from:text.indexOf('隔离'),to:text.indexOf('不同')+2,note:'跨行标注'}])}),snapshot:getThemeSnapshot,flush:flushThemePreferences,theme:(base:any,surfaces:any,profile:any)=>flushSync(()=>setTheme(old=>{const next=switchThemeBase(old,base);return {...next,surfaceColors:{...next.surfaceColors,[base]:{...next.surfaceColors[base],...surfaces}},editorProfiles:{...next.editorProfiles,[base]:profile}};}))};`;
  await fs.writeFile(path.join(output,'color-fixture.tsx'),fixture);
  const {build}=await import('esbuild');await build({stdin:{contents:fixture,resolveDir:project,sourcefile:'color-fixture.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'esm',outfile:path.join(output,'color-fixture.js'),loader:{'.css':'css','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
  await fs.writeFile(path.join(output,'color-fixture.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="color-fixture.css"><style>.app-shell{display:flex!important;flex-direction:row!important;height:950px!important}.editor-host{height:100%;overflow:hidden}</style><div id="root"></div><script type="module" src="color-fixture.js"></script>');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn((await import('electron')).default,[fileURLToPath(import.meta.url),'--editor-color-worker'],{cwd:project,windowsHide:true,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Editor color verification timeout'));},40000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});await fs.writeFile(path.join(output,'render.log'),log);console.log(log);assert.equal(code,0);
}
