# HIVE 0.1.9 桌面封装

`npm run desktop:folder` 生成 Windows x64 目录包。默认输出为项目同级 `.work/019-csharp-backend/release/win-unpacked`。目录中运行 `HIVE markdown editor.exe`。发行包包含 .NET 运行时。完整命令见 [运行手册](runbook.md)。

`resources/app.asar` 包含 Electron 外壳和前端构建资源。`resources/backend` 包含 C# 自包含程序和 `app` 资源目录。C# 从该目录加载前端、模板、图标、示例清单和构建记录。源码中的 JavaScript 服务模块用于旧行为对照和回归测试。

Electron 主进程直接启动 `resources/backend/Hive.Backend.exe`。Kestrel 绑定 IPv4 环回随机端口，并向标准输出发送包含端口与 PID 的 `hive-ready`。偏好、仓库外文稿和更新通过私有 JSON 管道调用。文件夹选择与系统资源管理器仍由 Electron 提供。开发模式另由 Vite 托管前端，`/api` 代理给相同的 C# 服务。

界面偏好由 `preload.cjs` 收集和恢复，`NativeData.cs` 验证与原子写入。退出时先等渲染端保存和偏好写入，再通知 C# 服务关闭。服务收到关闭消息或管道 EOF 时停止。桌面资料默认沿用 `%APPDATA%\HIVE`，隔离运行可设 `HIVE_DESKTOP_USER_DATA`。

0.1.9 更新包包含 `app.asar` 和完整后端资源。首次由 0.1.8 切换时使用完整目录包。后续更新细节见 [构建记录与更新](build-info.md)。

## 0.1.6 封装与窗口协议记录

以下是 0.1.6 封装与窗口协议的历史记录。当前构建和服务启动以本页开头及运行手册为准。

## 1. 目录与命令

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `desktop/main.mjs` | 363 | 主进程：起服务子进程、开主窗、放行独立面板窗、窗口命令、关闭/退出协议、单实例、偏好 IPC |
| `desktop/preload.cjs` | 72 | `contextBridge` 暴露 `window.hiveDesktop`；主窗额外做 localStorage ↔ `ui-preferences.json` 的恢复与回写 |
| `desktop/preferences.cjs` | 43 | 界面偏好存储：key 白名单、大小上限、原子写（`tmp` + `rename`）、串行队列 |
| `desktop/windowPolicy.cjs` | 70 | 四个纯函数：`allowNavigation(url, entry, loaded)`（只放行精确入口的首次导航）、`validCommand(value)`、`commandAllowed(command, isPanel)`（子窗拒绝 `maximize`）、`readyPanels(windows, ready)`（只取已 `panelReady` 且未销毁的窗） |
| `desktop/panelGeometry.cjs` | 39 | 子窗初始位置换算（`panelBounds`：默认主窗 +50/+50、按 `workArea` 夹取，见 [panel-lifecycle](panel-lifecycle.md)） |
| `desktop/panelReady.cjs` | 31 | `panelReady(id)` 状态记录（决定子窗何时 `show()`，防白屏） |
| `desktop/repositoryPicker.cjs` | 17 | 仓库选择对话框 |
| `desktop/templateSource.cjs` | 19 | 模板来源目录解析（打包内外路径） |
| `desktop/tooltipManager.cjs` | 49 | 悬浮提示（tooltip）管理 |
| `desktop/tooltip-overlay.cjs` | 6 | 提示浮层 |
| `desktop/dock-overlay.cjs` | 28 | 停靠拖拽浮层 |
| `desktop/fileReveal.cjs` | 18 | 「在资源管理器中显示」（`revealFile`） |
| `desktop/about.cjs` | 31 | 关于页 IPC（`getAboutInfo` / `openAppDataDirectory`，见 [build-info.md](build-info.md)） |
| `desktop/buildMetadata.cjs` | 15 | 构建编号/UTC/渠道生成（写入 `dist/build-info.json`） |
| `scripts/desktop-dev.mjs` | 6 | `spawn(electron, ['.'], {stdio:'inherit', windowsHide:true})` 并设 `HIVE_DESKTOP_DEV=1`；`HIVE_DESKTOP_USER_DATA` 缺省回退 `.runtime/dev-profile` |

