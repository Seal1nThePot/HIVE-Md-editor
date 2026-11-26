# 后端契约

## 0.1.9 服务入口与兼容格式

`backend/Program.cs` 装配 Kestrel、本机来源校验、写作空间上下文和请求队列。`Workspaces.cs` 管理仓库注册、切换和外置仓库清单。`Files.cs` 负责正文、草稿、目录快照和同步，`Explorer.cs` 负责结构操作和回收站。`Metadata.cs` 使用现有标注、写作大纲和创建时间 JSON 文件。历史记录、图片和参考附件分别由 `History.cs`、`Media.cs` 和 `References.cs` 管理。

`Models.cs`、`Generation.cs` 和 `AiTools.cs` 处理模型配置、生成和工具请求。模型配置与密钥沿用原状态目录及文件格式。主题和插件由 `CatalogService.cs` 及其存储模块实现。桌面主进程通过私有进程管道调用外部文稿、偏好和更新，保留现有渲染端 IPC 名称。桌面文件打开与保存需通过主窗口主 frame，仓库外保存还需有本次进程内打开记录和有效磁盘基线。

## 文档保存与同步

正文保存先核对磁盘基线，再写同目录暂存文件。发布前复查磁盘内容，已有文件使用原子替换，新文件使用不覆盖同名目标的硬链接。最后一次复查与替换之间仍有外部写入的竞态窗口。

`POST /api/file` 和 `POST /api/scratch` 返回 `{path,hash}`。正文发布成功后若时间记录更新失败，响应额外带 `warning`。前端接受此次写入的基线，保存期间产生的编辑继续留在内存并保持未保存。

## 0.1.5 同步补充（2026-11-18）

`POST /api/workspace/sync` 保留 `paths`、`baselines`，新增可选 `treeVersion`。响应为 `{workspace, treeVersion, entries, files}`；`entries` 恒返回，`treeVersion` 未变化时省略的是目录重扫而非响应字段（2026-11-19 实测）。该版本独立于仓库配置的 revision。

`GET /api/tree` 返回当前快照，`?refresh=1` 强制校验磁盘。`files.list()` 保持即时扫描兼容语义，供显式搜索与旧接口使用。扫描、保存与元数据写入沿用同仓库事务队列。树响应使用支持深层目录的序列化配置，请求解析深度与正文体积上限沿用原配置。

`Files.cs` 管理仓库扫描、目录监听和 60 秒兜底。变化使快照失效，下次请求重建过滤范围内的树。权限拒绝的子项会跳过，`/api/tree` 和 `/api/workspace/sync` 都会随可读条目返回 `warnings: [{path, message}]`。`path` 为仓库内斜杠分隔的相对路径。警告参与快照版本计算，权限恢复后重扫会清除警告。根目录和时间记录的读取失败返回错误，损坏的记录保留原样。同步探测最多缓存 100 项属性与哈希，监听到变化后重验内容，并保留 30 秒兜底。保存始终重新核对磁盘基线。`FileTimes.cs` 复用最多 16 MiB 创建时间状态文件的解析结果，磁盘签名变化或读写失败时失效。

切换仓库停止旧监听并释放索引和同步探测缓存。已捕获的请求继续访问原仓库。同步准备响应时若当前仓库已切换，返回 409。退出时停止监听并回收服务资源。

本地 HTTP 服务绑定 `127.0.0.1`。命令行入口 `server/index.mjs` 启动同一个 C# 可执行程序，开发模式下另开 Vite 提供前端热更新。生产桌面直接启动包内 C# 可执行程序。磁盘保存业务状态，C# 进程管理队列、锁、模型密钥和回收站清理令牌。

## 1. 前置条件（每个 `/api/*` 请求都会过）

