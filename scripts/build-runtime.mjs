import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceBuildPaths } from '../desktop/backendProcess.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = workspaceBuildPaths(root);
const mode = process.argv[2] || 'build';
const temp = path.join(paths.work, 'tmp');
await fs.mkdir(temp, { recursive: true });
Object.assign(process.env, {
  TEMP: temp, TMP: temp, TMPDIR: temp,
  DOTNET_CLI_HOME: process.env.DOTNET_CLI_HOME || path.join(paths.work, 'dotnet-home'),
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
  NUGET_PACKAGES: process.env.NUGET_PACKAGES || path.join(paths.work, 'nuget-packages'),
  ELECTRON_CACHE: process.env.ELECTRON_CACHE || path.join(paths.work, 'electron-cache'),
  ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || path.join(paths.work, 'electron-builder-cache'),
});
const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
const backend = path.join(root, 'backend', 'Hive.Backend.csproj');
const relativeToRoot = absolute => path.relative(root, absolute).replaceAll('\\', '/');

function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${file} exited with ${code ?? signal}`)));
  });
}

async function renderer(output = paths.dist) {
  await command(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
  await command(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', output]);
}

async function compile() {
  await command('dotnet', ['build', backend, '--nologo', '-p:ArtifactsPath=' + paths.dotnet]);
}

async function copyAssets(destination) {
  for (const [from, to] of [
    [path.join(root, 'templates'), 'templates'],
    [path.join(root, 'desktop', 'docking-colors.json'), 'desktop/docking-colors.json'],
    [path.join(root, 'desktop', 'editor-colors.json'), 'desktop/editor-colors.json'],
    [path.join(root, 'shared', 'icons.json'), 'shared/icons.json'],
    [path.join(root, 'server', 'plugin-examples', 'selection-lines.json'), 'plugin-examples/selection-lines.json'],
    [path.join(root, 'package.json'), 'package.json'],
  ]) {
    const target = path.join(destination, to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(from, target, { recursive: true });
  }
}

async function packageDesktop(target) {
  const { Arch, Platform, build } = await import('electron-builder');
  const configuration = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).build;
  await fs.mkdir(paths.publish, { recursive: true });
  const publish = await fs.mkdtemp(path.join(paths.publish, 'win-x64-'));
  const dist = path.join(publish, 'app', 'dist');
  await Promise.all([
    renderer(dist),
    command('dotnet', ['publish', backend, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', publish, '--nologo',
      '-p:ArtifactsPath=' + paths.dotnet, '-p:DebugType=None', '-p:DebugSymbols=false']),
  ]);
  await copyAssets(path.join(publish, 'app'));
  const result = await build({
    projectDir: root,
    targets: Platform.WINDOWS.createTarget([target], Arch.x64),
    publish: 'never',
    config: {
      ...configuration,
      directories: { ...configuration.directories, output: paths.release },
      files: [...configuration.files, { from: relativeToRoot(dist), to: 'dist' }],
      extraResources: [{ from: relativeToRoot(publish), to: 'backend' }],
      npmRebuild: false,
    },
  });
  const manifest = { publishedBackend: publish, dist, release: paths.release, artifacts: result };
  await fs.writeFile(path.join(paths.work, 'package-build.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest));
}

if (mode === 'backend') await compile();
else if (mode === 'build') await Promise.all([renderer(), compile()]);
else if (mode === 'dir' || mode === 'portable') await packageDesktop(mode);
else throw new Error('Unknown runtime build target: ' + mode);
