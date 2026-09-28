"""latex-studio desktop-plugin backend.

Mounted at /api/plugins/latex-studio/ by the dashboard plugin system.
Provides the small file/compile/sync primitives the latex-studio desktop
pane needs to edit .tex sources and preview the built PDF inside Hermes
Desktop:

  GET  /ping        -> availability of external tools
  GET  /scan        -> .tex / .pdf inventory under a project root
  GET  /read        -> UTF-8 text of a source file
  POST /save        -> write a source file (size-capped, extension-allowlisted)
  POST /build       -> latexmk (incremental or forced), serialized per root
  GET  /pdf-meta    -> page count + mtime of a PDF
  GET  /page        -> one PDF page rendered to PNG (base64)
  GET  /sync        -> SyncTeX forward search: (tex,line) -> (page,x,y,w,h)
  GET  /reverse     -> SyncTeX reverse lookup: (pdf page,x,y) -> (file,line,context)
  WS   /ws/status   -> build start/finish events for live UI updates

Security posture: single-user local machine tool. Paths must live inside the
request-provided project root (or be the root itself), source writes are
restricted to LaTeX-family extensions and 4 MiB, PDF reads to .pdf. No
shell=True anywhere.
"""

from __future__ import annotations

import asyncio
import base64
import difflib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)

router = APIRouter()

SOURCE_EXTS = {".tex", ".sty", ".cls", ".bib", ".txt", ".md"}
BUILD_TIMEOUT_DEFAULT_S = 600
MAX_SOURCE_BYTES = 4 * 1024 * 1024

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

_TOOLS: Dict[str, Optional[str]] = {}


def _tool(name: str) -> str:
    """Resolve an external tool, raising 501-style HTTPException when missing."""
    if name not in _TOOLS:
        _TOOLS[name] = shutil.which(name)
    path = _TOOLS[name]
    if not path:
        raise HTTPException(status_code=501, detail=f"external tool not found on PATH: {name}")
    return path


def _norm(p: str) -> Path:
    return Path(os.path.expanduser(os.path.expandvars((p or "").strip().strip('"')))).resolve()


def _inside(child: Path, root: Path) -> bool:
    try:
        child.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False


def _guard_source(path: Path) -> None:
    if path.suffix.lower() not in SOURCE_EXTS:
        raise HTTPException(status_code=400, detail=f"refusing to touch non-LaTeX file: {path.name}")


def _run(cmd: List[str], cwd: Path, timeout: float, encoding: str = "replace") -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding=None,
        errors=encoding,
        timeout=timeout,
        shell=False,
    )


def _tail(text: str, lines: int = 80) -> str:
    parts = (text or "").splitlines()
    return "\n".join(parts[-lines:])


