---
name: latex-split-merge
description: Use when splitting/merging LaTeX thesis chapters.
metadata:
  hermes:
    tags: [latex, thesis, refactor]
    related: [latex-studio-plugin, ustc-thesis-latex]
---

# LaTeX 论文结构拆分与合并（章 ↔ 节）

适用：一个大 `main.tex` 的学位论文工程，在「全文 / 按章 / 按节」三种粒度之间调整文件组织。
LaTeX Studio 插件的「本章 / 本节」按钮由目录结构决定（见 §5 插件对齐）。

## 0. 动手前（必做）
1. `git status` 干净才拆；没有 git 就先 `cp -r chapters chapters.bak_<date>`。
2. 先只拆一章试水，全量编译通过后再批量。
3. 铁律：**只搬内容、不改 label key**。图/表/公式/引用的 `\label{}-\ref{}` 与文件位置无关，key 不变引用就不断。

## 1. 全文拆成章（所有章节正文都写在 main.tex 里）
1. `grep -n '^\\chapter{' main.tex` 找分界；相邻两个 `\chapter` 之间即一章。
2. 每章内容写入 `chapters/N-name.tex`，文件首行保留该章 `\chapter{原标题}`。
3. `main.tex` 里那一段正文整体删除，换成按序一行 `\include{chapters/N-name}`。
   - 用 `\include` 而非 `\input`：插件 `\includeonly` 按章编译依赖它；代价是每章自动另起一页（论文本应如此）。
   - 前置部分（封面/摘要/目录）留在 `main.tex` 的 `\frontmatter` 区，不进 chapters。
4. 全量编译验证：`latexmk -xelatex main.tex`，核对页数与目录章节完整。

## 2. 章拆成节（配合插件「本节」按钮）
两种被插件识别的布局，**任选其一，全工程统一最好**：

### hybrid（推荐：main.tex 完全不用改）
```
chapters/3-swmt.tex             ← 壳：只有 \chapter + 若干 \input 行
chapters/3-swmt/3-1-intro.tex   ← 节：从 \section{...} 开始的正文
chapters/3-swmt/3-2-model.tex
```
- `main.tex` 继续 `\include{chapters/3-swmt}`（指向同名 .tex 文件）。
- 壳里的 `\input` 一律写**相对工程根**的路径：
  `\input{chapters/3-swmt/3-1-intro}`
  —— xelatex/latexmk 的 CWD 永远是工程根，不是章文件夹。这是最常见的翻车点。

### folder（章文件夹自包含）
```
main.tex:  \include{chapters/3/chapter}
chapters/3/chapter.tex    ← 壳，文件名必须是 chapter|ch|main|index 或与目录同名
chapters/3/3-1.tex ...    ← 节
```
- 同样：壳里的 `\input` 写根相对路径 `\input{chapters/3/3-1}`。
- `\include{chapters/3/chapter}` 这个键本身要能通过全量编译（键 = 路径去 .tex）。

### 切分步骤
1. 在章文件里 `grep -n '^\\section{'` 定位每节起点；相邻 `\section` 之间归各节。
2. 章首 `\chapter{}` 之前若有导引文字（章前记），留在壳里，不外搬。
3. 每节原样搬运成独立文件（不 trim、不改 label、不动图表浮动体位置）。
4. 壳改为：`\chapter{...}` + 章前记 + 依序 `\input{根相对/节名}` 行。
5. 验证三件事：
   - 全量编译页数与拆分前基本一致；
   - 打开某个节 .tex，插件出现「本节」，编译只出那一节；
   - 「本章」在节文件里点也能编整章。

## 3. 节合回章（反向）
1. 读壳，按 `\input` 顺序把各节文件内容拼接回一个 `chapters/N-name.tex`。
2. `\chapter` 与章前记保持原位；删掉壳里的 `\input` 行。
3. 删除节文件夹（`chapters/N-name/`）；确认没有别处残留指向它的 `\input`。
4. 全量编译验证。

## 4. 章合回全文（反向，很少需要）
把每个 `chapters/N.tex` 依 `\include` 顺序拼回 `main.tex`，删除 `\include` 行。
不建议：会失去按章/按节编译能力，单文件也大到编辑难受。

## 5. 插件对齐（LaTeX Studio 规则）
- `/structure` 判定「可节编」：
  - hybrid：include key `K` 且 `K.tex` 与 `K/` 文件夹同时存在（壳 = K）；
  - folder：include key 形如 `dir/{chapter|ch|main|index|dirname}`，且 `dir/` 内有其它 .tex（壳 = 该 key）。
- 「本节」编译 = 复制壳、把非目标 `\input` 行前缀 `% LSPSKIP ` 注释掉、`\includeonly` 指向过滤副本、jobname `main_partial_section`。
  - 注意：过滤按**文件**粒度——一个节文件里有多个 `\section` 会一起进来。想更细就得再拆文件。
- 扁平布局（`chapters/*.tex` 无同名文件夹）→ 只出「本章」。
- 部分编译（本章/本节）页码 ≠ 最终页码；写绝对页码、盲审、送印前必须全量编译。

## 6. 坑
- `\include` 自带 `\clearpage`：若某段内容不该另起页（如附录衔接段），留在同一个壳/文件里用 `\input`。
- 拆分后 aux/toc 里的旧 `@input` 记录过期：latexmk 会自动重跑，一般无需手动清；若报 “file not found”，几乎都是 `\input` 没按根相对写。
- 图片 `\includegraphics{figs/x}` 也是根相对——搬文件不用改；若原稿用了相对旧文件的奇怪路径，拆分时顺手统一成根相对。
- OneDrive 目录：批量改名/删文件夹后确认同步没锁文件；git 操作前 `git status` 看清有没有 .tmp 垃圾。

## 7. 用户话术（对应插件「?」里的提示）
- 拆成节：
  `按 latex-split-merge skill，把第3章 chapters/3-swmt.tex 拆成 hybrid 按节结构（它本身做壳 + 同名文件夹 3-swmt/ 放各节文件，\input 用根相对路径），拆完全量编译验证页数和引用没变。`
- 合回章：
  `按 latex-split-merge skill，把 chapters/3-swmt/ 里的节合回 chapters/3-swmt.tex 扁平结构，删掉文件夹并全量编译验证。`
- 全文拆章：
  `按 latex-split-merge skill，把 main.tex 里的第2到第5章拆成 chapters/ 下的独立文件，用 \include 挂回 main.tex，然后全量编译验证。`
- 体检：
  `按 latex-split-merge skill 检查第3章节拆分是否规范：壳内容、\input 根相对路径、label 有没有被改动。`
