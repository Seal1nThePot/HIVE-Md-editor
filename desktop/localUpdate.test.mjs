import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import localUpdate from './localUpdate.cjs';

const { createLocalUpdate, isNewer } = localUpdate;
const event = {};
const runtime = { electron: '45.3.3', platform: 'win32', arch: 'x64' };
const current = { appName: 'HIVE markdown editor', version: '0.1.7', buildNumber: 'old', buildTime: '2026-11-20T00:00:00.000Z', channel: 'stable' };
const fixtures = [];

async function fixture() {
  const resources = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hive-update-mode-'));
  const archive = path.join(resources, 'app.asar');
  const sourceFile = path.join(resources, 'update-source.json');
  const directoryConfig = path.join(resources, 'hive-update-source.json');
  const pack = path.join(archive, 'package.json');
  const buildInfo = path.join(archive, 'dist', 'build-info.json');
  await fs.promises.mkdir(path.dirname(buildInfo), { recursive: true });
  fixtures.push({ resources, sourceFile, directoryConfig, pack, buildInfo, archive });
  await fs.promises.writeFile(pack, JSON.stringify({ name: 'hive-writing-prototype', main: 'desktop/main.mjs', version: current.version }));
  await fs.promises.writeFile(buildInfo, JSON.stringify(current));
  const internetUpdate = { latest: vi.fn(), stage: vi.fn() };
  const dialog = { showMessageBox: vi.fn(), showOpenDialog: vi.fn() };
  const options = {
    app: { getName: () => current.appName, getAppPath: () => archive, isPackaged: true },
    dialog, getParent: () => ({}), isMainOrigin: value => value === event,
    resources, sourceFile, runtime, rawFs: fs, internetUpdate, requestClose: vi.fn(),
  };
  return { create: () => createLocalUpdate(options), directoryConfig, resources, internetUpdate, dialog, options };
}

afterEach(async () => {
  for (const files of fixtures.splice(0)) {
    for (const file of [files.sourceFile, files.directoryConfig, files.pack, files.buildInfo]) {
      await fs.promises.rm(file, { force: true });
    }
    for (const directory of [path.dirname(files.buildInfo), files.archive, files.resources]) {
      await fs.promises.rmdir(directory);
    }
  }
});

function candidate(build) {
  return { manifest: { format: 1, appId: 'local.hive.writing', bytes: 4, sha256: '0'.repeat(64), ...runtime, build } };
}

describe('application update version order', () => {
  it.each([
    ['0.1.7-r3', '0.1.7-r4', true],
    ['0.1.7-r3', '0.1.7-r10', true],
    ['0.1.7-r3', '0.1.7-r2', false],
    ['0.1.7-r3', '0.1.7', true],
    ['0.1.7-r3', '0.1.8', true],
    ['0.1.7-r3', '0.1.7r4', false],
    ['0.1.7', '0.1.7-r3', false],
    ['0.1.8-r1', '0.1.7', false],
  ])('compares %s to %s as newer=%s', (from, to, newer) => {
    expect(isNewer({version:from}, {version:to})).toBe(newer);
  });
});

describe('application update sources', () => {
  it('preserves the local directory and picker and remembers the chosen source in a new handler', async () => {
    const test = await fixture();
    const updates = test.create();
    await expect(updates.available(event)).resolves.toBe('picker');
    await fs.promises.writeFile(test.directoryConfig, JSON.stringify({ directory: test.resources }));
    await expect(updates.available(event)).resolves.toBe('directory');
    await expect(updates.setSource(event, 'internet')).resolves.toBe('internet');
    const reopened = test.create();
    await expect(reopened.available(event)).resolves.toBe('internet');
    await expect(reopened.setSource(event, 'local')).resolves.toBe('directory');
    expect(test.internetUpdate.latest).not.toHaveBeenCalled();
    await expect(updates.setSource({}, 'internet')).rejects.toThrow('无权');
    await expect(updates.setSource(event, 'https://example.com')).rejects.toThrow('无法切换');
  });

  it('checks a current internet build without fetching the archive or displaying an installation prompt', async () => {
    const test = await fixture();
    const updates = test.create();
    await updates.setSource(event, 'internet');
    test.internetUpdate.latest.mockResolvedValue(candidate(current));
    await expect(updates.apply(event)).resolves.toEqual({ status: 'current' });
    expect(test.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(test.internetUpdate.stage).not.toHaveBeenCalled();
  });

  it('prompts before downloading and cleans an invalid download without closing the app', async () => {
    const test = await fixture();
    const updates = test.create();
    await updates.setSource(event, 'internet');
    test.internetUpdate.latest.mockResolvedValue(candidate({ ...current, buildNumber: 'new', buildTime: '2026-11-21T00:00:00.000Z' }));
    test.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
    await expect(updates.apply(event)).resolves.toEqual({ status: 'cancelled' });
    expect(test.internetUpdate.stage).not.toHaveBeenCalled();
    test.internetUpdate.stage.mockImplementation((_candidate, file) => fs.promises.writeFile(file, 'asar', { flag: 'wx' }));
    await expect(updates.apply(event)).resolves.toMatchObject({ status: 'error', message: expect.stringContaining('校验失败') });
    expect(await fs.promises.readdir(test.resources)).toEqual(['app.asar', 'update-source.json']);
    expect(test.options.requestClose).not.toHaveBeenCalled();
  });
});