def _png_size(data: bytes) -> tuple:
    # PNG signature(8) + chunk len(4) + 'IHDR'(4) + width(4BE) + height(4BE)
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return (0, 0)
    return (int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big"))


def _pdf_pages(pdf: Path) -> int:
    try:
        info = _run([_tool("pdfinfo"), str(pdf)], pdf.parent, 30)
        for line in (info.stdout or "").splitlines():
            if line.lower().startswith("pages"):
                return int("".join(ch for ch in line if ch.isdigit()) or 0)
    except Exception:
        pass
    # crude fallback: count /Type /Page occurrences
    try:
        raw = pdf.read_bytes()
        return max(0, raw.count(b"/Type /Page") - raw.count(b"/Type /Pages"))
    except OSError:
        return 0


# ---------------------------------------------------------------------------
# build state + websocket broadcast
# ---------------------------------------------------------------------------

_build_locks: Dict[str, threading.Lock] = {}
_build_locks_guard = threading.Lock()
_subscribers: set = set()
_loop: Optional[asyncio.AbstractEventLoop] = None


def _broadcast(payload: dict) -> None:
    """Fan out from any thread (latexmk executor included) to every WS drain.

    The drain queue lives on the event loop thread, so hop via
    call_soon_threadsafe — never touch asyncio primitives from the worker.
    """
    loop = _loop
    if loop is None or loop.is_closed() or not _subscribers:
        return
    try:
        loop.call_soon_threadsafe(_dispatch_local, payload)
    except RuntimeError:
        pass


def _dispatch_local(payload: dict) -> None:
    for q in list(_subscribers):
        try:
            q.push(payload)
        except Exception:
            pass


def _get_build_lock(root: Path) -> threading.Lock:
    key = str(root).lower()
    with _build_locks_guard:
        return _build_locks.setdefault(key, threading.Lock())


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------


@router.get("/ping")
async def ping() -> dict:
    return {
        "ok": True,
        "tools": {t: bool(shutil.which(t)) for t in ("latexmk", "xelatex", "pdftoppm", "pdfinfo", "synctex")},
    }


@router.get("/scan")
async def scan(root: str = Query(...)) -> dict:
    rootp = _norm(root)
    if not rootp.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {rootp}")

    files: List[dict] = []
    pdfs: List[str] = []
    for base, dirs, names in os.walk(rootp):
        basep = Path(base)
        # skip VCS + junk dirs
        dirs[:] = [d for d in dirs if not d.startswith(".") and d.lower() not in {"node_modules", "__pycache__", "dist", "build"}]
        for n in names:
            if n.startswith("."):
                continue
            ext = Path(n).suffix.lower()
            rel = (basep / n).relative_to(rootp).as_posix()
            if ext == ".pdf":
                pdfs.append(rel)
            elif ext in SOURCE_EXTS and ext != ".txt":
                stat = (basep / n).stat()
                files.append({"rel": rel, "size": stat.st_size, "mtime": int(stat.st_mtime * 1000)})
        if len(files) > 800:
            break

    files.sort(key=lambda f: (f["rel"].count("/"), f["rel"]))
    pdfs.sort()
    mains = [f["rel"] for f in files if Path(f["rel"]).name == "main.tex"]
    return {
        "root": str(rootp),
        "files": files,
        "pdfs": pdfs,
        "main": (mains[0] if mains else (files[0]["rel"] if files else None)),
        "pdf": next((p for p in pdfs if Path(p).name == "main.pdf"), pdfs[0] if pdfs else None),
    }


@router.get("/dirs")
async def dirs(path: str = Query("")) -> dict:
    """Lightweight directory browser: one level of subdirs under `path`.

    Empty path -> drive list on Windows, '/' on POSIX. Marks dirs that
    directly contain .tex files (cheap hint for the picker UI).
    """
    raw = (path or "").strip()
    if not raw:
        if os.name == "nt":
            import string
            drives = []
            for letter in string.ascii_uppercase:
                root = f"{letter}:\\"
                if os.path.exists(root):
                    drives.append({"name": f"{letter}:", "path": root, "has_tex": False})
            return {"path": "", "parent": None, "dirs": drives}
        raw = "/"

    p = _norm(raw)
    if not p.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {p}")

    SKIP = {"node_modules", "__pycache__", "dist", "build", ".git", "$recycle.bin", "system volume information"}
    entries: List[dict] = []
    try:
        with os.scandir(p) as it:
            for e in it:
                try:
                    if not e.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                name = e.name
                if name.startswith(".") or name.lower() in SKIP:
                    continue
                full = Path(e.path)
                has_tex = False
                try:
                    has_tex = any(
                        f.suffix.lower() == ".tex"
                        for f in full.iterdir()
                        if f.is_file()
                    )
                except OSError:
                    pass
                entries.append({"name": name, "path": str(full), "has_tex": has_tex})
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"permission denied: {p}")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"cannot list directory: {exc}")

    entries.sort(key=lambda d: d["name"].lower())
    parent = str(p.parent) if p.parent != p else None
    return {"path": str(p), "parent": parent, "dirs": entries}


def _is_tex_root(d: Path) -> bool:
    """A usable thesis project root: contains main.tex (preferred marker)."""
    try:
        return (d / "main.tex").is_file()
    except OSError:
        return False


# ---------------------------------------------------------------- skill pack
# Bundled copy of the latex-split-merge skill; /skill-install copies it into
# the live skills dir so the agent can load it by name.
_SKILL_NAME = "latex-split-merge"

def _skills_dir() -> Path:
    home = os.environ.get("HERMES_HOME")
    if not home:
        la = os.environ.get("LOCALAPPDATA")
        home = str(Path(la) / "hermes") if la else str(Path.home() / ".hermes")
    return Path(home) / "skills"

