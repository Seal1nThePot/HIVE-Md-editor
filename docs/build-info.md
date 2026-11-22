# 关于页与构建记录

本说明对应 HIVE 0.1.7。Windows 文件夹包和日用入口见 [运行手册](runbook.md)。

## 信息来源

- 应用名称取 `package.json` 的 `build.productName`，版本取 `version`，界面不另写版本常量。
- Vite 启动或构建时，`desktop/buildMetadata.cjs` 生成编号、UTC 时间和渠道。生产构建向页面注入 `__HIVE_BUILD_INFO__`，同时将同一份记录写入 `dist/build-info.json`。
- 桌面开发服务器运行生成 `development` 记录。它与 Vite 开发服务器分别初始化，时间和编号可以不同；桌面关于页以主进程返回的记录为准。
- 加载生产前端的桌面运行读取随构建提供的 manifest，并校验名称、版本、编号、时间和渠道。缺失、损坏或与应用版本不匹配时明确显示无法确认构建，仍保留包自身的版本。
- `runtime.mode` 和 `packaged` 由实际宿主生成。`electron .` 始终属于桌面开发运行，即使它加载生产构建；发行渠道不会将开发进程冒充为已打包应用。

## 统一发布接入

正常 `npm run build` 默认生成 `local` 渠道。统一发布构建可预先设置 `HIVE_BUILD_CHANNEL` 为 `alpha`、`beta` 或 `stable`；渠道表示本次构建声明，不表示已经联网检查更新或经过签名。

`HIVE_BUILD_NUMBER` 可由统一发布流水线提供，限 1–64 个安全标识字符（首字符为字母或数字，其余可含点、下划线、短横线）。未提供时自动生成 UTC 时间加随机后缀。时间由构建过程生成，不接受页面覆盖。开发服务器只接受 `development` 渠道。

本轮没有修改 `package.json` 的打包文件列表：既有 `dist/**` 和 `desktop/**` 已覆盖 manifest、桥接及构建模块；离线帮助、更新日志和许可证通过构建导入前端资源。发布组应从当前主工程统一构建，并在最终包中复核关于页和 `dist/build-info.json` 一致，不把旧包的构建记录与新资源混装。

## 数据边界

`getAboutInfo()` 只返回五项构建字段及固定运行环境字段；`openAppDataDirectory()` 不接受路径参数，只打开当前应用的 `userData`。两条 IPC 仅允许同源主窗口的主 frame 调用。打开失败不会将系统错误中的本机路径显示给用户。

## Windows 目录版本地更新

使用同一 Electron 版本构建 Windows x64 目录包后，运行下面的命令发布更新包。

    npm run update:bundle -- release/win-unpacked

发布目录默认使用项目同级的 `stable-relese`。命令会将 `update.hive.json` 和 `app.asar` 共同发布到 `latest`，成功后只保留新的一份。单独验证发布时可用第二个参数指定测试发布目录。

在程序目录的 `resources/hive-update-source.json` 写入 `{"directory":"发布目录的绝对路径"}`，「设置 → 关于 → 检查更新」即可查找最新构建。安装时可核对构建号。程序会完成保存退出，再替换应用文件和重启。当新版未能启动时，更新进程会尝试恢复上一个程序包。

相同发布版本通过构建时间区分。Electron 版本或 Windows 架构改变时需要完整程序包。

## Windows 目录版互联网更新

在「设置 → 关于 → 应用更新」选择「互联网（GitHub）」。应用会保存来源选择，下次启动沿用。本地模式仍可检查配置的本地目录或选择 `update.hive.json`。

互联网模式检查 [GitHub 稳定发布](https://github.com/Seal1nThePot/HIVE-Md-editor/releases/latest)。最新稳定发布须同时提供同一构建的 `update.hive.json` 和 `app.asar`，以及供首次安装使用的 Windows x64 ZIP。用户确认后才下载 `app.asar`。更新器校验字节数、SHA-256、构建信息和运行时兼容性，再通过原有保存、重启和失败恢复流程替换应用。

诊断由前端白名单重新构造，默认展示可选择的文本预览，复制内容与点击时的预览一致。正文、聊天、模型配置、密钥、端点、环境变量及目录路径均不作为诊断来源。本地资料使用纯文本展开阅读，不导航离开写作会话，也不需要外链桥接。

## 验证入口

`npm test` 包括构建元数据与诊断隐私测试；`npm run build` 生成真实前端与 manifest；构建后运行 `node scripts/verify-about.mjs` 检查隐藏 Electron 中的实际页面、隔离真实后端及正式 sandbox preload/IPC。该脚本使用系统目录打开的替身，不会打开资源管理器或操作用户窗口。

发布后的构建编号可在关于页和发布附件 `update.hive.json` 中核对。
