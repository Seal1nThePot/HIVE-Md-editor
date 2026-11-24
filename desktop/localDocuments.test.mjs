import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLocalDocumentHandlers } from './localDocuments.mjs';

describe.skipIf(process.platform !== 'win32')('opening Windows Markdown paths from desktop', () => {
  const sender = {};
  const { open, save } = createLocalDocumentHandlers(event => event === sender);
  let folder, repo, internal, external;
  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-local-document-'));
    repo = path.join(folder, '仓库');
    await fs.mkdir(repo);
    internal = path.join(repo, '中文 空格.md');
    external = path.join(folder, '中文 空格.md');
    await Promise.all([
      fs.writeFile(internal, '# 仓库文稿\n'),
      fs.writeFile(external, '\uFEFF# 仓库外\r\n'),
    ]);
  });
  afterEach(() => fs.rm(folder, { recursive: true, force: true }));

  it('resolves the canonical repository path and rejects invalid files and other frames', async () => {
    await expect(open(sender, internal.replaceAll('\\', '/'), repo)).resolves.toEqual({ relative: '中文 空格.md' });
    await expect(open(sender, path.join(repo, '缺失.md'), repo)).rejects.toThrow('找不到');
    await expect(open(sender, external + ':stream', repo)).rejects.toThrow('有效');
    await expect(open({}, external, repo)).rejects.toThrow('此窗口');
  });

  it('saves the original with its line endings and blocks concurrent stale saves', async () => {
    const { external: disk } = await open(sender, external, repo);
    expect(disk).toMatchObject({ text: '# 仓库外\n', eol: 'CRLF', bom: true });
    const edits = await Promise.allSettled([
      save(sender, { ...disk, baseline: disk.hash, text: '# 编辑一\n' }),
      save(sender, { ...disk, baseline: disk.hash, text: '# 编辑二\n' }),
    ]);
    expect(edits[0].status).toBe('fulfilled');
    expect(edits[1]).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('已阻止覆盖') } });
    expect(await fs.readFile(external, 'utf8')).toBe('\uFEFF# 编辑一\r\n');
    expect(await fs.readFile(internal, 'utf8')).toBe('# 仓库文稿\n');
  });
});