def _bundled_skill() -> Path:
    return Path(__file__).resolve().parent / "references" / "skill-latex-split-merge.md"

@router.get("/skill")
async def skill_status() -> dict:
    target = _skills_dir() / _SKILL_NAME / "SKILL.md"
    return {
        "name": _SKILL_NAME,
        "installed": target.is_file(),
        "path": str(target.parent),
        "bundled": _bundled_skill().is_file(),
    }

@router.post("/skill-install")
async def skill_install() -> dict:
    src = _bundled_skill()
    if not src.is_file():
        raise HTTPException(status_code=404, detail="插件缺少内置 skill 文件（升级不完整？）")
    dst_dir = _skills_dir() / _SKILL_NAME
    dst = dst_dir / "SKILL.md"
    if dst.is_file():
        return {"ok": True, "already": True, "path": str(dst_dir)}
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    return {"ok": True, "already": False, "path": str(dst_dir)}


@router.get("/structure")
async def structure(root: str = Query(...)) -> dict:
    """Detect include layout for the 按章/按节 buttons.

    folder/hybrid chapters = \include key K whose sibling folder K/ exists
    and contains .tex files (the sections). section_capable = at least one
    such chapter. Flat layout (main.tex + chapters/*.tex, no folders) ->
    chapter-only buttons in the UI.
    """
    rootp = _norm(root)
    main = rootp / "main.tex"
    if not main.is_file():
        return {"root": str(rootp), "ok": False, "chapters": [], "section_capable": False}
    src = main.read_text(encoding="utf-8", errors="replace")
    keys: List[str] = []
    for k in re.findall(r"(?m)^\\include\{([^}%]+)\}", src):
        k = k.strip()
        if k not in keys:
            keys.append(k)
    GENERIC = ("chapter", "ch", "main", "index")
    chapters: List[dict] = []
    for k in keys:
        kp = PurePosixPath(k)
        par = "" if str(kp.parent) == "." else str(kp.parent)
        folder = shell = None
        if (rootp / (k + ".tex")).is_file() and (rootp / k).is_dir():
            folder, shell = k, k                      # hybrid: chapters/3.tex + chapters/3/*.tex
        elif par and (kp.stem.lower() in GENERIC or kp.stem.lower() == PurePosixPath(par).name.lower()):
            folder, shell = par, k                    # folder: chapters/3/chapter.tex + chapters/3/*.tex
        if not folder:
            continue                                  # flat include -> no section folder
        dirp = rootp / folder
        if not dirp.is_dir():
            continue
        try:
            secs = sorted(str(f.relative_to(rootp)).replace("\\", "/")
                          for f in dirp.glob("*.tex"))
        except OSError:
            continue
        secs = [s for s in secs if str(PurePosixPath(s).with_suffix("")) != shell]
        if not secs:
            continue
        chapters.append({"key": k, "dir": folder, "shell": shell, "sections": secs})
    return {"root": str(rootp), "ok": True, "include_keys": keys,
            "chapters": chapters, "section_capable": bool(chapters)}


@router.get("/find-project")
async def find_project(path: str = Query(...)) -> dict:
    """Locate the LaTeX project for a conversation working dir.

    Walks UP from `path` (session cwd often is the repo root or a subdir of
    the thesis dir), then does one bounded DOWN pass (cwd = 论文-博士大论文
    while the latex repo lives in 大论文latex/). Returns the first root that
    directly contains main.tex.
    """
    start = _norm(path)
    if not start.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {path}")
    # 1) up to 5 levels up (cwd itself included)
    d, walked = start, 0
    while d is not None and walked <= 5:
        if _is_tex_root(d):
            return {"ok": True, "root": str(d), "how": "up" if walked else "self"}
        parent = d.parent if d.parent != d else None
        d, walked = parent, walked + 1
    # 2) down: immediate subdirs + subsubdirs, skip junk, bounded visits
    SKIP = {"node_modules", "__pycache__", "dist", "build", ".git", ".obsidian",
            "$recycle.bin", "system volume information", ".venv", "venv", ".cache"}
    budget = 300
    frontier = [start]
    depth = 0
    while frontier and depth < 2 and budget > 0:
        nxt: List[Path] = []
        for base in frontier:
            try:
                with os.scandir(base) as it:
                    for e in it:
                        if budget <= 0:
                            break
                        try:
                            if not e.is_dir(follow_symlinks=False):
                                continue
                        except OSError:
                            continue
                        if e.name.startswith(".") or e.name.lower() in SKIP:
                            continue
                        budget -= 1
                        cand = Path(e.path)
                        if _is_tex_root(cand):
                            return {"ok": True, "root": str(cand), "how": "down"}
                        nxt.append(cand)
            except OSError:
                continue
            if budget <= 0:
                break
        frontier, depth = nxt, depth + 1
    return {"ok": False, "reason": f"在 {start} 及其上下两级内没找到含 main.tex 的目录"}