1. **本机限定**：`Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 403 `只允许本机访问。`
2. **来源校验**：带 `Origin` 时必须同源，否则 403 `请求来源不匹配。`
3. **不缓存**：统一 `Cache-Control: no-store`。
4. **请求上限**。JSON 为 3 MiB，图片原始字节为 12 MiB，参考附件为 2,000,000 字节。
5. **写作空间上下文**：路径首段属于 `workspaceRoutes`（`writing-outline / annotations / scratch / outline / tree / file / folder / rename / workspace / explorer / images / references`）时，按 `x-hive-workspace` 头取空间，过期即 409 `写作空间已在其他窗口切换。`
6. **POST 串行化**：同一空间内的 POST（`/workspace/sync` 除外）在服务端排队，前一个响应结束才处理下一个——结构操作与元数据保存不会互相插队。

环境变量包括 `HIVE_PORT`（4324）、`HIVE_DOCUMENTS`（文档根）、`HIVE_STATE_DIR`（状态目录）、`HIVE_APP_DATA_DIR`（桌面应用数据根，独立服务默认使用状态目录）、`HIVE_API_KEY`（仅当 state 目录尚无 `keys.json` 时，启动注入到选中或首个服务，见 §9）。

## 2. 路由表

| 方法 | 路径 | 入参 | 出参 |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{app:"hive-writing-prototype",pid,project,ready,backend:"dotnet"}`，PID 属于真实 C# 进程 |
| GET | `/api/workspace` | — | `{id,root,defaultRepositoryId,autoSave,revision,repositories:[{id,root,name?}]}`。列表包含当前仓库和默认文档根。 |
| POST | `/api/workspace` | `{root,autoSave,revision}` | 同 GET；`revision` 过期 → 409 |
| POST | `/api/workspace/repositories` | `{action:"add"\|"rename"\|"remove"\|"reorder", revision, …}` | 同 GET。`add` 须现有普通目录（拒符号链接/junction），`rename` 备注 ≤80 单行，`reorder` 须全量 id。`remove` 仅移出登记，保留文件与元数据。默认文档根禁止移出。移出当前仓库时同一事务切回默认文档根。`revision` 过期 → 409。 |
| POST | `/api/workspace/sync` | `{paths: string[], baselines?: Record<path, sha256>, treeVersion?}`（paths ≤100，`baselines` 可选，兼容旧请求） | `{workspace,treeVersion,entries,files,warnings?}`；服务端最多 4 个并发读文件；hash 与 `baselines[path]` 相同的文件只回 `{path,hash,unchanged:true}`，不带 `text`；不排队 |
| POST | `/api/references/resolve` | `{sources,budget,currentFile?,overrides?}`，来源格式见 §10 | `{sources,files:[{path,source,characters,truncated,text,unsaved?}],warnings}` |
| POST | `/api/references/attachments` | UTF-8 Markdown 原始字节（`application/octet-stream`，≤2 MB）和 `?name=` | `{type:"attachment",id,path}`，`path` 为显示文件名 |
| DELETE | `/api/references/attachments/:id` | 附件 ID | `{ok:true}` |
| GET | `/api/tree` | — | `{root,treeVersion,entries,warnings?}`（文件夹优先，`zh-CN` 排序） |
| GET | `/api/file` | `?path=` | `{path,text,hash,eol,bom}` |
| POST | `/api/file` | `{path,text,baseline,eol,bom}` | `{path,hash,warning?}` |
| POST | `/api/folder` | `{path}` | `{ok:true}` |
| POST | `/api/rename` | `{from,to,baseline}` | 改名结果（`link`+`unlink`，不静默覆盖） |
| GET | `/api/scratch` | — | `{text,hash,path}`（固定 `自由草稿.md`） |
| POST | `/api/scratch` | `{text,baseline}` | `{path,hash,warning?}` |
| GET | `/api/annotations` | `?source=document\|scratch&file=` | `{revision,fingerprint,items}` |
| POST | `/api/annotations` | `{source,file,revision,fingerprint,items}`，每条标注可带整数 `order` | `{revision}`（`source/file` 由服务端校正） |
| GET | `/api/writing-outline` | `?file=` | `{revision,initialized,nodes}` |
| POST | `/api/writing-outline` | `{file,nodes,revision}` | 同 GET；`revision` 过期 → 409 |
| GET | `/api/outline` | `?file=` | `{key: description}`（旧版大纲备注） |
| POST | `/api/outline` | `{file,key,description}` | 同上（无 revision 校验） |
| GET | `/api/templates` | — | `{directory,sourceDirectory,templates,warnings}`（olive-gold 置顶、zh-CN 名称排序；读取失败的目录记入 warnings） |
| GET | `/api/plugins` | — | `{directory,plugins,errors,limitReached,canOpenDirectory,canInstallSample}`。插件来自应用数据目录的 `plugins` 子目录。清单版本 1 支持 `editor.status` 的本地统计。 |
| POST | `/api/plugins/enabled` | `{id,enabled}` | 原子保存启用状态后返回插件目录快照。未知、冲突或无效插件返回 404。 |
| POST | `/api/plugins/sample` | `{}` | 添加未启用的选区行数示例，保留现有同名文件，返回插件目录快照。 |
| POST | `/api/plugins/open` | `{}` | 桌面端请求系统打开插件目录，返回 `{ok:true}`。 |
| GET | `/api/templates/:id` | 可选 `?colorsOnly=1` 或 `?iconPackRevision=<hash>` | `{template,directory,colors,revision,defaults,defaultsRevision,iconPack}`。仅配色请求省略 `iconPack`。图标包摘要匹配时返回 `iconPackUnchanged:true` 并省略包。 |
| POST | `/api/templates/:id` | `{revision,colors}` | 保存配色（version 1 全量校验；`colors.before-save.json` 备份；临时文件+rename；`revision` 过期 → 409 `模板配色文件已被外部修改，请重新读取后再保存。`） |
| POST | `/api/templates/:id/open` | — | `{ok,directory}`（仅 Windows。桌面端由 Electron 打开对应模板目录并确认系统调用结果，失败返回 503。独立后端调用 `explorer.exe`。） |
| GET | `/api/templates/:id/icons` | — | `{version:1,icons,localIcons,revision,warning,packRevision}`，独立读取图标包。`icons` 为逐键合并结果，`localIcons` 为用户模板子目录的有效定义。`warning` 报告跳过的坏包或无效条目。 |
| POST | `/api/templates/:id/icons` | `{version:1,revision,localIcons}` | 校验全部提交定义并原子替换用户模板子目录的图标文件，返回最新图标包。`revision` 为本地文件字节的 SHA-256，文件不存在时为 `null`。本地文件已有并发修改时返回 409。图标和配色文件各自限制 1 MiB。 |
| GET | `/api/explorer/trash` | — | 回收站记录数组（按删除时间倒序） |
| GET | `/api/explorer/trash/document` | `?id=<已删除条目 UUID>` | 当前仓库内已删除的 Markdown 文稿只读快照 `{id,path,text}`，最大 2 MB。未知或内容缺失的条目返回 404。 |
| POST | `/api/explorer/trash/preview` | `{days:0\|7\|15\|30\|90}`（0＝全部条目） | `{token,days,cutoff,expiresAt,items,count}` |
| POST | `/api/explorer/trash/purge` | `{token}` | `{deletedIds,failed}` |
| POST | `/api/explorer/trash/delete` | `{ids:[uuid]}`（1–100 条，免 token） | `{deletedIds,failed}`；逐条校验记录与内容指纹；全都不在 → 404 `这些条目已不在回收站中。`；失败项带 `dataDeleted`/`partialDataDeleted`（见 §6） |
| GET | `/api/explorer/search` | `?folder=&query=` | `{matches:[{path,line,excerpt}],truncated}` |
| POST | `/api/explorer` | `{action,path?,parent?,name?,type?,id?}` | 见 §6 |
| POST | `/api/images` | 原始字节体（`application/octet-stream`）+ `?document=&name=` | `{path,reference}` |
| GET | `/api/images` | `?workspace=&document=&path=` | 图片字节（带 `nosniff` 与 sandbox CSP） |
| GET | `/api/image-file` | `?workspace=&path=` | 图片字节（`workspace` 不匹配当前空间 → 409；带 `nosniff` 与 sandbox CSP） |
| GET | `/api/image-file/info` | `?path=` | `{path,mime,bytes}` |
| POST | `/api/import` | 原始字节体 + `?name=&parent=` | `{path,kind:"markdown"\|"image"}`（.md ≤2 MB 且 UTF-8；PNG/JPG/GIF/WebP 魔数须与扩展一致；默认落「导入的图片/」，重名加 `-2`…`-1000`） |
| GET | `/api/import` | — | 已导入图片列表（「导入的图片/」直下） |
| GET | `/api/import/references` | — | 文档中的图片引用 |
| GET | `/api/import/image` | `?path=` | 图片字节（限「导入的图片/」直下，≤12 MB，魔数校验） |
| GET | `/api/config` | — | 模型配置（含每服务 `hasKey`） |
| POST | `/api/config` | `{revision,demo,continuationLimit,...}`（兼容旧 `{endpoint,model,key,clearKey}`） | 新配置；`revision` 过期 → 409 |
| POST | `/api/model-services` | 服务对象（可带 `key`） | 新配置；服务数上限 40 |
| POST | `/api/model-services/remove` | `{id}` | 新配置（同时清除该服务密钥） |
| POST | `/api/model-services/probe` | `{revision,service:{id?,endpoint},key?,clearKey?,modelId?}` | 无 `modelId` → `{kind:"catalog",models,configurationLimit,hasMore?}`；带 → `{kind:"generation",modelId,elapsedMs}`（非流式测试生成 32 tokens；超时 504、无法连接 502；模型列表含密钥回显即中止；`revision` 前后双检） |
| POST | `/api/model-services/reorder` | `{ids}`（全量重排） | 新配置 |
| POST | `/api/generate` | `{messages,selection,reasoningEffort?}` | SSE：`event: chunk\|done\|error` |
| POST | `/api/ai-tools/find-note` | `{instruction,selection?,target:{workspaceId,file,text}}` | `{kind:"find-note",file,query,matches:[{line,column,from,to,snippet}],truncated}` |
| POST | `/api/ai-tools/repositories` | `{instruction,selection?,pendingName?,target:{workspaceId,revision}}` | `repository-list` 返回 `{repositories:[{id,name,path}]}`，`repository-created` 返回 `{repository,workspace}`，`repository-location-required` 返回 `{name,question}` |
| POST | `/api/ai-tools/documents` | `{instruction,selection?,target:{workspaceId}}` | `folder-list` 返回 `{folder,entries:[{name,path,type}]}`，`document-create` 返回 `{parent,name,type}`，`document-trash` 返回 `{path}` |
| POST | `/api/ai-tools/trash` | `{instruction,selection?,target:{workspaceId}}` | `trash-restore` 或 `trash-confirm-delete` 返回 `{items}`，条目沿用回收站记录 |
| POST | `/api/ai-tools/quick-open` | `{workspaceId,limit,candidates:[{path,count}]}` | `{paths}`。至多 16 个当前仓库目录候选，模型建议限定在可用候选内，最多 4 项。应用索引前在窗口内确认。 |

