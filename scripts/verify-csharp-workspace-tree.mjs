import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {scanFileTree} from '../server/file-index-scan.mjs';

const [backend, output] = process.argv.slice(2);
if (!backend || !output) throw Error('Usage: node scripts/verify-csharp-workspace-tree.mjs <backend executable> <evidence directory>');
const project = fileURLToPath(new URL('..', import.meta.url));
const run = await fs.mkdtemp(path.resolve(output) + path.sep + 'workspace-tree-');
const docs = path.join(run, 'documents');
const state = path.join(run, 'state');
const report = {backend: path.resolve(backend), run, cases: [], stdout: '', stderr: ''};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = async (directory, relative, content = '') => {
  const name = path.join(directory, relative);
  await fs.mkdir(path.dirname(name), {recursive: true});
  await fs.writeFile(name, content);
  return name;
};
const paths = entries => entries.flatMap(entry => [entry.path, ...(entry.children ? paths(entry.children) : [])]);
const oracle = async root => paths((await scanFileTree({root, counters: {readdirCount: 0, statCount: 0, maxPendingStats: 0}})).entries);
const workspaceId = root => hash(process.platform === 'win32' ? root.toLowerCase() : root).slice(0, 24);
const names = entries => paths(entries).sort();
let workspace;
let base;
let currentCase;

await file(docs, 'default.md', 'default');
await file(state, 'workspace.json', JSON.stringify({root: docs, autoSave: false, revision: 4, repositories: []}));
const binary = path.resolve(backend);
report.backendSha256 = hash(await fs.readFile(binary));
report.dllSha256 = hash(await fs.readFile(path.join(path.dirname(binary), 'Hive.Backend.dll')));
const child = spawn(binary, [], {cwd: run, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
  ...process.env, HIVE_PROJECT: project, HIVE_PORT: '0', HIVE_PIPE: '1', HIVE_API_KEY: '', HIVE_DESKTOP_SHELL: '',
  HIVE_DOCUMENTS: docs, HIVE_STATE_DIR: state, HIVE_APP_DATA_DIR: path.join(run, 'appdata'),
  HIVE_TEMPLATES_DIR: path.join(run, 'templates'), HIVE_TEMPLATES_SOURCE: path.join(project, 'templates'),
}});
report.pid = child.pid;
child.stdout.on('data', chunk => report.stdout += chunk);
child.stderr.on('data', chunk => report.stderr += chunk);
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));

