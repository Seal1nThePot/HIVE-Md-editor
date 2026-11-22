const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { validBuildInfo } = require('./buildMetadata.cjs');
const { createInternetUpdate } = require('./internetUpdate.cjs');

const appId = 'local.hive.writing';
const maxArchiveSize = 1024 * 1024 * 1024;
const tokenPattern = /^[0-9a-f-]{36}$/;

async function readJson(file, io = fs.promises) {
  if ((await io.stat(file)).size > 64 * 1024) throw new Error('更新包的构建记录无效。');
  return JSON.parse(await io.readFile(file, 'utf8'));
}

async function archiveDigest(file, rawFs) {
  const hash = createHash('sha256');
  for await (const bytes of rawFs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

function isNewer(current, next) {
  if (current.version === next.version) {
    return next.buildNumber !== current.buildNumber && next.buildTime > current.buildTime;
  }
  const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-r(\d+))?$/;
  const currentVersion = versionPattern.exec(current.version);
  const nextVersion = versionPattern.exec(next.version);
  if (!currentVersion || !nextVersion) return false;
  // A stable release sorts after any revision of the same version.
  const from = currentVersion.slice(1).map(part => part === undefined ? Infinity : Number(part));
  const to = nextVersion.slice(1).map(part => part === undefined ? Infinity : Number(part));
  const firstDifference = to.findIndex((part, index) => part !== from[index]);
  return firstDifference >= 0 && to[firstDifference] > from[firstDifference];
}

function validateManifest(manifest, runtime) {
  if (manifest?.format !== 1 || manifest.appId !== appId ||
      typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > maxArchiveSize) {
    throw new Error('请选择 HIVE 生成的有效更新清单。');
  }
  if (manifest.electron !== runtime.electron || manifest.platform !== runtime.platform || manifest.arch !== runtime.arch) {
    throw new Error('这个更新包需要不同的 Windows 运行时或架构，请使用对应的完整程序包。');
  }
}

async function cleanStage(directory, io) {
  for (const name of ['app.asar', 'apply.cjs', 'ready']) {
    await io.rm(path.join(directory, name), { force: true }).catch(() => {});
  }
  await io.rmdir(directory).catch(() => {});
}

async function markUpdateReady(resources, token = process.env.HIVE_UPDATE_STARTUP) {
  if (token && tokenPattern.test(token)) {
    await fs.promises.writeFile(path.join(resources, '.hive-update-' + token, 'ready'), '', { flag: 'wx' });
    delete process.env.HIVE_UPDATE_STARTUP;
  }
}

function createLocalUpdate({ app, dialog, getParent, isMainOrigin, requestClose, resources, sourceFile,
  rawFs = require('original-fs'), runtime, internetUpdate = createInternetUpdate(), execPath = process.execPath, launch = spawn }) {
  const archive = path.join(resources, 'app.asar');
  const supported = () => runtime.platform === 'win32' && app.isPackaged && app.getAppPath() === archive &&
    !process.env.PORTABLE_EXECUTABLE_FILE;
  let busy = false;

  async function releaseDirectory() {
    try {
      const config = await readJson(path.join(resources, 'hive-update-source.json'));
      if (typeof config.directory !== 'string' || !path.isAbsolute(config.directory)) {
        throw new Error('本地更新源配置无效。');
      }
      return path.join(config.directory, 'latest');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  }

  function authorize(event) {
    if (!isMainOrigin(event)) throw new Error('无权执行此操作。');
  }

  async function selectedSource() {
    try {
      return (await readJson(sourceFile))?.source === 'internet' ? 'internet' : 'local';
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return 'local';
    }
  }

  async function mode() {
    if (!supported()) return 'unsupported';
    if (await selectedSource() === 'internet') return 'internet';
    return await releaseDirectory().catch(() => 'configured') ? 'directory' : 'picker';
  }

  async function setSource(event, source) {
    authorize(event);
    if (!supported() || busy || !['local', 'internet'].includes(source)) throw new Error('无法切换更新来源。');
    busy = true;
    const temporary = `${sourceFile}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({ source }), { flag: 'wx' });
      await fs.promises.rename(temporary, sourceFile);
      return await mode();
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
      busy = false;
    }
  }

  async function confirmUpdate(parent, next, online) {
    const confirm = await dialog.showMessageBox(parent, {
      type: 'question', title: '更新 HIVE', message: '更新到 ' + next.version,
      detail: `构建号 ${next.buildNumber}\n\n${online ? '将从 GitHub 下载更新。' : '请确认更新包来自可信来源。'}HIVE 会先保存并退出，更新后自动重启。`,
      buttons: [online ? '下载并更新' : '保存并更新', '取消'], defaultId: 1, cancelId: 1, noLink: true,
    });
    return confirm.response === 0;
  }

  async function apply(event) {
    authorize(event);
    if (!supported()) return { status: 'error', message: '应用内更新适用于 Windows 目录版。' };
    if (busy) return { status: 'error', message: '已有更新正在处理。' };
    busy = true;
    let directory;
    let handedOff = false;
    try {
      const parent = getParent();
      if (!parent) return { status: 'cancelled' };
      const online = await selectedSource() === 'internet';
      let release, published, manifestPath, manifest;
      if (online) {
        release = await internetUpdate.latest();
        manifest = release?.manifest;
      } else {
        published = await releaseDirectory();
        if (published) {
          manifestPath = path.join(published, 'update.hive.json');
        } else {
          const picked = await dialog.showOpenDialog(parent, {
            title: '选择 HIVE 更新清单', properties: ['openFile'], filters: [{ name: 'HIVE 更新清单', extensions: ['json'] }],
          });
          if (picked.canceled || picked.filePaths.length !== 1) return { status: 'cancelled' };
          manifestPath = picked.filePaths[0];
        }
        manifest = await readJson(manifestPath).catch(error => {
          if (published && error.code === 'ENOENT') return null;
          throw error;
        });
      }
      if (!manifest) return { status: 'empty' };
      validateManifest(manifest, runtime);
      const installedPackage = await readJson(path.join(archive, 'package.json'));
      const current = await readJson(path.join(archive, 'dist', 'build-info.json'));
      const matches = (info, pkg) => validBuildInfo(info, { ...pkg, build: { productName: app.getName() } });
      if (!matches(current, installedPackage)) throw new Error('当前应用的构建记录无效。');
      const advertised = manifest.build;
      const advertisedValid = typeof advertised?.version === 'string' && matches(advertised, { ...installedPackage, version: advertised.version });
      if (online && (!advertisedValid || advertised.channel !== 'stable')) throw new Error('GitHub 更新包的构建记录无效。');
      if ((published || online) && advertisedValid && !isNewer(current, advertised)) return { status: 'current' };
      if (online && !await confirmUpdate(parent, advertised, true)) return { status: 'cancelled' };

      const token = randomUUID();
      const candidateDirectory = path.join(resources, '.hive-update-' + token);
      await fs.promises.mkdir(candidateDirectory);
      directory = candidateDirectory;
      const staged = path.join(directory, 'app.asar');
      if (online) {
        await internetUpdate.stage(release, staged, rawFs);
      } else {
        const source = path.join(path.dirname(manifestPath), 'app.asar');
        const stat = await rawFs.promises.lstat(source);
        if (!stat.isFile() || stat.size !== manifest.bytes) throw new Error('更新文件缺失或大小不符，请重新取得完整的更新包。');
        await rawFs.promises.copyFile(source, staged, rawFs.constants.COPYFILE_EXCL);
      }
      if (await archiveDigest(staged, rawFs) !== manifest.sha256) throw new Error('更新文件校验失败，请重新取得更新包。');

      const nextPackage = await readJson(path.join(staged, 'package.json'));
      const next = await readJson(path.join(staged, 'dist', 'build-info.json'));
      if (nextPackage.name !== installedPackage.name || nextPackage.main !== installedPackage.main ||
          !matches(next, nextPackage)) throw new Error('更新包的应用标识或构建记录不匹配。');
      if (online && ['version', 'buildNumber', 'buildTime', 'channel'].some(key => next[key] !== advertised[key])) {
        throw new Error('下载的更新包与 GitHub 更新清单的构建记录不匹配。');
      }
      if (!isNewer(current, next)) return { status: 'current' };
      if (!online && !await confirmUpdate(parent, next, false)) return { status: 'cancelled' };

      const workerFile = path.join(directory, 'apply.cjs');
      await fs.promises.copyFile(path.join(__dirname, 'applyLocalUpdate.cjs'), workerFile);
      const close = await requestClose(async () => {
        const worker = launch(execPath, [workerFile, String(process.pid), token, ...process.argv.slice(1)], {
          cwd: path.dirname(execPath), detached: true, windowsHide: true, stdio: 'ignore',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        await once(worker, 'spawn');
        worker.unref();
        handedOff = true;
      });
      return close ? { status: 'restarting' } : { status: 'error', message: 'HIVE 尚未完成保存退出。请处理当前提示后重试更新。' };
    } catch (error) {
      const message = error.code || error instanceof SyntaxError ? '无法读取或写入更新文件，请检查更新包和程序目录权限。' : error.message;
      return { status: 'error', message };
    } finally {
      if (directory && !handedOff) await cleanStage(directory, rawFs.promises);
      busy = false;
    }
  }

  return {
    async available(event) {
      authorize(event);
      return mode();
    },
    setSource,
    apply,
  };
}

module.exports = { createLocalUpdate, markUpdateReady, isNewer, validateManifest };
