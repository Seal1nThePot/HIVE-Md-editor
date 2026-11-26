import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import path from 'node:path';

export function workspaceBuildPaths(root, environment = process.env) {
  const work = path.resolve(environment.HIVE_BUILD_WORK_DIR || path.join(root, '..', '.work', '019-csharp-backend'));
  return { work, dist: path.join(work, 'dist'), dotnet: path.join(work, 'dotnet'), publish: path.join(work, 'published-backend'), release: path.join(work, 'release') };
}

export function launchBackend({ root, resources, env = {}, onLine = () => {}, onError = console.error, onNative = () => {} }) {
  const packaged = !!resources;
  const paths = workspaceBuildPaths(root);
  const environment = { ...process.env, ...env };
  const backend = packaged ? path.join(resources, 'backend') : undefined;
  const file = packaged ? path.join(backend, 'Hive.Backend.exe') : environment.HIVE_BACKEND_EXE ||
    path.join(paths.dotnet, 'bin', 'Hive.Backend', 'debug', process.platform === 'win32' ? 'Hive.Backend.exe' : 'Hive.Backend');
  const project = packaged ? path.join(backend, 'app') : environment.HIVE_PROJECT || root;
  const emitter = new EventEmitter();
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(file, [], {
    cwd: project,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...environment, HIVE_PIPE: '1', HIVE_PROJECT: project,
      HIVE_DIST_DIR: packaged ? path.join(project, 'dist') : environment.HIVE_DIST_DIR || paths.dist },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', onError);
  child.stdin.on('error', () => {});
  const requests = new Map();
  let startupError;
  let readyPort;
  let stopped = false;
  function send(message) {
    if (child.stdin.destroyed || !child.stdin.writable) return false;
    child.stdin.write(JSON.stringify(message) + '\n');
    return true;
  }
  function rejectPending(error) {
    for (const pending of requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    requests.clear();
  }
  const stdout = createInterface({ input: child.stdout });
  stdout.on('line', line => {
    if (!line.startsWith('{')) { onLine(line); return; }
    let message;
    try { message = JSON.parse(line); }
    catch { onLine(line); return; }
    if (message.type === 'hive-ready') {
      readyPort = message.port;
      emitter.emit('ready', message);
      return;
    }
    if (message.type === 'hive-startup-error') {
      startupError = new Error(message.message);
      emitter.emit('startup-error', startupError);
      return;
    }
    if (message.type === 'hive-native-result') {
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.message || '本地操作失败。'));
      return;
    }
    onNative(message, send);
  });
  child.once('error', error => {
    startupError ||= error;
    rejectPending(error);
    emitter.emit('startup-error', startupError);
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`本地服务退出 (${code ?? signal})`);
    rejectPending(error);
    if (!readyPort) emitter.emit('startup-error', startupError || error);
    emitter.emit('exit', code, signal, stopped);
  });
  function request(method, body = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = method === 'update-stage' ? 1200000 : method === 'update-choice' ? 600000 : method === 'update-begin' ? 30000 : 15000;
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('本地操作等待超时。')); }, timeout);
      requests.set(id, { resolve, reject, timer });
      if (!send({ type: 'hive-native-request', id, method, body })) {
        requests.delete(id);
        clearTimeout(timer);
        reject(new Error('本地服务暂不可用。'));
      }
    });
  }
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('本地服务启动超时。'));
    }, 30000);
    emitter.once('ready', message => { clearTimeout(timer); resolve(message); });
    emitter.once('startup-error', error => { clearTimeout(timer); reject(error); });
  });
  async function stop() {
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (send({ type: 'hive-shutdown' })) child.stdin.end();
      else child.kill();
    });
  }
  return { child, emitter, ready, request, stop, send };
}
