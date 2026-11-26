const { contextBridge, ipcRenderer } = require('electron');
// Only the main window receives preferences; child windows share its renderer-owned state.
const initialPreferences = ipcRenderer.sendSync('hive:preferences-read');
let collectPreferences = () => {};
if (initialPreferences !== null) {
  const exact = new Set(['hive.modelPicker.recent','hive.ai.references.v1','hive.editor-status.v1','hive.editor-status.v2','hive.editor-status.v3','hive.table.sizes.v1','hive.explorer.v1','hive.annotationPreferences.v1','hive.shortcuts.v1','hive.appearance.v1','hive.theme.v1','hive.frontmatter-visible.v1','hive.typography.v1','hive.panelIconDragPreferences.v1','hive.views.v1','hive.aiButtonLayout.v1','hive.recentRepositories.v1','hive.aiResponsePreferences.v1']);
  const allowed = key => {
    if (exact.has(key)) return true;
    if (key.length <= 4096 && ['hive.explorer.v1:', 'hive.views.v1:', 'hive.ai.references.v1:', 'hive.recentDocuments.v1:'].some(prefix => key.startsWith(prefix) && key.length > prefix.length)) return true;
    if (!key.startsWith('hive.reasoning.') || key.length > 512) return false;
    try { const parts = JSON.parse(key.slice('hive.reasoning.'.length)); return Array.isArray(parts) && parts.length === 2 && parts.every(value => typeof value === 'string'); } catch { return false; }
  };
  try {
    for (const key of Object.keys(localStorage)) if (allowed(key)) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(initialPreferences)) localStorage.setItem(key, value);
    let last = JSON.stringify(initialPreferences);
    collectPreferences = () => {
      try {
        const data = {};
        for (const key of Object.keys(localStorage).filter(allowed).sort()) {
          const value = localStorage.getItem(key);
          if (value !== null && (!key.startsWith('hive.reasoning.') || ['default','off','minimal','low','medium','high','xhigh','max'].includes(value))) data[key] = value;
        }
        const next = JSON.stringify(data);
        if (next !== last) { ipcRenderer.send('hive:preferences-save', data); last = next; }
      } catch (error) { console.error('Unable to collect UI preferences:', error); }
    };
    setInterval(collectPreferences, 2000);
  } catch (error) { console.error('Unable to restore UI preferences:', error); }
}
contextBridge.exposeInMainWorld('hiveDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  startupThemeReady: background => { if (initialPreferences !== null && typeof background === 'string' && /^#[a-f0-9]{6}$/i.test(background)) ipcRenderer.send('hive:startup-theme-ready', background); },
  chooseRepositoryDirectory: () => ipcRenderer.invoke('hive:repository-directory'),
  getAboutInfo: () => ipcRenderer.invoke('hive:about-info'),
  openAppDataDirectory: () => ipcRenderer.invoke('hive:open-app-data-directory'),
  openExternalHttpLink: target => typeof target === 'string' && target.length <= 8192 ? ipcRenderer.invoke('hive:open-external-http-link', target) : Promise.resolve(false),
  openLocalMarkdown: (target, root) => ipcRenderer.invoke('hive:open-local-markdown', target, root),
  saveLocalMarkdown: document => ipcRenderer.invoke('hive:save-local-markdown', document),
  getUpdateMode: () => ipcRenderer.invoke('hive:update-available'),
  setUpdateSource: source => ipcRenderer.invoke('hive:update-source', source),
  getUpdateProgress: () => ipcRenderer.invoke('hive:update-progress'),
  onUpdateProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('hive:update-progress-event', listener);
    return () => ipcRenderer.removeListener('hive:update-progress-event', listener);
  },
  installUpdate: () => ipcRenderer.invoke('hive:update'),
  windowCommand: (command, panelId) => { if (['minimize','maximize','close','focus','hide'].includes(command) && (panelId === undefined || typeof panelId === 'string')) ipcRenderer.send('hive:window-command', command, panelId); },
  panelReady: (id, placement, inactive) => { if (typeof id === 'string') return ipcRenderer.sendSync('hive:panel-ready', id, placement, inactive === true); return false; },
  panelRect: id => typeof id === 'string' ? ipcRenderer.sendSync('hive:panel-rect', id) : null,
  panelDrag: (id, phase, edge, free) => { if (typeof id === 'string' && ['start','move','end','cancel'].includes(phase) && (edge === undefined || ['n','s','e','w','ne','nw','se','sw'].includes(edge))) { if (phase === 'start') return ipcRenderer.sendSync('hive:panel-drag', id, phase, edge, free === true); ipcRenderer.send('hive:panel-drag', id, phase, edge, free === true); } return false; },
  dockOverlay: feedback => { if (feedback === null || (feedback && typeof feedback === 'object')) ipcRenderer.send('hive:dock-overlay', feedback); },
  dockTooltip: value => { if (value === null || (value && typeof value === 'object')) ipcRenderer.send('hive:dock-tooltip', value); },
  onPanelMove: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('hive:panel-move', listener);
    return () => ipcRenderer.removeListener('hive:panel-move', listener);
  },
  onCloseRequested: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = () => callback();
    ipcRenderer.on('hive:close-requested', listener);
    ipcRenderer.send('hive:close-ready');
    return () => ipcRenderer.removeListener('hive:close-requested', listener);
  },
  finishClose: allow => { if (typeof allow === 'boolean') { if (allow) collectPreferences(); ipcRenderer.send('hive:close-finish', allow); } },
  onPanelCloseRequested: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, id) => { if (typeof id === 'string') callback(id); };
    ipcRenderer.on('hive:panel-close-requested', listener);
    return () => ipcRenderer.removeListener('hive:panel-close-requested', listener);
  },
  closePanel: id => { if (typeof id === 'string') ipcRenderer.send('hive:panel-close', id); },
  onServiceError: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = () => callback();
    ipcRenderer.on('hive:service-error', listener);
    return () => ipcRenderer.removeListener('hive:service-error', listener);
  },
}));

