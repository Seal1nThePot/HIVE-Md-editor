<p align="center">
  <img src="assets/brand/hive.png" width="108" height="108" alt="HIVE 彩虹渐变六边形标志">
</p>

<h1 align="center">HIVE</h1>

<p align="center"><strong>在同一个工作区写 Markdown、整理资料、审阅 AI 建议。</strong></p>

<p align="center">
  <a href="https://github.com/Seal1nThePot/HIVE-Md-editor/releases/download/v0.1.8/HIVE-0.1.8-Windows-x64.zip"><strong>下载 Windows x64 · v0.1.8</strong></a>
  · <a href="https://github.com/Seal1nThePot/HIVE-Md-editor/releases">发行记录</a>
  · <a href="#快速开始">快速开始</a>
  · <a href="#界面一览">界面一览</a>
</p>

<p align="center">
  <img src="assets/readme/workspace.png" alt="HIVE 写作工作区，左侧是本地仓库的章节和资料，中间是 Markdown 文稿，右侧是演示对话" width="100%">
</p>

HIVE 是面向写作与笔记的桌面 Markdown 编辑器。把现有文件夹作为仓库打开，就能在正文旁查看章节、资料和标注。文稿以 `.md` 文件保存在你选择的文件夹里。

## 快速开始

1. 下载并解压完整的 [Windows x64 ZIP](https://github.com/Seal1nThePot/HIVE-Md-editor/releases/download/v0.1.8/HIVE-0.1.8-Windows-x64.zip)，运行 `win-unpacked` 中的 `HIVE markdown editor.exe`。
2. 点击左上角的仓库名称，在「仓库管理」里添加你的 Markdown 文件夹，再从左侧文档列表打开一篇文稿。
3. 在「设置 → 关于 → 应用更新」选择本地或互联网来源。互联网模式从 GitHub Releases 检查稳定版。 [更新说明](docs/build-info.md)

## 主要功能

- **编辑与阅读**　切换实时编辑、实时预览、代码模式和左右分栏。在正文里处理表格、待办和图片，点标题折叠章节。
- **仓库与标注**　在文档面板查找、整理多篇文稿，用标题目录跳转。为选中的段落添加标注，回到正文时可以接着审阅。
- **AI 协作**　将文稿选区和指定资料用作对话依据。对正文的修改先出现在提案预览中，由你决定保留或撤掉。在「设置 → 模型」配置自己的服务与模型即可使用真实请求。
- **工作区与外观**　文档、标题目录、草稿、标注和对话面板可以停靠或浮动。通过主题模板调整配色，并单独设置界面和正文字号。

## 界面一览

### Markdown 左右分栏

左侧保留 Markdown 标记和行号，右侧显示渲染后的正文。两侧编辑的是同一篇文稿。

![HIVE 左右分栏，左侧显示 Markdown 源码，右侧显示同一篇文稿及渲染表格](assets/readme/split-editor.png)

### 在正文中审阅 AI 提案

修改建议贴在原文位置，正文旁的按钮用来保留或撤掉建议。这里展示的是应用内演示模式，文稿与对话均为示例。

![HIVE 演示模式中的 AI 局部修改，正文原位显示提案与审阅按钮，右侧保留对话记录](assets/readme/ai-review.png)

## 从源码运行

发布标签保留了与 Windows 包对应的源码。使用 Node.js 22.12 或更新版本。

```powershell
git clone --branch v0.1.8 https://github.com/Seal1nThePot/HIVE-Md-editor.git
cd HIVE-Md-editor
npm ci
npm run desktop:dev
```

执行 `npm run desktop:folder` 可生成 Windows 目录包。 [架构说明](docs/architecture.md) · [更新日志](docs/CHANGELOG.md)

## 许可证

[AGPL-3.0-or-later](LICENSE)
