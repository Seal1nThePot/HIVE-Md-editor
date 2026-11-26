# HIVE 0.1.6 前端地图（2026-11-19）

`src/app/App.tsx` 装配工作台和文档会话。生成、传输、建议动作、持久化、参考资料、面板目录、桌面面板搬运、主题装载和仓库管理的模块入口见 §2。

## 1. 入口与样式装载

- `index.html` → `src/main.tsx`（10 行）→ 有 `?panelWindow=<id>` 时**不挂载任何 React 树**（独立面板窗只提供 document，DOM 由父窗搬进来）；否则 `createRoot(...).render(<App />)`。
- `App`（App.tsx:134）：`fetch("/api/workspace")` 拿空间信息，失败给重试按钮；成功后 `<WorkspaceProvider key={info.id}><DesktopPanelsProvider><WritingApp/></DesktopPanelsProvider></WorkspaceProvider>`（:139）。
- CSS 顺序：`styles.css`(:25) → `annotations.css`(:26) → `workbench-v3.css`(:27) → `free-workspace.css`(:28) → `panel-chrome.css`(:29) → `editor-tabs.css`(:30) → `files.css`(:43)。其余 36 个样式由组件各自 import（`desktop-panels.css`、`settings.css`、`view-presets.css`、`editor-tools.css`、`file-explorer.css`、`panel-icon-rail.css`、`annotation-bubble.css`、`editor-context-menu.css`、`model-picker.css`、`input-basis.css`、`note-properties.css`、`trash-panel.css`、`panel-switcher.css`、`table-of-contents.css`、`writing-dock.css`、`repositories.css`、`theme.css`、`templateManagement.css`、`typography-settings.css` 等）。

## 2. 已抽出的模块（App.tsx 之外）

| 模块 | 行数 | 职责 | 主入口 |
| --- | --- | --- | --- |
| `features/chat/writingGeneration.ts` | 351 | 组装 `GenerationContext` → `makePrompt` → 传输 → `parseSuggestion` → 写 proposal | `generateWriting(context, options)`、`stopWritingGeneration(...)` |
| `features/chat/generationTransport.ts` | 142 | 演示模式造文本；真实模式读 SSE 并抛可读错误 | `generateDemoText`、`streamModelText` |
| `features/chat/proposalActions.ts` | 105 | 接受/驳回/撤销，全部经 `canApply` | `createProposalActions({...})` |
| `features/files/useDocumentPersistence.ts`、`writeDocument.ts` | — | 900ms 自动保存、请求结束后 2s 磁盘同步、快照回执和冲突处理 | `useDocumentPersistence({api, sessions, ...})`、`writeDocument` |
| `features/editor/activeEditor.ts` | — | 从活动会话读取文档状态、基线与视图 | `activeEditor(sessions, activeId)` |
| `features/chat/referenceSources.ts` | 78 | 参考资料来源列表、预算截断、消息注入 | `useReferenceSources`、`fitReferenceMessages` |
| `features/chat/modelReasoning.ts` | 60 | 推理强度（按服务/模型分键存 localStorage；`default` + 七档） | `useModelReasoning`、`reasoningLevels` |
| `features/workspace/DesktopPanels.tsx` | 123 | 面板移出/移回独立窗口：稳定 portal 容器搬 document、CodeMirror `setRoot`、样式镜像、子窗骨架、`panelReady`、窗口命令、IME 与超时兜底（不再渲染占位卡片） | `DesktopPanelsProvider`、`DesktopPanel`、`useDesktopPanels` |
| `shared/panelDocument.tsx` | 7 | `PanelDocumentContext` + `usePanelDocument()`（默认 `document`） | `usePanelDocument()` |
| `features/workspace/panelCatalog.ts` | 27 | 面板分类、搜索、分组 | `panelCategories`、`filterPanels`、`groupPanels` |
| `features/workspace/railHoldGesture.ts` | 33 | 图标轨道长按拖出面板 | `RAIL_HOLD_MS`、`RailHoldGesture`、`railDragTarget` |
| `desktop/windowPolicy.cjs` | 70 | 导航放行、窗口命令白名单、子窗禁最大化、已就绪子窗筛选（主进程侧纯函数） | `allowNavigation`、`validCommand`、`commandAllowed`、`readyPanels` |
| `features/workspace/panelLockGesture.ts` | 21 | 面板位置锁手势（双击 / 长按） | `PANEL_LOCK_HOLD_MS`、`PanelLockGestureTracker` |
| `app/api.ts` / `shared/api.ts` | 8 / 15 | `requestApi` 与 `ApiClient` 类型 | `requestApi`、`requestJson` |
| `features/files/useFileActions.ts` | — | 打开/另存/新建/导入/整理/切换空间/对话框等文件动作 | `useFileActions({...})` |
| `features/workspace/useViewSnapshots.ts` | 154 | 视图快照捕获与应用 | `useViewSnapshots`、`captureView`/`applyView` |
| `features/annotations/useAnnotationActions.ts` | 128 | 标注动作 | `useAnnotationActions` |
| `features/theme/`（applyTheme / themePreferences / themeStore / templateBinding） | 94 / 152 / 78 / 68 | R9 主题装载：偏好读写、模板配色、CSS 变量应用、主题文件落盘 | `useApplyTheme`、`flushThemeFiles`、`flushThemePreferences` |
| `features/settings/modelConfig.ts` + `catalogOrder.ts` | 78 / 7 | 服务/模型配置客户端镜像、推理档位与输入类型计算、目录排序 | `effectiveReasoningLevels`、`effectiveInputTypes` |
| `features/chat/ChatComposer.tsx` + `composerKeys.ts` + `reasoningEffects.ts` | 34 / 8 / 9 | 聊天输入区、发送键位、推理条动效 | `ChatComposer` |
| `features/files/RepositoryPanel.tsx` | 71 | 仓库管理面板（`/api/workspace/repositories`：添加/重命名/移除/排序） | `RepositoryPanel` |

