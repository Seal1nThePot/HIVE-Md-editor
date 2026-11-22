import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer as createHttpServer} from 'node:http';
import {createRequire} from 'node:module';
import {fork, spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const out = path.resolve(process.env.HIVE_WINDOW_TOOLS_EVIDENCE || path.join(root, '.runtime/checks/window-tools'));
const repositoriesOnly = process.env.HIVE_WINDOW_TOOLS_REPOSITORIES_ONLY === '1';
const input = 'textarea[aria-label="向 AI 描述想法或修改要求"]';
const chip = label => '[aria-label="移除' + label + '窗口标注"]';
const panel = id => '[data-lock-panel="' + id + '"] b';
const secondWorkspace = 'beta-repository';
const newRepository = 'AutoCreated';

async function verify(port, profile, statusPort) {
  const {app, BrowserWindow} = require('electron');
  app.setPath('userData', path.join(profile, 'electron'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({show: false, focusable: false, skipTaskbar: true, width: 1600, height: 1000,
    webPreferences: {offscreen: true, contextIsolation: true, backgroundThrottling: false}});
  const cdp = win.webContents.debugger;
  const js = expression => win.webContents.executeJavaScript(expression);
  const element = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const visible = selector => element(selector) + '?.checkVisibility({checkVisibilityCSS:true})';
  const click = selector => js(element(selector) + '.click()');
  const value = text => JSON.stringify(text);
  const checks = [];
  const wait = async (expression, label = expression) => {
    const until = Date.now() + 7000;
    do {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 35));
    } while (Date.now() < until);
    throw Error('Timed out: ' + label + ' ' + await js('document.querySelector(".error-toast")?.textContent') + ' ' +
      await js('[...document.querySelectorAll(".messages .assistant")].map(e=>e.textContent).at(-1)'));
  };
  const check = (name, passed) => {
    checks.push({name, passed: !!passed});
    assert.ok(passed, name);
    console.log('PASS ' + name);
  };
  async function mark(id) {
    const title = panel(id), tab = '[data-panel-tab="' + id + '"]';
    await wait(visible(title) + ' || ' + visible(tab), title);
    const selector = await js(visible(title)) ? title : tab;
    const point = await js('(()=>{const node=' + element(selector) + ';const r=node.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()');
    for (const [type, buttons] of [['mousePressed', 1], ['mouseReleased', 0]])
      await cdp.sendCommand('Input.dispatchMouseEvent', {type, ...point, buttons, modifiers: 2, button: 'left', clickCount: 1});
  }
  async function showChat() {
    if (!await js(visible(input))) await click('[aria-label="打开 AI 面板"]');
    await wait(visible(input), 'chat composer');
  }
  async function send(text, reply) {
    await showChat();
    await js(element(input) + '.focus();' + element(input) + '.select()');
    await cdp.sendCommand('Input.insertText', {text});
    await click('button[aria-label="发送给 AI"]');
    if (reply) await wait('[...document.querySelectorAll(".messages .assistant")].at(-1)?.textContent.includes(' + value(reply) + ')', reply);
  }
  const status = async () => (await fetch('http://127.0.0.1:' + statusPort + '/state')).json();
  async function openRepositories(){
    await wait(visible('[aria-label="切换仓库"]'));
    await click('[aria-label="切换仓库"]');
    await wait(visible('.recent-repositories-manage'));
    await click('.recent-repositories-manage');
  }
  async function dialogClose() {
    await js(element('dialog.trash-confirm') + '.dispatchEvent(new Event("cancel",{cancelable:true}))');
    await wait('!document.querySelector("dialog.trash-confirm")');
  }
  try {
    cdp.attach('1.3');
    await win.loadURL('http://127.0.0.1:' + port);
    await openRepositories();
    await mark('repositories');
    await send('列出仓库', 'beta-repository');
    const list = await js('[...document.querySelectorAll(".messages .assistant")].at(-1).textContent');
    check('The annotated repository panel lists both repositories', list.includes('alpha-repository') && list.includes(secondWorkspace));
    await mark('repositories');
    await send('创建名为 AutoCreated 的仓库', '你要在哪个目录创建');
    check('Missing directory keeps the original repository mark and creates nothing', await js(visible(chip('仓库管理'))) && !(await status()).createdRepository);
    await send(path.join(profile, 'new-repositories'), '已创建仓库');
    await wait('document.querySelector(".repository-page")?.textContent.includes("AutoCreated")', 'repository cards update');
    check('An absolute path alone resumes and registers the original named repository', (await status()).createdRepository && !(await js(visible(chip('仓库管理')))));

    if (!repositoriesOnly) {
      await openRepositories();
      await mark('files');
      await send('列出根目录', 'alpha-only.md');
      const list = await js('[...document.querySelectorAll(".messages .assistant")].at(-1).textContent');
      check('File listing from the annotated document window stays in Alpha', list.includes('alpha-only.md') && !list.includes('beta-only.md'));
      await mark('files');
      await send('新建文件夹 AI-Folder', '已新建 AI-Folder');
      await mark('files');
      await send('在根目录新建 AI-Note', '已新建 AI-Note.md');
      check('Folder and file creation use Alpha only', (await status()).alphaCreated && !(await status()).betaCreated);
      await mark('files');
      await send('把 alpha-only.md 移到回收站', '已移入回收站');
      check('Document trash changes Alpha only', !(await status()).alphaPresent && (await status()).betaPresent);

      await click('.sidebar-trash-footer button');
      await mark('trash');
      await send('恢复 alpha-only.md', '已恢复 alpha-only.md');
      check('Restoring via the annotated trash window restores the requested file', (await status()).alphaPresent);
      await mark('trash');
      await send('永久删除 delete-one.md 和 delete-two.md', '确认要永久删除的 2 项');
      await wait('document.querySelector("dialog.trash-confirm")?.open', 'permanent delete confirmation');
      const dialog = await js('document.querySelector("dialog.trash-confirm").textContent');
      check('Permanent-delete dialog lists only the requested items and has made no changes',
        dialog.includes('delete-one.md') && dialog.includes('delete-two.md') && !dialog.includes('keep.md') && (await status()).selectedTrash === 2);
      await click('dialog.trash-confirm button:not(.trash-confirm-danger)');
      await wait('!document.querySelector("dialog.trash-confirm")');
      check('Cancel keeps all selected items in the trash', (await status()).selectedTrash === 2);

      await mark('trash');
      await send('永久删除 delete-one.md 和 delete-two.md');
      await wait('document.querySelector("dialog.trash-confirm")?.open');
      await dialogClose();
      check('Closing the confirmation leaves the selected items in the trash', (await status()).selectedTrash === 2);

      await mark('trash');
      await send('永久删除 delete-one.md 和 delete-two.md');
      await wait('document.querySelector("dialog.trash-confirm")?.open');
      await click('dialog.trash-confirm .trash-confirm-danger');
      await wait('!document.querySelector("dialog.trash-confirm")');
      const final = await status();
      check('Explicit confirm deletes only the listed items', final.selectedTrash === 0 && final.keepTrash);

      await openRepositories();
      await click('[aria-label="仓库：beta-repository"] .repository-card-actions > button');
      await wait(visible('[data-path="beta-only.md"]'), 'Beta becomes the active repository');
      await mark('files');
      await send('在根目录新建 Beta-Plan', '已新建 Beta-Plan.md');
      check('The same document action binds Beta after switching repositories', (await status()).betaSpecific && !(await status()).alphaSpecific);
    }
  } catch (error) {
    console.error(error);
    checks.push({name: 'harness', passed: false, error: error.stack});
  } finally {
    await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
    win.destroy();
    app.exit(checks.every(check => check.passed) ? 0 : 1);
  }
}

async function run() {
  await fs.mkdir(out, {recursive: true});
  const profile = await fs.mkdtemp(path.join(out, 'window-tools-profile-'));
  const state = path.join(profile, 'state');
  const alpha = path.join(profile, 'alpha-repository');
  const beta = path.join(profile, secondWorkspace);
  const newParent = path.join(profile, 'new-repositories');
  await Promise.all([state, alpha, beta, newParent, path.join(profile, 'electron')].map(dir => fs.mkdir(dir)));
  await fs.writeFile(path.join(state, 'workspace.json'), JSON.stringify({root: alpha, autoSave: false, revision: 0}));
  await Promise.all(['alpha-only.md','delete-one.md','delete-two.md','keep.md'].map(name => fs.writeFile(path.join(alpha, name), '# '+name)));
  await fs.writeFile(path.join(beta, 'beta-only.md'), '# Beta only');
  let base;
  const exists = name => fs.access(name).then(() => true, () => false);
  const stub = createHttpServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/state') {
      const trash = await (await fetch(base + '/api/explorer/trash')).json();
      res.end(JSON.stringify({
        createdRepository: await exists(path.join(newParent, newRepository)),
        alphaCreated: await exists(path.join(alpha, 'AI-Folder')) && await exists(path.join(alpha, 'AI-Note.md')),
        betaCreated: await exists(path.join(beta, 'AI-Folder')) || await exists(path.join(beta, 'AI-Note.md')),
        betaSpecific: await exists(path.join(beta, 'Beta-Plan.md')),
        alphaSpecific: await exists(path.join(alpha, 'Beta-Plan.md')),
        alphaPresent: await exists(path.join(alpha, 'alpha-only.md')),
        betaPresent: await exists(path.join(beta, 'beta-only.md')),
        selectedTrash: trash.filter(item => ['delete-one.md','delete-two.md'].includes(item.path)).length,
        keepTrash: trash.some(item => item.path === 'keep.md'),
      }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const text = body.messages.findLast(message => message.role === 'user').content;
    const action = text === '列出仓库' ? ['list_repositories', {}]
      : text.includes('创建名为') ? ['create_repository', {name: newRepository}]
      : text === newParent ? ['create_repository', {name: 'DifferentName', parent: newParent}]
      : text === '列出根目录' ? ['list_folder', {}]
      : text.includes('新建文件夹') ? ['create_folder', {name: 'AI-Folder'}]
      : text.includes('新建 AI-Note') ? ['create_file', {name: 'AI-Note'}]
      : text.includes('新建 Beta-Plan') ? ['create_file', {name: 'Beta-Plan'}]
      : text.includes('移到回收站') ? ['trash_file', {path: 'alpha-only.md'}]
      : text.startsWith('恢复') ? ['restore_trash', {targets: ['alpha-only.md']}]
      : ['confirm_trash_delete', {targets: ['delete-one.md','delete-two.md']}];
    assert.ok(body.tools.some(tool => tool.function.name === action[0]), action[0] + ' was not offered');
    res.end(JSON.stringify({choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{
      id: 'fixture', type: 'function', function: {name: action[0], arguments: JSON.stringify(action[1])},
    }]}}]}));
  });
  await new Promise((resolve, reject) => { stub.once('error', reject); stub.listen(0, '127.0.0.1', resolve); });
  const backendPath = path.resolve(process.env.HIVE_WINDOW_TOOLS_SERVER || path.join(root, 'server/index.mjs'));
  const backend = fork(backendPath, ['--production'], {
    cwd: path.dirname(path.dirname(backendPath)), silent: true, windowsHide: true,
    env: {...process.env, HIVE_PORT: '0', HIVE_STATE_DIR: state, HIVE_DOCUMENTS: alpha, HIVE_API_KEY: ''},
  });
  backend.stdout.resume();
  backend.stderr.pipe(process.stderr);
  let vite;
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Backend startup timed out')), 12000);
      backend.once('error', reject);
      backend.on('message', msg => { if (msg?.type === 'hive-ready') { clearTimeout(timer); resolve(msg.port); } });
    });
    base = 'http://127.0.0.1:' + port;
    const post = async (route, data) => {
      const response = await fetch(base + '/api' + route,{method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
      assert.ok(response.ok, route + ' ' + await response.clone().text());
      return response.json();
    };
    await post('/config', {endpoint: 'http://127.0.0.1:' + stub.address().port + '/v1', model: 'tools-fixture', key: 'test', demo: false});
    const workspace = await (await fetch(base + '/api/workspace')).json();
    await post('/workspace/repositories', {action: 'add', root: beta, revision: workspace.revision});
    for (const path of ['delete-one.md','delete-two.md','keep.md']) await post('/explorer', {action: 'trash', path});
    const {createServer} = await import('vite');
    vite = await createServer({root, cacheDir: path.join(profile, '.vite'), server: {
      host: '127.0.0.1', port: 0, hmr: false,
      proxy: {'/api': {target: base, changeOrigin: true, configure(proxy) { proxy.on('proxyReq', req => req.setHeader('origin', base)); }}},
    }});
    await vite.listen();
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    const flags = ['--user-data-dir=' + path.join(profile, 'electron')];
    if (process.env.HIVE_TEST_ELECTRON_NO_SANDBOX === '1') flags.push('--no-sandbox');
    const child = spawn((await import('electron')).default,
      [...flags, entry, '--worker', vite.httpServer.address().port, profile, stub.address().port],
      {cwd: root, env, windowsHide: true, stdio: 'inherit'});
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('Hidden Electron timed out')); }, 90000);
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(code, 0, 'See checks.json');
  } finally {
    if (vite) await vite.close();
    if (backend.exitCode === null && backend.signalCode === null)
      await new Promise(resolve => { backend.once('exit', resolve); backend.kill(); });
    stub.closeAllConnections();
    await new Promise(resolve => stub.close(resolve));
    const resolved = await fs.realpath(profile);
    assert.equal(path.dirname(resolved), await fs.realpath(out));
    assert.ok(path.basename(resolved).startsWith('window-tools-profile-'));
    await fs.rm(resolved, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
}

const worker = process.argv.indexOf('--worker');
if (worker !== -1)
  void verify(process.argv[worker + 1], process.argv[worker + 2], process.argv[worker + 3]).catch(error => { console.error(error); require('electron').app.exit(1); });
else
  void run().catch(error => { console.error(error); process.exitCode = 1; });
