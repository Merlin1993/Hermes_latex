// ~/.hermes/desktop-plugins/latex-studio/plugin.js
// LaTeX 编辑工作台：左 .tex 编辑器 / 右 PDF 分页预览；latexmk 编译 + SyncTeX 正跳。
// 磁盘插件约束：无 JSX（用 jsx()/jsxs()），只 import @hermes/plugin-sdk、react、react/jsx-runtime。

import { host, atom, useValue, queryClient, haptic } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ---------------------------------------------------------------- scoped ctx
let api = null
const rest = (p, o) => api ? api.rest(p, o) : Promise.reject(new Error('plugin ctx not ready'))

function fmtErr(e) {
  if (e == null) return String(e)
  if (typeof e === 'string') return e
  return e.message || e.detail || (e.data && e.data.detail) || JSON.stringify(e)
}

// ---------------------------------------------------------------- pane reveal
const PANE_TAB_ID = 'latex-studio:pane'

function revealLatexPane() {
  const tab = document.querySelector('[data-tree-tab="' + PANE_TAB_ID + '"]')
  if (tab) { tab.click(); return }
  host.notify({ kind: 'info', message: 'LaTeX 面板不在当前布局里。', detail: '⌘K → "Reset layout" 恢复，再点 TeX。', durationMs: 8000 })
}

// ---------------------------------------------------------------- reactive UI
const ui = atom({
  root: null, file: null, text: '', dirty: false,
  scanning: false, building: false, buildLog: '',
  pdfKey: '', pages: 0, page: 1, view: 'pages', zoom: 1.0,
  marker: null, files: [], pdfRel: 'main.pdf',
  pdfMissing: false, pdfError: false,
  annotate: false, // PDF 点击标注模式：点页面 → /reverse 反查 → 预填待办
  todos: [],       // 待办列表（镜像工程 todo.md / storage，供工具栏计数显示）
  board: [],       // 论文推进看板（镜像工程 todo.md / storage）
  todoOpen: true,  // 待办面板常驻开关（默认开=常驻在编辑器下方；可收起）
  todoAnnotate: null, // PDF 点击反查得到的预填位置 {file,line,page,context} | null
  splitPct: 45, // editor width % (resizable)
  wrap: true,  // editor soft-wrap (line-number gutter only makes sense when nowrap)
  diff: null,  // git diff view: {ok, rel, diff, adds, dels} | {ok:false, reason} | null
  structure: null, // {ok, include_keys, chapters:[{key,dir,shell,sections}], section_capable}
})
const patch = (p) => ui.set({ ...ui.get(), ...p })

// img cache
const imgCache = new Map()
const IMG_CACHE_MAX = 48
function cachePut(key, v) { if (imgCache.size >= IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value); imgCache.set(key, v) }

// ---------------------------------------------------------------- styling
const btn = 'rounded-md border border-(--ui-stroke-secondary) px-2 py-[3px] text-[0.72rem] leading-snug text-(--ui-text-secondary) hover:bg-black/10 disabled:opacity-40'
const accent = 'text-(--ui-accent)'

// ---- injected stylesheet ---------------------------------------------------
// 打包 app 的 Tailwind CSS 是预编译的，不扫描磁盘插件源码 —— plugin.js 里写的
// neutral-*/blue-* 等 utility class 在运行时根本不存在（透明底的根源）。
// 因此弹窗/下拉的视觉样式全部走注入的 <style>，不依赖任何 Tailwind class。
const LS_STYLE_ID = 'latex-studio-plugin-style'
// 全量 CSS 注入：模块加载时执行一次 + 面板组件每次渲染时执行（effect 双保险），
// style 元素驻留 head，内容必须总是覆盖为当前版本，否则热重载后新 class 无样式（9/23 踩坑）
function injectLspCss() {
  if (typeof document === 'undefined') return
  let st = document.getElementById(LS_STYLE_ID)
  if (!st) { st = document.createElement('style'); st.id = LS_STYLE_ID; document.head.appendChild(st) }
  st.textContent = `
.lsp-overlay{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center}
.lsp-dialog{display:flex;flex-direction:column;width:480px;max-height:76vh;overflow:hidden;border-radius:8px;border:1px solid #d4d4d4;background:#fff;box-shadow:0 25px 50px -12px rgba(0,0,0,.45);color:#262626}
.lsp-hd{display:flex;align-items:center;gap:6px;border-bottom:1px solid #e5e5e5;padding:8px 12px;background:#fff}
.lsp-title{font-size:12.5px;font-weight:600;color:#171717}
.lsp-bar{display:flex;align-items:center;gap:4px;border-bottom:1px solid #f0f0f0;padding:6px 8px;background:#fff}
.lsp-input{flex:1;min-width:0;border:1px solid #d4d4d4;border-radius:4px;background:#fff;color:#171717;padding:2px 6px;font-size:11px;outline:none}
.lsp-input:focus{border-color:#3b82f6}
.lsp-input::placeholder{color:#a3a3a3}
.lsp-path{padding:4px 12px;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:#737373;background:#fafafa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid #f0f0f0}
.lsp-list{flex:1;min-height:220px;overflow:auto;background:#fff;padding:4px 0}
.lsp-row{display:flex;align-items:center;gap:6px;padding:4px 12px}
.lsp-recent{border-bottom:1px solid var(--ui-stroke-secondary,#ddd);max-height:176px;overflow:auto;padding:4px 0}
.lsp-recent-hd{padding:2px 12px 4px;font-size:0.66rem;color:var(--ui-text-quaternary,#999)}
.lsp-recent-path{margin-left:auto;opacity:.45;font-size:0.62rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.lsp-help{max-width:min(560px,92vw)}
.lsp-help-body{max-height:min(420px,60vh);overflow:auto;padding:6px 14px 10px;background:#fff}
.lsp-prompt{display:grid;grid-template-columns:1fr auto;gap:2px 8px;align-items:center;border:1px solid #eee;border-radius:6px;padding:6px 8px;margin:5px 0}
.lsp-prompt-label{grid-column:1;font-size:0.66rem;font-weight:600;color:#333}
.lsp-prompt-copy{grid-row:1/3;grid-column:2;align-self:center}
.lsp-prompt-text{grid-column:1;font-size:0.62rem;color:#666;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lsp-row:hover{background:#eff6ff}
.lsp-name{flex:1;min-width:0;font-size:11.5px;color:#171717;text-align:left;background:none;border:0;padding:0;cursor:pointer;display:flex;align-items:center;gap:6px;overflow:hidden}
.lsp-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lsp-tex{flex-shrink:0;border:1px solid #93c5fd;background:#eff6ff;color:#2563eb;border-radius:4px;padding:0 4px;font-size:9.5px}
.lsp-btn{border:1px solid #d4d4d4;background:#fff;color:#404040;border-radius:6px;padding:3px 8px;font-size:11.5px;line-height:1.3;cursor:pointer}
.lsp-btn:hover{background:#f5f5f5}
.lsp-btn:disabled{opacity:.4;cursor:default;background:#fff}
.lsp-primary{border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:6px;padding:3px 10px;font-size:11.5px;line-height:1.3;cursor:pointer}
.lsp-primary:hover{background:#1d4ed8}
.lsp-primary:disabled{opacity:.4;cursor:default}
.lsp-ft{display:flex;align-items:center;gap:6px;border-top:1px solid #e5e5e5;background:#fafafa;padding:8px 12px}
.lsp-hint{font-size:10px;color:#a3a3a3}
.lsp-sp{flex:1}
.lsp-empty{padding:24px 12px;text-align:center;font-size:11px;color:#a3a3a3}
.lsp-open{border:1px solid #d4d4d4;background:#fff;color:#404040;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;visibility:hidden;flex-shrink:0}
.lsp-row:hover .lsp-open{visibility:visible}
.lst-dd{position:absolute;left:0;top:100%;z-index:50;margin-top:4px;max-height:70vh;width:320px;overflow:auto;border-radius:6px;border:1px solid #d4d4d4;background:#fff;padding:4px 0;box-shadow:0 20px 25px -5px rgba(0,0,0,.25)}
.lst-dir{display:flex;width:100%;align-items:center;gap:4px;text-align:left;background:none;border:0;padding:3px 8px;font-size:11px;font-weight:500;color:#171717;cursor:pointer}
.lst-dir:hover{background:#f5f5f5}
.lst-file{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;background:none;border:0;padding:3px 8px;font-size:11px;color:#404040;cursor:pointer}
.lst-file:hover{background:#eff6ff}
.lst-file-active{color:#2563eb;font-weight:500}
.lst-editor{position:relative;flex:1;min-width:0;min-height:0}
.lst-hl,.lst-ta{margin:0;padding:8px;font-family:ui-monospace,Consolas,monospace;font-size:0.78rem;line-height:1.4;tab-size:4;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word}
.lst-hl .lrow{display:block}
.lst-gutter{position:relative;padding:8px 6px 8px 0;min-width:3.2em}
.lst-gutter>div{line-height:1.4;padding-right:6px}
.diff-line{white-space:pre-wrap;word-break:break-word;padding:0 8px}
.diff-add{background:#e6f4ea;color:#137333}
.diff-del{background:#fce8e6;color:#c5221f}
.diff-hunk{background:#eef;color:#3b5bdb;font-weight:600}
.diff-h{color:#8a8a8a;font-weight:600}
.diff-ctx{color:#404040}
.lsp-on{background:#2563eb;color:#fff !important}
.lst-hl{position:absolute;inset:0;overflow-x:hidden;overflow-y:scroll;pointer-events:none;color:#171717;background:transparent}
.lst-ta{position:absolute;inset:0;width:100%;height:100%;overflow-x:auto;overflow-y:scroll;border:0;outline:none;resize:none;background:transparent;color:transparent;caret-color:#171717}
.lst-ta::placeholder{color:#a3a3a3}
.lst-hl.nowrap,.lst-ta.nowrap{white-space:pre;word-break:normal;overflow-wrap:normal}
.lst-ta::selection{background:rgba(59,130,246,.25)}
.lst-hl .c{color:#8a8a8a;font-style:italic}
.lst-hl .env{color:#9333ea}
.lst-hl .cmd{color:#2563eb}
.lst-hl .sec{color:#1d4ed8;font-weight:700}
.lst-hl .math{color:#0d9488}
.lst-hl .brace{color:#c2410c}
.lst-hl .opt{color:#6b7280}
/* ---- TODO 面板（常驻 dock，编辑器下方）---- */
.lsp-todo-dock{display:flex;flex-direction:column;min-height:0;background:#f7f8fa;color:#1a1a1a;border-top:2px solid #c9ccd1;box-shadow:0 -3px 10px -4px rgba(0,0,0,.18)}
.lsp-todo-hd{display:flex;align-items:center;gap:8px;padding:8px 14px 7px;background:#fff;flex-shrink:0}
.lsp-todo-hd-title{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:#171717}
.lsp-todo-hd-ico{width:15px;height:15px;color:#2563eb}
.lsp-todo-count{font-size:11px;color:#6b7280;background:#f1f3f5;border:1px solid #e5e7eb;border-radius:999px;padding:1px 8px;line-height:1.5}
.lsp-todo-count b{color:#171717;font-weight:600}
.lsp-todo-mini{border:0;background:none;color:#9ca3af;font-size:11px;cursor:pointer;padding:3px 6px;border-radius:5px;line-height:1.3}
.lsp-todo-mini:hover{background:#f3f4f6;color:#374151}
.lsp-todo-collapse{border:1px solid #e5e7eb;background:#fff;color:#6b7280;width:22px;height:22px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.lsp-todo-collapse:hover{background:#f3f4f6;color:#111}
.lsp-todo-progress{height:3px;background:#eceef1;flex-shrink:0;overflow:hidden}
.lsp-todo-progress>div{height:100%;background:linear-gradient(90deg,#3b82f6,#2563eb);border-radius:0 2px 2px 0;transition:width .25s ease}
.lsp-todo-list{max-height:300px;overflow:auto;padding:7px 9px 8px;background:#f7f8fa;flex-shrink:0}
.lsp-todo-item{position:relative;display:flex;align-items:flex-start;gap:10px;margin:4px 1px;padding:8px 11px 8px 12px;border-radius:8px;background:#fff;border:1px solid #e8eaee;box-shadow:0 1px 2px rgba(16,24,40,.04);transition:border-color .12s,box-shadow .12s}
.lsp-todo-item:hover{border-color:#cfd8e3;box-shadow:0 2px 6px rgba(16,24,40,.07)}
.lsp-todo-item.done{background:#fafbfc;border-color:#eef0f3}
.lsp-todo-cb{appearance:none;-webkit-appearance:none;flex-shrink:0;margin-top:2px;width:16px;height:16px;border:1.5px solid #c6cbd4;border-radius:5px;background:#fff;cursor:pointer;position:relative;transition:all .12s}
.lsp-todo-cb:hover{border-color:#2563eb}
.lsp-todo-cb:checked{background:#2563eb;border-color:#2563eb}
.lsp-todo-cb:checked::after{content:"";position:absolute;left:4.2px;top:1.4px;width:4px;height:8px;border:solid #fff;border-width:0 1.8px 1.8px 0;transform:rotate(42deg)}
.lsp-todo-body{flex:1;min-width:0}
.lsp-todo-text{font-size:13px;color:#1f2937;line-height:1.5;word-break:break-word;white-space:pre-wrap}
.lsp-todo-item.done .lsp-todo-text{color:#9ca3af;text-decoration:line-through;text-decoration-color:#c9ced6}
.lsp-todo-loc{display:inline-flex;align-items:center;gap:4px;margin-top:5px;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:#4b5563;background:#f4f6f9;border:1px solid #e3e7ee;border-radius:5px;padding:1.5px 7px;cursor:pointer;transition:all .12s}
.lsp-todo-loc svg{width:10px;height:10px;color:#2563eb}
.lsp-todo-loc:hover{background:#e8f0fe;border-color:#bfdbfe;color:#1d4ed8}
.lsp-todo-del{flex-shrink:0;border:0;background:none;color:#c9ced6;font-size:13px;cursor:pointer;padding:2px 4px;line-height:1;border-radius:5px;opacity:0;transition:opacity .12s,color .12s,background .12s;margin-top:1px}
.lsp-todo-item:hover .lsp-todo-del{opacity:1}
.lsp-todo-item.done .lsp-todo-del{opacity:1}
.lsp-todo-del:hover{color:#ef4444;background:#fef2f2}
.lsp-todo-empty{padding:26px 16px 24px;text-align:center}
.lsp-todo-empty-ico{width:34px;height:34px;border-radius:50%;background:#eef2f7;color:#9aa4b2;display:flex;align-items:center;justify-content:center;margin:0 auto 8px}
.lsp-todo-empty-t{font-size:12.5px;color:#6b7280;font-weight:500}
.lsp-todo-empty-s{font-size:11px;color:#a3a3a3;margin-top:3px}
.lsp-todo-ctx{display:flex;align-items:center;gap:8px;margin:0 9px 7px;padding:7px 11px;border-radius:8px;background:linear-gradient(90deg,#eff6ff,#f5f9ff);border:1px solid #bfdbfe}
.lsp-todo-ctx-pin{width:14px;height:14px;color:#2563eb;flex-shrink:0}
.lsp-todo-ctx-txt{flex:1;min-width:0;border:0;background:none;text-align:left;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#1e40af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;padding:0}
.lsp-todo-ctx-txt:hover{text-decoration:underline}
.lsp-todo-ctx-x{border:0;background:none;color:#93b4e8;cursor:pointer;font-size:12px;padding:2px 4px;border-radius:4px;line-height:1}
.lsp-todo-ctx-x:hover{color:#2563eb;background:#dbeafe}
.lsp-todo-add{display:flex;padding:9px 12px;border-top:1px solid #e8eaee;background:#fff}
.lsp-todo-add-wrap{display:flex;align-items:center;gap:8px;flex:1;border:1px solid #dfe3e9;border-radius:8px;background:#fbfcfd;padding:2px 4px 2px 10px;transition:border-color .15s,box-shadow .15s,background .15s}
.lsp-todo-add-wrap:focus-within{border-color:#3b82f6;background:#fff;box-shadow:0 0 0 3px rgba(59,130,246,.13)}
.lsp-todo-add-ico{color:#9ca3af;display:flex;padding-left:2px}
.lsp-todo-input{flex:1;min-width:0;border:0;background:none;color:#1f2937;font-size:13px;outline:none;padding:6px 0}
.lsp-todo-input::placeholder{color:#a3a3a3}
.lsp-todo-add-btn{border:0;background:#2563eb;color:#fff;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;line-height:1.4}
.lsp-todo-add-btn:hover{background:#1d4ed8}
.lsp-annotate-on{outline:2px dashed #2563eb;outline-offset:1px;border-radius:4px}
.lsp-th-row{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid #eef0f3;cursor:pointer;background:#fafbfd}
.lsp-th-row:hover{background:#f3f6fb}
.lsp-th-row b{font-size:.8rem;color:#1f2937;white-space:nowrap}
.lsp-th-flag{color:#2563eb;display:flex}
.lsp-th-count{font-size:.7rem;color:#6b7280;white-space:nowrap}
.lsp-th-bar{flex:1;display:flex;height:6px;border-radius:4px;overflow:hidden;background:#f3f4f6;border:1px solid #e5e7eb;min-width:48px}
.lsp-th-bar i{display:block;height:100%}
.lsp-th-bar .seg-todo{background:#d1d5db}
.lsp-th-bar .seg-doing{background:#3b82f6}
.lsp-th-bar .seg-done{background:#22c55e}
.lsp-th-open{font-size:.68rem;color:#2563eb;white-space:nowrap}
.lsp-th-overlay{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:56%;height:60%;z-index:60;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 18px 50px rgba(15,23,42,.22);display:flex;flex-direction:column;overflow:hidden}
.lsp-th-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #eef0f3}
.lsp-th-head b{font-size:.86rem;color:#111827}
.lsp-th-hint{font-size:.7rem;color:#9ca3af;flex:1}
.lsp-th-x{border:0;background:none;font-size:.8rem;color:#6b7280;cursor:pointer;padding:2px 6px;border-radius:4px}
.lsp-th-x:hover{background:#f3f4f6;color:#111827}
.lsp-th-cols{flex:1;display:flex;gap:10px;padding:10px 14px 14px;overflow:auto}
.lsp-th-col{flex:1;display:flex;flex-direction:column;gap:8px;background:#f8fafc;border:1px solid #eef0f3;border-radius:8px;padding:8px;min-width:0}
.lsp-th-col.over{border-color:#3b82f6;background:#eff6ff}
.lsp-th-col-hd{display:flex;align-items:center;gap:6px;font-size:.74rem;font-weight:600;padding:2px 4px 6px}
.lsp-th-col-hd.st-todo{color:#6b7280}
.lsp-th-col-hd.st-doing{color:#2563eb}
.lsp-th-col-hd.st-done{color:#16a34a}
.lsp-th-n{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:0 6px;font-size:.66rem;color:#6b7280}
.lsp-th-col-list{display:flex;flex-direction:column;gap:8px;overflow:auto}
.lsp-th-card{background:#fff;border:1px solid #e8eaee;border-radius:8px;padding:8px 9px;cursor:grab;box-shadow:0 1px 2px rgba(15,23,42,.05)}
.lsp-th-card:active{cursor:grabbing}
.lsp-th-card.drop-on{border-top:2px solid #3b82f6}
.lsp-th-card-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:2px}
.lsp-th-card-hd b{font-size:.72rem;color:#2563eb}
.lsp-th-exp{border:0;background:none;color:#9ca3af;cursor:pointer;font-size:.66rem;padding:0 2px}
.lsp-th-exp:hover{color:#2563eb}
.lsp-th-card-t{font-size:.76rem;color:#1f2937;font-weight:600;line-height:1.4;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.lsp-th-card-d{margin-top:4px;font-size:.7rem;color:#6b7280;line-height:1.5;white-space:pre-wrap;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.lsp-th-card-d.open{-webkit-line-clamp:unset;display:block}
.lsp-th-add-wrap{display:flex;gap:6px}
.lsp-th-add-input{flex:1;min-width:0;border:1px solid #e5e7eb;border-radius:6px;padding:5px 8px;font-size:.72rem;outline:none;background:#fff}
.lsp-th-add-input:focus{border-color:#3b82f6}
.lsp-th-add-btn{border:0;background:#2563eb;color:#fff;border-radius:6px;padding:5px 10px;font-size:.72rem;cursor:pointer;white-space:nowrap}
.lsp-th-add-btn:hover{background:#1d4ed8}
`
}
injectLspCss()