另有 `desktop/*.html` 与 CSS/JSON 资源、9 个 `.test` 文件（`windowPolicy` 12 项、`panelGeometry` 8 项、`panelReady` 8 项、`repositoryPicker` 7 项等），随 `npm test` 一并运行。

`package.json`：`main: "desktop/main.mjs"`，scripts `dev`（`node server/index.mjs`）、`start`（`--production`）、`build`（`tsc -b && vite build`）、`test`（`vitest run`）、`desktop`（`npm run build && electron .`）、`desktop:dev`、`desktop:folder`（`electron-builder --win --dir`）、`desktop:portable`（`electron-builder --win portable`）、`verify:app` / `verify:package`（`scripts/verify-*.mjs`）；`electron` / `electron-builder` 在 `devDependencies`。

## 2. 启动链

```text
electron .
  └─ desktop/main.mjs  app.whenReady()
       ├─ Menu.setApplicationMenu(null) / requestSingleInstanceLock()
       ├─ preferenceStore(userData/ui-preferences.json).read()
       ├─ fork(server/index.mjs, ['--production'], { ELECTRON_RUN_AS_NODE:1, HIVE_PORT:0, … , stdio 含 ipc })
       │    └─ 服务 listen(port,'127.0.0.1') → process.send({type:'hive-ready', port})   ← server/index.mjs
       ├─ origin = http://127.0.0.1:<port>
       └─ new BrowserWindow({1440×900, min 800×600, frame:false, show:false}) → loadURL(origin) → ready-to-show 再 show
```

主窗与子窗都不显示原生标题栏；关闭/最小化/最大化全部走渲染端按钮 → `windowCommand`。

- 用 `fork` + `ELECTRON_RUN_AS_NODE=1` 复用 Electron 自带的 Node，不额外带 node.exe。
- `HIVE_DESKTOP_DEV=1` 且未打包时走 Vite dev 服务。生产模式由 `server/index.mjs` 加载 `dist/`。
- 环境变量：`HIVE_PORT=0`（随机端口）、`HIVE_STATE_DIR=<userData>/state`、`HIVE_DOCUMENTS=<userData>/documents`；`HIVE_DESKTOP_USER_DATA` 可把整个 `userData` 重定向到指定目录（隔离验收用，main.mjs:20）。
- 服务启动超时 30s；失败弹 `dialog.showErrorBox('HIVE 启动失败', …)` 并退出。

## 3. 主进程 ↔ 渲染进程协议

| 通道 | 方向 | 语义 |
| --- | --- | --- |
| `hive-ready` | 服务 → 主（`process.send`） | `{port}`，服务就绪 |
| `hive-shutdown` | 主 → 服务 | 优雅关闭；3s 未退出则 `kill()` |
| `hive:service-error` | 主 → 渲染 | 服务意外退出（非主动停止）：界面提示 + `dialog.showErrorBox` |
| `hive:close-requested` | 主 → 渲染 | 用户点了主窗关闭，等渲染端保存 |
| `hive:close-ready` | 渲染 → 主 | preload 在 `onCloseRequested` 注册时发，表示渲染端接管了关闭流程 |
| `hive:close-finish` | 渲染 → 主 | `allow:boolean`；true → `completeExit()`，false → 留在窗口 |
| `hive:panel-close-requested` | 主 → 渲染 | 独立面板窗被点关闭，要求先把面板搬回主窗 |
| `hive:panel-close` | 渲染 → 主 | 回搬完成，销毁该子窗 |
| `hive:panel-ready` | 渲染 → 主 | 面板内容已搬进子窗（`panelReady(id)`），主进程把该 id 记入 `readyPanelIds` 并 `show()` 子窗——避免白屏闪一下 |
| `hive:window-command` | 渲染 → 主 | `(command, panelId?)`：`minimize` / `maximize`（已最大化则还原）/ `close` / `focus`；不带 id 操作主窗，带 id 操作对应子窗。`commandAllowed` 对子窗拒绝 `maximize` |
| `hive:preferences-read` | 渲染 → 主（`sendSync`） | preload 启动时同步读偏好；只有主窗拿得到（`isMainOrigin`） |
| `hive:preferences-save` | 渲染 → 主 | 主窗每 2s 比对白名单 key，变了才写盘 |

