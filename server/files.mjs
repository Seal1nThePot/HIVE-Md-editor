import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileTimes } from "./file-times.mjs";
import { fileIndex } from "./file-index.mjs";
import { scanFileTree } from "./file-index-scan.mjs";

export const hash = (text) =>
  crypto.createHash("sha256").update(text).digest("hex");
export const MAX_MARKDOWN_BYTES = 2_000_000;
export const markdownText = raw => raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });

async function readIfPresent(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function fileStore(root, state, options = {}) {
  const times = state ? fileTimes(state) : null;
  const locks = new Map();
  let mutations = Promise.resolve();
  function enqueue(fn) {
    const task = mutations.catch(() => {}).then(fn);
    mutations = task;
    return task;
  }
  const clearInactiveTimes = () => {if (!index.debugStats().active) times?.clear?.();};
  const index = fileIndex(root, counters => enqueue(async () => {
    try {return await scanFileTree({root, times, options, counters});}
    catch (error) {times?.clear?.(); throw error;}
    finally {clearInactiveTimes();}
  }), options);
  function transaction(fn) {
    return enqueue(async () => {
      try {return await fn();}
      catch (error) {times?.clear?.(); throw error;}
      finally {index.invalidate(); clearInactiveTimes();}
    });
  }
  async function resolve(relative, directory = false) {
    if (
      typeof relative !== "string" ||
      !relative.trim() ||
      relative.includes("\0") ||
      relative
        .split(/[\\/]/)
        .some((p) => p === ".." || p.startsWith(".") || /[:*?"<>|]/.test(p))
    )
      throw fail("文件名称无效。");
    if (!directory && path.extname(relative).toLowerCase() !== ".md")
      throw fail("原型只处理 .md 文件。");
    const target = path.resolve(root, relative);
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw fail("文件必须位于工作空间内。");
    // Do not follow symbolic links or Windows junctions, including parent directories.
    let current = root;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw fail("原型不跟随符号链接或目录联接。");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return target;
  }
  async function exclusive(file, fn) {
    const key = file.toLowerCase();
    const previous = locks.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(fn);
    locks.set(key, result);
    try {
      return await result;
    } finally {
      if (locks.get(key) === result) locks.delete(key);
    }
  }
  async function list(dir = root, prefix = "") {
    // Compatibility reads (search, references and tests) explicitly ask for a
    // fresh tree; polling uses snapshot() and does not walk the disk each time.
    if (dir === root && !prefix) return (await index.snapshot({force:true})).entries;
    return enqueue(async () => {
      const counters = {readdirCount:0, statCount:0, maxPendingStats:0};
      try {return (await scanFileTree({root, dir, prefix, times, options, counters})).entries;}
      catch (error) {times?.clear?.(); throw error;}
      finally {clearInactiveTimes();}
    });
  }
  async function read(relative, knownHash) {
    const target = await resolve(relative);
    const stat = await fs.stat(target);
    if (stat.size > MAX_MARKDOWN_BYTES)
      throw fail("原型支持 2 MB 以内的 Markdown 文件。");
    const raw = await fs.readFile(target, "utf8");
    const currentHash = hash(raw);
    if (typeof knownHash === "string" && currentHash === knownHash)
      return { path: relative, hash: currentHash, unchanged: true };
    return {
      path: relative,
      text: markdownText(raw),
      hash: currentHash,
      eol: raw.includes("\r\n") ? "CRLF" : "LF",
      bom: raw.startsWith("\uFEFF"),
    };
  }
  async function save({
    path: relative,
    text,
    baseline,
    eol = "LF",
    bom = false,
  }) {
    const target = await resolve(relative);
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_MARKDOWN_BYTES)
      throw fail("文件内容无效或超过 2 MB。");
    return exclusive(target, async () => {
      const old = await readIfPresent(target);
      if (
        (old !== null && hash(old) !== baseline) ||
        (old === null && baseline != null)
      )
        throw fail(
          "磁盘文件已变化，已阻止覆盖。请另存，或重新打开后核对。",
          409,
        );
      const timeData = times ? await times.read() : null;
      const originalCreatedAt = times && old !== null
        ? times.observe(timeData, relative, await fs.stat(target)).createdAt
        : undefined;
      const raw =
        (bom ? "\uFEFF" : "") +
        (eol === "CRLF" ? text.replace(/\r?\n/g, "\r\n") : text);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
      );
      try {
        await fs.writeFile(temp, raw, { encoding: "utf8", flag: "wx" });
        // Recheck after preparing the file. External writers can still race the rename.
        const latest = await readIfPresent(target);
        if (latest !== old)
          throw fail("保存期间磁盘文件发生变化，已阻止覆盖。", 409);
        if (old === null)
          await fs.link(temp, target);
        else await fs.rename(temp, target);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
      const result = { hash: hash(raw), path: relative };
      if (times) {
        try {
          const stat = await fs.stat(target);
          times.replaced(timeData, relative, stat, originalCreatedAt ?? stat.birthtimeMs);
          await times.write(timeData);
        } catch {
          times.clear();
          // The file is already published. The caller still needs its new baseline.
          return { ...result, warning: "正文已保存，但未能更新文件时间记录。" };
        }
      }
      return result;
    });
  }
  async function folder(relative) {
    const target = await resolve(relative, true);
    await fs.mkdir(target, { recursive: true });
  }
  async function rename(from, to, baseline) {
    const source = await resolve(from),
      target = await resolve(to);
    return exclusive(source, async () => {
      const current = await fs.readFile(source, "utf8");
      if (hash(current) !== baseline)
        throw fail("磁盘文件已变化，请重新打开后整理。", 409);
      const timeData=times ? await times.read() : null;
      const createdAt=times ? times.observe(timeData,from,await fs.stat(source)).createdAt : null;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.link(source, target); // No silent overwrite of an existing name.
      await fs.unlink(source);
      if(times){delete timeData[from];times.replaced(timeData,to,await fs.stat(target),createdAt);await times.write(timeData);}
      return read(to);
    });
  }
  return { list, snapshot:index.snapshot, invalidate:index.invalidate, debugStats:index.debugStats,
    suspend:() => {index.suspend(); times?.clear?.();}, resume:index.resume,
    close:async () => {await index.close(); await mutations.catch(() => {}); times?.clear?.();}, read, resolve, transaction,
    save: (...args) => transaction(() => save(...args)),
    folder: (...args) => transaction(() => folder(...args)),
    rename: (...args) => transaction(() => rename(...args)) };
}
