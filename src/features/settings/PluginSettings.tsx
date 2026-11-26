import type {usePlugins} from './usePlugins';
import './plugin-settings.css';

export default function PluginSettings({plugins}:{plugins:ReturnType<typeof usePlugins>}) {
  const {catalog,error,busy,reload,enable,openDirectory,installSample} = plugins;
  return <section className="settings-card plugin-settings" aria-labelledby="plugin-settings-title">
    <h2 id="plugin-settings-title">插件</h2>
    <p>将插件的 JSON 清单放入插件目录后，刷新列表并启用。当前扩展位置为写作区底部栏。</p>
    {catalog && <p className="plugin-directory"><span>插件目录</span><code>{catalog.directory}</code></p>}
    <div className="plugin-actions">
      {catalog?.canOpenDirectory && <button type="button" className="settings-secondary" disabled={busy} onClick={()=>void openDirectory()}>打开插件目录</button>}
      <button type="button" className="settings-secondary" disabled={busy} onClick={()=>void reload()}>刷新插件</button>
      {catalog?.canInstallSample && <button type="button" className="settings-secondary" disabled={busy} onClick={()=>void installSample()}>添加示例插件</button>}
    </div>
    {busy && !catalog && <p role="status">正在读取插件…</p>}
    {error && <p role="alert">{error}</p>}
    {catalog?.plugins.length === 0 && <p>插件目录还没有可用插件。</p>}
    {catalog && catalog.plugins.length > 0 && <ul className="plugin-list">{catalog.plugins.map(plugin=><li key={plugin.id}>
      <div><strong>{plugin.name}</strong>{plugin.description && <p>{plugin.description}</p>}<small>{plugin.file}</small></div>
      <label><input type="checkbox" role="switch" checked={plugin.enabled} disabled={busy} aria-label={`启用${plugin.name}`}
        onChange={event=>void enable(plugin.id,event.target.checked)}/><span>{plugin.enabled?'已启用':'未启用'}</span></label>
    </li>)}</ul>}
    {catalog?.limitReached && <p role="status">插件目录仅扫描按文件名排序的前 64 个 JSON 清单。</p>}
    {!!catalog?.errors.length && <details className="plugin-problems"><summary>无法加载的清单（{catalog.errors.length}）</summary>
      <ul>{catalog.errors.map(({file,message})=><li key={file}>{file} · {message}</li>)}</ul>
    </details>}
  </section>;
}