安全边界：`ipcMain` 一律校验 `isMainSender`（`event.sender === mainWindow.webContents`）或 `isMainOrigin`（再加同源 `senderFrame.url`）。**注意**：`hive:panel-ready` 与 `hive:window-command` 走的是 `isMainOrigin`，发起者是**主渲染上下文**——面板 DOM 搬到子窗后，React 树、`ipcRenderer`、事件处理仍属于主窗（子窗只是借了一个 document），所以子窗标题栏里的最小化/关闭按钮实际是主窗渲染树发出的消息。改这块前先确认这一点。

## 4. 窗口与导航策略（`secureWindow`）

| 策略 | 实现 |
| --- | --- |
| 页面内导航 | `will-navigate` 只放行**精确入口的首次导航**（`windowPolicy.allowNavigation`：`!loaded && url === entry`），其后一律阻止——链接不能把带未保存内容的窗口带走 |
| 重定向 | `will-redirect` 一律 `preventDefault()` |
| 刷新 | `before-input-event` 拦 F5 / Ctrl+R |
| 新窗口 | `setWindowOpenHandler` 默认 deny；只有**主窗**、URL 通过 `panelId()` 校验才放行 |
| 无边框 | 主窗与子窗都 `frame:false`；拖拽区由 CSS `-webkit-app-region:drag` 提供（`.hive-desktop .app-header`、子窗面板标题栏），按钮/输入框设 `no-drag`；窗口按钮走 `windowCommand` |
| 单实例与唤醒 | `requestSingleInstanceLock()`；`second-instance` / `activate` / 主窗 `focus` 都走 `showAllWindows()`：恢复主窗 + 所有已 `panelReady` 的子窗（`showInactive` / `moveTop`），最后把焦点给最后活跃的窗（`lastActivePanel`），带 `restoringWindows` 防重入；未就绪的子窗不显示 |
| 菜单 | `Menu.setApplicationMenu(null)`（无原生菜单栏，快捷键由渲染端负责） |
| webPreferences | `{preload, contextIsolation:true, nodeIntegration:false, sandbox:true}`，主窗与子窗同一套 |

## 5. 独立面板窗（可移出主窗口）

- **放行条件**（`main.mjs:55` `panelId`）：URL 必须 `origin` 相同、`pathname === '/'`、只有 `panelWindow` 一个查询参数、id 匹配 `^[A-Za-z0-9_-]{1,128}$`、无 hash。渲染端用 `window.open('/?panelWindow=<id>', 'hive-panel-<id>', 'popup,width=…,height=…')`。
- **防重复**：`panels` Set 记已放行的 id（15s 未真正建窗则过期），`did-create-window` 里再按 URL 复核一次后放进 `panelWindows`。
- **初始位置**（`panelBounds`）：解析 `features` 里的 `left/x/top/y/width/height`，默认相对主窗 +50/+50、900×700，按目标显示器 `workArea` 夹取；`width/height` 最小 320×200，`y` 允许到 `workArea.y - 40`（贴着顶边）。子窗 `frame:false / resizable / maximizable:false / show:false / backgroundColor:#18181b`——**子窗不可最大化**：`maximizable:false`，`commandAllowed` 拒绝 `maximize`，主进程还监听 `maximize` 事件强制 `unmaximize()` 并还原上次 `normalBounds`。
- **子窗里不跑第二个 App**：`src/main.tsx:6` 检测到 `panelWindow` 参数就跳过 `createRoot`——子窗只是一个空 document，等待父窗把 portal 容器搬进来。
- **关闭协议**：子窗 `close` → `preventDefault` + 发 `hive:panel-close-requested` → 渲染端 `attach()` 把容器搬回主窗 → 发 `hive:panel-close` → 主进程 `destroy()`。`exiting` 时不拦。
- **窗口按钮**：主窗右上角是独立的 `.header-window-controls`（最小化 / 最大化还原 / 保存并退出；第三个走 `windowCommand('close')` → 同一条保存退出协议），原 `header-actions` 整组左移；子窗标题栏菜单由 `nativeWindowActions(id)` 生成，只有「最小化窗口」与「关闭窗口并移回主窗口」两项（不提供最大化）。
- **移回主窗的唯一入口**：子窗标题栏的面板菜单（汉堡）里那一项；主窗侧没有占位卡片、没有定位/移回按钮。
- 渲染端细节（`features/workspace/DesktopPanels.tsx`）见 `architecture.md` §8 与 `src/features/workspace/index.md`。