@router.get("/read")
async def read(path: str = Query(...)) -> dict:
    p = _norm(path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {p}")
    _guard_source(p)
    stat = p.stat()
    if stat.st_size > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail=f"file too large: {stat.st_size} bytes")
    text = p.read_text(encoding="utf-8", errors="replace")
    return {"path": str(p), "text": text, "mtime": int(stat.st_mtime * 1000), "size": stat.st_size}


@router.post("/save")
async def save(body: dict) -> dict:
    p = _norm(str(body.get("path", "")))
    text = str(body.get("text", ""))
    _guard_source(p)
    root_raw = str(body.get("root", "")).strip()
    if root_raw:
        rootp = _norm(root_raw)
        if not _inside(p, rootp):
            raise HTTPException(status_code=400, detail="refusing to write outside the project root")
    if len(text.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="content too large")
    if not p.parent.is_dir():
        raise HTTPException(status_code=400, detail="parent directory does not exist")
    # atomic-ish write
    tmp = p.parent / (p.name + ".latexstudio.tmp")
    tmp.write_text(text, encoding="utf-8", newline="")
    os.replace(tmp, p)
    return {"ok": True, "path": str(p), "mtime": int(p.stat().st_mtime * 1000)}


@router.post("/build")
async def build(body: dict) -> dict:
    rootp = _norm(str(body.get("root", "")))
    if not rootp.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {rootp}")
    force = bool(body.get("force"))
    only = str(body.get("only") or "").strip().replace("\\", "/")
    timeout = min(int(body.get("timeout_s") or BUILD_TIMEOUT_DEFAULT_S), 1800)

    def _partial_wrapper() -> "str|None":
        """main.tex + \\includeonly{<chapter>} -> main_partial.tex. Returns chapter key.

        Two preview modes driven by `only`:
        * chapter  — only == an \\include key            -> that chapter only;
        * section  — only == <key>/<file> with a chapter
          folder <key>/ present on disk -> the chapter with every \\input
          commented out except the target section.

        Chapter-preview tweaks on top of plain \\includeonly:
        * suppress cover / declarations / abstract / TOC / lof / lot so the
          partial PDF is (almost) only the chapter under edit;
        * re-add the skipped \\mainmatter chapters *before* the target to the
          chapter counter, so the heading still reads e.g. "第3章" instead of
          restarting at 第1章.
        """
        main = rootp / "main.tex"
        if not main.is_file():
            raise HTTPException(status_code=404, detail="main.tex not found")
        src = main.read_text(encoding="utf-8", errors="replace")
        keys = [k.strip() for k in re.findall(r"(?m)^\\include\{([^}%]+)\}", src)]
        want = only[:-4] if only.endswith(".tex") else only
        key = next((k for k in keys if k == want), None)
        sec = None
        if key is None and want and ".." not in want.split("/"):
            # section mode. Two folder layouts qualify (see /structure):
            #  hybrid: include key `a/ch3` (file a/ch3.tex) + folder a/ch3/
            #  folder: include key `a/ch3/chapter` living inside folder a/ch3/
            P, _, tail = want.rpartition("/")
            if P and tail and (rootp / (want + ".tex")).is_file():
                if P in keys and (rootp / P).is_dir():
                    key, sec = P, tail                      # hybrid
                else:
                    for k in keys:
                        kp = PurePosixPath(k)
                        if str(kp.parent) == P and kp.stem.lower() in (
                                "chapter", "ch", "main", "index", PurePosixPath(P).name.lower()):
                            key, sec = k, tail              # folder
                            break
        if key is None:
            raise HTTPException(
                status_code=400,
                detail=f"{only} 不是 main.tex 的 \\include 章节（可选: {', '.join(keys) or '无'}）；"
                       "按节编译要求章节文件夹结构（章节名文件夹内含各节 .tex）",
            )
        if "\\begin{document}" not in src:
            raise HTTPException(status_code=400, detail="main.tex 无 \\begin{document}")
        key = key.strip()
        only_key = key
        if sec:
            # section mode: chapter file candidates, then a copy with every
            # \input commented out except the target section
            cands = [rootp / (key + ".tex"), rootp / key / (Path(key).name + ".tex"),
                     rootp / key / "chapter.tex", rootp / key / "ch.tex", rootp / key / "main.tex"]
            chap = next((c for c in cands if c.is_file()), None)
            if chap is None:
                raise HTTPException(status_code=400, detail=f"找不到 {key}.tex 或 {key}/ 文件夹内的章节文件，无法按节编译")
            stem = Path(sec).stem
            lines, kept = [], False
            for line in chap.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True):
                m = re.match(r"^\s*\\(?:input|subfile)\{([^}%]+)\}", line)
                if m:
                    if Path(m.group(1)).stem == stem:
                        kept = True
                    else:
                        lines.append("% LSPSKIP " + line)
                        continue
                lines.append(line)
            if not kept:
                raise HTTPException(status_code=400, detail=f"{chap.name} 中没有文件名匹配 “{stem}” 的 \\input 节文件，无法按节编译")
            # write the filtered copy next to the original chapter file so the
            # \\input targets inside keep resolving exactly as in a full build
            sub = PurePosixPath(key).parent
            base = "main_partial_" + PurePosixPath(key).name
            only_key = str(sub / base) if str(sub) != "." else base
            (rootp / str(only_key + ".tex")).write_text("".join(lines), encoding="utf-8", newline="\r\n")
            src = src.replace("\\include{%s}" % key, "\\include{%s}" % only_key)
        # skip front matter (title page, declarations, abstract, TOC, lists) —
        # preview only; final page numbers still require a full build.
        # line-scanner handles multi-line optional args like
        # \declarationofaiusage[\n  purpose={...}\n]
        skip_re = re.compile(
            r"^\s*\\(?:maketitle|declarationoforiginality|declarationofaiusage"
            r"|tableofcontents|listoffigures|listoftables|listoffiguresandtables)\b"
        )
        kept, depth, skipping = [], 0, False
        for line in src.splitlines(keepends=True):
            if skipping:
                depth += line.count("[") - line.count("]")
                if depth <= 0:
                    skipping = False
                continue
            if skip_re.match(line):
                depth = line.count("[") - line.count("]")
                skipping = depth > 0
                continue
            kept.append(line)
        wrapped = "".join(kept)
        # counter fix-up: count mainmatter includes before the target
        mm = src.find("\\mainmatter")
        add_ch = 0
        if mm != -1:
            main_keys = re.findall(
                r"(?m)^\\include\{([^}%]+)\}", src[mm:]
            )
            main_keys = [k.strip() for k in main_keys]
            if only_key in main_keys:
                add_ch = main_keys.index(only_key)
        insert = "\\includeonly{%s}\n" % only_key
        # 预览是连续页流：把 \cleardoublepage 降级为 \clearpage，否则 \mainmatter
        # 和 \chapter 的 openright 会各插一页空白（按节/按章预览开头两页空白）。
        # 导言区和 \begin{document} 后各放一次——后者压住宏包 AtBeginDocument 的重定义。
        insert += "\\let\\cleardoublepage\\clearpage\n"
        if add_ch:
            insert += "\\addtocounter{chapter}{%d}\n" % add_ch
        wrapped = wrapped.replace("\\begin{document}", insert + "\\begin{document}\n\\let\\cleardoublepage\\clearpage", 1)
        (rootp / "main_partial.tex").write_text(wrapped, encoding="utf-8", newline="\r\n")
        return only_key, sec

    def _run_build() -> dict:
        lock = _get_build_lock(rootp)
        if not lock.acquire(blocking=False):
            return {"ok": False, "busy": True, "log_tail": "另一个编译正在进行中。", "duration": 0}
        _broadcast({"type": "build", "state": "running", "root": str(rootp)})
        started = time.time()
        latexmk = _tool("latexmk")
        cmd = [latexmk, "-xelatex", "-interaction=nonstopmode"]
        if force:
            cmd.append("-g")
        pdf_out = "main.pdf"
        try:
            if only:
                # partial build: dedicated wrapper + jobname so the full
                # main.pdf is never clobbered; section previews get their own
                # jobname so their aux doesn't fight the chapter preview
                _only_key, sec = _partial_wrapper()
                job = "main_partial_section" if sec else "main_partial"
                cmd += [f"-jobname={job}", "main_partial.tex"]
                pdf_out = f"{job}.pdf"
            else:
                cmd.append("main.tex")
            proc = _run(cmd, rootp, timeout)
            out = (proc.stdout or "") + "\n" + (proc.stderr or "")
            ok = proc.returncode == 0
            result = {
                "ok": ok,
                "code": proc.returncode,
                "log_tail": _tail(out, 120),
                "duration": round(time.time() - started, 1),
                "root": str(rootp),
                "pdf": pdf_out,
                "only": only or None,
            }
        except subprocess.TimeoutExpired:
            result = {"ok": False, "code": -1, "log_tail": f"编译超时（>{timeout}s）", "duration": timeout}
        except HTTPException as exc:  # tool missing
            result = {"ok": False, "code": -1, "log_tail": str(exc.detail), "duration": 0}
        except Exception as exc:  # noqa: BLE001
            log.exception("latex build failed")
            result = {"ok": False, "code": -1, "log_tail": f"{type(exc).__name__}: {exc}", "duration": 0}
        finally:
            lock.release()
            _broadcast({"type": "build", "state": "done", "ok": result["ok"], "root": str(rootp)})
        return result

    # latexmk is slow; keep the event loop free
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run_build)