## 3. App.tsx 导航

| 符号 | 作用 |
| --- | --- |
| `App`、`WritingApp` | 引导写作空间，装配编辑工作台 |
| `sessions`、`activeSession`、`activeEditor` | 会话表、活动 ID、当前会话投影 |
| `usePanelWorkspace`、`useDesktopPanels`、`useViewSnapshots` | 工作台布局、实际窗口与视图快照 |
| `bindings`、`sessionCallbacks` | 将 CodeMirror 回调路由到对应会话 |
| `activateEditor`、`closeEditor`、`minimizeEditor`、`closeDocumentTab` | 活动标签切换、面板收纳与文档关闭 |
| `useDocumentPersistence`、`useFileActions` | 保存与同步、打开与整理、仓库切换 |
| `useReferenceSources`、`useTextAnnotations`、`useWritingNodes` | 参考资料、标注与写作节点 |
| `ribbonCommand`、`openSettings`、`selectChatModel` | 功能区命令、设置入口与模型切换 |
| `generate`、`stopWritingGeneration`、`createProposalActions` | 生成、停止、接受与驳回建议 |
| `beforeunload`、`onCloseRequested` | 浏览器离开提示和桌面退出前的保存检查 |

## 4. 会话与面板 id

- 固定面板：`files`、`conversation`、`outline`、`toc`、`scratch`、`annotations`、`basis`、`properties`、`search`、`trash`、`repositories`。
- 编辑区：主区 `editor`，多开为 `editor:<uuid>`；`workspacePolicy.isEditorPanel()` 认定两者。
- 独立窗口沿用同一套面板 id（URL `?panelWindow=<id>`，只允许 `[A-Za-z0-9_-]{1,128}`）。
- `EditorSession`（`features/editor/editorSessionTypes.ts`）：`{id, disk, state, view, dirty, landing?, restoreScroll?, context?}`。
- 权威 id 集合在 `features/workspace/viewPresets.ts:40`；新增面板要同时改 `panelLabel`、`renderPanel`、`panelCatalog` 与这里。

## 5. 保存与磁盘同步（`useDocumentPersistence`）

