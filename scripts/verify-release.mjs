import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';
import { workspaceBuildPaths } from '../desktop/backendProcess.mjs';

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const paths = workspaceBuildPaths(project);
const manifest = JSON.parse(fs.readFileSync(path.join(paths.work, 'package-build.json'), 'utf8'));
const bundle = path.resolve(process.argv[2] || manifest.release);
const output = path.resolve(process.env.HIVE_VERIFY_OUTPUT || path.join(paths.work, 'evidence'));
const packagePath = path.join(bundle, 'win-unpacked');
const resources = path.join(packagePath, 'resources');
const archive = path.join(resources, 'app.asar');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const archiveFile = file => extractFile(archive, file.split('/').join(path.sep));
function files(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(item => {
    const file = path.join(relative, item.name);
    assert(!item.isSymbolicLink(), 'Unexpected symbolic link: ' + file);
    return item.isDirectory() ? files(root, file) : [file.replaceAll('\\', '/')];
  });
}

const packageFiles = listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
assert(!packageFiles.some(name => name === 'server' || name.startsWith('server/')), 'Legacy backend must stay outside production');
assert(!packageFiles.some(name => name.startsWith('node_modules/')), 'Node dependencies must stay outside production');
assert(!packageFiles.some(name => /\.test\./.test(name)), 'Development tests must stay outside production');
const sourceFiles = ['LICENSE', 'assets/brand/hive.png',
  ...packageFiles.filter(file => /^(desktop|shared)\//.test(file) && fs.statSync(path.join(project, file)).isFile())];
const results = sourceFiles.map(file => ({
  path: 'app.asar/' + file,
  matches: fileHash(path.join(project, file)) === hash(archiveFile(file)),
}));
for (const file of files(manifest.dist)) {
  const from = path.join(manifest.dist, file);
  results.push({ path: 'app.asar/dist/' + file, matches: fileHash(from) === hash(archiveFile('dist/' + file)) });
}
const nativeRoot = path.join(resources, 'backend');
const actualNative = files(nativeRoot).sort();
assert.deepEqual(actualNative, files(manifest.publishedBackend).sort(), 'Backend payload file list differs');
for (const file of actualNative)
  results.push({ path: 'backend/' + file, matches: fileHash(path.join(manifest.publishedBackend, file)) === fileHash(path.join(nativeRoot, file)) });
assert(results.every(file => file.matches), 'Packaged runtime differs from source or build');
const current = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
const packaged = JSON.parse(archiveFile('package.json').toString());
const buildInfo = JSON.parse(archiveFile('dist/build-info.json').toString());
assert.deepEqual(buildInfo, JSON.parse(fs.readFileSync(path.join(nativeRoot, 'app', 'dist', 'build-info.json'), 'utf8')));
for (const field of ['version', 'name', 'main', 'dependencies']) assert.deepEqual(packaged[field], current[field], field);
const exe = path.join(packagePath, 'HIVE markdown editor.exe');
const backend = path.join(nativeRoot, 'Hive.Backend.exe');
assert.equal(fs.readFileSync(backend).subarray(0, 2).toString(), 'MZ');
assert(fs.existsSync(path.join(nativeRoot, 'hostfxr.dll')), 'Self-contained runtime must ship with the backend');

const report = {
  passed: true, package: packagePath, version: packaged.version, buildInfo,
  fileCount: files(packagePath).length, matchedRuntimeFiles: results.length, backendFileCount: actualNative.length,
  exeSha256: fileHash(exe).toUpperCase(), appAsarSha256: fileHash(archive).toUpperCase(), backendExeSha256: fileHash(backend).toUpperCase(), results,
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, results: undefined }));