@router.get("/pdf-meta")
async def pdf_meta(path: str = Query(...)) -> dict:
    p = _norm(path)
    if not p.is_file() or p.suffix.lower() != ".pdf":
        raise HTTPException(status_code=404, detail=f"pdf not found: {p}")
    stat = p.stat()
    return {"path": str(p), "pages": _pdf_pages(p), "mtime": int(stat.st_mtime * 1000), "size": stat.st_size}


@router.get("/page")
async def page(path: str = Query(...), page: int = Query(..., ge=1, le=2000), dpi: int = Query(110, ge=50, le=300)) -> dict:
    p = _norm(path)
    if not p.is_file() or p.suffix.lower() != ".pdf":
        raise HTTPException(status_code=404, detail=f"pdf not found: {p}")

    def _render() -> dict:
        tool = _tool("pdftoppm")
        tmpdir = Path(tempfile.mkdtemp(prefix="latexstudio_"))
        try:
            prefix = tmpdir / "pg"
            _run(
                [tool, "-png", "-r", str(dpi), "-f", str(page), "-l", str(page), "-q", str(p), str(prefix)],
                tmpdir,
                60,
            )
            pngs = sorted(tmpdir.glob("*.png"))
            if not pngs:
                raise HTTPException(status_code=500, detail="pdftoppm produced no image")
            data = pngs[0].read_bytes()
            w, h = _png_size(data)
            return {"page": page, "dpi": dpi, "w": w, "h": h, "b64": base64.b64encode(data).decode("ascii")}
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _render)


