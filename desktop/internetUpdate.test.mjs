import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import internetUpdate from './internetUpdate.cjs';

const { createInternetUpdate } = internetUpdate;
const repository = 'Seal1nThePot/HIVE-Md-editor';
const build = { version: '0.1.7' };
const release = { tag_name: 'v0.1.7', assets: [
  { name: 'update.hive.json', state: 'uploaded' }, { name: 'app.asar', state: 'uploaded', size: 4 },
] };
const folders = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map(async folder => {
    await fs.promises.rm(path.join(folder, 'app.asar'), { force: true });
    await fs.promises.rmdir(folder);
  }));
});

describe('GitHub updates', () => {
  it('pins both assets to one stable release and accepts a GitHub CDN redirect', async () => {
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(Response.redirect('https://release-assets.githubusercontent.com/manifest'))
      .mockResolvedValueOnce(Response.json({ build, bytes: 4 }))
      .mockResolvedValueOnce(new Response('asar'));
    const updates = createInternetUpdate(fetchFile);
    const candidate = await updates.latest();
    const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hive-internet-update-'));
    folders.push(folder);
    const destination = path.join(folder, 'app.asar');
    await updates.stage(candidate, destination, fs);
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('asar');
    expect(fetchFile.mock.calls.map(([url]) => url.href)).toEqual([
      `https://api.github.com/repos/${repository}/releases/latest`,
      `https://github.com/${repository}/releases/download/v0.1.7/update.hive.json`,
      'https://release-assets.githubusercontent.com/manifest',
      `https://github.com/${repository}/releases/download/v0.1.7/app.asar`,
    ]);
  });

  it('rejects an untrusted redirect before making a request to its destination', async () => {
    const fetchFile = vi.fn().mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(Response.redirect('https://example.com/update.hive.json'));
    await expect(createInternetUpdate(fetchFile).latest()).rejects.toThrow('不属于可信的 GitHub 发布源');
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it('reports an empty source when there is no public release with a complete update pair', async () => {
    const fetchFile = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ...release, assets: release.assets.slice(0, 1) }));
    const updates = createInternetUpdate(fetchFile);
    await expect(updates.latest()).resolves.toBeNull();
    await expect(updates.latest()).resolves.toBeNull();
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it('rejects manifest size and version mismatches', async () => {
    const fetchFile = vi.fn().mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(Response.json({ build: { version: '0.1.8' }, bytes: 5 }));
    await expect(createInternetUpdate(fetchFile).latest()).rejects.toThrow('与发布附件不匹配');
  });

  it.each(['too large', 'a'])('rejects archive byte count mismatches (%s)', async body => {
    const updates = createInternetUpdate(vi.fn().mockResolvedValue(new Response(body)));
    const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hive-internet-update-'));
    folders.push(folder);
    await expect(updates.stage({ archiveUrl: new URL('https://github.com/update'), manifest: { bytes: 4 } },
      path.join(folder, 'app.asar'), fs)).rejects.toThrow('更新包');
  });
});
