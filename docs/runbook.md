# HIVE 0.1.9 运行手册

窗口归属见 [窗口契约](panel-lifecycle.md)。运行包结构与退出协议见 [桌面封装](packaging.md)。

## 1. 环境

- 源码构建用 Node 24 和 .NET 11 SDK。Windows x64 目录包包含自带的 .NET 运行时。
- 开发依赖按照锁文件安装，使用 `npm ci`。

## 2. 启动和发布

```powershell
npm run dev             # Vite 和 C#，默认 4324
npm run build           # 生成生产前端并编译 C# 开发可执行程序
npm start               # 由 C# 托管上一步生成的前端
npm run desktop:dev     # Electron、Vite、C#
npm run desktop:folder  # Windows x64 目录包
npm run verify:package  # 校验 ASAR、C# 运行时和资源文件
```

输出默认在仓库同级的 `.work/019-csharp-backend`。可用 `HIVE_BUILD_WORK_DIR` 指定外置构建目录。目录包入口是输出目录下 `release/win-unpacked/HIVE markdown editor.exe`。本机固定入口为 `D:\HIVE stable\HIVE markdown editor.exe`。命令行前台服务用 Ctrl+C 停止。

## 3. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HIVE_PORT` | `4324` | 监听端口，仅绑定 127.0.0.1 |
| `HIVE_DOCUMENTS` | 命令行 `runtime/documents` | 文档根目录（写作空间的默认根） |
| `HIVE_STATE_DIR` | 命令行 `runtime/state` | 状态目录 |
| `HIVE_DESKTOP_USER_DATA` | `%APPDATA%\HIVE` | 桌面资料目录。隔离测试可指定新目录 |
| `HIVE_API_KEY` | 无 | 仅当 state 目录尚无 `keys.json` 时，启动给选中/首个服务注入；服务密钥本身明文持久化在 `state/keys.json`（见 backend-contract §9） |

## 4. 测试与构建基线

```powershell
npm test
npm run build
node scripts/verify-csharp-storage.mjs
node scripts/verify-csharp-desktop.mjs
```

常用的前端和旧协议对照测试入口如下。真实包验证脚本另外检查运行时进程和私有 IPC。

| 文件 | 项 | 文件 | 项 |
| --- | --- | --- | --- |
| `workspace/usePanelWorkspace.test.tsx` | 51 | `files/fileLifecycle.test.ts` | 34 |
| `shared/core.test.ts` | 28 | `settings/panelIconDragPreferences.test.ts` | 28 |
| `server/integration.test.mjs` | 24 | `workspace/autoHide.test.ts` | 24 |
| `workspace/workspacePolicy.test.ts` | 24 | `workspace/viewPresets.test.ts` | 23 |
| `workspace/nativeHostRuntime.test.ts` | 21 | `editor/formatting.test.ts` | 19 |
| `editor/noteProperties.test.ts` | 19 | `editor/tableWidget.test.ts` | 19 |
| `server/workspace.test.mjs` | 18 | `workspace/dockInteraction.test.ts` | 18 |
| `annotations/annotations.test.ts` | 16 | `workspace/workspaceState.test.ts` | 16 |
| `server/templates.test.mjs` | 15 | `typography/typography.test.ts` | 15 |

## 5. 隔离的界面验证

不要和日常实例抢端口与文档：

```powershell
$fixture = 'D:\HIVE context\.work\019-csharp-backend\ui-check'
$env:HIVE_PORT = '4327'
$env:HIVE_DOCUMENTS = Join-Path $fixture 'documents'
$env:HIVE_STATE_DIR = Join-Path $fixture 'state'
npm start
```

将验收记录放到外置工作目录的 `evidence` 中，验证结束后关闭隔离进程。

## 6. 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 403 `只允许本机访问。` | Host 头不是 `127.0.0.1:<port>`/`localhost:<port>` | 用 localhost 访问，别用局域网 IP 或反代域名 |
| 409 `写作空间已在其他窗口切换。` | 同一浏览器多窗口共用 `x-hive-workspace` | 关掉旧窗口，或刷新后重试 |
| 409 `磁盘文件已变化，已阻止覆盖。` | baseline sha256 不符 | 界面里选择"采纳磁盘"或另存 |
| 409 `图片所属写作空间已变化。` | 图片 URL 里的 workspace 与当前不符 | 重开文档，重新插入图片 |
| 图片打不开 | 预览只允许 `documents` 内相对路径 | 确认文件在 `<文档名>pic/` 下，别用绝对路径 |
| 回收站看不到文件 | 回收站是 `documents/.hive-trash/`，以点开头 | 用界面里的回收站入口，别用资源管理器找 |
| 改名后标注/大纲丢失 | 元数据没跟着搬 | 只能用 `/api/explorer` 的 rename/move，别手动改文件名 |
| 端口占用 | 另一个实例还在跑 | 为独立验证指定其他 `HIVE_PORT` |
| 想清掉已保存的密钥 | 密钥明文持久化在 `state/keys.json`（跨重启有效） | 在设置里「清除密钥」或更换接口地址即丢；`HIVE_API_KEY` 只在尚无 `keys.json` 时注入 |
| `npm start` 白屏 | 没 build 或 dist 过期 | `npm run build` 后重启 |
| 开发模式改了 `backend/*.cs` 不生效 | 后端需要重新编译 | 重启开发命令 |
| 参考资料被截断 | 上限 32 项 / 合计 6 万字符 | 看 `warnings`，减少来源或改用文件引用 |
| 回收站清理报 token 无效 | 清理是两步：`preview` 出清单与 token，`purge` 必须带同一 token | 重新预览后再确认 |
| 409 `所选推理档位已不可用` | `reasoningEffort` 不在所选模型的有效档位（七档 `off/minimal/low/medium/high/xhigh/max` ∪ 手动声明档） | 重新选择档位或切回 `default` |
| 文件创建时间变了 | 原子替换后 `dev/ino/birthtimeMs` 变了 | 正常行为：`file-times` 不冒充旧创建时间 |

## 7. 改完自查

1. `npm test` 全绿，且新增行为有对应用例。
2. `npm run build` 无 TS 错误。
3. 隔离端口起一遍，手动走：打开文档 → 编辑 → 等 2s 看是否被磁盘同步回滚 → 生成建议（可换推理强度）→ 采纳/撤销 → 新建/改名/回收站/还原 → 回收站清理两步确认 → 插入图片 → 加参考资料看 `basis` 面板。
4. 架构、契约、主流程有变化时同步更新 `docs/` 下对应文件。