@router.get("/sync")
async def sync(
    dir: str = Query(...),
    tex: str = Query(...),
    line: int = Query(..., ge=1, le=200000),
    col: int = Query(0, ge=0, le=5000),
    pdf: str = Query("main.pdf"),
) -> dict:
    dirp = _norm(dir)
    if not dirp.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {dirp}")
    target = f"{line}:{col}:{Path(tex).as_posix()}"

    def _view() -> dict:
        tool = _tool("synctex")
        # NOTE: the merged form "-i<arg>" mis-parses under Windows
        # CreateProcess (synctex reports "Missing -i required argument");
        # pass the value as a separate argv entry.
        proc = _run([tool, "view", "-i", target, "-o", Path(pdf).as_posix()], dirp, 30)
        out = (proc.stdout or "") + (proc.stderr or "")
        vals: Dict[str, float] = {}
        page_no = 0
        for ln in out.splitlines():
            ln = ln.strip()
            if ln.startswith("Page:") and not page_no:
                try:
                    page_no = int(ln.split(":", 1)[1])
                except ValueError:
                    pass
            elif ln[:2] in ("x:", "y:", "W:", "H:") and ln[0] not in vals:
                try:
                    vals[ln[0]] = float(ln.split(":", 1)[1])
                except ValueError:
                    pass
        if not page_no:
            raise HTTPException(status_code=404, detail="synctex: no forward mapping")
        return {"page": page_no, "x": vals.get("x", 0.0), "y": vals.get("y", 0.0), "w": vals.get("W", 0.0), "h": vals.get("H", 0.0)}

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _view)