`server/ai-tools/` 集中维护标注窗口可调用的内置工具。笔记查找使用发送时的编辑器快照，支持未保存正文。模型收到查找要求和 `find_note` 工具参数定义，允许返回查找词、区分大小写与完整词匹配。查找在本机进行，响应最多含 100 项。行和列从 1 开始，`from` 和 `to` 是编辑器使用的 UTF-16 偏移，`to` 为结束边界。仓库切换后返回 409。模型不支持结构化调用或返回未提供的工具时返回 502。

仓库清单 `repositories.json` 位于应用数据根，包含 `revision` 和仓库的编号、显示名称、路径。`workspace.json` 持有权威仓库配置，清单随仓库管理更新，并在启动或查阅时重新核对。创建新仓库需要本轮指令明确提供上一级绝对目录。缺少位置时前端保留返回的 `name`，将用户补充的绝对目录作为下一轮 `instruction`，并传原名称为 `pendingName`。成功创建后当前仓库仍保持打开。已有未登记目录会返回 409。

文档工具在标注的仓库内解释相对路径。查看文件夹返回直接子项。新建文件、新建文件夹和移入回收站返回明确的目标，由前端提交到现有文件事务。`POST /api/explorer` 的 `create` 可附带 `name`，显式名称撞名时返回 409；省略名称时沿用自动命名。回收站查找支持明确原路径、唯一文件名或条目 ID。同名匹配返回 409。恢复通过现有文件事务提交。永久删除的工具返回供界面确认的条目，用户确认后才调用回收站删除接口。

