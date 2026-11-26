import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileStore } from '../server/files.mjs';

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative)
    ? relative.replaceAll(path.sep, '/') : undefined;
};

function driveMarkdown(value) {
  if (typeof value !== 'string' || value.length > 32767 || !/^[a-z]:[\\/]/i.test(value)
      || /[:*?"<>|\x00-\x1f]/.test(value.slice(2)) || path.win32.extname(value).toLowerCase() !== '.md')
    throw new Error('请输入有效的 Markdown（.md）绝对路径。');
  return path.resolve(value);
}

export function createLocalDocumentHandlers(isMainFrame) {
  let writes = Promise.resolve();
  function checkSender(event) {
    if (!isMainFrame(event)) throw new Error('无法从此窗口访问本地文稿。');
  }
  async function existingFile(target) {
    try {
      const real = await fs.realpath(target);
      if (!(await fs.stat(real)).isFile()) throw new Error('目标路径必须指向 Markdown 文件。');
      return driveMarkdown(real);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('找不到 Markdown 文件，请核对路径。');
      throw error;
    }
  }
  return {
    async open(event, targetPath, root) {
      checkSender(event);
      const target = driveMarkdown(targetPath);
      const file = await existingFile(target);
      const realRoot = await fs.realpath(root);
      const relative = inside(realRoot, file);
      if (relative) return { relative };
      if (inside(root, target)) throw new Error('路径指向仓库外的符号链接或目录联接。');
      const files = fileStore(path.dirname(file));
      return { external: { ...await files.read(path.basename(file)), path: file.replaceAll(path.sep, '/') } };
    },
    save(event, input) {
      checkSender(event);
      const target = driveMarkdown(input?.path);
      if (typeof input.baseline !== 'string' || !/^[a-f0-9]{64}$/.test(input.baseline))
        throw new Error('保存前请先打开这个 Markdown 文件。');
      // Keep the existing baseline check and atomic replacement, including concurrent writes.
      const task = writes.then(async () => {
        const file = await existingFile(target);
        if (file !== target) throw new Error('目标路径已变化，请核对后重新打开。');
        const files = fileStore(path.dirname(file));
        try {
          const result = await files.save({ ...input, path: path.basename(file) });
          return { ...result, path: file.replaceAll(path.sep, '/') };
        } catch (error) {
          if (error.status === 409) throw new Error('磁盘文件已变化，已阻止覆盖。请复制需保留的内容，或重新读取磁盘。');
          throw error;
        }
      });
      writes = task.catch(() => {});
      return task;
    },
  };
}