@router.get("/reverse")
async def reverse(
    dir: str = Query(...),
    page: int = Query(..., ge=1, le=2000),
    x: float = Query(..., ge=0),
    y: float = Query(..., ge=0),
    pdf: str = Query("main.pdf"),
) -> dict:
    """Reverse SyncTeX: a point on the rendered PDF -> source file + line.

    `x`/`y` are in big points (72 dpi) measured from the page's TOP-LEFT
    corner — exactly what synctex edit expects, and what the frontend
    derives from the click position on the 110dpi render. Returns the
    absolute input path, line/column and a short context snippet so the
    UI can pre-fill a TODO with "which file / which section".
    """
    dirp = _norm(dir)
    if not dirp.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {dirp}")

    def _edit() -> dict:
        tool = _tool("synctex")
        target = f"{page}:{x:.1f}:{y:.1f}:{Path(pdf).as_posix()}"
        proc = _run([tool, "edit", "-o", target, "-d", "."], dirp, 30)
        out = (proc.stdout or "") + (proc.stderr or "")
        if "No tag" in out or not re.search(r"(?m)^Input:", out):
            raise HTTPException(status_code=404, detail="synctex: no reverse mapping here")
        res: Dict[str, Any] = {"page": page}
        for ln in out.splitlines():
            ln = ln.strip()
            if ln.startswith("Input:"):
                raw = ln[len("Input:"):]
                # synctex may emit a relative "./main.tex" or an absolute path;
                # normalize to an absolute, root-anchored form the frontend can use.
                p = Path(raw)
                res["input"] = str((dirp / p).resolve() if not p.is_absolute() else p.resolve())
            elif ln.startswith("Line:"):
                try:
                    res["line"] = int(ln.split(":", 1)[1])
                except ValueError:
                    pass
            elif ln.startswith("Column:"):
                try:
                    res["column"] = int(ln.split(":", 1)[1])
                except ValueError:
                    pass
            elif ln.startswith("Context:"):
                ctx = ln[len("Context:"):]
                if ctx.strip():
                    res["context"] = ctx.strip()[:200]
        return res

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _edit)


# ---------------------------------------------------------------------------
# websocket: cheap fan-out queue drained per client
# ---------------------------------------------------------------------------


class _Drain:
    def __init__(self) -> None:
        self._items: List[dict] = []
        self._event = asyncio.Event()

    def push(self, payload: dict) -> None:
        self._items.append(payload)
        self._event.set()

    async def wait(self) -> Optional[dict]:
        while not self._items:
            await self._event.wait()
            self._event.clear()
        return self._items.pop(0) if self._items else None