未命中的 `/api/*` → 404 `接口不存在。`；全局错误映射：`ENOENT`→404 `文件不存在，请刷新文件列表。`，`EEXIST`→409 `同名文件已存在，已阻止覆盖。`，其余 500 或 `error.status`。

## 3. 冲突闸

| 场景 | 机制 | 冲突响应 |
| --- | --- | --- |
| 正文保存 | 客户端回传 `baseline`（原始内容 sha256） | `hash(磁盘) !== baseline` → 409 `磁盘文件已变化，已阻止覆盖。…`；写入前再读一次校验，变化则 409 `保存期间磁盘文件发生变化…` |
| 标注 / 写作节点 / 空间 / 模型配置 | `revision` 整数 | 各资源各自的 409 文案（见前端 `setError` 展示） |
| 多窗口空间切换 | `x-hive-workspace` | 不匹配 → 409 `写作空间已在其他窗口切换。` |
| 图片预览 | `?workspace=` 必须等于当前空间 id | 不匹配 → 409 `图片所属写作空间已变化。` |
| 回收站清理 | `preview` 发一次性 `token`（5 分钟有效），`purge` 校验 token 与每条记录 fingerprint | 过期/内容变化 → 409 `回收站内容已变化或预览已过期，请重新预览并确认。` |

