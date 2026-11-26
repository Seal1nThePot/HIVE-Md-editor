import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { workspaceBuildPaths } from '../desktop/backendProcess.mjs';

const project = path.resolve(import.meta.dirname, '..');
const paths = workspaceBuildPaths(project);
const packageRoot = path.resolve(process.argv[2] || path.join(paths.release, 'win-unpacked'));
const executable = path.join(packageRoot, 'HIVE markdown editor.exe');
const expectedBackend = path.join(packageRoot, 'resources', 'backend', 'Hive.Backend.exe');
const evidence = path.resolve(process.env.HIVE_VERIFY_OUTPUT || path.join(paths.work, 'evidence'));
await fs.mkdir(evidence, { recursive: true });
const directory = await fs.mkdtemp(path.join(evidence, 'desktop-csharp-'));
const profile = path.join(directory, 'profile');
const docs = path.join(profile, 'documents');
const draft = path.join(docs, '迁移.md');
const external = path.join(directory, '仓库外.md');
const prefsFile = path.join(profile, 'ui-preferences.json');
const preferenceKey = 'hive.recentDocuments.v1:019-probe';
const sourceFile = path.join(profile, 'update-source.json');
await fs.mkdir(docs, { recursive: true });
await fs.writeFile(draft, '# 目录内文稿\n');
await fs.writeFile(external, '\uFEFF# 仓库外文稿\r\n');
await fs.writeFile(prefsFile, JSON.stringify({ [preferenceKey]: 'from-0.1.8-format' }));
const report = { executable, expectedBackend, directory, checks: [], processes: [] };
const check = (label, condition) => { assert.ok(condition, label); report.checks.push(label); };
const exec = promisify(execFile);

async function processInfo(pid) {
  assert(Number.isInteger(pid) && pid > 0);
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`], { windowsHide: true });
  return stdout.trim() ? JSON.parse(stdout) : null;
}
async function until(action, label, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result; }
    catch (error) { last = error; }
    await sleep(75);
  }
  throw new Error(label + (last ? ' · ' + last.message : ''));
}
async function attach(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data);
    pending.get(reply.id)?.(reply);
  });
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 8000);
      pending.set(id, reply => {
        pending.delete(id);
        clearTimeout(timer);
        if (reply.error) reject(new Error(reply.error.message));
        else resolve(reply.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function run(fn, ...args) {
    const result = await send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  return { run, close: () => socket.close() };
}

const log = [];
let current;
async function launch() {
  const bootLogStart = log.length;
  const activePort = path.join(profile, 'DevToolsActivePort');
  await fs.rm(activePort, { force: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HIVE_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/i.test(key)));
  const child = spawn(executable, ['--headless', '--disable-gpu', '--remote-debugging-port=0', '--enable-logging=stderr'], {
    cwd: packageRoot, env: { ...env, HIVE_DESKTOP_USER_DATA: profile, HIVE_API_KEY: '' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', part => log.push(part.toString()));
  child.stderr.on('data', part => log.push(part.toString()));
  child.on('error', error => log.push(error.message + '\n'));
  current = { child };
  const debuggerPort = await until(async () => Number((await fs.readFile(activePort, 'utf8')).split('\n')[0]), 'Hidden Chromium startup');
  const target = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/list`)).json();
    return pages.find(page => page.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(page.url));
  }, 'Installed renderer URL');
  current.page = await attach(target);
  const { page } = current;
  await until(() => page.run(() => !!window.hiveDesktop && !!document.querySelector('.workspace-switcher')), 'Workspace renderer');
  await until(() => log.slice(bootLogStart).join('').includes('HIVE window-ready: {"id":"$main"'), 'Native startup presentation');
  current.origin = new URL(target.url).origin;
  const health = await (await fetch(current.origin + '/api/health')).json();
  current.backend = health.pid;
  const native = await processInfo(health.pid);
  check('Kestrel reports the real packaged .NET child', health.backend === 'dotnet' &&
    native.ParentProcessId === child.pid && path.resolve(native.ExecutablePath).toLowerCase() === expectedBackend.toLowerCase());
  report.processes.push({ electronPid: child.pid, http: health, process: native });
  return current;
}
async function stop(graceful) {
  if (!current) return;
  const { child, backend, page, origin } = current;
  if (child.exitCode === null && child.signalCode === null) {
    if (graceful) await page.run(() => window.hiveDesktop.windowCommand('close'));
    else child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null, 'Electron exit');
  }
  page?.close();
  if (backend) {
    await until(async () => !await processInfo(backend), 'Managed Kestrel exit');
    await assert.rejects(fetch(origin + '/api/health'));
    check(graceful ? 'Save-and-close retires Kestrel' : 'Abrupt parent exit retires Kestrel through pipe EOF', true);
  }
  current = undefined;
}

