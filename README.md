# Hermes LaTeX Studio 插件

Hermes Agent 桌面端的 LaTeX 编辑工作台插件：左 .tex 编辑器 / 右 PDF 分页预览，latexmk 编译 + SyncTeX 正反向定位，PDF 点击标注 → 待办，论文推进看板，Git 差异/提交/合并远程。

## 目录结构（镜像安装路径）

| 仓库路径 | 安装位置（`%LOCALAPPDATA%\hermes\`） | 说明 |
|---|---|---|
| `desktop-plugins/latex-studio/plugin.js` | `desktop-plugins/latex-studio/plugin.js` | 前端面板（编辑器/PDF 预览/待办/看板/Git 按钮），保存即热重载 |
| `plugins/latex-studio/` | `plugins/latex-studio/` | 后端 FastAPI 路由（扫描/读写/编译/PDF 渲染/SyncTeX/Git），**改动需重启桌面端** |

## 功能

- 编译预览：全量 / 按章（`\includeonly`）/ 按节（章节文件夹结构），预览自动去掉 openright 空白页
- SyncTeX：编辑器 → PDF 定位（Ctrl+Alt+F）；PDF 点击 → 反查源文件行
- 标注 → 待办：PDF 点击预填待办，锚点定位（`\label`/章节命令 + 碎片文件父级兜底）
- 待办 + 论文推进看板：存到工程内 `todo.md`，随工程拷贝/git 带走
- 「上一节 / 下一节」：按文档 `\input` 包含链跨文件跳转
- Git：差异对比（含未保存改动）、一键提交、合并远程

## 依赖（Windows 不自带，需自行安装并加入 PATH）

| 工具 | 来源 | 用途 |
|---|---|---|
| `latexmk` + `xelatex` | TeX Live / MiKTeX | 编译 |
| `synctex` | TeX Live / MiKTeX 自带 | 正反向定位 |
| `pdftoppm` / `pdfinfo` | TeX Live Windows 版自带（poppler 工具） | PDF 分页渲染 |
| `git` | Git for Windows | 差异/提交/合并远程 |

缺一会在编译/预览时按"tool not found on PATH"报错。