// ---------------------------------------------------------------- file tree builder
function buildTree(files) {
  // flat [{rel,size,mtime}] → nested tree with dirs-first sort
  const tree = { name: '', children: [] }
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const parts = f.rel.split('/')
    let cur = tree
    for (let i = 0; i < parts.length - 1; i++) {
      let child = cur.children.find(c => c.name === parts[i] && !c.isFile)
      if (!child) { child = { name: parts[i], children: [], isFile: false }; cur.children.push(child) }
      cur = child
    }
    const fname = parts[parts.length - 1]
    if (!cur.children.find(c => c.name === fname && c.isFile)) {
      cur.children.push({ name: fname, isFile: true, rel: f.rel, size: f.size })
    }
  }
  // sort dirs first then files alphabetically (leaves have no children)
  function sortNode(n) { if (!n.children) return; n.children.sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : !a.isFile ? -1 : 1)) ; n.children.forEach(sortNode) }
  sortNode(tree)
  return tree
}

// ---------------------------------------------------------------- dir picker (browse mode)
// ---------------------------------------------------------------- help dialog
// 话术一句指令 + 当前章路径，复制即用。拆分粒度=整章全拆（规程在 latex-split-merge skill）
function helpPrompts() {
  const s = ui.get()
  const f = s.file ? String(s.file).replace(/\\/g, '/') : ''
  const st = s.structure || {}
  // 当前文件所在（或对应的）章壳路径
  let chap = f.replace(/\.tex$/i, '')
  const hit = (st.chapters || []).find(c => c.dir && chap !== c.shell && chap.startsWith(c.dir + '/'))
  if (hit) chap = hit.shell
  const cur = f ? `「${chap}.tex」` : '目标章文件'
  return [
    ['整章拆成节 · hybrid（推荐，main.tex 不动）', `用 latex-split-merge skill，把${cur}整章按 \\section 全拆成节（hybrid）。`],
    ['整章拆成节 · folder（章文件夹自包含）', `用 latex-split-merge skill，把${cur}整章按 \\section 全拆成节（folder 布局）。`],
    ['合回扁平', `用 latex-split-merge skill，把${cur}对应的章文件夹合回扁平章文件。`],
    ['全工程拆成节', '用 latex-split-merge skill，把 main.tex 里所有章节整章拆成节（hybrid）。'],
  ]
}

function HelpDialog({ onClose }) {
  const [skill, setSkill] = useState(null)
  const [installing, setInstalling] = useState(false)
  const loadSkill = useCallback(() => { rest('/skill').then(setSkill).catch(() => setSkill({ installed: false, bundled: false, offline: true })) }, [])
  useEffect(() => {
    loadSkill()
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const install = useCallback(async () => {
    setInstalling(true)
    try {
      const r = await rest('/skill-install', { method: 'POST', body: {} })
      host.notify({ kind: 'success', message: r.already ? 'skill 已在' : 'skill 已安装', detail: r.path + ' · 新对话里即可按名字引用（本会话可能要重开才索引到）。' })
      loadSkill()
    } catch (e) { host.notify({ kind: 'error', message: '安装失败：' + fmtErr(e) }) } finally { setInstalling(false) }
  }, [])

  const copy = useCallback(async (text) => {
    let ok = false
    try { ok = await api.os.writeClipboard(text) } catch { /* no os door */ }
    if (!ok) { try { await navigator.clipboard.writeText(text); ok = true } catch { /* fallback below */ } }
    if (!ok) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy') } catch {} ta.remove() }
    host.notify(ok ? { kind: 'success', message: '话术已复制，粘贴给 AI 即可' } : { kind: 'warning', message: '复制失败，请手动选中文字' })
  }, [])

  const h3 = { fontSize: '0.72rem', fontWeight: 600, margin: '10px 0 4px' }
  const li = { fontSize: '0.68rem', lineHeight: 1.55, color: 'var(--ui-text-secondary,#333)' }
  const code = { fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '0.64rem', background: '#f5f5f5', borderRadius: 4, padding: '6px 8px', whiteSpace: 'pre', overflowX: 'auto', display: 'block', margin: '4px 0' }
  return jsx('div', { className: 'lsp-overlay', onClick: onClose, children:
    jsxs('div', { className: 'lsp-dialog lsp-help', onClick: e => e.stopPropagation(), children: [
      jsxs('div', { className: 'lsp-hd', children: [
        jsx('span', { className: 'lsp-title', children: 'LaTeX Studio · 按章 / 按节编译指南' }),
        jsx('span', { className: 'lsp-sp' }),
        jsx('button', { type: 'button', className: 'lsp-btn', title: '关闭 (Esc)', onClick: onClose, children: '✕' }),
      ] }),
      jsx('div', { className: 'lsp-help-body', children: [
        jsx('div', { style: h3, children: '编译粒度怎么来的' }),
        jsx('ul', { style: { margin: 0, paddingLeft: '1.2em' }, children: [
          jsx('li', { style: li, children: '编译预览 = 全量（main.pdf，最终页码以它为准）' }),
          jsx('li', { style: li, children: '本章 = \\includeonly 只排当前章（main_partial.pdf，保留风格/编号/引用）' }),
          jsx('li', { style: li, children: '本节 = 只排当前节（main_partial_section.pdf）。需要章节文件夹结构才会出现此按钮' }),
          jsx('li', { style: li, children: '部分编译页码 ≠ 最终页码：写绝对页码、盲审、送印前必须全量编译' }),
        ] }),
        jsx('div', { style: h3, children: '方式一 · hybrid（推荐，main.tex 不用改）' }),
        jsx('code', { style: code, children:
          'main.tex           \\include{chapters/3-swmt}\n' +
          'chapters/3-swmt.tex        ← 壳：只放 \\chapter + \\input\n' +
          'chapters/3-swmt/3-1.tex    ← 节\n' +
          'chapters/3-swmt/3-2.tex' }),
        jsx('div', { style: li, children: '要求：存在 chapters/3-swmt.tex 且同名文件夹 3-swmt/ 里有节 .tex；壳内 \\input 写根相对路径。' }),
        jsx('div', { style: h3, children: '方式二 · folder（章文件夹自包含）' }),
        jsx('code', { style: code, children:
          'main.tex           \\include{chapters/3/chapter}\n' +
          'chapters/3/chapter.tex     ← 壳（也可叫 ch/main/index 或与文件夹同名）\n' +
          'chapters/3/3-1.tex ...\u3000\u3000← 节' }),
        jsx('div', { style: h3, children: '让 AI 帮你拆 / 合 —— 复制一句粘贴到对话（细节规程都在 skill 里；AI 没装 skill 会先提示装）' }),
        helpPrompts().map(([label, text]) => jsxs('div', { className: 'lsp-prompt', children: [
          jsx('div', { className: 'lsp-prompt-label', children: label }),
          jsx('div', { className: 'lsp-prompt-text', children: text }),
          jsx('button', { type: 'button', className: 'lsp-btn lsp-prompt-copy', onClick: () => copy(text), children: '复制' }),
        ] }, label)),
        jsx('div', { style: h3, children: '拆分指南 skill（latex-split-merge）' }),
        skill ? (skill.installed
          ? jsxs('div', { style: li, children: ['✅ 已安装：', skill.path || ''] })
          : skill.bundled
            ? jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [
                jsx('span', { style: li, children: '未安装。安装后 AI 按「拆分/合并」话术干活时有完整规程（先 git、后编译验证）。' }),
                jsx('span', { className: 'lsp-sp' }),
                jsx('button', { type: 'button', className: 'lsp-primary', disabled: installing, onClick: install, children: installing ? '安装中…' : '安装 skill' }),
              ] })
            : jsx('div', { style: li, children: '后端未加载 /skill 端点 —— 完全退出并重开 Hermes Desktop 后可用。' })
        ) : jsx('div', { style: li, children: '检查安装状态中…' }),
      ] }),
      jsxs('div', { className: 'lsp-ft', children: [
        jsx('span', { className: 'lsp-hint', children: 'Esc 关闭 · 话术复制到剪贴板' }),
        jsx('span', { className: 'lsp-sp' }),
        jsx('button', { type: 'button', className: 'lsp-btn', onClick: onClose, children: '关闭' }),
      ] }),
    ] }) })
}