try {
  const { page, origin } = await launch();
  const workspace = await (await fetch(origin + '/api/workspace')).json();
  const about = await page.run(() => window.hiveDesktop.getAboutInfo());
  check('Installed about page reports version 0.1.9', about.version === '0.1.9' && about.runtime.packaged === true && about.buildNumber !== 'unavailable');
  const internal = await page.run((filepath, root) => window.hiveDesktop.openLocalMarkdown(filepath, root), draft, workspace.root);
  check('Native opens in-repository path as a relative document', internal.relative === '迁移.md');
  const unauthorized = await page.run(async filepath => {
    try { await window.hiveDesktop.saveLocalMarkdown({path: filepath, text: 'unused', baseline: '0'.repeat(64)}); }
    catch (error) { return error.message; }
  }, external);
  check('Native external save requires a file opened through the trusted main frame', unauthorized?.includes('保存前请先打开'));
  const opened = await page.run((filepath, root) => window.hiveDesktop.openLocalMarkdown(filepath, root), external, workspace.root);
  check('Native external read preserves EOL and BOM flags', opened.external.text === '# 仓库外文稿\n' && opened.external.bom && opened.external.eol === 'CRLF');
  const saved = await page.run(doc => window.hiveDesktop.saveLocalMarkdown({ ...doc, baseline: doc.hash, text: '# 新内容\n' }), opened.external);
  check('Native external save publishes BOM and CRLF bytes', saved.hash !== opened.external.hash && await fs.readFile(external, 'utf8') === '\uFEFF# 新内容\r\n');
  const stale = await page.run(async doc => {
    try { await window.hiveDesktop.saveLocalMarkdown({ ...doc, baseline: doc.hash, text: 'stale' }); }
    catch (error) { return error.message; }
  }, opened.external);
  check('Native external save blocks a stale baseline', stale?.includes('已阻止覆盖') && await fs.readFile(external, 'utf8') === '\uFEFF# 新内容\r\n');
  const updater = await page.run(async () => ({
    mode: await window.hiveDesktop.getUpdateMode(),
    progress: await window.hiveDesktop.getUpdateProgress(),
    source: await window.hiveDesktop.setUpdateSource('local'),
  }));
  report.updater = updater;
  check('Native update mode and progress come from C#', updater.mode === 'picker' && updater.progress.phase === 'idle' && updater.source === 'picker');
  check('Native update source persists in the existing data file', JSON.parse(await fs.readFile(sourceFile, 'utf8')).source === 'local');
  const preference = await page.run(key => {
    const before = localStorage.getItem(key);
    localStorage.setItem(key, 'after-csharp-save');
    return before;
  }, preferenceKey);
  check('Preload restores preferences from the old JSON format', preference === 'from-0.1.8-format');
  await stop(true);
  check('C# drains final UI preferences before exit', JSON.parse(await fs.readFile(prefsFile, 'utf8'))[preferenceKey] === 'after-csharp-save');

  const restarted = await launch();
  check('Restarted renderer sees preferences saved by C#', await restarted.page.run(key => localStorage.getItem(key), preferenceKey) === 'after-csharp-save');
  await stop(false);
  report.passed = true;
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  if (current) await stop(false).catch(error => log.push(error.stack + '\n'));
  await fs.writeFile(path.join(directory, 'electron.log'), log.join(''));
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed === true, checks: report.checks.length, report: path.join(directory, 'result.json') }));
}