@router.post("/git-diff")
async def git_diff(body: dict) -> dict:
    """Unified diff: last committed version vs current (working) file.

    body: {root, file, text?}  — if `text` is given it is diffed instead of
    the file on disk (so unsaved editor content is reflected).
    """
    rootp = _norm(str(body.get("root", "")))
    if not rootp.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {rootp}")
    fp = _norm(str(body.get("file", "")))
    if not _inside(fp, rootp):
        raise HTTPException(status_code=400, detail="file outside project root")
    text: Optional[str] = body.get("text")

    def _run_diff() -> dict:
        git = shutil.which("git")
        if not git:
            raise HTTPException(status_code=501, detail="git not found on PATH")
        try:
            rel = fp.relative_to(rootp).as_posix()
            head = subprocess.run(
                [git, "show", f"HEAD:{rel}"], cwd=str(rootp),
                capture_output=True, timeout=20,
            )
            if head.returncode != 0:
                err = head.stderr.decode("utf-8", "replace")
                if "does not have a commit" in err or "bad revision" in err:
                    return {"ok": False, "reason": "仓库还没有任何提交，无 HEAD 可比"}
                if "does not match any file" in err or "exists on disk, but not in" in err:
                    return {"ok": False, "reason": f"{rel} 未被 git 跟踪（新文件）"}
                return {"ok": False, "reason": err.strip().splitlines()[-1] if err.strip() else "git show 失败"}
            committed = head.stdout.decode("utf-8", "replace").splitlines()
            if text is not None:
                current = text.replace("\r\n", "\n").replace("\r", "\n").splitlines()
                src_label = f"{rel}（编辑器未保存）"
            else:
                current = fp.read_text(encoding="utf-8", errors="replace").splitlines()
                src_label = f"{rel}（磁盘）"
            diff = list(difflib.unified_diff(
                committed, current, fromfile=f"a/{rel}", tofile=f"b/{src_label}",
                lineterm="", n=3,
            ))
            adds = sum(1 for d in diff if d.startswith("+") and not d.startswith("+++"))
            dels = sum(1 for d in diff if d.startswith("-") and not d.startswith("---"))
            return {"ok": True, "rel": rel, "diff": "\n".join(diff), "adds": adds, "dels": dels}
        except subprocess.TimeoutExpired:
            return {"ok": False, "reason": "git 命令超时"}
        except Exception as exc:  # noqa: BLE001
            log.exception("git-diff failed")
            return {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run_diff)


@router.post("/git-commit")
async def git_commit(body: dict) -> dict:
    """git add -A + commit。body: {root, message?}（message 空则自动 wip 时间戳）"""
    rootp = _norm(str(body.get("root", "")))
    if not rootp.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {rootp}")
    if not (rootp / ".git").exists():
        raise HTTPException(status_code=400, detail="不是 git 仓库")
    msg = str(body.get("message") or "").strip() or time.strftime("wip %Y-%m-%d %H:%M")

    def _run_commit() -> dict:
        git = shutil.which("git")
        if not git:
            raise HTTPException(status_code=501, detail="git not found on PATH")
        try:
            add = subprocess.run([git, "add", "-A"], cwd=str(rootp), capture_output=True, timeout=60)
            if add.returncode != 0:
                return {"ok": False, "log": add.stderr.decode("utf-8", "replace")}
            proc = subprocess.run([git, "commit", "-m", msg], cwd=str(rootp), capture_output=True, timeout=120)
            out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
            if proc.returncode != 0 and "nothing to commit" in out:
                return {"ok": True, "noop": True, "log": out}
            return {"ok": proc.returncode == 0, "message": msg, "log": _tail(out, 30)}
        except subprocess.TimeoutExpired:
            return {"ok": False, "log": "git 命令超时"}

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run_commit)


@router.post("/git-pull")
async def git_pull(body: dict) -> dict:
    """git pull --no-edit（合并远程）。body: {root}；返回 conflict/uptodate 标志"""
    rootp = _norm(str(body.get("root", "")))
    if not rootp.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {rootp}")
    if not (rootp / ".git").exists():
        raise HTTPException(status_code=400, detail="不是 git 仓库")

    def _run_pull() -> dict:
        git = shutil.which("git")
        if not git:
            raise HTTPException(status_code=501, detail="git not found on PATH")
        try:
            proc = subprocess.run([git, "pull", "--no-edit"], cwd=str(rootp), capture_output=True, timeout=300)
            out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
            return {"ok": proc.returncode == 0,
                    "conflict": "CONFLICT" in out,
                    "uptodate": "Already up to date" in out,
                    "log": _tail(out, 40)}
        except subprocess.TimeoutExpired:
            return {"ok": False, "log": "git pull 超时（>300s）"}

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run_pull)


@router.websocket("/ws/status")
async def ws_status(ws: WebSocket) -> None:
    global _loop
    _loop = asyncio.get_running_loop()
    await ws.accept()
    q = _Drain()
    _subscribers.add(q)
    try:
        await ws.send_text(json.dumps({"type": "hello", "ok": True}))
        while True:
            msg = await q.wait()
            if msg is None:
                continue
            await ws.send_text(json.dumps(msg, ensure_ascii=False))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        _subscribers.discard(q)
