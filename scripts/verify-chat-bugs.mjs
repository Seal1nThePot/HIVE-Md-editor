import assert from 'node:assert/strict';
import {fork,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),entry=fileURLToPath(import.meta.url);
const output=path.resolve(process.env.HIVE_VERIFY_CHAT_OUTPUT||path.join(root,'.runtime/checks/chat-bugs'));
const require=createRequire(import.meta.url);
const fence='~~~';
const assistantStart=['## 回复标题','','> **标注 1｜原文与备注**','','- 回复条目','',fence+'md','[1] **字面符号**'].join('\n');
const assistantEnd=['','<literal> & 未解析',fence,'','[回复链接](https://example.test/reply)'].join('\n');
const annotationFile='标注来源.md',otherFile='另一文稿.md';
const quotes=Array.from({length:7},(_,index)=>`选区 ${index+1} 开头。用于证明紧凑气泡不会展开的完整原文尾部 ${index+1}。`);
const manuscript=['# 夹具标注',...quotes].join('\n\n');

async function exercise({annotationFile,otherFile,quotes}){
  const get=selector=>document.querySelector(selector);
  const all=selector=>[...document.querySelectorAll(selector)];
  const shown=element=>element?.checkVisibility({checkVisibilityCSS:true});
  const checks=[];
  const check=(label,passed)=>{
    if(!passed)throw Error(label);
    checks.push(label);
  };
  async function wait(label,predicate){
    for(let tryIndex=0;tryIndex<220;tryIndex++){
      const found=predicate();if(found)return found;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    throw Error('Timeout: '+label+' | '+(get('.error-toast')?.textContent||''));
  }
  const panel=id=>get('[data-panel-id="'+id+'"].workspace-panel');
  const composer=()=>get('.conversation-view textarea');
  const central=()=>get('.dock-ai-button');
  const activeEditor=()=>get('.active-editor .split-main .cm-content')?.cmTile?.root?.view;
  const chatBatches=()=>all('.messages .message.user .chat-annotation-entries');
  const stream=()=>get('.messages .message.thinking');
  async function openFile(file,expected){
    (await wait('file '+file,()=>get('.explorer-row[data-path="'+file+'"]'))).click();
    await wait('editor '+file,()=>activeEditor()?.state.doc.toString().includes(expected));
  }
  async function togglePanel(label){
    get('button[aria-label="面板"]').click();
    (await wait('panel manager',()=>get('[role="switch"][aria-label="'+label+'显示"]'))).click();
    get('button[aria-label="关闭面板管理"]').click();
  }
  function writePrompt(value){
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(composer(),value);
    composer().dispatchEvent(new Event('input',{bubbles:true}));
  }

  await openFile(annotationFile,quotes[0]);
  const originalChat=await wait('initial conversation',()=>shown(panel('conversation'))&&panel('conversation'));
  const userMarkdown=['# 用户标题','','> **用户粗体**','','- 用户条目','',
    '行内 '+String.fromCharCode(96)+'**字面代码**'+String.fromCharCode(96),
    '[有效链接](https://example.test/user)', '',
    '<img src="https://example.test/never" onerror="window.__chatDanger=1">', '',
    '[危险](javascript:window.__chatDanger=2)'].join('\n');
  writePrompt(userMarkdown);
  (await wait('composer send button',()=>{const button=get('[aria-label="发送给 AI"]');return button&&!button.disabled&&button;})).click();
  await wait('unfinished Markdown fence',()=>stream()?.querySelector('pre code')?.textContent.includes('[1] **字面符号**'));
  check('discussion stream retains the fence structure and protocol-looking code',!!stream()?.querySelector('blockquote strong'));
  await wait('completed response',()=>!stream()&&get('.messages .message.assistant'));
  const user=get('.messages .message.user'),assistant=get('.messages .message.assistant');
  check('user and assistant render headings, quotes, bold, lists, and links',
    !!user.querySelector('h1')&&!!user.querySelector('blockquote strong')&&!!user.querySelector('ul li')&&!!
    user.querySelector('a[href="https://example.test/user"]')&&!!assistant.querySelector('h2')&&
    assistant.querySelector('strong')?.textContent==='标注 1｜原文与备注'&&!!assistant.querySelector('ul li')&&
    !!assistant.querySelector('a[href="https://example.test/reply"]'));
  check('inline and fenced code preserve literal punctuation',
    user.querySelector('code')?.textContent==='**字面代码**'&&
    assistant.querySelector('pre code')?.textContent==='[1] **字面符号**\n<literal> & 未解析');
  check('chat never inserts an HTML image or unsafe link',!user.querySelector('img, [onerror], a[href^="javascript:"]')&&!window.__chatDanger);

  await togglePanel('标注');
  const normalRows=()=>all('[data-panel-id="annotations"] .annotation-title-button');
  const selected=new Set();
  async function sendAnnotations(count){
    const current=chatBatches().length;
    await wait('annotation records loaded',()=>normalRows().length===quotes.length);
    const rows=normalRows();
    for(let i=0;i<rows.length;i++){
      if(selected.has(i)===(i<count))continue;
      rows[i].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));
      if(i<count)selected.add(i);else selected.delete(i);
    }
    rows[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:160,clientY:210}));
    const send=await wait('selected annotation send command',()=>
      all('.annotation-title-menu [role="menuitem"]').find(button=>button.textContent===`发送所选标注（${count}）`&&!button.disabled));
    send.click();
    await wait('sent batch '+count,()=>chatBatches().length===current+1&&!stream());
    return chatBatches().at(-1);
  }
  const one=await sendAnnotations(1);
  check('a single annotation is a compact chip',one.querySelectorAll('button').length===1&&
    one.textContent.includes('选区 1')&&!one.closest('.message').textContent.includes(quotes[0]));
  const four=await sendAnnotations(4);
  check('four annotations show four compact chips',four.querySelectorAll('button').length===4&&
    !four.closest('.message').textContent.includes(quotes[3]));
  const five=await sendAnnotations(5);
  check('five annotations retain individual chips',five.querySelectorAll('button').length===5);
  const six=await sendAnnotations(6);
  check('six annotations collapse into one batch button',six.querySelectorAll('button').length===1&&
    six.textContent.trim()==='查看 6 条标注'&&!six.closest('.message').textContent.includes(quotes[5]));

  await openFile(otherFile,'另一篇夹具文稿');
  four.querySelectorAll('button')[2].click();
  await wait('chip opens and selects the original annotation',()=>{
    const editor=activeEditor(),selection=editor?.state.selection.main;
    return editor&&selection&&editor.state.sliceDoc(selection.from,selection.to)===quotes[2];
  });
  check('a chip opens the real note and positions its selection',activeEditor().state.doc.toString().includes(quotes[0]));
  await openFile(otherFile,'另一篇夹具文稿');
  six.querySelector('button').click();
  const batch=await wait('historical batch after changing notes',()=>get('.chat-annotation-batch'));
  check('the batch view identifies this message and shows its exact submitted quotes and notes',
    batch.querySelectorAll('li').length===6&&batch.textContent.includes(quotes[5])&&
    batch.textContent.includes('具体的标注备注 6')&&!batch.textContent.includes(quotes[6]));
  [...batch.querySelectorAll('button')].find(button=>button.textContent==='返回标注列表').click();
  await wait('normal annotation list',()=>!get('.chat-annotation-batch'));
  await togglePanel('标注');

  writePrompt('保留中的未发送对话草稿');
  await togglePanel('查找替换');
  const cover=await wait('open floating search panel',()=>shown(panel('search'))&&panel('search'));
  const box=originalChat.getBoundingClientRect(),point={x:box.left+28,y:box.top+25};
  Object.assign(cover.style,{left:box.left+'px',top:box.top+'px',width:'180px',height:'100px'});
  const hit=()=>document.elementFromPoint(point.x,point.y)?.closest('[data-panel-id]')?.dataset.panelId;
  await wait('search overlaps conversation',()=>hit()==='search');
  central().click();
  await wait('conversation is brought above overlapping panel',()=>hit()==='conversation');
  check('raising the covered conversation preserves surface, history and draft',
    panel('conversation')===originalChat&&composer().value==='保留中的未发送对话草稿'&&chatBatches().length===4);
  central().click();
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  check('repeated activation keeps the conversation open',shown(originalChat)&&central().getAttribute('aria-expanded')==='true');
  await togglePanel('对话');
  await wait('close from panel management',()=>!shown(panel('conversation')));
  central().click();
  await wait('central button opens the closed conversation',()=>shown(panel('conversation')));
  check('reopening through the central button retains current history and draft',composer().value==='保留中的未发送对话草稿'&&chatBatches().length===4);
  return checks;
}