## 4. `/api/generate`（SSE 代理）

- 入参校验：`messages` ≤ 160 条、`role ∈ {system,user,assistant}`，否则 400 `本轮上下文格式无效或超过 160 条消息。`；`content` 为字符串，或 user 消息的多段数组（≤32 段：text/`input_text` 文本段各 ≤100000 字；image 段仅接受 `data:image/` URL）；消息含图片段而模型未声明图片输入 → 415 `该模型未声明图片输入。请在「模型设置 · 输入类型」勾选图片，或换用支持图片的模型。`；序列化后 ≤ 120000 字符，超出 → `本轮请求超过 HIVE 的 12 万序列化字符上限，请减少会话内容或缩小选区后重试。`；估算输入+输出预留超模型上下文 → 413 `本轮完整请求约需 N token（含 M 输出预留），超过该模型的 X token 上限。请缩小选区、减少参考资料或另开会话。`
- 端点拼接：`endpoint` 以 `/chat/completions` 结尾则直接用，否则追加；`Authorization: Bearer <key>` 仅在内存有 key 时加。请求经 `sendChatCompletion` 发出并带 `max_completion_tokens: outputLimit`（计算见 §11）；上游 400/422 报参数不支持时回退 `max_tokens` 重发。
- 流式：`event: chunk`（delta 文本）、`done`、`error`；非 SSE 响应则退化为一次性 `chunk` + `done`。
- 完整性：必须收到正文且 `finish_reason === "stop"`，否则 `模型响应中断或未返回正文，未生成可采纳建议。`；`finish_reason === "length"` 报 `本轮已达到最大输出长度，请调整后重试。`；其他非 stop 报 `生成未完整结束，请重试。`
- 超时/中断：客户端断开或 120 秒超时 → `AbortController.abort()`，报 `请求已停止或超时。`；连接失败报 `无法连接模型端点，请检查本机网络及端点地址。`
- 推理强度：`reasoningEffort` 取 `default`（或省略）与 `off/minimal/low/medium/high/xhigh/max`（有效集合见 §11）；档位不在所选模型有效集合 → 409 `所选推理档位已不可用，请切回默认或重新选择。`；非默认时按上游声明映射为 `reasoning_effort`/`reasoning.effort`/`thinking.type` 之一（`off` 传 `none`）；上游端点报错文案会追加「可将推理强度调回默认后重试。」
- 首字节前出错 → 502 JSON；已发头后出错 → `event: error`。

## 5. `files.mjs`（Markdown 文件层）

- `resolve()` 拒绝：`..`/`.` 段、含 `:*?"<>|` 的段、非 `.md` 后缀、符号链接/junction（逐段 `lstat`）。
- `read()` 上限 2 MB；返回 `text`（去 BOM、CRLF→LF）、`hash`（原始字节 sha256）、`eol`、`bom`。
- `save()` 每文件一把 promise 锁（键为小写路径），临时文件 `.<name>.<uuid>.tmp`（`wx`）→ rename。
- `rename()` 先 `link` 再 `unlink`，目标存在即失败（不静默覆盖）。
- `transaction()` 供 explorer / images 组合多次写入。
- 创建时间：`list()` 给每个条目附 `createdAt` 与 `modifiedAt`。`createdAt` 来自 `file-times.json`（见 §12），按 `dev/ino/birthtimeMs` 三元组认文件身份——改名/复制保留原创建时间，同名但被替换过的文件重置为新 `birthtime`。`save()` 也会把被覆盖文件的 `createdAt` 续写回去。