async function request(route, body, id = workspace?.id) {
  const started = performance.now();
  const headers = {...(id ? {'x-hive-workspace': id} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'})};
  const response = await fetch(base + '/api' + route, {method: body === undefined ? 'GET' : 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000)});
  const value = await response.json();
  currentCase?.requests.push({route, status: response.status, elapsedMs: Math.round(performance.now() - started), root: value.root ?? value.workspace?.root,
    treeVersion: value.treeVersion, entryCount: value.entries && paths(value.entries).length, error: value.error});
  return {status: response.status, value};
}
async function api(route, body, id) {
  const result = await request(route, body, id);
  assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.status === 200 ? undefined : result.value)}`);
  return result.value;
}
async function open(root) {
  workspace = await api('/workspace/repositories', {action: 'add', root, revision: workspace.revision});
  workspace = await api('/workspace', {root, revision: workspace.revision});
  assert.equal(workspace.root, root);
}
async function checked(name, action) {
  const result = {name, requests: []};
  currentCase = result;
  report.cases.push(result);
  try { await action(); result.pass = true; console.log(`PASS ${name}`); }
  catch (error) { result.pass = false; result.error = error.stack; console.error(`FAIL ${name}\n${error.stack}`); }
  finally { currentCase = undefined; }
}

try {
  for (let count = 0; count < 200 && !base; count++) {
    const match = /\{"type":"hive-ready","port":(\d+),"pid":(\d+)\}/.exec(report.stdout);
    if (match) { assert.equal(Number(match[2]), child.pid); base = `http://127.0.0.1:${match[1]}`; }
    else { assert.equal(child.exitCode, null, report.stdout + report.stderr); await delay(50); }
  }
  assert.ok(base, 'C# backend startup timed out');
  assert.equal((await api('/health')).backend, 'dotnet');
  workspace = await api('/workspace');
  assert.equal(workspace.revision, 4);
  const defaultId = workspace.id;
  const regular = path.join(run, '普通仓库😀');
  const note = '章节/第一章😀.md';
  const windowsNote = note.replaceAll('/', '\\');
  await file(regular, note, '旧文');
  await file(regular, 'release/交付记录.md', 'ordinary workspace includes release');
  await file(regular, 'node_modules/ignored.md');
  await file(regular, '.hidden/ignored.md');
  await file(regular, 'ignored.txt');
  await file(regular, 'picture.png');
  await fs.mkdir(path.join(regular, '空文件夹'));
  await fs.symlink(docs, path.join(regular, '联接'), process.platform === 'win32' ? 'junction' : 'dir');

  await checked('Default and ordinary repository return matching visible tree, Windows roots and document paths', async () => {
    assert.deepEqual(names((await api('/tree')).entries), ['default.md']);
    const record = await fs.stat(path.join(regular, note));
    await file(path.join(state, 'workspaces', workspaceId(regular)), 'file-times.json', JSON.stringify({
      [note]: {dev: record.dev, ino: record.ino, birthtimeMs: record.birthtimeMs, createdAt: 1600000000123},
    }));
    await open(regular);
    const tree = await api('/tree');
    assert.deepEqual(names(tree.entries), (await oracle(regular)).sort());
    assert.equal(tree.entries.find(entry => entry.path === '章节').children[0].createdAt, 1600000000123);
    assert.equal((await api('/file?path=' + encodeURIComponent(windowsNote))).text, '旧文');
    const sync = await api('/workspace/sync', {paths: [note], treeVersion: tree.treeVersion});
    assert.equal(sync.workspace.id, workspace.id);
    assert.equal(sync.treeVersion, tree.treeVersion);
    assert.deepEqual(names(sync.entries), names(tree.entries));
    assert.equal((await request('/tree', undefined, defaultId)).status, 409);
  });

  await checked('Source repository detection keeps source documents and skips only root generated-output names', async () => {
    const root = path.join(run, 'source');
    for (const relative of ['server/files.mjs', 'desktop/main.mjs', 'README.md', 'docs/README.md',
      'release/ignored.md', 'delivery/ignored.md', 'dist/ignored.md', 'performance/baselines/ignored.md', 'docs/release/kept.md'])
      await file(root, relative);
    await file(root, 'package.json', JSON.stringify({name: 'hive-writing-prototype', main: 'desktop/main.mjs'}));
    await open(root);
    assert.deepEqual(names((await api('/tree')).entries), (await oracle(root)).sort());
  });

  await checked('Deep and wide repository returns all existing documents in tree and sync', async () => {
    const root = path.join(run, 'deep-wide');
    const deep = Array.from({length: 42}, () => 'a').join('/') + '/deep.md';
    for (let i = 0; i < 180; i++) await file(root, `chapter-${i}/nested/稿件-${i}😀.md`, 'content');
    await file(root, deep, 'deep');
    await open(root);
    const expected = (await oracle(root)).sort();
    const tree = await request('/tree');
    const sync = await request('/workspace/sync', {paths: [deep]});
    assert.equal(tree.status, 200, JSON.stringify(tree.value.error));
    assert.equal(sync.status, 200, JSON.stringify(sync.value.error));
    assert.deepEqual(names(tree.value.entries), expected);
    assert.deepEqual(names(sync.value.entries), expected);
    assert.equal(sync.value.files[0].text, 'deep');
    assert.equal((await api('/file?path=' + encodeURIComponent(deep))).text, 'deep');
  });

  if (process.platform === 'win32') await checked('Unreadable child directory does not hide readable siblings', async () => {
    const root = path.join(run, 'restricted');
    const denied = 'parent/restricted-child';
    const hidden = path.join(root, denied);
    const identity = execFileSync('whoami.exe', [], {encoding: 'utf8', windowsHide: true}).trim();
    await file(root, 'readable.md', 'readable');
    await file(root, 'parent/readable.md', 'readable');
    await file(hidden, 'hidden.md', 'restricted');
    await open(root);
    const acl = (...args) => execFileSync('icacls.exe', [hidden, ...args], {windowsHide: true});
    acl('/deny', `${identity}:(RD)`);
    try {
      await assert.rejects(fs.readdir(hidden), {code: 'EPERM'});
      const tree = await request('/tree');
      const sync = await request('/workspace/sync', {paths: []});
      assert.equal(tree.status, 200, JSON.stringify(tree.value.error));
      assert.equal(sync.status, 200, JSON.stringify(sync.value.error));
      assert.deepEqual(names(tree.value.entries), ['parent', 'parent/readable.md', 'readable.md']);
      assert.deepEqual(names(sync.value.entries), names(tree.value.entries));
      assert.equal(tree.value.warnings[0].path, denied);
      assert.match(tree.value.warnings[0].message, /访问权限/);
      assert.deepEqual(sync.value.warnings, tree.value.warnings);
      assert.equal(sync.value.treeVersion, tree.value.treeVersion);
      currentCase.deniedTreeVersion = tree.value.treeVersion;
    } finally { acl('/remove:d', identity); }
    let restored;
    for (let i = 0; i < 30; i++) {
      restored = await api('/workspace/sync', {paths: []});
      if (!restored.warnings) break;
      await delay(40);
    }
    assert.equal(restored.warnings, undefined, 'watcher must clear warnings after permissions are restored');
    assert.notEqual(restored.treeVersion, currentCase.deniedTreeVersion);
    const expected = (await oracle(root)).sort();
    assert.deepEqual(names(restored.entries), expected);
    assert.deepEqual(names((await api('/tree?refresh=1')).entries), expected);
  });

  await checked('Watcher converges after external create, rename, delete and same-time same-size edit; save rejects stale baseline', async () => {
    await open(regular);
    const filename = path.join(regular, note);
    const fixedTime = new Date('2026-11-15T10:00:00.000Z');
    await fs.utimes(filename, fixedTime, fixedTime);
    const initial = await api('/tree');
    const initialSync = await api('/workspace/sync', {paths: [note], treeVersion: initial.treeVersion});
    const baseline = initialSync.files[0].hash;
    const b = {[note]: baseline};
    assert.equal((await api('/workspace/sync', {paths: [note], baselines: b})).files[0].unchanged, true);
    const previousStat = await fs.stat(filename, {bigint: true});
    await fs.writeFile(filename, '新文');
    await fs.utimes(filename, fixedTime, fixedTime);
    const currentStat = await fs.stat(filename, {bigint: true});
    for (const key of ['size', 'mtimeNs', 'birthtimeNs']) assert.equal(currentStat[key], previousStat[key], key);
    const added = await file(regular, '章节/外部新增.md', '新增');
    const moved = '章节/外部移入.md';
    await fs.rename(added, path.join(regular, moved));
    await fs.unlink(path.join(regular, 'picture.png'));
    async function waitFor(check) {
      for (let i = 0; i < 30; i++) { const reply = await api('/workspace/sync', {paths: [note], baselines: b}); if (check(reply)) return reply; await delay(40); }
      throw Error('Watcher did not converge to the observed disk state');
    }
    const synced = await waitFor(reply => names(reply.entries).includes(moved) && !names(reply.entries).includes('picture.png'));
    assert.equal(synced.files[0].text, '新文');
    assert.notEqual(synced.treeVersion, initial.treeVersion);
    assert.equal((await request('/file', {path: note, text: '未保存', baseline})).status, 409);
    assert.equal((await api('/file?path=' + encodeURIComponent(note))).text, '新文');
    await fs.unlink(filename);
    const removed = await waitFor(reply => !names(reply.entries).includes(note));
    assert.match(removed.files[0].error, /删除或移动/);
  });

  await checked('A sync overtaken by a repository switch never labels the old tree as the new repository', async () => {
    const previous = path.join(run, 'previous');
    const next = path.join(run, 'next');
    await fs.mkdir(previous);
    for (let index = 0; index < 1000; index++) await file(previous, `chapter-${index}/note.md`, 'old');
    await file(next, 'different.md', 'different');
    await open(next);
    await api('/tree');
    await open(previous);
    const previousId = workspace.id;
    let switched = false;
    let syncFinished = false;
    const inflight = request('/workspace/sync', {paths: ['chapter-0/note.md']}, previousId).then(result => {
      syncFinished = true;
      return result;
    });
    try {
      await delay(20);
      workspace = await api('/workspace', {root: next, revision: workspace.revision}, previousId);
      switched = !syncFinished;
    } finally {
      const result = await inflight;
      assert.ok(switched, 'isolated switch completed before the old sync response');
      assert.equal(result.status, 409, `response workspace=${result.value.workspace?.id}, prior workspace=${previousId}`);
    }
    const current = await api('/workspace/sync', {paths: []});
    assert.equal(current.workspace.id, workspace.id);
    assert.deepEqual(names(current.entries), ['different.md']);
  });

  await checked('Corrupt file times fail closed and retry after restoring exact old records', async () => {
    const root = path.join(run, 'metadata-retry');
    await file(root, 'valid.md', 'valid');
    await open(root);
    const target = path.join(state, 'workspaces', workspace.id, 'file-times.json');
    const good = await api('/tree');
    const bytes = await fs.readFile(target);
    await fs.writeFile(target, '{');
    try {
      const result = await request('/tree?refresh=1');
      assert.equal(result.status, 500);
      assert.equal(result.value.code, 'HIVE_STATE_CORRUPT');
      assert.equal(await fs.readFile(target, 'utf8'), '{');
    } finally { await fs.writeFile(target, bytes); }
    assert.deepEqual((await api('/tree')).entries, good.entries);
  });
} catch (error) { report.error = error.stack; console.error(error); }
finally {
  child.stdin.end();
  const timeout = new AbortController();
  try { report.exit = await Promise.race([exited, delay(8000, null, {signal: timeout.signal})]); }
  finally { timeout.abort(); }
  if (!report.exit) { child.kill(); report.exit = await exited; }
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
  console.log(path.join(run, 'result.json'));
  if (report.error || report.exit.code !== 0 || report.cases.some(item => !item.pass)) process.exitCode = 1;
}