## 6. 退出与偏好

**退出**（`main.mjs` 主窗 `close` 拦截与 `App.tsx` 的 `onCloseRequested` 协议）：

1. 主窗 `close`（`main.mjs:333`）→ `preventDefault()`；渲染端没接管（`rendererReady=false`）则直接 `completeExit()`。
2. 否则发 `hive:close-requested`，并起 25s 计时：超时弹 `dialog.showErrorBox('HIVE 退出未完成', …)`，窗口与内容保留。
3. 渲染端：所有 document `body.inert = true` → 校验（生成中 / 切空间 / 结构操作 / 组词中 / 保存中）→ `fileWorkspace.flush()` + 逐会话 `saveSession(id, true)` → `finishClose(true)`；自身 20s 超时 → `finishClose(false)`。
4. `completeExit()`（`main.mjs:130`）：destroy 所有窗口 → `preferenceStore.flush()` → `stopService()`（发 `hive-shutdown`，3s 兜底 kill）→ `app.quit()`。
5. `window-all-closed` / `before-quit` 也汇到同一条路径，不会留孤儿 node 进程。

**界面偏好**（`desktop/preferences.cjs` + `preload.cjs` 各维护一份同样的白名单，改一处必须改两处）：

- exact（14 键）：`hive.modelPicker.recent`、`hive.ai.references.v1`、`hive.editor-status.v1/v2/v3`、`hive.table.sizes.v1`、`hive.explorer.v1`、`hive.annotationPreferences.v1`、`hive.appearance.v1`、`hive.theme.v1`、`hive.frontmatter-visible.v1`、`hive.typography.v1`、`hive.panelIconDragPreferences.v1`、`hive.views.v1`。
- 前缀（4 条）：`hive.explorer.v1:`、`hive.views.v1:`、`hive.ai.references.v1:`、`hive.recentDocuments.v1:`（key 长度 ≤ 4096）。
- `hive.reasoning.<JSON 数组>`：`JSON.parse` 后必须是两个字符串，值只能是 `default/low/medium/high/xhigh`。
- 上限：256 条 / 单值 131072 B / 总量 524288 B；`tmp` 写入 + `rename` 原子替换，写入串行队列。
- preload 启动时先删本机同名 key 再灌文件值，之后每 2s 比对差异回写；`finishClose(true)` 前再强制收集一次，避免最后 2 秒的偏好丢失。只有主窗拿到偏好（`hive:preferences-read` 对子窗返回 `null`）。

## 7. 打包与分发

`package.json` 的 `build` 段（现状）：

```json
{ "appId": "local.hive.writing", "productName": "HIVE markdown editor", "directories": { "output": "release" },
  "files": ["dist/**", "server/**", "desktop/**", "templates/**", "LICENSE", "!**/*.test.*", "package.json"],
  "win": { "target": ["portable"] } }
```

