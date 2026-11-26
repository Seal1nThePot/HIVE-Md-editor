import { spawn } from 'node:child_process';
import electron from 'electron';
import path from 'node:path';
import { workspaceBuildPaths } from '../desktop/backendProcess.mjs';
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, HIVE_DESKTOP_DEV: '1',
  HIVE_DESKTOP_USER_DATA: process.env.HIVE_DESKTOP_USER_DATA || path.join(workspaceBuildPaths(process.cwd()).work, 'dev-profile') }, windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