1. CodeMirror 文档变化由对应会话更新正文与 `dirty`，界面根据活动会话重新读取。
2. 自动保存启用时，900ms 后通过 `writeDocument` 提交快照。冲突时保留内存内容。成功回执只确认写入的快照，文件时间记录失败可附带警告。
3. 同步请求完成 2s 后再次发送 `POST /api/workspace/sync {paths, baselines, treeVersion}`。逐文件比较基线、本地文本和磁盘，判定 `unchanged`、`adopt` 或 `conflict`。同哈希响应省略正文。C# 服务每次返回 `entries`，前端按目录版本更新已有树，并接受旧后端省略目录的响应。服务端最多并发读取 4 份文档。
4. 结构操作（新建/改名/移动/复制/回收站/还原/清理）走 `POST /api/explorer` 与 `/api/explorer/trash/*`。
5. 桌面版退出前先等待 `fileWorkspace.flush()`，再逐会话执行 `saveSession(id, true)`。
6. 首次打开或主动重试使用 `GET /api/tree?refresh=1`。文档栏保留最后成功的目录，显示当前仓库的读取失败或子项权限提示。成功刷新或轮询清除读取错误，也能确认空仓库的状态。过期仓库或过期刷新响应不能更新当前文档栏。

包内联动验收用 `node scripts/verify-csharp-repositories.mjs "<包目录>"`，以 `HIVE_VERIFY_OUTPUT` 指定隔离记录目录。脚本运行包内 C#、前端资产和仓库选择 IPC。隐藏窗口使用受控的系统目录选择结果，验证添加和切换、左栏正文与嵌套目录、磁盘轮询，以及故障后恢复。

## 6. 生成与建议生命周期

- `generateWriting` 收集 `GenerationContext`：文档（view/disk/file/outline/currentHeading/currentWritingNode）、模型（config/reasoningEffort）、对话（mode/prompt/messages）、生命周期 ref、参考资料、写作节点、UI 回调。
- `makePrompt()`（`shared/core.ts:323`）拼 system + 历史 + user；`basis` 面板用 `InputBasisRequest` 展示同一份内容。
- 传输：演示模式走 `generateDemoText`；真实模式 `streamModelText` 读 SSE（`chunk|done|error`），中止时 `reader.cancel()`、`finally` 里 `releaseLock()`。
- `parseSuggestion(raw, mode, continuationLimit)`：`text` 1–30000 字、`reason` ≤1000、`continue` 必须恰好一段且 `visibleCount ≤ limit`。
- 通过后写 `proposal.current`，**不落盘**；`accept/reject/undoAI` 由 `createProposalActions` 提供，全部经 `canApply`。
- `mapAnchor`（`shared/core.ts`）在每次 `docChanged` 时重定位 proposal / requestAnchor / undo。

## 7. 编辑器能力（`features/editor`）

| 模块 | 要点 |
| --- | --- |
| `formatting.ts` | `inlineFormatting` / `paragraphAlignment` / `lineFormatting` / `insertStructure` / `inspectFormatting`，全部返回 `TransactionSpec` |
| `insertions.ts` | `insertImage` / `insertTable` / `imageMarkdown` / `localImageUrl` |
| `markdownDisplay.ts` | `DisplayMode = live\|source`、`configureMarkdownDisplay`、`configureImageContext` |
| `markdownPresentation.ts` | `previewPlan` / `visibleReplacements`（纯函数，单元格文本在 plan 阶段就切片） |
| `tableWidget.ts` | 表格的 CodeMirror 控件与行列操作（80 行）；`cellContent(cell, doc)` 必须传 `Text` |
| `noteProperties.ts` / `NotePropertiesDialog.tsx` | frontmatter 属性的读写与对话框 |
| `searchTools.ts` | `FindFields`、`makeSearchQuery`、`configureFloatingSearch`、`searchMatches` |
| `typewriter.ts` | `configureTypewriter`、`typewriterExtensions` |
| `statusModel.ts` | `statusItems`、`readStatusOptions`、`textStatistics`、`documentStatistics` |
| `EditorContextMenu.tsx` / `EditorInsertDialog.tsx` / `FindReplacePanel.tsx` / `DisplayModeControl.tsx` / `NewTabPage.tsx` / `StatusBarSettings.tsx` | 视图层组件（前四个用 `usePanelDocument()` 决定 portal 目标） |

## 8. 文件浏览与回收站（`features/files`）