## 6. `explorer.mjs`（结构操作）

`POST /api/explorer` 的 `action`：

| action | 入参 | 行为 |
| --- | --- | --- |
| `create` | `{parent,type:"file"\|"folder"}` | 自动去重命名（`新建文档.md` / `新建文档 2.md`）；文件夹用 `mkdir` |
| `rename` | `{path,name}` | 校验名字（禁斜杠、结尾 `. `、Windows 保留名）；文件补 `.md` |
| `move` | `{path,parent}` | 禁止把文件夹移进自身子树 |
| `duplicate` | `{path}` | 生成 `… 副本.md` / `… 副本` |
| `trash` | `{path}` | 移到 `documents/.hive-trash/<uuid>` + 同名 `.json` 记录；`自由草稿.md` 同样可删（`rename`/`move` 仍拒绝） |
| `restore` | `{id}` | 按记录回原路径；目标已存在 → 409 |
| `reveal` | `{path}` | 仅 Windows：桌面外壳经 `revealFile` 定位选中；独立服务器回退 `explorer.exe <所在目录>`（不带 `/select`） |

所有改动路径的操作都在 `files.transaction()` 内，并调用 `remapMetadata(state, from, to)` 同步迁移标注/大纲/创建时间键；迁移失败则回滚文件移动。

**保留期清理**（`trash-retention.mjs`，由 explorer 挂载）：`preview(days)` 接受 0/7/15/30/90（0＝回收站全部条目），筛出删除时间早于 cut-off 的记录，逐条算 fingerprint，发一个 5 分钟有效的一次性 `token`（内存 Map，最多 32 个，超时即淘汰）；`purge(token)` 在事务里重新校验每条 fingerprint 与记录是否仍在，变了就整批 409，不删；删除成功的 id 进 `deletedIds`，失败的进 `failed`，同时清掉对应元数据。`deleteTrash(ids)`（`POST /api/explorer/trash/delete`）供回收站面板行内永久删除：免 token，`ids` 1–100 条 uuid，逐条校验记录与内容指纹后删除并清元数据；全都不在 → 404 `这些条目已不在回收站中。`；失败项进 `failed:[{id,path,error,dataDeleted?,partialDataDeleted?}]`。

`GET /api/explorer/search`：`query` 1–200 字，按小写子串匹配内容与文件名，最多 200 条，返回行号与 25+60 字上下文；超过 2 MB 或已删除的文件跳过。

## 7. `images.mjs`（图片）