- 目前只出 **portable**（免安装单文件）；NSIS 安装包尚未配置（`nsis.oneClick:false` / 安装目录选择等）。
- `express` / `zod` / `yaml` 必须在 `dependencies`（现状满足），`electron` / `electron-builder` 是 `devDependencies`。
- 包体积：不在这里估。每次 `electron-builder` 产出的实际字节数以 `VALIDATION.md` 的实包记录为准（旧版占位截图与旧包数字都不能当最终证据）。
- 签名：未签名会触发 SmartScreen；对外分发需 OV/EV 证书（`win.certificateFile` 或 Azure Trusted Signing）。
- 升级：`electron-updater` 只替换 `dist/` `server/` `desktop/`，**绝不动 `HIVE_DOCUMENTS`**；`model.json` 已有 `schemaVersion`/`migrate()`，`workspace.json`、`text-annotations.json` 等要向后兼容。
- 数据位置：`userData/state`（`.local` 状态 JSON）、`userData/documents`（默认写作空间）、`userData/ui-preferences.json`。
- 2026-11-17 桌面版更名为 `HIVE markdown editor`；输出 `release/HIVE markdown editor 0.1.0.exe` 与 `release/win-unpacked/HIVE markdown editor.exe`。正常 `userData` 显式保持 `%APPDATA%\HIVE`，`HIVE_DESKTOP_USER_DATA` 隔离覆盖优先，`appId`／IPC／存储键不改；不会因产品改名切换到空白文稿或设置目录。

## 8. 为什么是 Electron（不是 Tauri）

| | Electron（已选） | Tauri 2 |
| --- | --- | --- |
| Node 运行时 | 主进程自带，`fork` 现有 `server/index.mjs` 即可 | 也能配 sidecar 带 node.exe，但要自己管进程与端口 |
| 接入现有代码 | 零改造 | 重写服务层，或维护两套运行时 |
| 独立面板共享 React 状态 | 同源 `window.open` + 同源 document 直接可用 | 跨 webview/多 web 进程，状态共享要另设计 |
| 体积 | 较大 | 外壳小，带 Node sidecar 后仍明显更小 |
| 内存 | 较高 | 低 |

结论：本轮选 Electron 的理由是「复用已有 Node 服务 + 同源 `window.open` 让面板 DOM 直接搬过去」这两点最省改造，**不是唯一可行路线**——Tauri 2 也能用 sidecar 起同一个服务，代价是要自己管 sidecar 生命周期，且独立面板的 React 状态共享需要另做一套。

## 9. 验收清单

1. 全新机器：`npm run desktop` 能起窗、能选/建文档、能保存。
2. 断网可用（除生成外全功能）；任务管理器无残留 node 进程（关窗后 3s 内）。
3. `HIVE_PORT` 被占时用随机端口正常起（`HIVE_PORT=0` 已是默认）。
4. 面板移出（面板菜单「浮动面板」）：子窗能编辑、能保存、能打开菜单（菜单在子窗内）；子窗标题栏菜单只有最小化与「关闭窗口并移回主窗口」，没有最大化；移回后滚动位置、撤销历史、未保存内容都在。
5. 子窗开着时关主窗：先回搬、再退出，不丢未保存内容；有脏文档且保存失败时窗口保留并提示。
6. 窗口唤醒：主窗最小化/失焦后再点任务栏或第二次启动，主窗与所有已就绪子窗一起恢复并前置，未就绪的子窗不冒出空白窗。
7. 退出时若正在生成 / 组词 / 保存，应拒绝退出并给出文案。
8. 从旧版升级：文档、标注、大纲、视图预设、界面偏好全在；卸载不删用户文档。
9. 双击 `.md` 打开（可选，未实现）：注册文件关联走 `open-file`。

## 10. 尚未实现

- NSIS 安装包、应用图标、代码签名、自动更新（`electron-updater`）。
- 独立面板窗的尺寸/位置记忆（每次按主窗相对位置重算；已确认本轮不做）、多显示器 DPI 变化重排。
- 偏好白名单抽成共享模块（`preload.cjs` 与 `preferences.cjs` 现各一份，已确认本轮不拆，改时两处同改）。
- 子窗内的拖拽停靠手势（当前子窗里面板固定铺满、`panel-resize` 隐藏，标题栏是窗口拖拽区 `-webkit-app-region:drag`，拖动等于移动窗口而不是移动面板）。
