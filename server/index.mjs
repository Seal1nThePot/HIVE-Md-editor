import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBackend, workspaceBuildPaths } from '../desktop/backendProcess.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');
const runtime = path.join(workspaceBuildPaths(root).work, 'runtime');
const service = launchBackend({
  root,
  env: {
    HIVE_PORT: production ? process.env.HIVE_PORT ?? '4324' : '0',
    HIVE_DOCUMENTS: process.env.HIVE_DOCUMENTS || path.join(runtime, 'documents'),
    HIVE_STATE_DIR: process.env.HIVE_STATE_DIR || path.join(runtime, 'state'),
  },
  onNative: message => { if (process.connected) process.send(message); },
});
let front;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await front?.close();
  await service.stop();
  if (process.connected) process.disconnect();
}
process.on('message', message => {
  if (message?.type === 'hive-shutdown') void stop();
  else service.send(message);
});
process.on('disconnect', () => void stop());
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
service.emitter.on('exit', (code, _signal, closed) => {
  if (!closed) { process.exitCode = code || 1; void stop(); }
});
try {
  const backend = await service.ready;
  if (!production) {
    const { devFrontend } = await import('../scripts/devFrontend.mjs');
    front = await devFrontend(root, backend.port, Number(process.env.HIVE_PORT ?? 4324));
  }
  const port = front?.port ?? backend.port;
  console.log(`HIVE ready: http://127.0.0.1:${port}`);
  if (process.connected) process.send({ ...backend, port });
} catch (error) {
  console.error(error.message);
  if (process.connected) process.send({ type: 'hive-startup-error', message: error.message });
  process.exitCode = 1;
  await stop();
}