- `explorerState.ts`：`Entry`、`SortMode`、`ExplorerOrder`、`sortEntries`、`reorderEntry`、`remapOrder`、`readOrder`、`mapEntryPath`、`flattenEntries`。
- `FileExplorer.tsx`（268 行，压缩风格单行代码）：树渲染 + 右键/工具栏动作，通过 `onAction(action: FileAction)` 交给 App；菜单 portal 到 `usePanelDocument()`。
- `TrashPanel.tsx`（115 行）：回收站列表；行内单项永久删除走 `POST /api/explorer/trash/delete`（每项 Trash2 按钮，需确认）；批量清理先 `previewTrash(days)` 拿 token，再 `purgeTrash(token)`。
- `RepositoryPanel.tsx`（71 行）：仓库管理面板（`/api/workspace/repositories`：添加/重命名/移除/排序）。
- `FilePicker.tsx`：把文件打开到指定编辑区。
- `fileSync.ts`：`diskSyncDecision`（7 行判定）。

## 9. 面板层（`features/workspace`）

见 `workspace-ui.md`。要点：`panelLayout`（树与测量）、`workspaceState`（布局纯函数）、`dockInteraction`（拖拽意图）、`autoHide`（自动隐藏）、`workspacePolicy`（主编辑区/层号/可移动性）、`panelCatalog`（分类与搜索）、`railHoldGesture` / `panelLockGesture`（手势）、`usePanelWorkspace`（React 绑定）、`viewPresets`（快照校验）、`DesktopPanels`（移出/移回独立窗口，见 §12）。

## 10. 其余面板

- `outline`：`WritingOutlineV2` + `useWritingNodes`（`/api/writing-outline`）；`TableOfContentsPanel` + `tocModel.tocRows`。
- `annotations`：`useTextAnnotations`（拉取/修订/重锚）、`useAnnotationTool`、`annotations.ts`、`AnnotationPanel`、`InlineAnnotationEditor`、`annotationDecorations`、`annotationCache.ts`。
- `scratch`：`ScratchPad`（`/api/scratch`，固定 `自由草稿.md`；关视图留历史）。
- `chat`：`WritingDock`、`ChatComposer`（`composerKeys` 发送键位）、`WritingModeControl`、`ModelPicker`（模型图标、推理档位与对应提示）、`InputBasisPanel`、`FloatingOrb`（`reasoningEffects` 推理条动效）。
- `settings`：`SettingsPage`（分区 `appearance`（界面）/`appearance-reserved`（外观，挂 `ThemeSettings`）/`features`（功能）/`writing`（写作）/`models`（模型）/`shortcuts`（快捷键）/`about`（关于））、`useAppearance`、`useAnnotationPreferences`、`usePanelIconDragPreferences`、`modelConfig`、`catalogOrder`、`AppearanceSettings`、`AnnotationSettings`、`StatusBarSettings`、`AboutSettings`。
- `ribbon`：`Ribbon.tsx` + `editorCommands.ts`（命令表）。

## 11. 想改 → 改哪里

| 想改的东西 | 改哪里 | 同步更新 |
| --- | --- | --- |
| 生成模式或提示词规则 | `shared/core.ts` 的 `Mode`/`makePrompt`/`parseSuggestion` | `core.test.ts`、`agent.md` 第 5 节 |
| 生成编排（上下文/预算） | `chat/writingGeneration.ts` | `writingGeneration.test.ts` |
| SSE 解析与错误文案 | `chat/generationTransport.ts` | `generationTransport.test.ts` |
| 接受/驳回/撤销 | `chat/proposalActions.ts` + `core.ts` `canApply` | `core.test.ts` |
| 保存与冲突策略 | `files/useDocumentPersistence.ts` + `server/files.mjs` | `files.test.mjs`、`backend-contract.md` |
| 磁盘同步判定 | `features/files/fileSync.ts` | `fileSync.test.ts` |
| 文件树与回收站 | `FileExplorer.tsx` / `TrashPanel.tsx` + `server/explorer.mjs` | `explorer.test.mjs`、`trash-retention.test.mjs` |
| 参考资料预算 | `chat/referenceSources.ts` + `server/references.mjs` | `referenceSources.test.ts`、`references.test.mjs` |
| 图片插入与预览 | `editor/insertions.ts` + `server/images.mjs` | `images.test.mjs` |
| 格式化/表格/属性 | `editor/formatting.ts` / `tableWidget.ts` / `noteProperties.ts` | 各自 `.test.ts` |
| 标注交互/渲染 | `features/annotations/*` | `annotations.test.ts` |
| 大纲与目录 | `features/outline/*` | `writingOutline.test.ts`、`tocModel.test.ts` |
| 面板布局/停靠/自动隐藏 | `features/workspace/*` | 见 `workspace-ui.md` |
| 面板移出/移回独立窗口 | `features/workspace/DesktopPanels.tsx` + `desktop/main.mjs` | `architecture.md` §8、`packaging.md` §5 |
| 桌面外壳行为（窗口/退出/服务/唤醒） | `desktop/main.mjs` | `packaging.md`、`runbook.md` |
| 主窗右上角窗口按钮 | `src/app/AppHeader.tsx`（`.header-window-controls`）+ `PanelFrame.tsx` 的 `nativeWindowActions()` | `packaging.md` §5、`desktop-panels.css` |
| 桌面版界面偏好白名单 | `desktop/preferences.cjs`（与 `preload.cjs` 的同一份白名单必须一起改） | `packaging.md` §6 |
| 模型/服务配置 | `settings/modelConfig.ts` + `server/model-config.mjs` | `model-config.test.mjs` |