async function worker(port,profile){
  const {app,BrowserWindow}=require('electron');
  app.setPath('userData',path.join(profile,'electron'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1600,height:1000,
    webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  try{
    await win.loadURL('http://127.0.0.1:'+port);
    const checks=await win.webContents.executeJavaScript('('+exercise.toString()+')('+JSON.stringify({annotationFile,otherFile,quotes})+')');
    await fs.writeFile(path.join(output,'chat-bugs.json'),JSON.stringify({
      passed:true,method:'Hidden nonfocusable Electron with isolated repository and local mock SSE model; synthetic DOM events, no desktop input.',checks,
    },null,2)+'\n');
    for(const check of checks)console.log('PASS '+check);
  }catch(error){
    await fs.writeFile(path.join(output,'chat-bugs-failure.png'),(await win.webContents.capturePage()).toPNG());
    throw error;
  }finally{win.destroy();}
  app.exit(0);
}

async function run(){
  await fs.mkdir(output,{recursive:true});
  const profile=await fs.mkdtemp(path.join(output,'chat-test-'));
  const docs=path.join(profile,'documents'),state=path.join(profile,'state');
  let backend,backendLog='';
  const upstream=createServer((request,response)=>{
    if(request.method!=='POST'||request.url!=='/v1/chat/completions'){response.writeHead(404);response.end();return;}
    request.resume();
    response.writeHead(200,{'Content-Type':'text/event-stream'});
    const chunk=content=>'data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n';
    response.write(chunk(assistantStart));
    const completion=setTimeout(()=>response.end(chunk(assistantEnd)+'data: [DONE]\n\n'),650);
    response.on('close',()=>clearTimeout(completion));
  });
  try{
    await Promise.all([fs.mkdir(docs),fs.mkdir(state)]);
    await Promise.all([
      fs.writeFile(path.join(docs,annotationFile),manuscript),
      fs.writeFile(path.join(docs,otherFile),'另一篇夹具文稿'),
      fs.writeFile(path.join(state,'text-annotations.json'),JSON.stringify({
        ['document:'+annotationFile]:{
          revision:1,fingerprint:createHash('sha256').update(manuscript).digest('hex'),
          items:quotes.map((original,index)=>({id:'fixture-'+index,file:annotationFile,source:'document',
            original,from:manuscript.indexOf(original),to:manuscript.indexOf(original)+original.length,
            note:'具体的标注备注 '+(index+1),stale:false,createdAt:new Date(0).toISOString(),order:index})),
        },
      })),
    ]);
    upstream.listen(0,'127.0.0.1');
    await once(upstream,'listening');
    await fs.writeFile(path.join(state,'model.json'),JSON.stringify({demo:false,model:'fixture-model',endpoint:'http://127.0.0.1:'+upstream.address().port+'/v1'}));
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^HIVE_|^ELECTRON_RUN_AS_NODE$/i.test(key)));
    backend=fork(path.join(root,'server/index.mjs'),['--production'],{cwd:root,silent:true,windowsHide:true,env:{...env,
      HIVE_PORT:'0',HIVE_DOCUMENTS:docs,HIVE_STATE_DIR:state,HIVE_APP_DATA_DIR:profile,HIVE_TEMPLATES_DIR:path.join(profile,'templates'),
    }});
    backend.stdout.on('data',chunk=>backendLog+=chunk);
    backend.stderr.on('data',chunk=>backendLog+=chunk);
    const port=await new Promise((resolve,reject)=>{
      const wait=setTimeout(()=>reject(Error('Chat test backend did not start')),15000);
      backend.once('error',reject);
      backend.once('exit',code=>{clearTimeout(wait);reject(Error('Chat test backend exited '+code+'\n'+backendLog));});
      backend.on('message',message=>{if(message?.type==='hive-ready'){clearTimeout(wait);resolve(message.port);}});
    });
    const child=spawn((await import('electron')).default,['--user-data-dir='+path.join(profile,'electron'),entry,'--worker',String(port),profile],{
      cwd:root,env:{...env,HIVE_VERIFY_CHAT_OUTPUT:output},windowsHide:true,stdio:'inherit',
    });
    const code=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{child.kill();reject(Error('Hidden chat test timed out'));},65000);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('exit',status=>{clearTimeout(timeout);resolve(status);});
    });
    assert.equal(code,0,'Hidden chat verification failed');
  }finally{
    if(backend&&backend.exitCode===null&&backend.signalCode===null){
      const stopped=once(backend,'exit');
      backend.kill();
      await stopped;
    }
    if(upstream.listening){const stopped=once(upstream,'close');upstream.close();upstream.closeAllConnections();await stopped;}
    const resolved=await fs.realpath(profile);
    assert.equal(path.dirname(resolved),await fs.realpath(output));
    assert.ok(path.basename(resolved).startsWith('chat-test-'));
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}

if(process.argv.includes('--worker')){
  const workerArg=process.argv.indexOf('--worker');
  void worker(process.argv[workerArg+1],process.argv[workerArg+2]).catch(error=>{
    console.error(error);
    require('electron').app.exit(1);
  });
}else void run().catch(error=>{console.error(error);process.exitCode=1;});
