import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBackend, workspaceBuildPaths } from '../desktop/backendProcess.mjs';

const script = fileURLToPath(import.meta.url);
const project = path.resolve(path.dirname(script), '..');
const initial = '默认.md';
const repositoryName = '导入仓库 中文';
const recoveryName = '读树恢复';
const folder = '笔记';
const childFolder = `${folder}/二级 目录`;
const rootNote = '主文稿.MD';
const childNote = `${childFolder}/百分号% 与 😀.md`;
const externalNote = '外部新增.md';
const unsupported = ['其他.markdown', '忽略.txt', '.隐藏.md'];
const image = `${childFolder}/图片.png`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tS9kAAAAASUVORK5CYII=', 'base64');

async function waitFor(read, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await sleep(40);
  }
  throw new Error(`等待超时：${label}`);
}

function runRenderer(window, callback, ...args) {
  return window.webContents.executeJavaScript(`(${callback})(...${JSON.stringify(args)})`);
}

async function runWorker(port, run, packageRoot) {
  const base = `http://127.0.0.1:${port}`;
  const require = createRequire(import.meta.url);
  const { app, BrowserWindow, ipcMain } = require('electron');
  const archive = path.join(packageRoot, 'resources', 'app.asar');
  const { createRepositoryPicker } = require(path.join(archive, 'desktop', 'repositoryPicker.cjs'));
  const repository = path.join(run, repositoryName);
  const recoveryRepository = path.join(run, recoveryName);
  let picked = repository;
  app.setPath('userData', path.join(run, 'electron-profile'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  ipcMain.on('hive:preferences-read', event => { event.returnValue = {}; });
  ipcMain.on('hive:panel-ready', event => { event.returnValue = false; });
  ipcMain.on('hive:panel-rect', event => { event.returnValue = null; });
  const window = new BrowserWindow({
    show: false, focusable: false, skipTaskbar: true, width: 1280, height: 900,
    webPreferences: {
      preload: path.join(archive, 'desktop', 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, offscreen: true, backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const report = { packageRoot, checks: [], requests: [], pickerCalls: 0, rendererErrors: [] };
  ipcMain.handle('hive:repository-directory', createRepositoryPicker({
    isMainOrigin: event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === base + '/',
    getParent: () => window,
    showOpenDialog: async (parent, options) => {
      assert.equal(parent, window);
      assert.deepEqual(options.properties, ['openDirectory']);
      report.pickerCalls++;
      return { canceled: false, filePaths: [picked] };
    },
  }));
  window.webContents.on('console-message', event => {
    if (event.level === 'error') report.rendererErrors.push(event.message);
  });
  window.webContents.session.webRequest.onCompleted({ urls: [`${base}/api/*`] }, event => {
    report.requests.push({ method: event.method, url: new URL(event.url).pathname, status: event.statusCode });
  });
  const check = (label, condition) => { assert.ok(condition, label); report.checks.push(label); };
  const click = selector => runRenderer(window, selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`缺少操作入口 ${selector}`);
    element.click();
  }, selector);
  const rows = () => runRenderer(window, () => [...document.querySelectorAll('.explorer-tree [data-path]')].map(row => ({
    path: row.dataset.path, level: Number(row.getAttribute('aria-level')), folder: row.hasAttribute('aria-expanded'),
  })));
  const row = async name => (await rows()).find(entry => entry.path === name);
  const waitRow = name => waitFor(() => row(name), name);
  const clickRow = name => runRenderer(window, name => {
    const row = [...document.querySelectorAll('.explorer-row')].find(item => item.dataset.path === name);
    if (!row) throw new Error(`缺少文件树条目 ${name}`);
    row.click();
  }, name);
  const readWorkspace = () => fetch(base + '/api/workspace').then(response => response.json());
  const header = () => runRenderer(window, () => document.querySelector('.workspace-switcher b')?.textContent);
  const editor = () => runRenderer(window, () => document.querySelector('[data-panel-id="editor"] .cm-content')?.textContent);
  const openManager = async () => {
    await click('.workspace-switcher');
    await waitFor(() => runRenderer(window, () => !!document.querySelector('.recent-repositories-manage')), '仓库管理入口');
    await click('.recent-repositories-manage');
    await waitFor(() => runRenderer(window, () => !!document.querySelector('.repository-add-button')), '仓库管理面板');
  };
  const register = async expectedRoot => {
    picked = expectedRoot;
    await openManager();
    await click('.repository-add-button');
    return waitFor(async () => (await readWorkspace()).repositories.find(item => item.root === expectedRoot), '添加仓库');
  };
  const openRepository = async id => {
    const open = `.repository-card[data-repository-id="${id}"] .repository-card-actions > button`;
    await waitFor(() => runRenderer(window, selector => !!document.querySelector(selector) && !document.querySelector(selector).disabled, open), '打开仓库按钮');
    await click(open);
  };
  const treeState = () => runRenderer(window, () => ({
    rows: document.querySelectorAll('.explorer-tree [data-path]').length,
    error: document.querySelector('.explorer-tree-error')?.textContent ?? null,
    emptyAction: !!document.querySelector('.explorer-empty button'),
    emptyNotice: document.querySelector('.explorer-empty [role="status"]')?.textContent ?? null,
  }));

  try {
    await window.loadURL(base);
    check('真实 C# health', (await fetch(base + '/api/health').then(response => response.json())).backend === 'dotnet');
    const original = await readWorkspace();
    check('旧 workspace.json 保留 revision 和手动保存设置', original.revision === 19 && original.autoSave === false);
    check('默认仓库文件在左侧显示', !!await waitRow(initial));
    const registered = await register(repository);
    check('真实目录选择 IPC 收到受控系统返回', report.pickerCalls === 1);
    check('添加后保留原仓库和文件树', (await readWorkspace()).id === original.id && !!await row(initial));
    await openRepository(registered.id);
    await waitFor(async () => await header() === repositoryName, '切换到导入仓库');
    report.switchedWorkspace = await readWorkspace();
    check('打开仓库提交正确 id 和 root', report.switchedWorkspace.id === registered.id && report.switchedWorkspace.root === repository);
    report.entries = await fetch(base + '/api/tree').then(response => response.json());
    check('新仓库根文件实际出现在左侧且旧树消失', (await waitRow(rootNote)).level === 1 && !await row(initial));
    check('首层目录按文件夹渲染', (await waitRow(folder)).folder);
    await clickRow(folder);
    check('二级目录层级正确', (await waitRow(childFolder)).level === 2 && (await row(childFolder)).folder);
    await clickRow(childFolder);
    check('中文、空格、百分号与 emoji 路径显示并保留层级', (await waitRow(childNote)).level === 3);
    check('合法图片出现在嵌套目录', (await waitRow(image)).level === 3 && !(await row(image)).folder);
    check('沿用现有文件类型/隐藏名称过滤', (await Promise.all(unsupported.map(row))).every(entry => !entry));
    await clickRow(rootNote);
    check('可从左栏打开大写扩展名根文稿', !!await waitFor(async () => (await editor())?.includes('现有根文稿'), '读取主文稿'));
    await clickRow(childNote);
    check('可沿左栏打开嵌套文稿', !!await waitFor(async () => (await editor())?.includes('嵌套文稿'), '读取嵌套文稿'));
    await fs.writeFile(path.join(repository, externalNote), '# 外部新增');
    await fs.writeFile(path.join(repository, childNote), '# 已在外部修改');
    check('轮询检测到外部新增并更新左栏', !!await waitRow(externalNote));
    check('轮询更新未编辑的打开文稿', !!await waitFor(async () => (await editor())?.includes('已在外部修改'), '外部正文同步'));
    const warmState = path.join(run, 'profile', 'state', 'workspaces', registered.id, 'file-times.json');
    const validTimes = await fs.readFile(warmState);
    const warmStart = report.requests.length;
    await fs.writeFile(warmState, '[]');
    const afterFailure = '恢复后.md';
    await fs.writeFile(path.join(repository, afterFailure), '# 故障期间外部新增');
    await waitFor(() => report.requests.slice(warmStart).some(item => item.url === '/api/workspace/sync' && item.status === 500), '已有树收到轮询读取错误');
    check('已有目录读取失败时保留最后成功树，打开正文依旧可用', !!await row(rootNote) && !await row(afterFailure) &&
      (await editor())?.includes('已在外部修改'));
    await waitFor(async () => (await treeState()).error?.includes('创建时间状态'), '已有树显示读取错误');
    await click('.explorer-tree-error button');
    check('左栏重试按钮发出真实强制读树请求', !!await waitFor(() => report.requests.slice(warmStart).some(item => item.url === '/api/tree' && item.status === 500), '重试发出 GET tree'));
    await fs.writeFile(warmState, validTimes);
    check('同一仓库轮询成功后发布新树并清除读取错误', !!await waitRow(afterFailure) && !(await treeState()).error);
    await openManager();
    await openRepository(original.id);
    check('再次切换保留原仓库树且不混入后续快照', !!await waitRow(initial) && !await row(rootNote));
    check('所有仓库及树请求经真实 HTTP 成功完成', report.requests.some(item => item.url === '/api/workspace/repositories' && item.method === 'POST' && item.status === 200) &&
      report.requests.some(item => item.url === '/api/workspace' && item.method === 'POST' && item.status === 200) &&
      report.requests.some(item => item.url === '/api/workspace/sync' && item.method === 'POST' && item.status === 200));

    const recovered = await register(recoveryRepository);
    const recoveryState = path.join(run, 'profile', 'state', 'workspaces', recovered.id);
    const fileTimes = path.join(recoveryState, 'file-times.json');
    await fs.mkdir(recoveryState, { recursive: true });
    await fs.writeFile(fileTimes, '[]');
    const recoveryStart = report.requests.length;
    await openRepository(recovered.id);
    await waitFor(async () => await header() === recoveryName, '打开有故障的隔离仓库');
    const recoveryHttp = () => report.requests.slice(recoveryStart);
    await waitFor(() => recoveryHttp().some(item => item.url === '/api/tree' && item.status === 500) &&
      recoveryHttp().filter(item => item.url === '/api/workspace/sync' && item.status === 500).length >= 2, '真实 C# 树与两次轮询返回 500');
    report.recovery = { injection: '隔离仓库 file-times.json 写入非对象 JSON', before: await treeState() };
    await fs.writeFile(fileTimes, '{}');
    await waitFor(() => recoveryHttp().some(item => item.url === '/api/workspace/sync' && item.status === 200), '修复测试状态后真实轮询成功');
    await sleep(150);
    report.recovery.after = await treeState();
    await fs.writeFile(path.join(recoveryRepository, externalNote), '# 恢复后的新增文稿');
    check('修复磁盘状态后，无需重启便可显示新文档', !!await waitRow(externalNote));
    check('初次读树失败时左栏显示持续的错误且避免误报空仓库', report.recovery.before.rows === 0 &&
      report.recovery.before.error?.includes('创建时间状态') && !report.recovery.before.emptyAction);
    check('轮询成功清除错误并为实际空仓库显示说明和入口', !report.recovery.after.error &&
      report.recovery.after.emptyAction && report.recovery.after.emptyNotice?.includes('没有可显示'));
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.stack;
    report.visible = await rows().catch(() => []);
    report.uiErrors = await runRenderer(window, () => [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent)).catch(() => []);
    console.error(error.stack);
  } finally {
    await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
    window.destroy();
    app.exit(report.passed ? 0 : 1);
  }
}

async function runParent() {
  const paths = workspaceBuildPaths(project);
  const packageRoot = path.resolve(process.argv[2] || path.join(paths.release, 'win-unpacked'));
  const output = path.resolve(process.env.HIVE_VERIFY_OUTPUT || path.join(paths.work, 'evidence'));
  await fs.mkdir(output, { recursive: true });
  const run = await fs.mkdtemp(path.join(output, 'desktop-repositories-'));
  const backendDir = path.join(packageRoot, 'resources', 'backend');
  const profile = path.join(run, 'profile');
  const root = path.join(profile, 'documents');
  const state = path.join(profile, 'state');
  const repository = path.join(run, repositoryName);
  await Promise.all([root, state, path.join(run, recoveryName), path.join(repository, childFolder)].map(directory => fs.mkdir(directory, { recursive: true })));
  await Promise.all([
    fs.writeFile(path.join(root, initial), '# 原仓库文稿'),
    fs.writeFile(path.join(state, 'workspace.json'), JSON.stringify({ root, revision: 19, autoSave: false, repositories: [] })),
    fs.writeFile(path.join(repository, rootNote), '# 现有根文稿'),
    fs.writeFile(path.join(repository, childNote), '# 已有嵌套文稿'),
    fs.writeFile(path.join(repository, image), png),
    ...unsupported.map(name => fs.writeFile(path.join(repository, name), '应过滤')),
  ]);
  const log = [];
  const backend = launchBackend({ root: project, resources: path.join(packageRoot, 'resources'),
    env: { HIVE_PORT: '0', HIVE_DOCUMENTS: root, HIVE_STATE_DIR: state, HIVE_APP_DATA_DIR: profile,
      HIVE_TEMPLATES_DIR: path.join(profile, 'templates'), HIVE_API_KEY: '', HIVE_DESKTOP_SHELL: '1' },
    onLine: line => log.push(line), onError: line => log.push(line),
  });
  try {
    const ready = await backend.ready;
    const base = `http://127.0.0.1:${ready.port}`;
    const health = await fetch(base + '/api/health').then(response => response.json());
    assert.equal(health.pid, backend.child.pid);
    assert.equal(health.project, path.join(backendDir, 'app'));
    const electron = (await import('electron')).default;
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, ['--headless', '--disable-gpu', '--enable-logging=stderr', script, '--repository-worker', String(ready.port), run, packageRoot], {
      cwd: project, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => log.push(data.toString()));
    child.stderr.on('data', data => log.push(data.toString()));
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('隐藏仓库验收超时')); }, 90000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', exit => { clearTimeout(timer); resolve(exit); });
    });
    assert.equal(code, 0, log.join('\n'));
    const result = JSON.parse(await fs.readFile(path.join(run, 'result.json'), 'utf8'));
    console.log(JSON.stringify({ result: path.join(run, 'result.json'), backendPid: health.pid, checks: result.checks.length }));
  } finally {
    await backend.stop();
    await fs.writeFile(path.join(run, 'run.log'), log.join('\n'));
    console.log(`仓库验收记录 ${run}`);
  }
}

if (process.argv.includes('--repository-worker')) {
  runWorker(...process.argv.slice(-3)).catch(error => {
    console.error(error.stack);
    createRequire(import.meta.url)('electron').app.exit(1);
  });
} else await runParent();
