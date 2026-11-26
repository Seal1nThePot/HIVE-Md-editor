# 关于页与构建记录

本说明对应 HIVE 0.1.9。Windows 目录包和日用入口见 [运行手册](runbook.md)。

## 信息来源

- 应用名称取 `package.json` 的 `build.productName`，版本取 `version`，界面不另写版本常量。
- Vite 启动或构建时，`desktop/buildMetadata.cjs` 生成编号、UTC 时间和渠道。生产构建向页面注入 `__HIVE_BUILD_INFO__`，同时将同一份记录写入 `dist/build-info.json`。
- 桌面开发服务器生成 `development` 记录。Vite 也会独立生成开发记录，桌面关于页以 C# 返回的记录为准。
- 加载生产前端的桌面运行读取随构建提供的 manifest，并校验名称、版本、编号、时间和渠道。缺失、损坏或与应用版本不匹配时明确显示无法确认构建，仍保留包自身的版本。
- `runtime.mode` 和 `packaged` 由实际宿主生成。`electron .` 始终属于桌面开发运行，即使它加载生产构建；发行渠道不会将开发进程冒充为已打包应用。

## 统一发布接入

正常 `npm run build` 默认生成 `local` 渠道。统一发布构建可预先设置 `HIVE_BUILD_CHANNEL` 为 `alpha`、`beta` 或 `stable`；渠道表示本次构建声明，不表示已经联网检查更新或经过签名。

`HIVE_BUILD_NUMBER` 可由统一发布流水线提供，限 1–64 个安全标识字符（首字符为字母或数字，其余可含点、下划线、短横线）。未提供时自动生成 UTC 时间加随机后缀。时间由构建过程生成，不接受页面覆盖。开发服务器只接受 `development` 渠道。

`app.asar` 和包内 `resources/backend/app/dist` 使用同一份 `build-info.json`。C# 读取并校验构建记录，Electron 补充原生运行信息。包校验及更新过程核对两份记录。

## 数据边界

`getAboutInfo()` 只返回五项构建字段及固定运行环境字段；`openAppDataDirectory()` 不接受路径参数，只打开当前应用的 `userData`。两条 IPC 仅允许同源主窗口的主 frame 调用。打开失败不会将系统错误中的本机路径显示给用户。

## Windows 目录版本地更新

使用同一 Electron 版本构建 Windows x64 目录包后，运行下面的命令发布更新包。

    npm run update:bundle -- <win-unpacked 目录> [发布目录]

发布目录默认使用外置工作目录下的 `update-release`。C# 打包程序将格式 2 的 `update.hive.json` 和 `hive-update.zip` 共同发布到 `latest`。ZIP 包含同一版本的 `app.asar` 和完整的 `backend` 目录。

在程序目录的 `resources/hive-update-source.json` 写入 `{"directory":"发布目录的绝对路径"}`，「设置 → 关于 → 检查更新」即可查找最新构建。安装时可核对构建号。程序会完成保存退出，再替换应用文件和重启。当新版未能启动时，更新进程会尝试恢复上一个程序包。

同版本构建通过时间区分。从 0.1.8 首次迁移、Electron 版本变化或 Windows 架构变化时使用完整目录包。

## Windows 目录版互联网更新

在「设置 → 关于 → 应用更新」选择「互联网（GitHub）」。应用会保存来源选择，下次启动沿用。本地模式仍可检查配置的本地目录或选择 `update.hive.json`。

互联网模式从 GitHub 稳定发布检查 `update.hive.json` 和 `hive-update.zip`。发布也可附首次安装用的完整 Windows x64 ZIP。用户确认后开始下载。C# 更新程序校验字节数、SHA-256、构建记录和运行时兼容性。完成保存退出后成套替换前端和 C# 后端，新版本未完成启动时恢复上一套。 [GitHub 稳定发布](https://github.com/Seal1nThePot/HIVE-Md-editor/releases/latest)

诊断由前端白名单重新构造，默认展示可选择的文本预览，复制内容与点击时的预览一致。正文、聊天、模型配置、密钥、端点、环境变量及目录路径均不作为诊断来源。本地资料使用纯文本展开阅读，不导航离开写作会话，也不需要外链桥接。

## 验证入口

`npm test` 包括构建元数据与诊断隐私测试。构建后使用 `node scripts/verify-csharp-desktop.mjs` 在隔离资料的隐藏运行中核对包内构建记录、后端进程和正式 preload IPC。

发布后的构建编号可在关于页和发布附件 `update.hive.json` 中核对。
