import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {readStateObject} from './state-json.mjs';

const metrics = new Set(['document-lines', 'selected-lines', 'line-length']);
const idPattern = /^[a-z][a-z0-9.-]{0,63}$/;
const manifestLimit = 16 * 1024;
const pluginLimit = 64;
const fail = (message, status=400) => Object.assign(new Error(message), {status});
const validText = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value);

function parseManifest(value) {
  if (value?.version !== 1 || typeof value.id !== 'string' || !idPattern.test(value.id) || !validText(value.name, 48)
      || (value.description !== undefined && !validText(value.description, 240))) throw fail('插件名称、标识或清单版本无效。');
  const entry = value.contribution;
  if (entry?.slot !== 'editor.status' || !metrics.has(entry.metric) || !validText(entry.label, 28)) {
    throw fail('插件的扩展位置、统计类型或标签无效。');
  }
  return {id:value.id, name:value.name.trim(), description:value.description?.trim() ?? '',
    contribution:{slot:entry.slot, metric:entry.metric, label:entry.label.trim()}};
}

async function readManifest(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > manifestLimit) throw fail('请选择 16 KB 以内的普通 JSON 文件。');
  const handle = await fs.open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw fail('请选择普通 JSON 文件。');
    const bytes = Buffer.alloc(manifestLimit + 1);
    const {bytesRead} = await handle.read(bytes);
    if (bytesRead > manifestLimit) throw fail('插件清单超过 16 KB。');
    return parseManifest(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')));
  } finally { await handle.close(); }
}

export function pluginStore(directory, stateDirectory, sampleFile, openDirectory) {
  const stateFile = path.join(stateDirectory, 'plugins-enabled.json');
  let writes = Promise.resolve();

  async function prepare() {
    await fs.mkdir(directory, {recursive:true});
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('插件目录必须是普通目录。', 409);
  }

  async function enabledIds() {
    const state = await readStateObject(stateFile, '已启用插件');
    if (!state) return new Set();
    if (!Array.isArray(state.ids) || state.ids.length > pluginLimit || state.ids.some(id=>typeof id !== 'string' || !idPattern.test(id))) {
      throw fail('已启用插件的配置格式无效。', 409);
    }
    return new Set(state.ids);
  }

  async function list() {
    await prepare();
    const enabled = await enabledIds();
    const records = await fs.readdir(directory, {withFileTypes:true});
    const manifestFiles = records.filter(entry => entry.name.toLowerCase().endsWith('.json') && !entry.isDirectory())
      .map(entry=>entry.name).sort((a,b)=>a.localeCompare(b,'en'));
    const errors = [];
    const found = new Map();
    const duplicates = new Set();
    for (const file of manifestFiles.slice(0, pluginLimit)) {
      try {
        const plugin = await readManifest(path.join(directory, file));
        const previous = found.get(plugin.id);
        if (previous) {
          errors.push({file:previous.file,message:'插件标识重复。'});
          found.delete(plugin.id);
          duplicates.add(plugin.id);
        }
        if (duplicates.has(plugin.id)) errors.push({file,message:'插件标识重复。'});
        else found.set(plugin.id, {...plugin, file, enabled:enabled.has(plugin.id)});
      } catch (error) {
        errors.push({file,message:error instanceof SyntaxError ? '插件清单不是有效的 JSON。'
          : error.status ? error.message : '无法读取插件清单。'});
      }
    }
    return {directory, plugins:[...found.values()], errors, limitReached:manifestFiles.length > pluginLimit,
      canOpenDirectory:!!openDirectory, canInstallSample:!manifestFiles.some(name=>name.toLowerCase()==='hive-selection-lines.json')};
  }

  function serialize(action) {
    const next = writes.then(action);
    writes = next.catch(()=>{});
    return next;
  }

  return {
    list,
    setEnabled(value) {
      return serialize(async () => {
        if (typeof value?.id !== 'string' || typeof value.enabled !== 'boolean') throw fail('请选择有效插件。');
        const current = await list();
        if (!current.plugins.some(plugin=>plugin.id===value.id)) throw fail('插件已移除或无法读取，请刷新列表。', 404);
        const enabled = new Set(current.plugins.filter(plugin=>plugin.enabled).map(plugin=>plugin.id));
        if (value.enabled) enabled.add(value.id);
        else enabled.delete(value.id);
        await fs.mkdir(stateDirectory, {recursive:true});
        const temporary = `${stateFile}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify({ids:[...enabled]}), {flag:'wx'});
          await fs.rename(temporary, stateFile);
        } finally { await fs.rm(temporary, {force:true}).catch(()=>{}); }
        return {...current, plugins:current.plugins.map(plugin=>({...plugin,enabled:enabled.has(plugin.id)}))};
      });
    },
    installSample() {
      return serialize(async () => {
        await prepare();
        const destination = path.join(directory, 'hive-selection-lines.json');
        const source = await fs.readFile(sampleFile);
        try { await fs.writeFile(destination, source, {flag:'wx'}); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        return list();
      });
    },
    async open() {
      if (!openDirectory) throw fail('请在系统文件管理器中手动打开插件目录。', 503);
      await prepare();
      await openDirectory(await fs.realpath(directory));
      return {ok:true};
    },
  };
}
