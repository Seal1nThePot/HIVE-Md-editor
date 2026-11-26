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
const expectedVersion=process.env.HIVE_VERIFY_EXPECTED_VERSION||pkg.version;
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
      const checks=[],get=s=>document.querySelector(s),pause=()=>new Promise(r=>setTimeout(r,200));
      const check=(label,value,detail)=>{checks.push({label,passed:!!value,detail});if(!value)throw new Error(label+' '+JSON.stringify(detail));};
      const wait=async(fn,label)=>{for(let i=0;i<220;i++){if(fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Timeout '+label);};
      await wait(()=>get('.explorer-row[data-path="整合验收.md"]'),'file explorer');
      check('file tree initially collapses nested folders',!get('.explorer-row[data-path="章节/一.md"]'));
      check('permanent batch action bar is absent',!get('.explorer-selection'));
      get('.explorer-row[data-path="编辑显示验收.md"]').click();
      await wait(()=>get('.active-editor .cm-format-highlight'),'editor display fixture');
      const fontGroup=get('.home-ribbon [data-ribbon-group="字体"]');
      const fontButtons=[...fontGroup.querySelectorAll('.ribbon-tool-trigger > button')];
      const inlineCode=fontGroup.querySelector('[aria-label="行内代码"]');
      const settingsRoot=document.documentElement.style;
      const priorScale=settingsRoot.getPropertyValue('--ui-scale');
      try{
        for(const scale of ['1','1.5']){
          settingsRoot.setProperty('--ui-scale',scale);
          const box=fontGroup.closest('.ribbon-body').getBoundingClientRect();
          const rows=fontButtons.map(button=>button.getBoundingClientRect());
          const hit=inlineCode.getBoundingClientRect();
          check('font ribbon keeps all six commands visible at scale '+scale,
            rows.length===6&&rows.every(row=>Math.abs(row.top-rows[0].top)<1&&row.bottom<=box.bottom)&&inlineCode.contains(document.elementFromPoint(hit.x+hit.width/2,hit.y+hit.height/2)));
        }
      }finally{settingsRoot.setProperty('--ui-scale',priorScale);}
      const fixtureEditor=get('.active-editor .split-main .cm-content').cmTile.root.view;
      const codeWidget=()=>get('.active-editor .cm-code-block');
      await wait(()=>codeWidget()?.querySelector('pre > code'),'short code block preview');
      const framed=codeWidget();
      const codeStyle=getComputedStyle(framed);
      check('short code preview shows its frame, language and exact body',framed.querySelector('.hive-code-language')?.textContent==='C#'
        &&framed.querySelector('pre > code').textContent.replace(/\\n$/,'')==='log 1\\n\\nlog 2'
        &&parseFloat(codeStyle.borderTopWidth)>0&&parseFloat(codeStyle.borderTopLeftRadius)>0&&parseFloat(codeStyle.borderBottomLeftRadius)>0);
      framed.querySelector('pre > code').click();
      const fence=String.fromCharCode(96).repeat(3);
      const editorLines=()=>[...document.querySelectorAll('.active-editor .split-main .cm-line')].map(line=>line.textContent);
      await wait(()=>!codeWidget()&&editorLines().includes(fence+'csharp')&&editorLines().includes(fence),'editable code fences');
      const insideCode=fixtureEditor.state.sliceDoc().indexOf('log 1');
      check('clicking short code enters the editable Markdown frame',insideCode>=0&&fixtureEditor.state.selection.main.from>=insideCode
        &&fixtureEditor.state.selection.main.from<fixtureEditor.state.sliceDoc().indexOf(fence,insideCode),editorLines());
      fixtureEditor.dispatch({changes:{from:insideCode,to:insideCode+5,insert:'log 3'},userEvent:'input.type'});
      check('editing the frame updates source and keeps both fences',fixtureEditor.state.sliceDoc().includes(fence+'csharp\\nlog 3\\n\\nlog 2\\n'+fence));
      get('.home-ribbon [aria-label="居中"]').click();
      await wait(()=>get('.error-toast'),'formatting error toast');
      const errorToast=get('.error-toast'),toastStart=performance.now();
      check('editor error toast has no close button',errorToast.textContent.includes('代码区域')&&!errorToast.querySelector('button'));
      await wait(()=>!errorToast.isConnected,'automatic error toast dismissal');
      check('editor error toast disappears after about two seconds',performance.now()-toastStart>=1600&&performance.now()-toastStart<2800);
      const enter=()=>fixtureEditor.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
      const listStart=fixtureEditor.state.doc.length;
      for(const [marker,expected] of [['-','-\\n'],['1. ','1. \\n'],['1. 已有内容','1. 已有内容\\n2. ']]){
        fixtureEditor.dispatch({changes:{from:listStart,to:fixtureEditor.state.doc.length,insert:'\\n\\n'+marker},selection:{anchor:listStart+2+marker.length},userEvent:'input.type'});
        enter();
        const actual=fixtureEditor.state.sliceDoc(listStart+2);
        check('Enter retains or continues Markdown list marker '+marker,actual===expected,{actual,expected});
      }
      fixtureEditor.dispatch({changes:{from:listStart,to:fixtureEditor.state.doc.length,insert:'\\n\\n'},
        selection:{anchor:listStart+2},userEvent:'select.widget'});
      const tab=label=>[...document.querySelectorAll('.ribbon-tabs [role="tab"]')].find(button=>button.textContent===label);
      tab('插入').click();
      await wait(()=>get('.ribbon-body [aria-label="折叠块"]'),'details insertion command');
      get('.ribbon-body [aria-label="折叠块"]').click();
      const detailsToggle=()=>get('.active-editor .cm-preview-details-toggle');
      await wait(()=>detailsToggle()?.dataset.detailsAction==='收起','details control while the title is being edited');
      check('inserted details have a title hint and a visible collapse button',
        detailsToggle().textContent==='折叠块'&&get('.cm-preview-details-hint')?.textContent==='编辑下方标题');
      const summaryStart=fixtureEditor.state.selection.main.from;
      fixtureEditor.dispatch({changes:{from:summaryStart,insert:'自定义折叠块'},userEvent:'input.type'});
      await wait(()=>detailsToggle()?.textContent==='自定义折叠块','live details title');
      detailsToggle().click();
      await wait(()=>detailsToggle()?.dataset.detailsAction==='展开','collapse details while editing the title');
      check('collapse hides the details body',!fixtureEditor.contentDOM.textContent.includes('折叠块内容'));
      detailsToggle().click();
      await wait(()=>detailsToggle()?.dataset.detailsAction==='收起'&&fixtureEditor.contentDOM.textContent.includes('折叠块内容'),'reopen details');
      tab('开始').click();
      get('.explorer-row[data-path="整合验收.md"]').click();await wait(()=>get('.cm-preview-image img')?.naturalWidth>0,'wiki image');
      check('wiki image decodes through packaged image API',get('.cm-preview-image img').naturalWidth>0);
      await wait(()=>get('.cm-preview-task'),'task');
      const task=get('.cm-preview-task');
      check('task box uses the document text color',getComputedStyle(task).color===getComputedStyle(task.closest('.cm-content')).color);
      task.click();await wait(()=>get('.cm-preview-task')?.getAttribute('aria-checked')==='true','task toggle');check('task toggles in integrated app',true);
      const mode=async text=>{get('[aria-label="正文 1显示模式"]').click();await wait(()=>get('.display-mode-menu'),'mode menu');[...document.querySelectorAll('.display-mode-menu button')].find(b=>b.textContent.includes(text)).click();await pause();};
      await mode('代码模式');await wait(()=>get('.document-pane .cm-editor[data-display-mode=source]'),'code mode');
      const editor=()=>get('.document-pane .split-main .cm-editor');
      check('code mode displays logical line numbers',getComputedStyle(editor().querySelector('.cm-gutters')).display!=='none'&&editor().querySelector('.cm-lineNumbers').textContent.includes('1'));
      check('code mode shows original Markdown',editor().querySelector('.cm-content').textContent.includes('![[示例 图.png]]'));
      await mode('左右分栏');await wait(()=>get('.split-source .cm-content'),'source pane');await new Promise(r=>setTimeout(r,800));
      check('split source has line numbers and preview hides them',getComputedStyle(get('.split-source .cm-gutters')).display!=='none'&&getComputedStyle(get('.split-main .cm-gutters')).display==='none');
      check('split source wraps independently of the preview',!get('.split-source .cm-split-projected-break'));
      const wordRect=(root,text)=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);for(let node;node=walker.nextNode();){const at=node.textContent.indexOf(text);if(at>=0){const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+text.length);return range.getClientRects()[0];}}return null;};
      for(const text of ['整合验收','最终入口：']){const a=wordRect(get('.split-source .cm-content'),text),b=wordRect(get('.split-main .cm-content'),text);check('split paragraph start alignment '+text,!!a&&!!b&&Math.abs(a.top-b.top)<=3,{source:a?.top,preview:b?.top});}
      check('source prose wraps at its own boundary',getComputedStyle(get('.split-source .cm-content')).whiteSpace==='pre-wrap');
      const sourceBounds=get('.split-source .cm-scroller').getBoundingClientRect();let sourceRight=0;
      const sourceText=document.createTreeWalker(get('.split-source .cm-content'),NodeFilter.SHOW_TEXT);
      for(let node;node=sourceText.nextNode();){if(node.parentElement?.closest('.cm-code-nowrap'))continue;const range=document.createRange();range.selectNodeContents(node);for(const rect of range.getClientRects())sourceRight=Math.max(sourceRight,rect.right);}
      check('source prose remains inside its split pane',sourceRight<=sourceBounds.right+1,{sourceRight,paneRight:sourceBounds.right});
      const table=()=>get('.split-main [data-table-widget]');await wait(()=>table()?.querySelector('[data-table-action="column-after"]'),'table actions');table().querySelector('textarea[data-row="1"][data-col="0"]').focus();table().querySelector('[data-table-action="column-after"]').click();await pause();check('table quick insert renders three columns',table().querySelectorAll('th').length===3);
      const editableCell=table().querySelector('[data-cell="1:0"]');editableCell.querySelector('.cm-table-cell-preview').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await pause();const input=editableCell.querySelector('textarea');check('table preview enters source editing on double click',!input.hidden);Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'整合联动内容');input.dispatchEvent(new Event('input',{bubbles:true}));await pause();check('live table edit updates source',get('.split-source .cm-content').textContent.includes('整合联动内容'));input.blur();input.dispatchEvent(new FocusEvent('blur'));await pause();check('table returns to rendered cell on synthetic blur',!table().querySelector('[data-cell="1:0"] .cm-table-cell-preview').hidden);
      get('[aria-label="设置"]').click();
      await wait(()=>get('.settings-page'),'settings');
      [...document.querySelectorAll('[aria-label="设置分类"] button')].find(button=>button.textContent==='外观').click();
      await wait(()=>get('.theme-current-scheme'),'current color scheme');
      const currentScheme=get('.theme-current-scheme'),schemeName=currentScheme.textContent;
      currentScheme.textContent='较长的主题方案名称'.repeat(14);
      try{
        check('a long scheme name can use its whole row and wrap',currentScheme.clientWidth>=currentScheme.parentElement.clientWidth-1&&currentScheme.scrollWidth<=currentScheme.clientWidth+1&&getComputedStyle(currentScheme).textAlign==='right');
      }finally{currentScheme.textContent=schemeName;}
      const customColors=()=>[...document.querySelectorAll('.theme-settings button')]
        .find(button=>button.textContent.includes('进入自定义配色'));
      await wait(customColors,'custom colors entry');
      customColors().click();
      const editorColors=()=>get('.theme-custom-colors .editor-color-settings');
      await wait(()=>get('dialog.child-window-custom-color-settings[open]')&&editorColors(),'custom color child dialog');
      check('appearance settings remain behind the custom color dialog',!!get('.theme-current-scheme'));
      const editorColorGroup=editorColors().closest('details');
      editorColorGroup.querySelector('summary').click();
      await wait(()=>editorColorGroup.open,'expanded editor colors');
      check('editor page colors and alpha controls are integrated',get('.editor-color-settings').querySelectorAll('input[type=color]').length===17&&get('.editor-color-settings').querySelectorAll('input[type=range]').length===10);
      const highlight=get('[aria-label="正文高亮颜色值"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(highlight,'#bb6d3277');highlight.dispatchEvent(new Event('input',{bubbles:true}));
      await wait(()=>document.documentElement.style.getPropertyValue('--hive-editor-text-highlight-background')==='#bb6d3277','apply scheme-specific text highlight color');
      check('text highlighting has its own theme color',document.documentElement.style.getPropertyValue('--hive-editor-selection-background')!=='#bb6d3277');
      const inputThemeColor=(label,value)=>{
        const field=get('[aria-label="'+label+'"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,value);
        field.dispatchEvent(new Event('input',{bubbles:true}));
      };
      inputThemeColor('选区底色颜色值','#b374d977');
      await wait(()=>document.documentElement.style.getPropertyValue('--hive-editor-selection-background')==='#b374d977','apply selection fill');
      inputThemeColor('选区线框颜色值','#207f9bdd');
      await wait(()=>document.documentElement.style.getPropertyValue('--hive-editor-selection-border')==='#207f9bdd','apply selection border');
      check('editor selection fill and border are independently configurable',
        document.documentElement.style.getPropertyValue('--hive-editor-selection-background')==='#b374d977'&&
        document.documentElement.style.getPropertyValue('--hive-editor-text-highlight-background')==='#bb6d3277');
      get('[aria-label="关闭自定义配色"]').click();
      await wait(()=>!get('dialog.child-window-custom-color-settings'),'close custom color child');
      check('closing custom colors returns to the appearance settings',!!get('.theme-current-scheme'));
      get('[aria-label="关闭设置"]').click();await pause();
      get('[aria-label="切换仓库"]').click();await wait(()=>get('.recent-repositories-manage'),'recent repository menu');
      get('.recent-repositories-manage').click();await wait(()=>get('.repository-card'),'repository manager');check('shared repository manager is integrated',!!get('.repository-current')&&!!get('.repository-rename')&&!get('.repository-auto-save'));
      [...get('.repository-card-actions').querySelectorAll('button')].find(b=>b.textContent.includes('返回写作')).click();await pause();
      const build=await(await fetch('/build-info.json')).json();check('current build metadata is present',build.version===${JSON.stringify(expectedVersion)}&&!!build.buildNumber);
      const menuAction=async(path,text)=>{const row=get('.explorer-row[data-path="'+path+'"]');if(!row)throw Error('Missing file '+path);row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:110,clientY:240}));await wait(()=>get('.explorer-menu'),'file menu');const button=[...get('.explorer-menu').querySelectorAll('button')].find(b=>b.textContent.includes(text));if(!button)throw Error('Missing menu '+text);button.click();await pause();};
      const trash=async path=>{await menuAction(path,'删除到回收站');await wait(()=>get('dialog[aria-label="删除到回收站"]'),'delete confirmation');[...get('dialog[aria-label="删除到回收站"]').querySelectorAll('button')].find(b=>b.textContent==='移到回收站').click();await wait(()=>!get('.explorer-row[data-path="'+path+'"]'),'delete complete');await pause();};
      const open=async(path,text)=>{get('.explorer-row[data-path="'+path+'"]').click();await wait(()=>get('.document-pane .cm-content')?.textContent.includes(text),'open '+path);};
      await open('删除当前.md','删除当前唯一内容');await trash('删除当前.md');
      check('deleting the current document removes its content and returns to landing',!!get('.document-new-page')&&!get('.document-pane')?.textContent.includes('删除当前唯一内容'));
      check('deleted file is absent from disk',(await fetch('/api/file?path='+encodeURIComponent('删除当前.md'))).status===404);
      get('.document-tab-close')?.click();await pause();check('closing deleted document does not demand save or duplicate',!document.body.textContent.includes('文档未能保存或保存期间有新修改'));
      await open('整合验收.md','整合验收');await menuAction('删除其他.md','在新标签页中打开');await wait(()=>get('.document-pane .cm-content')?.textContent.includes('删除其他唯一内容'),'open other tab');
      await trash('删除其他.md');check('deleting another document preserves the existing document',get('.document-pane .cm-content')?.textContent.includes('整合验收')&&!get('.document-pane')?.textContent.includes('删除其他唯一内容'));
      const folder=get('.explorer-row[data-path="删除文件夹"]');folder.click();await wait(()=>get('.explorer-row[data-path="删除文件夹/子稿.md"]'),'expand delete folder');await open('删除文件夹/子稿.md','后代删除唯一内容');await trash('删除文件夹');
      check('deleting a folder removes its open descendant content',!get('.document-pane')?.textContent.includes('后代删除唯一内容'));
      await open('整合验收.md','整合验收');
      const composer=()=>get('.conversation-view textarea');
      const writeTextarea=(area,value)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,value);area.dispatchEvent(new Event('input',{bubbles:true}));};
      const writePrompt=value=>writeTextarea(composer(),value);
      const send=async()=>{await wait(()=>!get('[aria-label="发送给 AI"]')?.disabled&&get('[aria-label="发送给 AI"]'),'ready to send');get('[aria-label="发送给 AI"]').click();};
      const closeTab=(path,id)=>[...document.querySelectorAll('.document-tab-close')].find(button=>button.getAttribute('aria-label')==='关闭'+path+'标签页'&&button.getClientRects().length&&(!id||(button.closest('.workspace-tab-item')?.querySelector('[data-panel-tab]')?.dataset.panelTab||button.closest('[data-panel-id]')?.dataset.panelId)===id))?.click();
      const activeDocument=()=>get('.active-editor .split-main .cm-content')?.cmTile?.root?.view;
      const select=source=>{const v=activeDocument(),from=v.state.doc.toString().indexOf(source);if(from<0)throw Error('Missing selection '+source);v.dispatch({selection:{anchor:from,head:from+source.length}});};
      const chatMode=async text=>{get('[aria-label="切换写作模式"]').click();await wait(()=>get('.writing-mode-menu'),'writing modes');[...get('.writing-mode-menu').querySelectorAll('button')].find(button=>button.textContent===text).click();await pause();};
      const fileText=async path=>(await(await fetch('/api/file?path='+encodeURIComponent(path))).json()).text;
      const currentChat=()=>get('.messages').textContent;
      const activeTabText=()=>get('.active-editor')?.textContent||'';
      const reviewButton=path=>[...document.querySelectorAll('.messages .chat-context')].find(item=>item.textContent.includes(path))?.querySelector('button');
      const comparison=()=>get('.active-editor .proposal-comparison');
      const candidate=()=>comparison()?.querySelector('textarea[aria-label="编辑润色结果"]');

      await open('对话甲.md','甲稿原句');
      writePrompt('跨标签讨论消息');
      await send();
      closeTab('对话甲.md','editor');
      await wait(()=>get('.active-editor .document-new-page'),'close last document while discussion runs');
      await wait(()=>currentChat().includes('【交互演示】'),'discussion finishes after closing last document');
      check('discussion survives closing the last document during generation',currentChat().includes('跨标签讨论消息'));
      writePrompt('未发送草稿留在同一个对话');
      await open('对话甲.md','甲稿原句');
      await menuAction('对话乙.md','在新标签页中打开');
      await wait(()=>activeTabText().includes('乙稿原句'),'open second document without clearing draft');
      closeTab('对话乙.md');
      await wait(()=>activeTabText().includes('甲稿原句'),'close second document');
      check('history and unsent draft survive switching and closing documents',currentChat().includes('跨标签讨论消息')&&composer().value==='未发送草稿留在同一个对话');

      await menuAction('对话甲.md','在新标签页中打开');
      await wait(()=>get('.workspace-tabs [data-panel-tab="editor"]'),'same-file editor tabs');
      const siblingTab=[...document.querySelectorAll('.workspace-tabs [data-panel-tab]')].find(tab=>tab.dataset.panelTab!=='editor'&&tab.textContent==='对话甲.md');
      get('.workspace-tabs [data-panel-tab="editor"]').click();
      await wait(()=>get('.active-editor[data-panel-id="editor"]'),'select primary copy for proposal');
      await chatMode('轻量修改');
      const primary=activeDocument(),primaryEnd=primary.state.doc.length;
      primary.dispatch({changes:{from:primaryEnd,insert:'手写尾句。'},userEvent:'input.type'});
      select('甲稿原句');
      writePrompt('把“甲稿原句”改成“甲稿建议”');
      await send();
      await wait(()=>candidate()?.value==='甲稿建议','primary polish comparison');
      check('polish compares the complete candidate below unchanged original body and disk',
        get('.active-editor .proposal-original')?.textContent==='甲稿原句'&&activeDocument().state.sliceDoc().includes('甲稿原句。手写尾句。')&&
        !activeDocument().state.sliceDoc().includes('甲稿建议')&&(await fileText('对话甲.md')).endsWith('甲稿原句。')&&
        comparison().getBoundingClientRect().top>get('.active-editor .proposal-original').getBoundingClientRect().bottom);
      writePrompt('审阅期间保留的草稿');
      closeTab('对话甲.md','editor');
      await wait(()=>get('.active-editor .document-new-page')&&reviewButton('对话甲.md'),'park primary proposal');
      check('closing primary keeps pending suggestion unsaved and retains the chat draft',(await fileText('对话甲.md')).includes('甲稿原句')&&!(await fileText('对话甲.md')).includes('甲稿建议')&&composer().value==='审阅期间保留的草稿');
      get('[data-panel-tab="'+siblingTab.dataset.panelTab+'"]').click();
      await wait(()=>activeTabText().includes('甲稿原句')&&activeTabText().includes('手写尾句。'),'select a mirrored view of the pending proposal');
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}));
      await wait(()=>document.body.textContent.includes('这段 AI 建议还没确认'),'saving the mirrored preview is blocked');
      check('saving another tab for the same file cannot commit the pending proposal',!(await fileText('对话甲.md')).includes('甲稿建议'));
      reviewButton('对话甲.md').click();
      await wait(()=>candidate()?.value==='甲稿建议'&&activeTabText().includes('手写尾句。'),'restore primary proposal with pre-existing manual edit');
      comparison().querySelector('.proposal-cancel').click();
      await wait(()=>!comparison()&&activeTabText().includes('甲稿原句'),'reject restored primary proposal');
      check('review restores original text and keeps the unsent message',composer().value==='审阅期间保留的草稿'&&activeTabText().includes('手写尾句。'));

      select('甲稿原句');
      const markView=activeDocument(),{from:markFrom,to:markTo}=markView.state.selection.main;
      markView.dom.dispatchEvent(new CustomEvent('hive:table-annotation',{detail:{action:'mark',ranges:[{from:markFrom,to:markTo}]}}));
      const linkedPencil=()=>get('.active-editor .annotation-bubble[title*="甲稿原句"]');
      await wait(linkedPencil,'source annotation for the linked comparison');
      writePrompt('把“甲稿原句”改成“关联批注的建议”');
      await send();
      await wait(()=>candidate()?.value==='关联批注的建议','linked polish comparison');
      get('[data-panel-tab="'+siblingTab.dataset.panelTab+'"]').click();
      await wait(()=>reviewButton('对话甲.md')&&linkedPencil(),'linked comparison parked in the mirrored tab');
      const deletePrompt=()=>get('dialog.annotation-delete-confirm[open]');
      linkedPencil().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));
      await wait(deletePrompt,'confirm deleting the linked annotation');
      check('asking to delete keeps the annotation and linked comparison',!!reviewButton('对话甲.md')&&!!linkedPencil());
      deletePrompt().querySelector('button').click();
      await wait(()=>!deletePrompt(),'cancel annotation deletion');
      check('declining keeps the matching review parked in the other copy',!!reviewButton('对话甲.md')&&!!linkedPencil());
      linkedPencil().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));
      await wait(deletePrompt,'reopen delete confirmation');
      deletePrompt().querySelector('.annotation-delete-danger').click();
      await wait(()=>!reviewButton('对话甲.md')&&!linkedPencil(),'confirmed deletion clears the matching review parked in the other copy');
      check('annotation cancellation clears the linked comparison across two tabs without changing the body',activeDocument().state.sliceDoc().includes('甲稿原句。手写尾句。'));

      await menuAction('对话乙.md','在新标签页中打开');
      await wait(()=>activeTabText().includes('乙稿原句'),'open second document for proposal');
      select('乙稿原句');
      writePrompt('把“乙稿原句”改成“乙稿建议”');
      await send();
      await wait(()=>candidate()?.value==='乙稿建议','secondary polish comparison');
      closeTab('对话乙.md');
      await wait(()=>reviewButton('对话乙.md'),'park secondary proposal');
      check('closing secondary preserves the uncommitted proposal',(await fileText('对话乙.md')).includes('乙稿原句')&&!(await fileText('对话乙.md')).includes('乙稿建议'));
      get('.explorer-row[data-path="对话乙.md"]').click();
      await wait(()=>candidate()?.value==='乙稿建议','reopen secondary proposal by file path');
      comparison().querySelector('.proposal-refine-button').click();
      await wait(()=>comparison()?.querySelector('.proposal-refine textarea'),'lower candidate annotation');
      writeTextarea(comparison().querySelector('.proposal-refine textarea'),'把“乙稿建议”改成“乙稿二次建议”');
      comparison().querySelector('.proposal-refine button[type="submit"]').click();
      check('the prior candidate stays available while new polish is running',candidate()?.value==='乙稿建议'&&activeDocument().state.sliceDoc().includes('乙稿原句'));
      await wait(()=>candidate()?.value==='乙稿二次建议','refine the lower candidate');
      writeTextarea(candidate(),'乙稿人工定稿');
      comparison().querySelector('.proposal-accept').click();
      await wait(()=>!comparison()&&activeDocument().state.sliceDoc().includes('乙稿人工定稿'),'accept the manually edited candidate on the original document');
      check('acceptance writes only the selected range in its own editor',activeDocument().state.sliceDoc().endsWith('乙稿人工定稿。')&&(await fileText('对话乙.md')).endsWith('乙稿原句。')&&!(await fileText('对话甲.md')).includes('乙稿人工定稿'));
      get('.header-help[aria-label="历史记录"]').click();
      await wait(()=>get('.history-page [role="tablist"]'),'open history journal');
      [...document.querySelectorAll('.history-page [role="tab"]')].find(button=>button.textContent==='AI 操作').click();
      const historyAction=title=>[...document.querySelectorAll('.history-detail .history-actions button')].find(button=>button.textContent===title);
      await wait(()=>historyAction('撤回这次改动')&&!historyAction('撤回这次改动').disabled,'history adoption entry');
      historyAction('撤回这次改动').click();
      await wait(()=>historyAction('重新应用')&&!historyAction('重新应用').disabled,'undo the adoption through operation history');
      get('[aria-label="关闭历史记录"]').click();
      await wait(()=>candidate()?.value==='乙稿人工定稿','recover the exact accepted candidate from the history journal');
      check('history undo restores original body and both comparison boxes',activeDocument().state.sliceDoc().endsWith('乙稿原句。')&&!!get('.active-editor .proposal-original'));
      comparison().querySelector('.proposal-accept').click();
      await wait(()=>!comparison(),'reaccept the restored comparison');
      get('.active-editor [aria-label="撤回 AI 修改"]').click();
      await wait(()=>candidate()?.value==='乙稿人工定稿','inline undo also restores the comparison');
      check('inline undo restores exact accepted candidate and original',activeDocument().state.sliceDoc().endsWith('乙稿原句。')&&!!get('.active-editor .proposal-original'));
      await new Promise(resolve=>setTimeout(resolve,900));
      return {checks,build};
    })()`);
    assert.deepEqual(errors,[],'Renderer console errors');await fs.writeFile(path.join(output,prefix+'-app-preview.png'),(await win.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(output,prefix+'-app-validation.json'),JSON.stringify({passed:true,method:'Hidden nonfocusable Electron, complete frozen integrated frontend and isolated real backend; synthetic DOM events, no desktop input.',...result,consoleErrors:errors},null,2)+'\n');console.log(JSON.stringify({passed:true,checks:result.checks.length,build:result.build}));win.destroy();app.exit(0);
  }catch(error){await fs.writeFile(path.join(output,prefix+'-app-failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error.stack);win.destroy();app.exit(1);}
}
if(process.argv.includes('--integrated-worker'))void worker().catch(error=>{console.error(error.stack);require('electron').app.exit(1);});
else{
  await fs.mkdir(output,{recursive:true});const temp=await fs.mkdtemp(path.join(output,'.app-check-'));let server,serverLog='';
  try{
    const docs=path.join(temp,'documents');await fs.mkdir(path.join(docs,'章节'),{recursive:true});
    await fs.writeFile(path.join(docs,'章节/一.md'),'内部验证文稿。');
    await fs.writeFile(path.join(docs,'删除当前.md'),'删除当前唯一内容。');await fs.writeFile(path.join(docs,'删除其他.md'),'删除其他唯一内容。');await fs.mkdir(path.join(docs,'删除文件夹'));await fs.writeFile(path.join(docs,'删除文件夹/子稿.md'),'后代删除唯一内容。');
    await fs.writeFile(path.join(docs,'对话甲.md'),'# 对话甲\n\n甲稿原句。');await fs.writeFile(path.join(docs,'对话乙.md'),'# 对话乙\n\n乙稿原句。');
    await fs.writeFile(path.join(docs,'示例 图.png'),fixtureImage);
    const fence=String.fromCharCode(96).repeat(3);
    await fs.writeFile(path.join(docs,'编辑显示验收.md'),['正文 <mark>主题高亮</mark>。','',fence+'csharp','log 1','','log 2',fence,'','代码后正文。'].join('\n'));
    const paragraph='这是用于整合验证的中文与 English mixed text，数字 12345、标点和很长的网址 https://example.org/research/2026/notes?language=English&version=12345 都保持原文。';
    await fs.writeFile(path.join(docs,'整合验收.md'),'# 整合验收\n\n> **最终入口：** '+paragraph.repeat(2)+'\n\n![[示例 图.png]]\n\n- [ ] 整合待办\n\n| 标题甲 | 标题乙 |\n| :--- | ---: |\n| 内容甲 | 内容乙 |\n\n这是本轮合成资料，不含用户文稿。\n');
    const resources=packaged?path.join(bundle,'win-unpacked','resources'):undefined;
    server=launchBackend({root:project,resources,env:{HIVE_PORT:'0',HIVE_DOCUMENTS:docs,HIVE_STATE_DIR:path.join(temp,'state'),HIVE_API_KEY:''},onLine:line=>serverLog+=line+'\n',onError:line=>serverLog+=line});
    const backend=await server.ready;
    const {port}=backend;
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const hostFlags=env.HIVE_TEST_ELECTRON_NO_SANDBOX==='1'?['--no-sandbox']:[];
    const child=spawn((await import('electron')).default,[...hostFlags,fileURLToPath(import.meta.url),'--integrated-worker',...(packaged?['--package']:[]),String(port),temp],{cwd:project,windowsHide:true,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Integrated UI timeout'));},45000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});await fs.writeFile(path.join(output,prefix+'-app.log'),log);console.log(log);assert.equal(code,0);
  }finally{await fs.writeFile(path.join(output,prefix+'-server.log'),serverLog);await server?.stop();const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(output));assert.ok(path.basename(resolved).startsWith('.app-check-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