function DirPicker({ onPick, onClose }) {
  const [recent, setRecent] = useState(() => recentGet())
  const [cwd, setCwd] = useState('')
  const [parent, setParent] = useState(null)
  const [dirs, setDirs] = useState([])
  const [busy, setBusy] = useState(false)
  const [jump, setJump] = useState('')

  const load = useCallback(async (p) => {
    setBusy(true)
    try {
      const r = await rest(`/dirs?path=${encodeURIComponent(p || '')}`)
      setCwd(r.path || ''); setParent(r.parent); setDirs(r.dirs || [])
    } catch (e) {
      const msg = fmtErr(e)
      const stale = /404|web UI disabled|not found/i.test(msg)
      host.notify({ kind: 'error', message: stale ? '后端未加载 /dirs 端点 —— 请完全退出并重开 Hermes Desktop' : '无法列出目录：' + msg, durationMs: 10000 })
    }
    finally { setBusy(false) }
  }, [])

  useEffect(() => {
    const s = ui.get()
    load(s.root || host.state.cwd.get() || '')
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return jsx('div', { className: 'lsp-overlay', onClick: onClose, children:
    jsxs('div', { className: 'lsp-dialog', onClick: e => e.stopPropagation(), children: [
      // header
      jsxs('div', { className: 'lsp-hd', children: [
        jsx('span', { className: 'lsp-title', children: '打开 LaTeX 工程' }),
        jsx('span', { className: 'lsp-sp' }),
        jsx('button', { type: 'button', className: 'lsp-btn', title: '关闭 (Esc)', onClick: onClose, children: '✕' }),
      ] }),
      // path bar: up + home + jump input
      jsxs('div', { className: 'lsp-bar', children: [
        jsx('button', { type: 'button', className: 'lsp-btn', disabled: busy || parent === null && !cwd, title: '上一级', onClick: () => load(parent || ''), children: '↑' }),
        jsx('button', { type: 'button', className: 'lsp-btn', disabled: busy, title: '驱动器列表', onClick: () => load(''), children: cwd ? '⌂' : '💻' }),
        jsx('input', { type: 'text', placeholder: '粘贴路径后回车跳转…', value: jump, onChange: e => setJump(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && jump.trim()) { load(jump.trim()); setJump('') } }, className: 'lsp-input' }),
      ] }),
      // recent projects (MRU, ≤8)
      recent.length ? jsxs('div', { className: 'lsp-recent', children: [
        jsx('div', { className: 'lsp-recent-hd', children: '最近打开' }),
        recent.map(rt => jsxs('div', { className: 'lsp-row', children: [
          jsx('button', { type: 'button', className: 'lsp-name', onClick: () => load(rt), title: rt + '\n单击浏览 · 双击打开工程', children: [
            jsx('span', { style: { flexShrink: 0 }, children: '🕘' }),
            jsx('span', { children: String(rt).split(/[\\/]/).pop() }),
            jsx('span', { className: 'lsp-recent-path', children: rt }),
          ] }),
          jsx('button', { type: 'button', className: 'lsp-open', onClick: () => onPick(rt), title: '打开此工程', children: '打开' }),
        ] }, 'r_' + rt)),
      ] }) : null,
      // current path
      jsx('div', { className: 'lsp-path', title: cwd, children: cwd || '（驱动器）' }),
      // dir list
      jsx('div', { className: 'lsp-list', children: busy
        ? jsx('div', { className: 'lsp-empty', children: '加载中…' })
        : (dirs.length ? dirs.map(d => jsxs('div', { className: 'lsp-row', children: [
            jsx('button', { type: 'button', className: 'lsp-name', onClick: () => load(d.path), onDoubleClick: () => onPick(d.path), title: d.path + '\n单击进入 · 双击打开工程', children: [
              jsx('span', { style: { flexShrink: 0 }, children: '📁' }),
              jsx('span', { children: d.name }),
              d.has_tex ? jsx('span', { className: 'lsp-tex', children: 'TeX' }) : null,
            ] }),
            jsx('button', { type: 'button', className: 'lsp-open', onClick: () => onPick(d.path), title: '打开此工程', children: '打开' }),
          ] }, 'd_' + d.path))
          : jsx('div', { className: 'lsp-empty', children: '（无子目录）' })) }),
      // footer
      jsxs('div', { className: 'lsp-ft', children: [
        jsx('span', { className: 'lsp-hint', children: '单击进入 · 双击/「打开」选择工程' }),
        jsx('span', { className: 'lsp-sp' }),
        jsx('button', { type: 'button', className: 'lsp-btn', onClick: onClose, children: '取消' }),
        jsx('button', { type: 'button', className: 'lsp-primary', disabled: !cwd || busy, onClick: () => onPick(cwd), children: '打开当前目录' }),
      ] }),
    ] }) })
}

// ---------------------------------------------------------------- todo panel（常驻，编辑器下方）
// 待办：按条陈列，可勾选完成、删除；每条可带「位置」(file:line)，点位置跳编辑器。
// 数据持久化：待办 + 论文推进 存到 <工程>/todo.md（JSON 代码块），拷贝/git 工程即带走；
// 旧插件 storage 数据在首次打开工程时自动迁入并落盘；未开工程时仍用 storage。
// 面板默认常驻在编辑器下方，工具栏「待办」按钮可收起/展开。
const NOTES_FILE = 'todo.md'
let notesRoot = ''
let notesData = { todos: [], board: [] }
function notesPersist() {
  if (!notesRoot) return
  const text = '# LaTeX Studio 待办与论文推进（插件自动维护，手改会被覆盖）\n\n```json\n' + JSON.stringify(notesData, null, 2) + '\n```\n'
  rest('/save', { method: 'POST', body: { path: notesRoot + '/' + NOTES_FILE, text, root: notesRoot } }).catch(() => {})
}
function seedBoard() { return THESIS_SEED.map((t, i) => ({ id: 'th' + (i + 1), code: t.code, title: t.title, desc: t.desc, status: 'todo' })) }
async function notesLoad(root) {
  notesRoot = String(root).replace(/[\\/]+$/, '')
  let loaded = null
  try {
    const r = await rest(`/read?path=${encodeURIComponent(notesRoot + '/' + NOTES_FILE)}`)
    const m = String(r.text || '').match(/```json\s*([\s\S]*?)```/)
    const j = JSON.parse(m ? m[1] : r.text)
    if (j && (Array.isArray(j.todos) || Array.isArray(j.board))) loaded = j
  } catch {}
  if (loaded) {
    notesData = { todos: loaded.todos || [], board: loaded.board || [] }
  } else {
    // 首次：从旧插件 storage 迁入（看板没有就用种子），并立即落盘到工程
    let t = [], b = null
    try { t = (api && api.storage && api.storage.get('todos', [])) || [] } catch {}
    try { b = api && api.storage && api.storage.get('thesisBoard', null) } catch {}
    notesData = { todos: Array.isArray(t) ? t : [], board: Array.isArray(b) && b.length ? b : seedBoard() }
    notesPersist()
  }
  if (!notesData.board.length) { notesData.board = seedBoard(); notesPersist() }
  patch({ todos: notesData.todos, board: notesData.board })
}
function todosGet() { if (notesRoot) return notesData.todos; try { return (api && api.storage && api.storage.get('todos', [])) || [] } catch { return [] } }
function todosSet(list) {
  if (notesRoot) { notesData.todos = list; notesPersist() }
  else { try { api && api.storage && api.storage.set('todos', list) } catch {} }
  patch({ todos: list })
}

// 全局待办：论文推进看板（种子 = 推进计划-20260920.md 的 T1-T15；状态存 api.storage，看板里拖改）
const THESIS_SEED = [
  { code: 'T1', title: '通读 ch1+ch2+前置', desc: '绪论+框架是全文口径的"总闸"，先验收这里，后面 ch3-5 的验收标准才立得住。只判不改，产出问题清单（台账）。' },
  { code: 'T2', title: 'evidencexport 立项挂后台', desc: '唯一解锁 ch6 数据链的任务，今天挂后台，此后不占注意力。' },
  { code: 'T3', title: '关 ch1 两个 TODO（1.2重组/1.3顺序）', desc: '1.2 重组为"承诺—共识—验证"三子问题、1.3 综述顺序锁定。依据 T1 的问题清单动手，改完跑验证管线+commit。' },
  { code: 'T4', title: '关 ch2 四个 TODO（导师意见3/4/5）', desc: '新增"状态一致性问题分析"小节、总体框架/架构二选一、2.3-2.7 补引导句。T3+T4 做完，全文骨架不再变——这是重绘框架图的发令枪。' },
  { code: 'T5', title: '重绘概念/架构/流程图', desc: 'ch2框架图 + ch3/4/5 核心概念图（机制示意、流程图），统一风格重制。可与 T6-T8 并行。依赖 T3+T4 结构定稿。' },
  { code: 'T6', title: 'ch3 SWMT 验收式改写', desc: '对照 SIGMOD 原文逐节认账/改写，关A-，扩写机制与证明。' },
  { code: 'T7', title: 'ch4 Symphony 验收式改写', desc: '同 T6，另补对 ch3 的依赖段（现在读起来像独立论文）。' },
  { code: 'T8', title: 'ch5 Fountain 验收式改写', desc: '同 T6，另定死验证边界（TODO-FTN-INT-001：不能声称验证节点重算SWMT/MPT状态根）。T8 的边界口径是 T9 的前提。' },
  { code: 'T9', title: 'ch6 设计类改写（APP-007~010＋意见6/7/8）', desc: '复合状态承诺设计（定义+正确性论证+验证路径）、导师意见6/7/8（6.2重构、6.3/6.4分工、"为例"代表性论证）。依赖 T8 边界。' },
  { code: 'T10', title: 'S组实验执行', desc: 'evidencexport 就绪后，FISCO 3.x/Fabric 2.5/Fountain 按 §9 已批口径跑同序列负载。红线：增量持久化前只报字节量与端到端指标。依赖 T2 交付。' },
  { code: 'T11', title: 'ch6 数据回填＋实验图统一重画', desc: '关 APP-001~006、011~015 中所有等数据的 TODO；ch6 新图 + ②类旧实验图统一重画（T5 定下的风格模板套用）。' },
  { code: 'T12', title: 'ch7 写实＋ch6 适用边界', desc: '写 ch7 总结（61行骨架→成文）+ ch6 适用边界与失效场景。' },
  { code: 'T13', title: '摘要/创新点/绪论首尾最后重写', desc: '永远最后写——它们是对全文的承诺，前面每章验收都可能改口径。创新点链式+每贡献一硬数字。' },
  { code: 'T14', title: '成果列表/致谢/符号表/appendix 等格式件', desc: '成果列表核对（TODO-ACH-001/002/003，含盲审匿名版）、致谢、符号表统一过一遍、appendix.tex 挂接、audit-bibliography。' },
  { code: 'T15', title: '终检：冻结送审版', desc: '全书 review 记号=0 → 重跑 9/17"拼盘vs链条"体检全绿 → latexmk 全量编译 0 悬空引用 → 冻结送审版 commit + 归档 PDF。' },
]
function boardGet() {
  if (notesRoot) return notesData.board
  try {
    const v = api && api.storage && api.storage.get('thesisBoard', null)
    if (v && v.length) return v
    const seeded = seedBoard()
    if (api && api.storage) api.storage.set('thesisBoard', seeded)
    return seeded
  } catch { return [] }
}
function boardSet(list) {
  if (notesRoot) { notesData.board = list; notesPersist() }
  else { try { api && api.storage && api.storage.set('thesisBoard', list) } catch {} }
  patch({ board: list })
}

let todoSeq = 0
function newTodoId() { const d = new Date(); return 't' + d.getTime().toString(36) + (todoSeq++).toString(36) }

// PDF 点击反查 → 预填位置：写入 atom.todoAnnotate，并自动展开面板（见 onAnnotateClick）

function TodoPanel() {
  const s = useValue(ui)
  const [list, setList] = useState(() => todosGet())
  const [draft, setDraft] = useState('')
  const ctx = s.todoAnnotate
  const board = (s.board && s.board.length ? s.board : boardGet()) // 看板走 ui 镜像（工程 todo.md 异步加载后会 patch 进来）
  const setBoard = (fn) => { const next = typeof fn === 'function' ? fn(board) : fn; boardSet(next) }
  const [boardOpen, setBoardOpen] = useState(false)
  const [dragOver, setDragOver] = useState('')
  const [expanded, setExpanded] = useState({})
  const boardCounts = { todo: 0, doing: 0, done: 0 }
  board.forEach(i => { boardCounts[i.status] = (boardCounts[i.status] || 0) + 1 })
  const moveItem = (id, status) => setBoard(prev => {
    const drag = prev.find(i => i.id === id)
    if (!drag) return prev
    const moved = { ...drag, status }
    const rest = prev.filter(i => i.id !== id)
    let idx = -1
    rest.forEach((it, k) => { if (it.status === status) idx = k })
    const next = idx >= 0 ? [...rest.slice(0, idx + 1), moved, ...rest.slice(idx + 1)] : [...rest, moved]
    boardSet(next)
    return next
  })
  const [dropOn, setDropOn] = useState('')
  const reorderMove = (dragId, targetId) => {
    if (dragId === targetId) return
    setBoard(prev => {
      const target = prev.find(i => i.id === targetId)
      const drag = prev.find(i => i.id === dragId)
      if (!target || !drag) return prev
      const moved = { ...drag, status: target.status }
      const rest = prev.filter(i => i.id !== dragId)
      const idx = rest.findIndex(i => i.id === targetId)
      const next = [...rest.slice(0, idx), moved, ...rest.slice(idx)]
      boardSet(next)
      return next
    })
  }
  const [boardDraft, setBoardDraft] = useState('')
  const addBoardItem = () => {
    const t = boardDraft.trim()
    if (!t) return
    const maxN = Math.max(0, ...board.map(i => parseInt(String(i.code || '').replace(/^[Tt]/, ''), 10) || 0))
    const next = [...board, { id: 'th' + Date.now().toString(36), code: 'T' + (maxN + 1), title: t, desc: '', status: 'todo' }]
    setBoard(next); boardSet(next); setBoardDraft('')
  }
  const toggleExp = (id) => setExpanded(p => ({ ...p, [id]: !p[id] }))
  useEffect(() => {
    if (!boardOpen) return
    const onKey = (e) => { if (e.key === 'Escape') setBoardOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [boardOpen]) // 预填的位置上下文（来自 PDF 点击）

  const commit = (next) => { setList(next); todosSet(next); patch({ todos: next }) } // 同步镜像，工具栏计数实时更新

  const addTodo = () => {
    const text = draft.trim()
    if (!text && !ctx) return
    const item = { id: newTodoId(), text: text || '（PDF 标注）', done: false, ts: Date.now() }
    if (ctx) item.loc = { file: ctx.file, line: ctx.line, page: ctx.page, label: ctx.label || '', needle: ctx.needle || '', anchorFile: ctx.anchorFile || '' }
    commit([item, ...list])
    setDraft('')
    patch({ todoAnnotate: null }) // 用掉预填位置
  }

  const toggle = (id) => commit(list.map(t => t.id === id ? { ...t, done: !t.done } : t))
  const remove = (id) => commit(list.filter(t => t.id !== id))

  const gotoLoc = async (loc) => {
    if (!loc || !loc.file) return
    const st = ui.get()
    const root = normPath(st.root)
    let rel = cleanTexPath(loc.file)
    if (rel.toLowerCase().startsWith(root.toLowerCase())) rel = rel.slice(root.length + 1)
    // 优先按锚点（\label 或章节命令）现查所在行；锚点在父文件时跳父文件对应小节
    let targetRel = rel, line = loc.line || 0
    if (loc.needle) {
      const anchorRel = loc.anchorFile ? cleanTexPath(loc.anchorFile) : rel
      const anchorAbs = isAbsPath(anchorRel) ? anchorRel : root + '/' + anchorRel
      const l = await anchorLine(anchorAbs, loc.needle)
      if (l) { targetRel = anchorRel; line = l }
    }
    const abs = isAbsPath(targetRel) ? targetRel : root + '/' + targetRel
    // 目标就是当前打开的文件：直跳行，不重载（不触发 dirty 拦截）
    const cur = normPath(st.file || '')
    if (cur && cur.toLowerCase() === abs.toLowerCase() && editorJumpFn) { editorJumpFn(line || 1); return }
    openFile(targetRel, line)
  }

  const doneCount = list.filter(t => t.done).length
  const pct = list.length ? Math.round(doneCount / list.length * 100) : 0
  const clearDone = () => commit(list.filter(t => !t.done))
  const svgLine = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
  // SVG 必须自带 width/height 属性兜底：class 的 CSS 尺寸一旦缺席（样式未注入），
  // 无约束 SVG 会按默认尺寸撑满容器（9/23 巨大图标的根因）
  const pinSvg = (cls, w) => jsx('svg', { className: cls, width: w || 14, height: w || 14, viewBox: '0 0 24 24', ...svgLine, children: [
    jsx('path', { d: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z' }),
    jsx('circle', { cx: 12, cy: 10, r: 3 }),
  ] })
  const checkSvg = (cls, w) => jsx('svg', { className: cls, width: w || 15, height: w || 15, viewBox: '0 0 24 24', ...svgLine, children: [
    jsx('path', { d: 'M9 11l3 3L22 4' }),
    jsx('path', { d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' }),
  ] })
  return jsxs('div', { className: 'lsp-todo-dock', children: [
    // 全局待办：论文推进（总体进度条，点击展开大看板）
    jsxs('div', { className: 'lsp-th-row', title: '点击展开论文推进看板', onClick: () => setBoardOpen(true), children: [
      jsx('span', { className: 'lsp-th-flag', children: jsx('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', children: jsx('path', { d: 'M4 22V4c0-1 1-2 2-2h9l5 5v15c0 1-1 2-2 2H4z' }) }) }),
      jsx('b', { children: '论文推进' }),
      jsx('span', { className: 'lsp-th-count', children: `${boardCounts.done}/${board.length} 已结束` }),
      jsx('div', { className: 'lsp-th-bar', children: [
        jsx('i', { className: 'seg-todo', style: { width: (boardCounts.todo / Math.max(1, board.length) * 100) + '%' } }),
        jsx('i', { className: 'seg-doing', style: { width: (boardCounts.doing / Math.max(1, board.length) * 100) + '%' } }),
        jsx('i', { className: 'seg-done', style: { width: (boardCounts.done / Math.max(1, board.length) * 100) + '%' } }),
      ] }),
      jsx('span', { className: 'lsp-th-open', children: '看板 ▾' }),
    ] }),
    // 头部：图标 + 标题 + 计数胶囊 + 清除已完成 + 收起
    jsxs('div', { className: 'lsp-todo-hd', children: [
      jsxs('span', { className: 'lsp-todo-hd-title', children: [checkSvg('lsp-todo-hd-ico'), '待办'] }),
      list.length ? jsxs('span', { className: 'lsp-todo-count', children: [jsx('b', { children: doneCount }), `/${list.length} 完成`] }) : null,
      jsx('span', { className: 'lsp-sp' }),
      doneCount ? jsx('button', { type: 'button', className: 'lsp-todo-mini', title: '清除所有已完成条目', onClick: clearDone, children: '清除已完成' }) : null,
      jsx('button', { type: 'button', className: 'lsp-todo-collapse', title: '收起待办面板（工具栏「待办」可再展开）', onClick: () => patch({ todoOpen: false }), children: jsx('svg', { width: 11, height: 11, viewBox: '0 0 24 24', ...svgLine, children: jsx('path', { d: 'M6 9l6 6 6-6' }) }) }),
    ] }),
    // 完成度进度条（有条目时才显示）
    list.length ? jsx('div', { className: 'lsp-todo-progress', children: jsx('div', { style: { width: pct + '%' } }) }) : null,
    // PDF 预填位置条：图钉 + 单行上下文（点击跳原文，✕ 放弃关联）
    ctx ? jsxs('div', { className: 'lsp-todo-ctx', children: [
      pinSvg('lsp-todo-ctx-pin'),
      jsxs('button', { type: 'button', className: 'lsp-todo-ctx-txt', onClick: () => gotoLoc(ctx), title: (ctx.context ? ctx.context + '\n' : '') + '点击跳到该位置', children: [`${String(ctx.file).split(/[\\/]/).pop()} · L${ctx.line}`, ctx.label ? ` · #${ctx.label}` : '', ctx.page ? ` · p${ctx.page}` : '', ctx.context ? ` —— ${ctx.context}` : ''] }),
      jsx('button', { type: 'button', className: 'lsp-todo-ctx-x', title: '不关联此位置', onClick: () => patch({ todoAnnotate: null }), children: '✕' }),
    ] }) : null,
    // 列表：最多显示 6 条，超出滚动（.lsp-todo-list max-height ≈ 6 行）
    jsx('div', { className: 'lsp-todo-list', children: list.length ? list.map(t => jsxs('div', { className: 'lsp-todo-item' + (t.done ? ' done' : ''), children: [
      jsx('input', { type: 'checkbox', className: 'lsp-todo-cb', checked: !!t.done, onChange: () => toggle(t.id) }),
      jsxs('div', { className: 'lsp-todo-body', children: [
        jsx('div', { className: 'lsp-todo-text', children: t.text || '（空）' }),
        t.loc ? jsxs('button', { type: 'button', className: 'lsp-todo-loc', onClick: () => gotoLoc(t.loc), title: locTitle(t.loc), children: [pinSvg(null), String(t.loc.file).split(/[\\/]/).pop(), t.loc.label ? ' · #' + t.loc.label : (t.loc.line ? ' · L' + t.loc.line : ''), t.loc.page ? ' · p' + t.loc.page : ''] }) : null,
      ] }),
      jsx('button', { type: 'button', className: 'lsp-todo-del', title: '删除此条', onClick: () => remove(t.id), children: '✕' }),
    ] }, t.id)) : jsxs('div', { className: 'lsp-todo-empty', children: [
      jsx('div', { className: 'lsp-todo-empty-ico', children: checkSvg(null, 17) }),
      jsx('div', { className: 'lsp-todo-empty-t', children: '还没有待办' }),
      jsx('div', { className: 'lsp-todo-empty-s', children: '在下方输入，或点 PDF 工具栏「标注」后直接添加' }),
    ] }) }),
    // 新增输入框（常驻）：+ 图标 + 无边框输入 + 添加按钮，整体 focus 光环
    jsx('div', { className: 'lsp-todo-add', children: jsxs('div', { className: 'lsp-todo-add-wrap', children: [
      jsx('span', { className: 'lsp-todo-add-ico', children: jsx('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', children: jsx('path', { d: 'M12 5v14M5 12h14' }) }) }),
      jsx('input', { type: 'text', className: 'lsp-todo-input', placeholder: ctx ? '补充说明（可选），回车添加到此位置…' : '输入待办内容，回车添加…', value: draft, onChange: e => setDraft(e.target.value), onKeyDown: e => { if (e.key === 'Enter') addTodo() } }),
      jsx('button', { type: 'button', className: 'lsp-todo-add-btn', onClick: addTodo, children: '添加' }),
    ] }) }),
    // 大看板：三列状态（未开始/进行中/已结束），拖卡换列，▸ 展开完整描述，Esc/✕ 关闭
    boardOpen ? jsxs('div', { className: 'lsp-th-overlay', children: [
      jsxs('div', { className: 'lsp-th-head', children: [
        jsx('b', { children: '论文推进 · 状态看板' }),
        jsx('span', { className: 'lsp-th-hint', children: '拖动卡片切换状态；点 ▸ 展开完整描述' }),
        jsx('button', { type: 'button', className: 'lsp-th-x', title: '关闭（Esc）', onClick: () => setBoardOpen(false), children: '✕' }),
      ] }),
      jsx('div', { className: 'lsp-th-cols', children: [['todo', '未开始'], ['doing', '进行中'], ['done', '已结束']].map(([st, name]) => jsxs('div', { className: 'lsp-th-col' + (dragOver === st ? ' over' : ''), onDragOver: (e) => { e.preventDefault(); setDragOver(st) }, onDragLeave: () => setDragOver(''), onDrop: (e) => { e.preventDefault(); setDragOver(''); const id = e.dataTransfer.getData('text/plain'); if (id) moveItem(id, st) }, children: [
        jsxs('div', { className: 'lsp-th-col-hd st-' + st, children: [name, jsx('span', { className: 'lsp-th-n', children: String(boardCounts[st] || 0) })] }),
        jsx('div', { className: 'lsp-th-col-list', children: board.filter(i => i.status === st).map(it => jsxs('div', { className: 'lsp-th-card' + (dropOn === it.id ? ' drop-on' : ''), draggable: true, onDragStart: (e) => { e.dataTransfer.setData('text/plain', it.id); e.dataTransfer.effectAllowed = 'move' }, onDragOver: (e) => { e.preventDefault(); e.stopPropagation(); setDropOn(it.id) }, onDragLeave: () => setDropOn(''), onDrop: (e) => { e.preventDefault(); e.stopPropagation(); setDropOn(''); const id = e.dataTransfer.getData('text/plain'); if (id) reorderMove(id, it.id) }, children: [
          jsxs('div', { className: 'lsp-th-card-hd', children: [jsx('b', { children: it.code }), jsx('button', { type: 'button', className: 'lsp-th-exp', title: expanded[it.id] ? '折叠' : '展开', onClick: () => toggleExp(it.id), children: expanded[it.id] ? '▾' : '▸' })] }),
          jsx('div', { className: 'lsp-th-card-t', children: it.title }),
          it.desc ? jsx('div', { className: 'lsp-th-card-d' + (expanded[it.id] ? ' open' : ''), children: it.desc }) : null,
        ] }, it.id)) }),
        st === 'todo' ? jsx('div', { className: 'lsp-th-add-wrap', children: [
          jsx('input', { type: 'text', className: 'lsp-th-add-input', placeholder: '新增推进项（自动编号），回车添加…', value: boardDraft, onChange: e => setBoardDraft(e.target.value), onKeyDown: e => { if (e.key === 'Enter') addBoardItem() } }),
          jsx('button', { type: 'button', className: 'lsp-th-add-btn', onClick: addBoardItem, children: '添加' }),
        ] }) : null,
      ] }, st)) }),
    ] }) : null,
  ] })
}

// ---------------------------------------------------------------- toolbar
function Toolbar() {
  const s = useValue(ui)
  const cwd = useValue(host.state.cwd)
  const [showPicker, setShowPicker] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [gitBusy, setGitBusy] = useState(false)
  const doGitCommit = async () => {
    const msg = commitMsg.trim()
    setGitBusy(true)
    try {
      if (ui.get().dirty) await saveFile() // 提交前先把未保存的当前文件落盘
      const r = await rest('/git-commit', { method: 'POST', body: { root: ui.get().root, message: msg } })
      if (r && r.ok && r.noop) host.notify({ kind: 'info', message: '没有需要提交的改动' })
      else if (r && r.ok) host.notify({ kind: 'success', message: `已提交：${r.message || msg}`, detail: r.log })
      else host.notify({ kind: 'error', message: '提交失败', detail: (r && r.log) || '' })
    } catch (e) { host.notify({ kind: 'error', message: '提交失败：' + fmtErr(e) }) }
    setGitBusy(false); setCommitOpen(false); setCommitMsg('')
  }
  const doGitPull = async () => {
    setGitBusy(true)
    try {
      const r = await rest('/git-pull', { method: 'POST', body: { root: ui.get().root } })
      if (r && r.ok && r.uptodate) host.notify({ kind: 'info', message: '远程没有新提交，已是最新' })
      else if (r && r.ok) {
        host.notify({ kind: 'success', message: '已合并远程', detail: r.log })
        const rel = relOfCurrent() // 磁盘被 pull 改了：当前文件无未保存改动就重新载入
        if (rel && !ui.get().dirty) openFile(rel)
      }
      else if (r && r.conflict) host.notify({ kind: 'warning', message: '合并冲突：请到终端解决后提交', detail: r.log, durationMs: 8000 })
      else host.notify({ kind: 'error', message: '合并远程失败', detail: (r && r.log) || '' })
    } catch (e) { host.notify({ kind: 'error', message: '合并远程失败：' + fmtErr(e) }) }
    setGitBusy(false)
  }
  useEffect(() => { patch({ todos: todosGet() }) }, []) // 初始计数（面板内改动会再同步）

  const pickProject = useCallback(async (rootOverride) => {
    const start = rootOverride || s.root || cwd
    if (!start) { setShowPicker(true); return }
    patch({ scanning: true })
    try {
      let res = await rest(`/scan?root=${encodeURIComponent(start)}`)
      let files = (res && res.files) || []
      if (!files.length) { host.notify({ kind: 'warning', message: '该目录下没有找到 .tex 文件' }); return }
      const main = files.find(f => f.rel === 'main.tex') || files.find(f => /(^|\/)main\.tex$/.test(f.rel)) || files[0]
      const relDir = main.rel.includes('/') ? main.rel.slice(0, main.rel.lastIndexOf('/')) : ''
      const scanRoot = String(res.root).replace(/[\\/]+$/, '')
      const root = relDir ? scanRoot + '/' + relDir : scanRoot
      if (root !== scanRoot) { res = await rest(`/scan?root=${encodeURIComponent(root)}`); files = (res && res.files) || files }
      const pdfRel = (res.pdfs || []).find(p => /(^|\/)main\.pdf$/.test(p)) || (res.pdfs || [])[0] || 'main.pdf'
      const mainRel = (files.find(f => /(^|\/)main\.tex$/.test(f.rel)) || files[0]).rel
      patch({ root, pdfRel, files, structure: null })
      try { api && api.storage && api.storage.set('lastRoot', root); recentPush(root) } catch { /* storage best-effort */ }
      loadStructure(root)
      notesLoad(root) // 待办+论文推进从工程 todo.md 载入（没有则从旧 storage 迁入）
      await openFile(mainRel)
      refreshPdf(true)
    } catch (e) { host.notify({ kind: 'error', message: '扫描失败：' + fmtErr(e) }) } finally { patch({ scanning: false }) }
  }, [cwd, s.root])

  const goCurrentProject = useCallback(async () => {
    if (!cwd) { host.notify({ kind: 'warning', message: '当前对话没有工作目录（会话 detached）。', detail: '用「换工程…」手动选择目录。' }); return }
    patch({ scanning: true })
    try {
      // 会话 cwd 可能就是工程根、也可能在其上层/子层 —— 让后端双向探测 main.tex
      let root = cwd
      try {
        const fp = await rest(`/find-project?path=${encodeURIComponent(cwd)}`)
        if (fp && fp.ok && fp.root) root = fp.root
        else if (fp && !fp.ok) {
          // 没找到 main.tex：仍回退到直接扫描 cwd（里面有任意 .tex 也能编）
          host.notify({ kind: 'info', message: '会话目录附近没发现 main.tex，尝试直接扫描…', detail: fp.reason || '' })
        }
      } catch { /* 后端旧版无此端点：直接扫 cwd */ }
      await pickProject(root)
      if (ui.get().root) host.notify({ kind: 'success', message: '已切换到本对话的工程', detail: String(ui.get().root) })
    } catch (e) { host.notify({ kind: 'error', message: '切换失败：' + fmtErr(e) }) } finally { patch({ scanning: false }) }
  }, [cwd, pickProject])

  useEffect(() => {
    if (s.root) return
    // 默认打开上次的工程；上次的目录没了/不可用则回退到会话 cwd
    let last = null
    try { last = api && api.storage && api.storage.get('lastRoot', null) } catch { /* older hosts */ }
    if (last) {
      pickProject(last).then(() => {
        if (!ui.get().root && cwd) pickProject(cwd)
      })
      return
    }
    pickProject()
  }, [])

  return jsxs('div', { className: 'flex flex-wrap items-center gap-1.5 border-b border-(--ui-stroke-secondary) px-2 py-1.5', children: [
    jsx('span', { className: 'text-[0.72rem] font-medium text-(--ui-text-secondary)', children: 'LaTeX' }),
    // project display + browse button
    jsxs('div', { className: 'flex items-center gap-1', children: [
      s.root ? jsx('span', { className: 'max-w-[180px] truncate text-[0.68rem] text-(--ui-text-quaternary)', title: s.root, children: String(s.root).split(/[\\/]/).pop() }) : null,
      jsx('button', { type: 'button', className: btn, disabled: s.scanning, onClick: () => setShowPicker(true), title: s.scanning ? '扫描中…' : '浏览目录选择工程', children: s.scanning ? '扫描中…' : (s.root ? '换工程…' : '打开工程…') }),
      jsx('button', { type: 'button', className: btn, disabled: s.scanning || !cwd, onClick: goCurrentProject, title: cwd ? `定位并打开本对话工作目录对应的 LaTeX 工程\n(${cwd})` : '当前对话没有工作目录' , children: '本对话工程' }),
    ] }),
    FileTree(),
    jsx('span', { className: 'flex-1' }),
    jsx('button', { type: 'button', className: btn + (s.annotate ? ' lsp-on' : ''), disabled: !s.root || s.pdfMissing, onClick: () => patch({ annotate: !s.annotate }), title: s.annotate ? '标注模式已开：点 PDF 任意位置 → 反查源文件行号 → 预填待办。再点关闭' : '开启「PDF 点击标注」：点页面某处，自动定位到 .tex 的哪一行，并预填一条待办', children: s.annotate ? '标注·开' : '标注' }),
    jsx('button', { type: 'button', className: btn + (s.todoOpen ? ' lsp-on' : ''), onClick: () => patch({ todoOpen: !s.todoOpen }), title: s.todoOpen ? '收起待办面板（常驻在编辑器下方）' : '展开待办面板（常驻在编辑器下方，可输入/勾选/删除；带 PDF 位置的条目可点击跳转）', children: `待办${s.todos.length ? ' ·' + s.todos.filter(t => !t.done).length : ''}` }),
    jsx('button', { type: 'button', className: btn, onClick: () => setShowHelp(true), title: '按章/按节编译怎么用 · 拆分部指南 · 安装 skill', children: '?' }),
    s.dirty ? jsx('span', { className: `${accent} text-[0.68rem]`, children: '● 未保存' }) : null,
    jsx('button', { type: 'button', className: btn, disabled: !s.file || s.building, onClick: () => saveFile(), title: 'Ctrl+S', children: '保存' }),
    jsx('button', { type: 'button', className: btn, disabled: !s.root || s.building, onClick: () => buildAndSync(false), children: s.building ? '编译中…' : '编译预览' }),
    (() => { const or = chapterOfCurrent(); const chapTarget = or && ui.get().structure ? (() => { const stem = or; const ch = (ui.get().structure.chapters || []).find(c => c.dir && (stem === c.shell || stem.startsWith(c.dir + '/'))); return ch ? ch.key : stem })() : or; return jsx('button', { type: 'button', className: btn, disabled: !s.root || !chapTarget || s.building, onClick: () => buildAndSync(false, chapTarget), title: chapTarget ? `\\includeonly 只重排 ${chapTarget}（风格/编号/引用保留，产出 main_partial.pdf）` : '当前文件不是章节/节文件', children: '本章' }) })(),
    // 「本节」按钮：章节文件夹结构才显示（/structure 返回 section_capable）
    s.structure && s.structure.section_capable ? (() => { const sc = sectionOfCurrent(); return jsx('button', { type: 'button', className: btn, disabled: !s.root || !sc || s.building, onClick: () => buildAndSync(false, sc, true), title: sc ? `只重排当前节 ${sc}（章节壳保留编号，产出 main_partial_section.pdf）` : '当前文件不是章节文件夹里的节 .tex', children: '本节' }) })() : null,
    jsx('button', { type: 'button', className: btn, disabled: !s.root || s.building, onClick: () => buildAndSync(true), title: 'latexmk -g 全量重编译', children: '强制' }),
    jsx('button', { type: 'button', className: btn, onClick: () => patch({ wrap: !s.wrap }), title: s.wrap ? '当前：软换行（长行折显）；点击改为不换行（横向滚动+行号）' : '当前：不换行（显示行号）；点击改为软换行', children: s.wrap ? '换行·开' : '换行·关' }),
    jsx('button', { type: 'button', className: btn + (s.diff ? ' lsp-on' : ''), disabled: !s.file || !s.root, onClick: () => (s.diff ? patch({ diff: null }) : showGitDiff()), title: '当前文件 vs 上次 git 提交的差异（含未保存改动）', children: s.diff ? '关闭差异' : 'Git差异' }),
    jsx('button', { type: 'button', className: btn + (commitOpen ? ' lsp-on' : ''), disabled: !s.root || gitBusy, onClick: () => setCommitOpen(!commitOpen), title: 'git add -A + commit（会先保存当前文件）', children: 'Git提交' }),
    commitOpen ? jsx('input', { type: 'text', className: 'lsp-input', style: { maxWidth: '170px' }, placeholder: '提交信息，回车提交（空=自动）', value: commitMsg, autoFocus: true, onChange: e => setCommitMsg(e.target.value), onKeyDown: e => { if (e.key === 'Enter') doGitCommit(); if (e.key === 'Escape') { setCommitOpen(false); setCommitMsg('') } } }) : null,
    jsx('button', { type: 'button', className: btn, disabled: !s.root || gitBusy, onClick: doGitPull, title: 'git pull --no-edit 合并远程分支', children: gitBusy ? 'Git…' : '合并远程' }),
    jsx('button', { type: 'button', className: btn, disabled: !s.root || !s.file || s.building, onClick: () => forwardSync(), title: '跳到 PDF 当前行 (Ctrl+Alt+F)', children: '定位⇥' }),
    showPicker ? jsx(DirPicker, { onPick: (p) => { setShowPicker(false); pickProject(p) }, onClose: () => setShowPicker(false) }) : null,
    showHelp ? jsx(HelpDialog, { onClose: () => setShowHelp(false) }) : null,
  ] })
}

// ---------------------------------------------------------------- file tree (replaces flat FileMenu)
function FileTree() {
  const s = useValue(ui)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState({}) // dir path → bool
  const tree = useMemo(() => buildTree(s.files), [s.files])

  function renderNode(node, depth) {
    if (node.isFile) {
      const isActive = String(s.file || '').replace(/\\/g, '/').endsWith('/' + node.rel)
      return jsx('button', { key: 'f_' + node.rel, type: 'button', className: `lst-file ${isActive ? 'lst-file-active' : ''}`, style: { paddingLeft: (8 + depth * 14) + 'px' }, onClick: () => { setOpen(false); openFile(node.rel) }, children: node.name })
    }
    const isExp = expanded[node.name] !== false // default expanded
    return jsxs('div', { key: 'd_' + node.name, children: [
      jsx('button', { type: 'button', className: 'lst-dir', style: { paddingLeft: (8 + depth * 14) + 'px' }, onClick: () => setExpanded(prev => ({ ...prev, [node.name]: !isExp })), children: [
        jsx('span', { style: { display: 'inline-block', width: '12px', fontSize: '9.5px' }, children: isExp ? '▾' : '▸' }), node.name + '/'
      ] }),
      isExp ? jsx('div', { children: node.children.map(c => renderNode(c, depth + 1)) }) : null,
    ] })
  }

  return jsxs('div', { className: 'relative', children: [
    jsx('button', { type: 'button', className: btn, disabled: !s.files.length, onClick: () => setOpen(v => !v), children: '文件树 ▾' }),
    open ? jsx('div', { className: 'lst-dd', children: tree.children.map(c => renderNode(c, 0)) }) : null,
  ] })
}

// ---------------------------------------------------------------- actions
let cursorLine = 1
let pendingEditorLine = 0 // openFile(rel, line) 时让编辑器跳到该行
let editorJumpFn = null   // Editor 注册的即时跳行函数（同文件跳转免重载）
// 路径比较前必须统一成正斜杠 + 去尾部分隔符：synctex 返回正斜杠绝对路径，
// 而 ui.root 是反斜杠 —— 直接 startsWith 永不命中（9/23 定位 chip 报错根因）
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
const isAbsPath = (p) => /^[A-Za-z]:/.test(p) || p.startsWith('/')
// 容错：存储/跳转前把路径截到最后一个 .tex 为止（9/23 有 todo 存进了 '2-01.tex}' 这种
// 带尾巴的脏路径，后端 _guard_source 直接 400 "non-LaTeX file"）
const cleanTexPath = (p) => { const s = normPath(p); const i = s.toLowerCase().lastIndexOf('.tex'); return i >= 0 ? s.slice(0, i + 4) : s }
const locTitle = (loc) => loc.label
  ? `按锚点「${loc.label}」定位${loc.anchorFile ? '（锚点在 ' + loc.anchorFile + '）' : ''}（记录于 ${loc.file} L${loc.line}）`
  : `跳到 ${loc.file} 第 ${loc.line} 行（记录时的行号，编辑后可能漂移）`
// 稳定锚点：从 (file,line) 向上找最近的 \label{} 或 \chapter/\section/\subsection/\subsubsection
// （论文里 \label 多在图表上、正文段落最近的稳定不动点是小节标题；向上 60 行，找不到再向下 30 行——
// 2-01.tex 这类被 include 的碎片文件自己没有 section，得够到下方图表的 \label）。
// 返回 { needle, name }：needle 为原文中连续子串（跳转时 includes 查找），name 用于 chip 展示；找不到返回 null
const ANCHOR_RE = /\\label\{([^}]*)\}|\\(chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{([^{}]*)\}/
async function findAnchor(absFile, line) {
  try {
    const rr = await rest(`/read?path=${encodeURIComponent(absFile)}`)
    const lines = String(rr.text || '').split(/\r?\n/)
    const start = Math.max(0, (line || 1) - 1)
    const scan = (i) => {
      const m = lines[i] && lines[i].match(ANCHOR_RE)
      if (!m) return null
      return { needle: m[0], name: m[1] !== undefined ? m[1] : (m[3] || m[2]) }
    }
    for (let i = start; i >= 0 && i >= start - 60; i--) { const a = scan(i); if (a) return a }
    for (let i = start + 1; i < lines.length && i <= start + 30; i++) { const a = scan(i); if (a) return a }
  } catch {}
  return null
}
// 按锚点子串找当前所在行（编辑后行号漂移时的稳定定位）；找不到返回 0
async function anchorLine(absFile, needle) {
  if (!needle) return 0
  try {
    const rr = await rest(`/read?path=${encodeURIComponent(absFile)}`)
    const idx = String(rr.text || '').split(/\r?\n/).findIndex(l => l.includes(needle))
    return idx >= 0 ? idx + 1 : 0
  } catch { return 0 }
}
// 碎片文件兜底：文件内找不到锚点时，找 include 它的父文件，在父文件引用本碎片那行向上找最近的
// 章节命令。父文件命名按序尝试：chapters/2/2-01.tex → chapters/2/chapter.tex（本论文实际结构）、
// chapters/2/main.tex、chapters/2.tex（目录同名兄弟文件，通用约定）
async function findAnchorDeep(relFile, line, root) {
  const abs = isAbsPath(relFile) ? relFile : root + '/' + relFile
  const direct = await findAnchor(abs, line)
  if (direct) return { ...direct, file: relFile }
  const m = String(relFile).match(/^(.*)\/([^\/]+)\/[^\/]+\.tex$/)
  if (!m) return null
  const fragBase = String(relFile).split('/').pop().replace(/\.tex$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const inputRe = new RegExp('\\\\(input|include|subfile)\\{[^}]*' + fragBase + '\\}')
  const candidates = [m[1] + '/' + m[2] + '/chapter.tex', m[1] + '/' + m[2] + '/main.tex', m[1] + '/' + m[2] + '.tex']
  for (const parentRel of candidates) {
    try {
      const rr = await rest(`/read?path=${encodeURIComponent(root + '/' + parentRel)}`)
      if (!rr || !rr.text) continue
      const lines = String(rr.text).split(/\r?\n/)
      let inputLine = -1
      for (let i = 0; i < lines.length; i++) { if (inputRe.test(lines[i])) { inputLine = i; break } }
      if (inputLine < 0) continue
      for (let i = inputLine; i >= 0 && i >= inputLine - 80; i--) {
        const mm = lines[i] && lines[i].match(ANCHOR_RE)
        if (mm) return { needle: mm[0], name: mm[1] !== undefined ? mm[1] : (mm[3] || mm[2]), file: parentRel }
      }
    } catch {}
  }
  return null
}

async function openFile(rel, line) {
  const s = ui.get()
  if (!s.root) return
  const abs = rel.startsWith('/') || /^[A-Za-z]:/.test(rel) ? rel : String(s.root).replace(/[\\/]+$/, '') + '/' + rel
  try {
    if (s.dirty && !(await confirmDiscard())) return
    const r = await rest(`/read?path=${encodeURIComponent(abs)}`)
    patch({ file: r.path, text: r.text, dirty: false })
    if (line > 0) { cursorLine = line; pendingEditorLine = line }
  } catch (e) { host.notify({ kind: 'error', message: '打开失败：' + fmtErr(e) }) }
}

function confirmDiscard() { host.notify({ kind: 'warning', message: '有未保存修改，请先保存（Ctrl+S）' }); return Promise.resolve(false) }

async function saveFile() {
  const s = ui.get(); if (!s.file) return
  try { await rest('/save', { method: 'POST', body: { path: s.file, text: s.text, root: s.root } }); patch({ dirty: false }) }
  catch (e) { host.notify({ kind: 'error', message: '保存失败：' + fmtErr(e) }) }
}

// 当前打开文件 -> main.tex \\include 的章节键（如 chapters/3-swmt）；不匹配返回 null。
// 是否真是 \\include 章节由后端校验（400 时报错信息列出可选项）。
function relOfCurrent() {
  const s = ui.get()
  if (!s.file || !s.root) return null
  const rel = String(s.file).slice(String(s.root).replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/')
  if (!rel.toLowerCase().endsWith('.tex') || /(^|\/)main(\.tex)?$/i.test(rel)) return null
  return rel.replace(/\.tex$/i, '')
}
function chapterOfCurrent() { return relOfCurrent() }
// 当前文件是「章节文件夹里的节文件」时返回它的 rel（用于按节编译），否则 null
function sectionOfCurrent() {
  const st = ui.get().structure
  if (!st || !st.section_capable) return null
  const stem = relOfCurrent()
  if (!stem) return null
  for (const ch of st.chapters || []) {
    if (stem !== ch.shell && ch.dir && stem.startsWith(ch.dir + '/')) return stem
  }
  return null
}
// 最近打开工程列表（MRU，去重，≤8），存宿主提供的插件作用域 storage
function recentGet() { try { return (api && api.storage && api.storage.get('recentRoots', [])) || [] } catch { return [] } }
function recentPush(root) {
  const next = [root, ...recentGet().filter(r => r !== root)].slice(0, 8)
  try { api && api.storage && api.storage.set('recentRoots', next) } catch { /* best-effort */ }
  return next
}
async function loadStructure(root) {
  try {
    const st = await rest(`/structure?root=${encodeURIComponent(root)}`)
    patch({ structure: st && st.ok ? st : null })
  } catch { patch({ structure: null }) }  // 旧后端无此端点 -> 只出「本章」
}

async function buildAndSync(force, only, isSection) {
  const s = ui.get(); if (!s.root || s.building) return
  if (s.dirty) await saveFile()
  patch({ building: true, buildLog: '' })
  try {
    // latexmk is slow; the host IPC default (15s) must be widened explicitly
    // (backend BUILD_TIMEOUT_DEFAULT_S=600 -> 660s budget with margin)
    const body = { root: s.root, force }
    if (only) body.only = only
    const r = await rest('/build', { method: 'POST', body, timeoutMs: 660000 })
    if (r.busy) host.notify({ kind: 'warning', message: '已有编译在运行中' })
    else if (r.ok) {
      haptic('tap')
      host.notify({ kind: 'info', message: `编译完成（${r.duration}s${only ? (isSection ? '，仅本节' : '，仅本章') : ''}）` })
      // partial builds use dedicated jobnames so the full main.pdf is untouched
      if (r.pdf) { const cur = ui.get().pdfRel; if (cur !== r.pdf) patch({ pdfRel: r.pdf }) }
      await refreshPdf(true); const m = ui.get().marker; if (m) jumpTo(m.page)
    }
    else { patch({ buildLog: String(r.log_tail || '编译失败') }); host.notify({ kind: 'error', message: '编译失败，见底部日志' }) }
  } catch (e) { patch({ buildLog: fmtErr(e) }); host.notify({ kind: 'error', message: '编译请求失败' }) } finally { patch({ building: false }) }
}

async function showGitDiff() {
  const s = ui.get(); if (!s.root || !s.file) return
  patch({ diff: { loading: true } })
  try {
    // dirty 时把编辑器内存内容发给后端一起比 —— 未保存的改动也能看到
    const body = { root: s.root, file: s.file }
    if (s.dirty) body.text = s.text
    const r = await rest('/git-diff', { method: 'POST', body })
    patch({ diff: r })
  } catch (e) { patch({ diff: { ok: false, reason: fmtErr(e) } }) }
}

function DiffView() {
  const s = useValue(ui)
  const d = s.diff
  if (!d || d.loading) return jsx('div', { className: 'p-3 text-[0.72rem] text-(--ui-text-tertiary)', children: '正在与上次 git 提交比较…' })
  if (!d.ok) return jsxs('div', { className: 'p-3 text-[0.72rem] text-red-600', children: ['无法比较：', d.reason || '未知错误'] })
  if (!d.diff) return jsxs('div', { className: 'p-3 text-[0.72rem] text-(--ui-text-tertiary)', children: [d.rel, '：与上次提交完全一致，没有差异'] })
  const lines = d.diff.split('\n')
  return jsxs('div', { className: 'h-full overflow-auto font-mono text-[0.72rem] leading-[1.5]', children: [
    jsxs('div', { className: 'sticky top-0 z-10 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2 py-1 text-(--ui-text-tertiary)', children: [d.rel, ' · +', String(d.adds), ' −', String(d.dels), '（当前 vs 上次提交）'] }),
    lines.map((ln, i) => {
      let cls
      if (ln.startsWith('+++')) cls = 'diff-h'
      else if (ln.startsWith('---')) cls = 'diff-h'
      else if (ln.startsWith('@@')) cls = 'diff-hunk'
      else if (ln.startsWith('+')) cls = 'diff-add'
      else if (ln.startsWith('-')) cls = 'diff-del'
      else cls = 'diff-ctx'
      return jsx('div', { className: 'diff-line ' + cls, children: ln || '\u00a0' }, i)
    }),
  ] })
}

async function refreshPdf(force) {
  const s = ui.get(); if (!s.root) return
  const pdfAbs = String(s.root).replace(/[\\/]+$/, '') + '/' + s.pdfRel
  try {
    const m = await rest(`/pdf-meta?path=${encodeURIComponent(pdfAbs)}`)
    const key = String(m.mtime)
    if (force || key !== s.pdfKey) patch({ pdfKey: key, pages: m.pages || 0, pdfMissing: false, pdfError: false })
    else patch({ pdfMissing: false, pdfError: false, pages: m.pages || ui.get().pages })
  } catch (e) { patch({ pdfMissing: true, pdfKey: '' }) }
}

async function forwardSync(line) {
  const s = ui.get(); if (!s.file || !s.root) return
  const ln = typeof line === 'number' ? line : cursorLine
  const rel = String(s.file).slice(String(s.root).replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/')
  try { const r = await rest(`/sync?dir=${encodeURIComponent(s.root)}&tex=${encodeURIComponent(rel)}&line=${ln}&pdf=${encodeURIComponent(s.pdfRel || 'main.pdf')}`); patch({ marker: r, page: r.page }); jumpTo(r.page) }
  catch (e) { host.notify({ kind: 'warning', message: 'SyncTeX 无映射（先「编译预览」）：' + fmtErr(e) }) }
}

function jumpTo(page) { if (!page) return; const el = scrollerEl; if (!el) return; const sheet = el.querySelector(`[data-page="${page}"]`); if (!sheet) return; const er = el.getBoundingClientRect(), sr = sheet.getBoundingClientRect(); el.scrollTop += sr.top - er.top - 8 }

// ---------------------------------------------------------------- editor
// LaTeX 语法高亮：先转义再分段着色（注释/环境/命令/章节/行内数学/括号）。
// 输出 HTML 字符串喂给底层 <pre>，上层 textarea 文字透明，两者字体/内距完全一致。
function latexHl(text) {
  const re = /(?<!\\)%[^\n]*|\\(?:begin|end)\{[^{}]*\}|\\(?:chapter|section|subsection|subsubsection|part)\{[^{}]*\}|\\[a-zA-Z@]+\*?|\\[^a-zA-Z\n{}]|(?<!\$)\$(?!\$)[^$\n]*(?:\$|$)|\{|\}/g
  // 每行包一个 .lrow（display:block）：软换行时靠它测量每行的 offsetTop，
  // 给出行号栏的「视觉行号」映射。空行用 \u00a0 占位保证有行高。
  return text.split('\n').map((line) => {
    const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    let out = '', last = 0, m
    re.lastIndex = 0
    while ((m = re.exec(esc))) {
      if (m.index > last) out += esc.slice(last, m.index)
      const t = m[0]
      let cls
      if (t[0] === '%') cls = 'c'
      else if (t.startsWith('\\begin{') || t.startsWith('\\end{')) cls = 'env'
      else if (/^\\(?:chapter|section|subsection|subsubsection|part)\{/.test(t)) cls = 'sec'
      else if (t[0] === '\\') cls = 'cmd'
      else if (t[0] === '$') cls = 'math'
      else cls = 'brace'
      out += `<span class="${cls}">${t}</span>`
      last = m.index + t.length
      if (t === '\\') re.lastIndex = m.index + 1 // 防御：转义符不吃进
    }
    out += esc.slice(last)
    return `<span class="lrow">${out || '\u00a0'}</span>`
  }).join('')
}

function Editor() {
  const s = useValue(ui)
  const taRef = useRef(null), gutRef = useRef(null), hlRef = useRef(null)
  const lineNums = useMemo(() => { const n = (s.text.match(/\n/g) || []).length + 1; const out = new Array(n); for (let i = 0; i < n; i++) out[i] = i + 1; return out }, [s.text])
  const html = useMemo(() => latexHl(s.text), [s.text])
  useEffect(() => { if (hlRef.current) { hlRef.current.innerHTML = html } rowTops = null; relayout(); syncScroll() }, [html, s.wrap])
  // 跳到指定行（滚动 + 光标）：openFile 经 pendingEditorLine 间接触发；
  // doJump 同时注册为 editorJumpFn，供待办定位「同文件免重载直跳」
  const doJump = (ln) => requestAnimationFrame(() => {
    const ta = taRef.current; if (!ta || !ln) return
    rowTops = measure()
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || (parseFloat(getComputedStyle(ta).fontSize) * 1.4)
    const top = Math.max(0, ((rowTops && rowTops[ln - 1]) != null ? rowTops[ln - 1] : (ln - 1) * lh))
    ta.scrollTop = Math.max(0, top - ta.clientHeight / 3)
    syncScroll()
    const pos = ta.value.split('\n').slice(0, ln).join('\n').length
    try { ta.setSelectionRange(pos, pos) } catch {}
  })
  editorJumpFn = doJump
  useEffect(() => {
    if (!pendingEditorLine || !taRef.current) return
    const ln = pendingEditorLine; pendingEditorLine = 0
    doJump(ln)
  }, [s.file, s.text])
  // 拖窄/拉宽编辑器会让软换行折点全变 —— 重新测量
  useEffect(() => {
    const hl = hlRef.current; if (!hl || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { rowTops = null; relayout() })
    ro.observe(hl); return () => ro.disconnect()
  }, [])
  // 软换行行号：测量高亮层每行(.lrow)的 offsetTop，把逻辑行号绝对定位到该行首视觉行处
  let rowTops = null
  const measure = () => {
    const hl = hlRef.current; if (!hl) return null
    const rows = hl.children
    const tops = new Array(rows.length)
    for (let i = 0; i < rows.length; i++) tops[i] = rows[i].offsetTop
    return tops
  }
  const relayout = () => {
    const gut = gutRef.current; if (!gut) return
    const s = ui.get()
    const kids = gut.children
    if (!s.wrap) { // nowrap：行号回到普通文档流，清掉测量留下的定位/高度
      for (let i = 0; i < kids.length; i++) { kids[i].style.top = ''; kids[i].style.height = '' }
      return
    }
    if (!rowTops) rowTops = measure()
    if (!rowTops) return
    for (let i = 0; i < kids.length && i < rowTops.length; i++) {
      kids[i].style.top = rowTops[i] + 'px' // .lrow.offsetTop 已含高亮层 8px padding
    }
    // 最后一个号加高到正文总高：撑出行号栏自己的可滚动区，滚到底不错位
    const hl = hlRef.current
    if (hl && kids.length && rowTops.length) {
      kids[Math.min(kids.length, rowTops.length) - 1].style.height = Math.max(0, hl.scrollHeight - rowTops[rowTops.length - 1]) + 'px'
    }
  }
  const syncScroll = () => {
    const ta = taRef.current; if (!ta) return
    if (hlRef.current) { hlRef.current.scrollTop = ta.scrollTop; hlRef.current.scrollLeft = ta.scrollLeft }
    if (gutRef.current) gutRef.current.scrollTop = ta.scrollTop
  }
  const readCursor = () => { const el = taRef.current; if (!el) return; cursorLine = el.value.slice(0, el.selectionStart).split('\n').length }
  const onKeyDown = useCallback((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); return }
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); readCursor(); forwardSync(cursorLine); return }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); buildAndSync(false); return }
    if (e.key === 'Tab') { e.preventDefault(); const el = e.target, a = el.selectionStart, b = el.selectionEnd; const next = el.value.slice(0, a) + '  ' + el.value.slice(b); patch({ text: next, dirty: true }); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 2 }) }
  }, [])

  return jsxs('div', { className: 'relative flex h-full min-h-0 flex-1', children: [
    jsx('div', { ref: gutRef, className: 'lst-gutter select-none overflow-hidden border-r border-(--ui-stroke-secondary) text-right font-mono text-[0.78rem] leading-[1.4] text-(--ui-text-quaternary)', style: { minWidth: '3.2em' }, children:
      lineNums.map((n, i) => jsx('div', { style: s.wrap ? { position: 'absolute', right: 0, left: 0 } : undefined, children: String(n) }, i)) }),
    jsxs('div', { className: 'lst-editor', children: [
      jsx('pre', { ref: hlRef, 'aria-hidden': 'true', className: 'lst-hl' + (s.wrap ? '' : ' nowrap') }),
      jsx('textarea', { ref: taRef, className: 'lst-ta' + (s.wrap ? '' : ' nowrap'), spellCheck: false, value: s.text, onChange: (e) => { patch({ text: e.target.value, dirty: true }) }, onKeyDown, onKeyUp: readCursor, onClick: readCursor, onScroll: syncScroll, placeholder: '// 输入路径打开工程，或「文件树 ▾」选择 .tex' }),
    ] }),
    s.file ? jsxs('span', { className: 'pointer-events-none absolute bottom-1 right-2 rounded bg-(--ui-bg-primary)/80 px-1.5 text-[0.62rem] text-(--ui-text-quaternary)', children: [String(s.file).split(/[\\/]/).pop(), ' · 行 ', String(cursorLine)] }) : null,
  ] })
}

// ---------------------------------------------------------------- pdf pane
let scrollerEl = null
const pagePtDims = new Map() // `${pdfKey}|${n}` -> {ptW, ptH}（该页真实点尺寸，用于点击→big point 换算）

// 页面渲染在 110dpi：像素 → big point(72dpi) = px * 72/110。存下每页真实点尺寸，
// 这样点击坐标按比例归一化后乘回 ptW/ptH 就得到 synctex edit 需要的 (x,y)。
function recordDims(n, pdfKey, v) { if (!v || !v.w || !v.h) return; pagePtDims.set(`${pdfKey}|${n}`, { ptW: v.w * 72 / 110, ptH: v.h * 72 / 110 }) }

function onAnnotateClick(n, e) {
  const s = ui.get()
  if (!s.annotate || !s.root) return
  // 找到该页渲染的 <img>，用其显示矩形把鼠标坐标归一化到页面比例
  const sheet = scrollerEl && scrollerEl.querySelector(`[data-page="${n}"]`)
  const imgEl = sheet ? (sheet.querySelector('img') || sheet) : null
  if (!imgEl) return
  const rect = imgEl.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return
  const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  const fy = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
  const dims = pagePtDims.get(`${s.pdfKey}|${n}`) || { ptW: 595.28, ptH: 841.89 }
  const x = fx * dims.ptW, y = fy * dims.ptH
  host.notify({ kind: 'info', message: `反查 PDF 第 ${n} 页 → 源文件…` })
  rest(`/reverse?dir=${encodeURIComponent(s.root)}&page=${n}&x=${x.toFixed(1)}&y=${y.toFixed(1)}&pdf=${encodeURIComponent(s.pdfRel || 'main.pdf')}`)
    .then(async r => {
      const root = normPath(s.root)
      let file = cleanTexPath(r.input || '')
      if (file.toLowerCase().startsWith(root.toLowerCase())) file = file.slice(root.length + 1)
      // 顺手锚定最近的不动点：\label 或章节命令（行号会漂移，锚点不会）；碎片文件兜底到父文件的小节
      const anchor = await findAnchorDeep(file, r.line || 0, root)
      patch({ todoAnnotate: { file, line: r.line || 0, page: n, context: r.context || '', label: anchor ? anchor.name : '', needle: anchor ? anchor.needle : '', anchorFile: anchor && anchor.file !== file ? anchor.file : '' }, todoOpen: true })
      host.notify({ kind: 'info', message: `已定位：${String(file).split(/[\\/]/).pop()} 第 ${r.line || '?'} 行${anchor ? ' · 锚点 #' + anchor.name : ''} — 已预填到待办` })
    })
    .catch(err => host.notify({ kind: 'warning', message: '该处无 SyncTeX 映射（可能未编译或空白区）：' + fmtErr(err), durationMs: 6000 }))
}

function PdfPane() {
  const s = useValue(ui)
  const scrollRef = useRef(null)
  useEffect(() => { scrollerEl = scrollRef.current }, [s.pdfKey, s.view])

  if (!s.root) return jsx('div', { className: 'flex h-full items-center justify-center text-[0.75rem] text-(--ui-text-quaternary)', children: '输入路径打开工程' })
  if (s.pdfMissing) return jsx('div', { className: 'flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-[0.72rem] text-(--ui-text-quaternary)', children: jsxs('div', { children: ['未找到 ', jsx('span', { className: accent, children: s.pdfRel }), '，点「编译预览」生成。'] }) })

  const pdfAbs = String(s.root).replace(/[\\/]+$/, '') + '/' + s.pdfRel
  const pages = s.pages || 0
  const list = []
  if (s.view === 'single') { for (let i = s.page; i <= s.page; i++) list.push(i) } else { for (let i = 1; i <= (pages || 1); i++) list.push(i) }

  const setScrollPage = () => { const el = scrollRef.current; if (!el || s.view === 'single') return; const kids = el.querySelectorAll('[data-page]'); for (const k of kids) { if (k.offsetTop + k.offsetHeight * 0.5 > el.scrollTop + el.clientHeight * 0.3) { const p = parseInt(k.getAttribute('data-page')); if (p && p !== ui.get().page) ui.set({ ...ui.get(), page: p }); break } } }

  return jsxs('div', { className: 'flex h-full min-h-0 flex-1 flex-col', children: [
    jsxs('div', { className: 'flex items-center gap-1 border-b border-(--ui-stroke-secondary) px-2 py-1 text-[0.68rem] text-(--ui-text-tertiary)', children: [
      jsx('button', { type: 'button', className: btn, onClick: () => patch({ view: s.view === 'pages' ? 'single' : 'pages' }), children: s.view === 'pages' ? '单页' : '连续' }),
      jsx('button', { type: 'button', className: btn, onClick: () => patch({ zoom: Math.max(0.4, +(s.zoom - 0.15).toFixed(2)) }), children: '−' }),
      jsx('span', { children: Math.round(s.zoom * 100) + '%' }),
      jsx('button', { type: 'button', className: btn, onClick: () => patch({ zoom: Math.min(3, +(s.zoom + 0.15).toFixed(2)) }), children: '+' }),
      jsx('span', { className: 'flex-1' }),
      jsxs('button', { type: 'button', className: btn, disabled: !pages, onClick: () => refreshPdf(true), title: '检查 PDF 更新', children: ['页 ', String(s.page || '?'), '/', String(pages || '?')] }),
      pages ? jsx('span', { className: 'text-[0.62rem] text-(--ui-text-quaternary)', children: `更新于 ${new Date(parseInt(s.pdfKey)).toLocaleTimeString()}` }) : null,
    ] }),
    jsx('div', { ref: scrollRef, className: 'min-h-0 flex-1 overflow-auto bg-(--ui-bg-secondary)/60 p-2', onScroll: setScrollPage, children: jsx('div', { className: 'mx-auto flex w-fit flex-col items-stretch gap-2', children: list.map(i => jsx(PageSheet, { n: i, pdfAbs, zoom: s.zoom, pdfKey: s.pdfKey, marker: s.marker, key: `${s.pdfKey}|${i}` })) }) }),
  ] })
}

function PageSheet({ n, pdfAbs, zoom, pdfKey, marker }) { const s = useValue(ui); return jsxs('div', { 'data-page': String(n), className: 'relative w-fit' + (s.annotate ? ' lsp-annotate-on' : ''), style: s.annotate ? { cursor: 'crosshair' } : undefined, onClick: (e) => onAnnotateClick(n, e), children: [PageImg(n, pdfAbs, zoom, pdfKey), marker && marker.page === n ? jsx(SyncMark, { marker, n }) : null] }) }

function PageImg(n, pdfAbs, zoom, pdfKey) {
  const key = `${pdfKey}|${pdfAbs}|${n}`
  const cached = imgCache.get(key)
  const [img, setImg] = useState(cached || null)
  const [err, setErr] = useState(null)
  useEffect(() => { let alive = true; const hit = imgCache.get(key); if (hit) { setImg(hit); setErr(null); recordDims(n, pdfKey, hit); return } setImg(null); setErr(null); rest(`/page?path=${encodeURIComponent(pdfAbs)}&page=${n}&dpi=110`).then(r => { if (!alive) return; const v = { b64: r.b64, w: r.w, h: r.h }; cachePut(key, v); recordDims(n, pdfKey, v); setImg(v) }).catch(e => { if (alive) setErr(fmtErr(e)) }); return () => { alive = false } }, [key, pdfAbs, n])
  const ptW = 595.28, ptH = 841.89
  const w = Math.round((img ? img.w : ptW * 110 / 72) * zoom), h = Math.round((img ? img.h : ptH * 110 / 72) * zoom)
  if (err) return jsx('div', { style: { width: w, height: h }, className: 'flex items-center justify-center rounded bg-black/30 p-4 text-center text-[0.66rem] text-(--ui-text-quaternary)', children: '渲染失败：' + err })
  if (!img) return jsx('div', { style: { width: w, height: h }, className: 'flex items-center justify-center rounded bg-black/20 text-[0.66rem] text-(--ui-text-quaternary)', children: `第 ${n} 页 …` })
  return jsx('img', { src: 'data:image/png;base64,' + img.b64, width: w, height: h, className: 'rounded shadow-lg', style: { background: 'white' }, alt: `page ${n}` })
}

function SyncMark({ marker, n }) { const s = useValue(ui); const key = `${s.pdfKey}|${pdfAbsFor()}|${n}`; const hit = imgCache.get(key); if (!hit || !hit.w || !hit.h) return null; const pxPerPt = 110 / 72; const style = { left: (marker.x * pxPerPt / hit.w * 100) + '%', top: ((marker.y - marker.h * 0.9) * pxPerPt / hit.h * 100) + '%', width: Math.max(2, marker.w * pxPerPt / hit.w * 100) + '%', height: Math.max(3, marker.h * 1.9 * pxPerPt / hit.h * 100) + '%' }; return jsx('div', { className: 'pointer-events-none absolute rounded-sm outline outline-2 outline-(--ui-accent)', style }) }
function pdfAbsFor() { const s = ui.get(); return String(s.root).replace(/[\\/]+$/, '') + '/' + s.pdfRel }

// ---------------------------------------------------------------- log panel
function LogPanel() { const s = useValue(ui); if (!s.buildLog) return null; return jsxs('details', { className: 'border-t border-(--ui-stroke-secondary)', open: true, children: [jsxs('summary', { className: 'cursor-pointer px-2 py-1 text-[0.68rem] text-(--ui-text-tertiary)', children: ['编译日志 ', jsx('button', { type: 'button', className: `ml-2 ${accent}`, onClick: (e) => { e.preventDefault(); patch({ buildLog: '' }) }, children: '清除' }) ] }), jsx('pre', { className: 'max-h-44 overflow-auto whitespace-pre-wrap px-3 pb-2 font-mono text-[0.66rem] leading-[1.35] text-(--ui-text-tertiary)', children: s.buildLog })] }) }

// ---------------------------------------------------------------- section nav（编辑栏下方：跳到下一节）
const SEC_RE = /^\s*\\(chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{/
// 文档包含顺序：从 main.tex 出发沿 \input/\include/\subfile 展开文件出现顺序
// （论文是碎片结构：main → chapters/2/chapter.tex → 2-01…2-08，节标题在碎片里，必须按包含链跨文件找）
async function docFileOrder(root) {
  const order = []
  const seen = new Set()
  const INC_RE = /\\(?:input|include|subfile)\{([^}]+)\}/g
  const readTex = async (rel) => {
    try { const r = await rest(`/read?path=${encodeURIComponent(root + '/' + rel)}`); return (r && r.text) || '' } catch { return null }
  }
  async function walk(rel, parentDir) {
    rel = String(rel).trim().replace(/\\/g, '/')
    if (!/\.tex$/i.test(rel)) rel += '.tex'
    if (seen.has(rel)) return
    seen.add(rel)
    let text = await readTex(rel)
    if (text == null) {
      // 兼容相对父文件目录的写法：root/chapters/2/chapter.tex 里 \input{2-01}
      const alt = parentDir ? parentDir + '/' + rel : rel
      if (seen.has(alt)) return
      text = await readTex(alt)
      if (text == null) return
      rel = alt
      seen.add(rel)
    }
    order.push(rel)
    const dir = rel.split('/').slice(0, -1).join('/')
    let m
    INC_RE.lastIndex = 0
    while ((m = INC_RE.exec(text))) await walk(m[1], dir)
  }
  await walk('main.tex', '')
  return order
}

function SectionNav() {
  const s = useValue(ui)
  if (!s.file) return null
  const nextSection = async () => {
    const st = ui.get()
    if (st.diff) { host.notify({ kind: 'info', message: '差异视图打开时不可用，先关闭差异' }); return }
    const lines = st.text.split('\n')
    for (let i = Math.max(0, cursorLine); i < lines.length; i++) { // cursorLine 是 1-based 当前行，从其下一行开始找
      if (SEC_RE.test(lines[i])) { if (editorJumpFn) editorJumpFn(i + 1); return }
    }
    // 当前文件后面没有了 → 按文档包含顺序（main.tex 的 \input 链）找下一个文件的第一个节标题
    const root = normPath(st.root)
    const order = await docFileOrder(root)
    const cur = String(st.file).replace(/\\/g, '/')
    const idx = order.findIndex(f => cur === f || cur.endsWith('/' + f) || f.endsWith('/' + cur))
    for (const f of order.slice(idx + 1)) {
      try {
        const r = await rest(`/read?path=${encodeURIComponent(root + '/' + f)}`)
        const fl = String((r && r.text) || '').split('\n')
        for (let i = 0; i < fl.length; i++) {
          if (SEC_RE.test(fl[i])) { openFile(f, i + 1); return }
        }
      } catch {}
    }
    host.notify({ kind: 'info', message: '已到文档末尾，后面没有更多节' })
  }
  const prevSection = async () => {
    const st = ui.get()
    if (st.diff) { host.notify({ kind: 'info', message: '差异视图打开时不可用，先关闭差异' }); return }
    const lines = st.text.split('\n')
    for (let i = Math.min(lines.length - 1, cursorLine - 2); i >= 0; i--) { // 从当前行上一行往上找
      if (SEC_RE.test(lines[i])) { if (editorJumpFn) editorJumpFn(i + 1); return }
    }
    // 当前文件前面没有了 → 按文档包含顺序往前找上一个文件的最后一个节标题
    const root = normPath(st.root)
    const order = await docFileOrder(root)
    const cur = String(st.file).replace(/\\/g, '/')
    const idx = order.findIndex(f => cur === f || cur.endsWith('/' + f) || f.endsWith('/' + cur))
    for (let k = idx - 1; k >= 0; k--) {
      const f = order[k]
      try {
        const r = await rest(`/read?path=${encodeURIComponent(root + '/' + f)}`)
        const fl = String((r && r.text) || '').split('\n')
        for (let i = fl.length - 1; i >= 0; i--) {
          if (SEC_RE.test(fl[i])) { openFile(f, i + 1); return }
        }
      } catch {}
    }
    host.notify({ kind: 'info', message: '已到文档开头，前面没有更多节' })
  }
  return jsxs('div', { className: 'flex items-center gap-1.5 border-b border-(--ui-stroke-secondary) px-2 py-1', children: [
    jsx('button', { type: 'button', className: btn, onClick: prevSection, title: '从当前光标向上找最近的节标题；本文件没有就按文档结构跳到上一个文件的最后一个节', children: '上一节 ↑' }),
    jsx('button', { type: 'button', className: btn, onClick: nextSection, title: '从当前光标向下找最近的 \\section/\\subsection/\\subsubsection/\\chapter；本文件没有就按文档结构（main.tex 的 \\input 链）跳到下一个文件的节', children: '下一节 ↓' }),
    jsx('span', { className: 'text-[0.66rem] text-(--ui-text-quaternary)', children: '按文档结构找相邻节（可跨文件）' }),
  ] })
}

// ---------------------------------------------------------------- resizer
function Resizer() {
  const s = useValue(ui) // reactive splitPct
  const containerRef = useRef(null)
  const onPointerDown = useCallback((e) => {
    e.preventDefault()
    const container = containerRef.current || e.currentTarget.parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    function onMove(ev) {
      const pct = Math.max(15, Math.min(80, ((ev.clientX - rect.left) / rect.width * 100)))
      patch({ splitPct: +pct.toFixed(1) })
    }
    function onUp() { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp) }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [])

  return jsx('div', { ref: containerRef, className: 'flex w-full min-h-0 flex-1 items-stretch select-none', style: { touchAction: 'none' }, children: [
    // editor side (width controlled by splitPct)：编辑器 + 其下方的常驻待办面板（可收起）
    jsx('div', { className: 'min-w-0 overflow-hidden border-r border-(--ui-stroke-secondary)', style: { width: s.splitPct + '%' }, children:
      jsxs('div', { className: 'flex h-full min-h-0 flex-col', children: [
        jsx('div', { className: 'min-h-0 flex-1 overflow-hidden', children: s.diff ? DiffView() : Editor() }),
        s.todoOpen ? jsx(TodoPanel, {}) : null,
      ] })
    }),
    // drag handle
    jsx('div', { className: 'flex w-[5px] shrink-0 cursor-col-resize items-center justify-center bg-transparent hover:bg-(--ui-accent)/30 active:bg-(--ui-accent)/50', onPointerDown, title: '拖拽调整宽度' }),
    // pdf side (fills remaining)
    jsx('div', { className: 'min-w-0 flex-1 overflow-hidden', children: PdfPane() }),
  ] })
}

// ---------------------------------------------------------------- root pane
function LatexStudioPane() {
  const s = useValue(ui)
  useEffect(() => { injectLspCss() }) // 每次渲染都覆盖 <style> 为当前 CSS（无依赖：热重载/重渲染双保险）
  useEffect(() => {
    const stop = api.socket('/ws/status', (frame) => { try { const d = typeof frame === 'string' ? JSON.parse(frame) : frame; if (d && d.type === 'build' && d.state === 'done' && !ui.get().building) refreshPdf(true) } catch {} })
    return stop
  }, [])
  return jsxs('div', { className: 'flex h-full min-h-0 flex-col text-(--ui-text-primary)', children: [
    Toolbar(),
    jsx(SectionNav, {}), // 编辑栏正下方、全宽的「下一节」导航条（不在编辑器里）
    jsx(Resizer, {}),
    LogPanel(),
  ] })
}

// ---------------------------------------------------------------- plugin
export default {
  id: 'latex-studio', name: 'LaTeX Studio',
  register(c) {
    api = c
    c.register({ id: 'pane', area: 'panes', title: 'latex', data: { placement: 'right', width: '720px' }, render: () => jsx(LatexStudioPane, {}) })
    c.register({ id: 'reveal', area: 'keybinds', data: { id: 'latex-studio.reveal', label: 'Toggle LaTeX Studio pane', defaults: ['ctrl+alt+l'], run: revealLatexPane } })
    c.register({ id: 'reveal', area: 'palette', data: { id: 'latex-studio.reveal', label: '打开 LaTeX 编辑面板', action: 'latex-studio:reveal', keywords: ['latex', 'tex', '论文', 'thesis', 'pdf', '编辑', 'pane'], run: revealLatexPane } })
    c.register({ id: 'tex-button', area: 'statusBar.right', order: 90, data: { id: 'latex-studio.tex', variant: 'action', className: 'w-7 justify-center px-0', title: 'LaTeX 编辑面板 (Ctrl+Alt+L)', toggleLabel: 'LaTeX Studio', icon: jsx('span', { style: { fontSize: '0.7rem', fontWeight: 600 }, children: 'TeX' }), onSelect: () => revealLatexPane() } })
  },
}