- 上传：`MAX_IMAGE_BYTES = 12 MB`；按魔数识别 PNG/JPG/GIF/WebP，其他 400 `支持 PNG、JPG、GIF 和 WebP 图片。`
- 落盘：与文档同级的 `<文档名>pic/` 目录，文件名去非法字符、截 100 字、冲突加 `-2`；返回 `{path, reference}`（`reference` 是相对文档的 Markdown 路径）。
- 预览：只接受相对路径，拒绝 `scheme:`、绝对路径、NUL、非图片后缀、符号链接、> 12 MB；响应 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: default-src 'none'; sandbox`。

## 8. `metadata-paths.mjs`

`remapMetadata(state, from, to)` 同时改四份 JSON 的键：`text-annotations.json`（键 `document:<path>`，并改每条 `item.file`）、`writing-outline-nodes.json`、`writing-outlines.json`、`file-times.json`。任一步失败按记录回滚；目标键已存在则报 `目标路径已有标注或大纲记录，请换一个名称。`（`file-times.json` 例外：允许覆盖目标键）。`removeMetadata` 在彻底删除时清掉这些键。

## 9. `model.json`（schemaVersion 2）

```json
{
  "schemaVersion": 2,
  "revision": 3,
  "demo": false,
  "continuationLimit": 100,
  "services": [{"id":"…","name":"…","endpoint":"https://…","enabled":true,
                "models":[{"id":"…","name":"…"}]}],
  "selection": {"serviceId":"…","modelId":"…"}
}
```

- `endpoint()` 拒绝带凭据/查询串/片段的 URL 与非 http(s)；`text()` 拒绝换行与 NUL。
- `migrate()` 把旧版单端点变成 `id: "legacy"` 的服务；`reconcile()` 在模型不存在或服务被停用时清空选择并切回演示模式。
- 密钥持久化在 state 目录 `keys.json`（明文 `{serviceId:{endpoint:<chat 地址>,key}}`，临时文件 `0o600` + rename 原子写入）——应用须跨重启不重输密钥；`read()` 只回 `hasKey`，密钥永不交给渲染端；换端点或清除密钥即丢。`HIVE_API_KEY` 仅在尚无 `keys.json` 时注入。上限：服务 40 个、每服务模型 100、服务名 ≤120 字、服务 id ≤80。

## 10. `references.mjs`（参考资料解析）

`POST /api/references/resolve`，无状态纯函数 `resolveReferences({files}, input)`：

- `sources` ≤ 32 项。仓库文件及文件夹采用 `{type,path}`，路径经 `files.resolve()` 校验后按小写路径去重。外部 Markdown 采用 `{type:"attachment",id,path}`，按 ID 去重，内容保存在当前仓库对应的应用数据目录。
- 文件夹递归展开（隐藏项与符号链接由 `list()` 排除），候选最多 256 份，超出记 warning 只取前 256；`currentFile` 命中的路径跳过并提示「已包含在当前正文中」。
- `budget` 必须为 0–60000 的整数；按候选顺序依次填充，放不下的记 `本轮参考空间已满`；单份被截短时提示「已截短，优先保留开头 N 个字符」。
- `overrides`（未保存的参考稿）≤ 64 项，总长 ≤ 60000，命中路径用内存文本替代磁盘内容，输出带 `unsaved:true`；未保存内容超出剩余空间则跳过并提示。
- 输出 `{sources, files:[{path,source,characters,truncated,text}], warnings}`；显式指定的文件读不到 → 400，文件夹里的读不到只记 warning。

## 11. `generation-options.mjs`

`reasoningOptions(value, model)`：`level = value ?? model.defaultReasoning`；`undefined`/`"default"` → `{}`（不传字段）；level 不在 `effectiveReasoningLevels(model)`（上游声明档 ∩ 七档 `off/minimal/low/medium/high/xhigh/max`，∪ 手动声明档）→ 409 `所选推理档位已不可用，请切回默认或重新选择。`；命中上游声明 `capabilities.reasoning[level]` 按其 `{parameter,value}` 映射，否则默认 `{parameter:"reasoning_effort", value}`（`off` → `none`）——`reasoning.effort` → `{reasoning:{effort}}`、`thinking.type` → `{thinking:{type}}`、其余平铺 `reasoning_effort`。

`generationPayload(route, body)` 另做：messages ≤160 与多段内容校验（见 §4）、12 万序列化上限、413 token 预算（`estimatedInput + outputLimit > contextTokens` 即拒；`outputLimit = model.maxOutputTokens ?? 上游 maxOutputTokens ?? min(上游上限, contextTokens−estimatedInput)`，无任何声明时按 `contextTokens/4` 夹 1–2048）。

## 12. `file-times.mjs`（创建时间）

`fileTimes(state)` 维护 `file-times.json`：

- 记录形状 `{相对路径: {dev, ino, birthtimeMs, createdAt}}`。
- `observe(data, path, stat)`：三元组（`dev`/`ino`/`birthtimeMs`）全等 → 沿用旧 `createdAt`；否则视为新文件，用 `stat.birthtimeMs`，并标记 `dirty` 让 `list()` 回写。
- `replaced(data, path, stat, createdAt)`：写入新身份 + 指定 `createdAt`（`save()` 覆盖时续用旧值，`rename()` 迁移时带上原值）。
- 读写都过符号链接/非普通文件检查（与其它状态文件一致），解析失败当作空表。

## 13. 加一个后端能力的六步

1. 在 `server/<area>.mjs` 写 store 工厂，返回纯函数对象，不做 HTTP。
2. 在 `workspace.mjs` 的组合处挂上它，拿到 `root / files / state` 依赖。
3. 在所属模块注册路由。文档接口放在 `document-routes.mjs`，需要空间上下文的新路径首段登记到 `index.mjs` 的 `workspaceRoutes`。
4. 校验入参，错误用 `Object.assign(new Error(msg),{status})` 带上状态码。
5. 需要一致性的多步写入走 `files.transaction()`；涉及路径变化调 `remapMetadata`。
6. 写 `server/<area>.test.mjs`（直接测 store，不启 HTTP），并在本文件补一行。
