import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { workspaceBuildPaths } from '../desktop/backendProcess.mjs';

const require = createRequire(import.meta.url);
const [bundle, destination] = process.argv.slice(2);
if (!bundle) throw new Error('用法：npm run update:bundle -- <win-unpacked 目录> [发布目录]');
const install = path.resolve(bundle);
const backend = path.join(install, 'resources', 'backend', 'Hive.Backend.exe');
const output = path.resolve(destination || path.join(workspaceBuildPaths(path.resolve(import.meta.dirname, '..')).work, 'update-release'));
const electron = require('electron/package.json').version;
const child = spawn(backend, ['--pack-update', install, output, electron], { stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
