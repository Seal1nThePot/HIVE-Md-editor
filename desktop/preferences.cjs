const { promises: fs } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const exact = new Set(['hive.modelPicker.recent','hive.ai.references.v1','hive.editor-status.v1','hive.editor-status.v2','hive.editor-status.v3','hive.table.sizes.v1','hive.explorer.v1','hive.annotationPreferences.v1','hive.shortcuts.v1','hive.appearance.v1','hive.theme.v1','hive.frontmatter-visible.v1','hive.typography.v1','hive.panelIconDragPreferences.v1','hive.views.v1','hive.aiButtonLayout.v1','hive.recentRepositories.v1','hive.aiResponsePreferences.v1']);
function allowed(key) {
  if (typeof key !== 'string') return false;
  if (exact.has(key)) return true;
  if (key.length <= 4096 && ['hive.explorer.v1:', 'hive.views.v1:', 'hive.ai.references.v1:', 'hive.recentDocuments.v1:', 'hive.quickOpen.v1:'].some(prefix => key.startsWith(prefix) && key.length > prefix.length)) return true;
  if (!key.startsWith('hive.reasoning.') || key.length > 512) return false;
  try { const parts = JSON.parse(key.slice('hive.reasoning.'.length)); return Array.isArray(parts) && parts.length === 2 && parts.every(value => typeof value === 'string'); } catch { return false; }
}
function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid preferences');
  const result = Object.create(null), keys = Object.keys(input).sort();
  if (keys.length > 256) throw new Error('Too many preferences');
  for (const key of keys) {
    if (!allowed(key) || typeof input[key] !== 'string' || Buffer.byteLength(input[key], 'utf8') > 131072) throw new Error('Invalid preference');
    if (key.startsWith('hive.reasoning.') && !['default','off','minimal','low','medium','high','xhigh','max'].includes(input[key])) throw new Error('Invalid reasoning preference');
    result[key] = input[key];
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 524288) throw new Error('Preferences too large');
  return result;
}
function preferenceStore(file) {
  let current = '{}', queue = Promise.resolve();
  async function read() {
    try { const data = normalize(JSON.parse(await fs.readFile(file, 'utf8'))); current = JSON.stringify(data); return data; }
    catch (error) { if (error.code !== 'ENOENT') console.error('Unable to load UI preferences:', error.message); return Object.create(null); }
  }
  function save(input) {
    const json = JSON.stringify(normalize(input));
    queue = queue.catch(() => {}).then(async () => {
      if (json === current) return;
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, json, { encoding: 'utf8', flag: 'wx' }); await fs.rename(temp, file); current = json; }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    });
    return queue;
  }
  return { read, save, flush: () => queue };
}
module.exports = { allowed, normalize, preferenceStore };
