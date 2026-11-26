import {useEffect, useRef, useState} from 'react';
import type {AboutInfo} from '../../shared/buildInfo';
import {browserAboutInfo, copyAboutDiagnostic, diagnosticPreview, openAboutDataDirectory, readDesktopAboutInfo} from './aboutInfo';
import type {UpdateProgress} from './updateProgress';
import helpText from '../../../docs/help.md?raw';
import changelogText from '../../../docs/CHANGELOG.md?raw';
import licenseText from '../../../LICENSE?raw';
import './about.css';

const modeLabels: Record<AboutInfo['runtime']['mode'], string> = {
  'desktop-development': '桌面开发运行', 'desktop-package': '桌面应用包',
  'browser-development': '浏览器开发运行', 'browser-build': '浏览器本地构建',
};
const displayBuildValue = (value: string) => !value || value === 'unavailable' ? '未记录' : value;
const displayReleaseVersion = (version: string) => version.replace(/^(\d+\.\d+\.\d+)-r(\d+)$/, '$1r$2');
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
  ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export default function AboutSettings() {
  const bridge = window.hiveDesktop?.isDesktop ? window.hiveDesktop : undefined;
  const desktop = !!bridge;
  const build = __HIVE_BUILD_INFO__;
  const [info, setInfo] = useState<AboutInfo | null>(() => desktop ? null : browserAboutInfo(build, import.meta.env.DEV, navigator.platform));
  const [loading, setLoading] = useState(desktop);
  const [feedback, setFeedback] = useState('');
  const [copying, setCopying] = useState(false);
  const [opening, setOpening] = useState(false);
  const [updateMode, setUpdateMode] = useState<'unsupported'|'directory'|'picker'|'internet'>('unsupported');
  const [settingUpdateSource, setSettingUpdateSource] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>({phase:'idle'});
  const [updateFeedback, setUpdateFeedback] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (bridge) {
      void readDesktopAboutInfo(bridge).then(value => {
        if (alive.current) { setInfo(value); setLoading(false); }
      });
      void bridge.getUpdateMode?.().then(value => {
        if (alive.current) setUpdateMode(value);
      }).catch(() => {});
    }
    return () => { alive.current = false; };
  }, [bridge]);
  useEffect(() => {
    let current = true;
    let hasEvent = false;
    const unsubscribe = bridge?.onUpdateProgress?.(value => {
      hasEvent = true;
      if (current) setUpdateProgress(value);
    });
    void bridge?.getUpdateProgress?.().then(value => {
      if (current && !hasEvent) setUpdateProgress(value);
    }).catch(() => {});
    return () => { current = false; unsubscribe?.(); };
  }, [bridge]);
  const updating = requestPending || (updateProgress.phase !== 'idle' && updateProgress.phase !== 'error');
  const transfer = 'receivedBytes' in updateProgress && updateProgress.receivedBytes !== undefined ? updateProgress : null;
  const updateStatus = updateProgress.phase === 'downloaded' ? '下载完成，正在验证更新包…'
    : updateProgress.phase === 'restarting' ? '正在重启 HIVE…'
    : updateProgress.phase === 'error' ? updateProgress.message : updateFeedback;
  const metadata = info || build;
  const missingBuildRecord = !loading && [metadata.buildNumber, metadata.buildTime, metadata.channel].some(value => !value || value === 'unavailable');
  const preview = diagnosticPreview(build, info, desktop);

  async function copy() {
    setCopying(true); setFeedback('');
    const result = await copyAboutDiagnostic(preview, navigator.clipboard);
    if (!alive.current) return;
    setCopying(false);
    setFeedback(result === 'copied' ? '已复制上方预览中的诊断信息。' : result === 'unavailable'
      ? '当前环境不支持剪贴板，请手动选择上方预览并复制。' : '复制失败，请手动选择上方预览并复制。');
  }
  async function openDirectory() {
    if (!bridge) return;
    setOpening(true); setFeedback('');
    const opened = await openAboutDataDirectory(bridge);
    if (!alive.current) return;
    setOpening(false); setFeedback(opened ? '已请求打开应用数据目录。' : '无法打开应用数据目录，请稍后重试。');
  }
  async function changeUpdateSource(source: 'local' | 'internet') {
    if (!bridge?.setUpdateSource) return;
    setSettingUpdateSource(true);
    setUpdateFeedback('');
    try {
      const mode = await bridge.setUpdateSource(source);
      if (alive.current) setUpdateMode(mode);
    } catch {
      if (alive.current) setUpdateFeedback('无法保存更新来源，请重试。');
    } finally {
      if (alive.current) setSettingUpdateSource(false);
    }
  }
  async function update() {
    if (!bridge?.installUpdate) return;
    setRequestPending(true);
    setUpdateProgress({phase:'idle'});
    setUpdateFeedback('');
    try {
      const result = await bridge.installUpdate();
      if (!alive.current) return;
      if (result.status === 'restarting') setUpdateFeedback('正在重启 HIVE…');
      if (result.status === 'error') setUpdateFeedback(result.message);
      if (result.status === 'current') setUpdateFeedback('当前没有较新的更新。');
      if (result.status === 'empty') setUpdateFeedback(updateMode === 'internet' ? 'GitHub 暂无可用的稳定版更新包。' : '更新目录中还没有发布包。');
    } catch {
      if (alive.current) setUpdateFeedback('无法开始更新，请重试。');
    } finally {
      if (alive.current) setRequestPending(false);
    }
  }

  return <div className="about-settings">
    <section className="settings-card about-metadata" aria-labelledby="about-version-title">
      <h2 id="about-version-title">{metadata.appName}</h2>
      <p className="about-mode">{loading ? '正在读取桌面运行信息…' : info ? modeLabels[info.runtime.mode] : '桌面运行信息暂不可用'}</p>
      {!loading && desktop && !info && <p role="alert">无法读取桌面信息。下方版本与构建来自当前页面的构建元数据，不能据此确认桌面应用包；诊断中的运行环境留空。</p>}
      {missingBuildRecord && <p role="status">构建记录缺失或与应用版本不一致，无法确认该构建。</p>}
      <dl>
        <div><dt>版本</dt><dd>{displayReleaseVersion(metadata.version)}</dd></div>
        <div><dt>构建编号</dt><dd>{displayBuildValue(metadata.buildNumber)}</dd></div>
        <div><dt>构建时间（UTC）</dt><dd>{displayBuildValue(metadata.buildTime)}</dd></div>
        <div><dt>发行渠道</dt><dd>{displayBuildValue(metadata.channel)}</dd></div>
        <div><dt>信息来源</dt><dd>{info && desktop ? '桌面应用' : desktop ? '页面构建元数据（回退）' : '页面构建元数据'}</dd></div>
        {info && <><div><dt>平台 / 架构</dt><dd>{info.runtime.platform} / {info.runtime.arch}</dd></div>
          {info.runtime.electron && <div><dt>Electron</dt><dd>{info.runtime.electron}</dd></div>}
          {info.runtime.chrome && <div><dt>Chromium</dt><dd>{info.runtime.chrome}</dd></div>}
          {info.runtime.node && <div><dt>Node.js</dt><dd>{info.runtime.node}</dd></div>}</>}
      </dl>
    </section>
    <section className="settings-card about-update" aria-labelledby="about-update-title">
      <h2 id="about-update-title">应用更新</h2>
      {updateMode !== 'unsupported' ? <>
        <label className="about-update-source">
          更新来源
          <select value={updateMode === 'internet' ? 'internet' : 'local'} disabled={updating || settingUpdateSource}
            onChange={event => void changeUpdateSource(event.target.value === 'internet' ? 'internet' : 'local')}>
            <option value="local">本地</option>
            <option value="internet">互联网（GitHub）</option>
          </select>
        </label>
        <p>{updateMode === 'internet' ? '从 GitHub Releases 检查稳定版。' : updateMode === 'directory'
          ? '从本地稳定版发布目录检查更新。' : '选择新版更新包中的 update.hive.json。'} 确认后，HIVE 会保存并退出，更新完成后自动重启。</p>
        <div className="about-actions">
          <button type="button" className="settings-secondary" disabled={updating || settingUpdateSource} onClick={() => void update()}>
            {updating ? updateProgress.phase === 'downloading' ? '正在下载更新…' : updateProgress.phase === 'downloaded' || updateProgress.phase === 'restarting' ? '正在准备更新…' : '正在检查更新…' : updateMode === 'picker' ? '选择本地更新包…' : '检查更新'}
          </button>
        </div>
        {transfer && transfer.receivedBytes !== undefined && <div className="about-download-progress">
          <div><span>下载进度</span><span>{transfer.totalBytes ? `${Math.floor(100 * transfer.receivedBytes / transfer.totalBytes)}% · ${formatBytes(transfer.receivedBytes)} / ${formatBytes(transfer.totalBytes)}`
            : `已下载 ${formatBytes(transfer.receivedBytes)}`}</span></div>
          <progress aria-label="更新下载进度" value={transfer.totalBytes ? transfer.receivedBytes : undefined} max={transfer.totalBytes || undefined}/>
        </div>}
        {updateStatus && <p role={updateProgress.phase === 'error' ? 'alert' : 'status'} className="about-feedback">{updateStatus}</p>}
      </> : <p>应用内更新适用于 Windows 目录版。</p>}
    </section>
    <section className="settings-card about-documents" aria-labelledby="about-documents-title">
      <h2 id="about-documents-title">离线资料</h2>
      <p>在此展开阅读，不会离开当前写作会话。</p>
      {[['使用帮助', helpText], ['更新日志', changelogText], ['许可证 · AGPL-3.0-or-later', licenseText]].map(([title, text]) =>
        <details key={title}><summary>{title}</summary><pre tabIndex={0} aria-label={title}>{text}</pre></details>)}
    </section>
    <section className="settings-card about-diagnostics" aria-labelledby="about-diagnostics-title">
      <h2 id="about-diagnostics-title">诊断信息</h2>
      <p>复制内容与下方预览一致，仅包含版本、构建与运行环境。不读取正文、聊天、模型配置、密钥或本机完整路径。</p>
      <pre tabIndex={0} aria-label="诊断信息预览">{preview}</pre>
      <div className="about-actions">
        <button type="button" className="settings-secondary" disabled={loading || copying} onClick={() => void copy()}>{copying ? '正在复制…' : '复制诊断信息'}</button>
        {desktop && <button type="button" className="settings-secondary" disabled={opening} onClick={() => void openDirectory()}>{opening ? '正在打开…' : '打开应用数据目录'}</button>}
      </div>
      {!desktop && <p>应用数据目录仅在桌面版中可打开。</p>}
      {feedback && <p role="status" aria-live="polite" className="about-feedback">{feedback}</p>}
    </section>
  </div>;
}