## 12. 桌面外壳与独立窗口

```text
主窗（#root, React 树）                     独立窗（/?panelWindow=<id>，不挂 React）
  PanelFrame > DesktopPanel
     ├─ .desktop-panel-home（原位占位容器）
     └─ createPortal(children → .desktop-panel-surface)
                    │  window.open + appendChild
                    └──────────────►  child.document.body
                                       ├─ .desktop-panel-window（body class）
                                       ├─ mirrorAppearance：克隆 style/link
                                       └─ .desktop-panel-surface（同一个节点，未重挂）
```

- **移出**（`detach()`）：面板菜单「浮动面板」→ `workspace.prepareNativeFloat(id)` 先摘出停靠树 → `window.open('/?panelWindow=<id>', 'hive-panel-<id>', 'popup,width,height')` → 子窗 `load` 后校验 `location.href` → 清空 body、插入骨架（`.app-shell.desktop-panel-shell > .workbench.free-workbench.desktop-panel-workbench`）→ `mirrorAppearance()` → `move(stage)`（记/还原 `.cm-scroller` 滚动、`setRoot` + `requestMeasure`）→ `opened(id, child)` → 确认容器里有 `[data-panel-id]` 后 `panelReady(id)`（主进程才 `show()` 子窗）。
- **移回**（`attach()`）：唯一入口是子窗标题栏面板菜单的「关闭窗口并移回主窗口」/「移回主窗口」；组词中直接拒绝；否则 `move(home.current)` → `opened(id, null)` → `hiveDesktop.closePanel(id)` → `window.focus()`。
- **主窗不留占位**：占位卡片、定位按钮、移回按钮已删除；主窗只留 `display:contents` 的 `.desktop-panel-home` 节点。
- **无边框窗口**：主窗与子窗都是 `frame:false`，拖拽区来自 `desktop-panels.css` 的 `-webkit-app-region:drag`（`.hive-desktop .app-header`、子窗面板标题栏），按钮/输入框 `no-drag`。主窗右上角 `.header-window-controls` 三键（最小化 / 最大化还原 / 保存并退出），原 `header-actions` 整组左移；子窗标题栏菜单由 `nativeWindowActions(id)` 生成，只有最小化与「关闭窗口并移回主窗口」，**子窗不可最大化**（`maximizable:false` + `commandAllowed` 拒绝 + `maximize` 事件强制还原）。全部走 `window.hiveDesktop.windowCommand`。
- **窗口唤醒**：`second-instance` / `activate` / 主窗 `focus` → `showAllWindows()` 恢复主窗与所有已 `panelReady` 的子窗并前置，未就绪子窗不显示。
- **全局弹窗**：设置/帮助/文件选择/通用对话框仍在主窗；`App.tsx:677` 打开时 `window.focus()` 把主窗拉到前面。
- **关闭已移出的编辑区**：`closeEditor` / `minimizeEditor` 先 `desktopPanels.attach(id)`，返回 false（组词中）就中止，再走原来的 `session.state` / `restoreScroll` 捕获。
- **关闭子窗**：主进程拦 `close` 发 `hive:panel-close-requested` → `attach()` 回搬 → `destroy()`。
- **崩溃/刷新**：500ms `child.closed` 轮询、15s 连接超时、`unload` → `restore()` 回搬；`cleanup` 里断开 MutationObserver。
- **ownerDocument**：容器内所有组件通过 `PanelDocumentContext` 拿到当前 document（`usePanelDocument()`），菜单/浮层 portal 到它而不是 `document.body`。
