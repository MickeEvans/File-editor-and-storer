"""FastAPI app: serves the static frontend and the file-backbone API.

API:
  GET  /api/tree           — recursive folder tree of the workspace
  GET  /api/file?path=...  — one file's text contents
  GET  /api/file/raw       — one file's raw bytes (PDF viewer)
  PUT  /api/file           — write a file's contents back to disk
  POST /api/folder         — create a folder
  GET  /api/files          — what the SQLite index currently holds
  GET  /api/search?q=...   — workspace-wide full-text search (#tag filters)
  GET  /api/graph          — the wiki-link graph (nodes + edges)
  GET  /api/tags           — all tags with file counts
  POST /api/scan           — re-sync disk -> files table
  GET  /api/workspace      — current workspace root
  POST /api/workspace/pick — open the native folder picker and switch root
  POST /api/workspace/switch — switch to a known workspace root
  POST /api/workspace/forget — drop a root from the known-workspaces list
  GET  /api/settings       — settings for the UI (provider, workspaces)
  PUT  /api/settings       — change the LLM provider
"""

import os
import re
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text as sql

from . import config
from .agent.routes import router as chat_router
from .config import PROJECT_ROOT, file_type
from .database import FileRecord, SessionLocal, engine, init_db
from .scanner import is_hidden_from_workspace, scan_workspace
from .workspace import resolve_in_workspace

STATIC_DIR = PROJECT_ROOT / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    init_db()
    scan_workspace()
    yield


app = FastAPI(title="Workspace", lifespan=lifespan)
app.include_router(chat_router)


def build_tree(directory: Path) -> list[dict]:
    entries = []
    for path in sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if is_hidden_from_workspace(path):
            continue
        rel = path.relative_to(config.WORKSPACE_ROOT).as_posix()
        if path.is_dir():
            entries.append(
                {"name": path.name, "path": rel, "kind": "folder", "children": build_tree(path)}
            )
        else:
            entries.append(
                {"name": path.name, "path": rel, "kind": "file", "type": file_type(path)}
            )
    return entries


@app.get("/api/tree")
def get_tree():
    return {"root": str(config.WORKSPACE_ROOT), "tree": build_tree(config.WORKSPACE_ROOT)}


@app.get("/api/file")
def get_file(path: str = Query(..., description="Path relative to the workspace root")):
    target = resolve_in_workspace(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"No such file: {path}")
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=415, detail="Not a text file")
    rel = target.relative_to(config.WORKSPACE_ROOT).as_posix()
    with engine.connect() as conn:
        tags = [
            t for (t,) in conn.execute(
                sql("SELECT DISTINCT tag FROM file_tags WHERE path = :p ORDER BY tag"), {"p": rel}
            ).fetchall()
        ]
    return {
        "path": rel,
        "type": file_type(target),
        "content": content,
        "tags": tags,
    }


@app.get("/api/file/raw")
def get_file_raw(path: str = Query(..., description="Path relative to the workspace root")):
    """Serve a file's raw bytes. Only for types the browser renders natively
    (PDF) — text files go through /api/file, and serving arbitrary HTML raw
    would run it same-origin with the app."""
    target = resolve_in_workspace(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"No such file: {path}")
    if file_type(target) != "pdf":
        raise HTTPException(status_code=415, detail="Raw access is only for PDF files")
    return FileResponse(target, media_type="application/pdf")


class FileWritePayload(BaseModel):
    path: str
    content: str
    create_parents: bool = False  # make missing parent folders (used by "new file")
    overwrite: bool = True        # set False to refuse clobbering an existing file


@app.put("/api/file")
def save_file(payload: FileWritePayload):
    """Write contents to a file inside the workspace, then re-sync the index."""
    target = resolve_in_workspace(payload.path)
    if target.is_dir():
        raise HTTPException(status_code=400, detail="Path is a folder")
    if file_type(target) == "pdf":
        raise HTTPException(status_code=415, detail="PDF files are read-only in the workspace")
    if target.exists() and not payload.overwrite:
        raise HTTPException(status_code=409, detail="File already exists")
    if not target.parent.is_dir():
        if payload.create_parents:
            target.parent.mkdir(parents=True, exist_ok=True)
        else:
            raise HTTPException(status_code=404, detail="Parent folder does not exist")
    target.write_text(payload.content, encoding="utf-8")
    scan_workspace()
    stat = target.stat()
    return {
        "path": target.relative_to(config.WORKSPACE_ROOT).as_posix(),
        "type": file_type(target),
        "size": stat.st_size,
        "modified": stat.st_mtime,
    }


# Runs in a subprocess so tkinter gets its own main thread. The dialog is a
# real Windows Explorer folder picker, shown on the machine the server runs
# on — which is the user's own machine in this local-first app.
FOLDER_PICKER_SCRIPT = """
import sys, tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
root.attributes("-topmost", True)
path = filedialog.askdirectory(title="Choose workspace folder", initialdir=sys.argv[1])
print(path or "")
"""


def workspace_info() -> dict:
    root = config.WORKSPACE_ROOT
    return {"root": str(root), "name": root.name or str(root)}


@app.get("/api/workspace")
def get_workspace():
    return workspace_info()


@app.post("/api/workspace/pick")
def pick_workspace():
    """Open the native folder picker; if the user chooses a folder, switch
    the workspace root to it, persist the choice, and re-index."""
    try:
        result = subprocess.run(
            [sys.executable, "-c", FOLDER_PICKER_SCRIPT, str(config.WORKSPACE_ROOT)],
            capture_output=True, text=True, timeout=300,
        )
    except subprocess.TimeoutExpired:
        return {"cancelled": True, **workspace_info()}

    chosen = result.stdout.strip()
    if not chosen:
        return {"cancelled": True, **workspace_info()}
    return _switch_to(Path(chosen))


def _switch_to(new_root: Path) -> dict:
    """Shared guts of pick/switch: validate, switch, re-index."""
    if new_root == PROJECT_ROOT or PROJECT_ROOT in new_root.parents:
        raise HTTPException(
            status_code=400,
            detail="That folder is inside the app's own code — pick another one.",
        )
    try:
        config.set_workspace_root(new_root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    scan_workspace()
    return {"cancelled": False, **workspace_info()}


class WorkspacePayload(BaseModel):
    root: str


@app.post("/api/workspace/switch")
def switch_workspace(payload: WorkspacePayload):
    """Switch to a workspace root by path (used by the settings screen)."""
    return _switch_to(Path(payload.root))


@app.post("/api/workspace/forget")
def forget_workspace(payload: WorkspacePayload):
    """Remove a root from the known-workspaces list. The current workspace
    can't be forgotten, and no folder on disk is touched."""
    if Path(payload.root) == config.WORKSPACE_ROOT:
        raise HTTPException(status_code=400, detail="Can't forget the active workspace")
    config.forget_workspace(payload.root)
    return {"workspaces": config.list_workspaces()}


@app.get("/api/settings")
def get_settings():
    return {
        "workspace": workspace_info(),
        "workspaces": config.list_workspaces(),
        "provider": config.get_llm_provider(),
        "providers": list(config.KNOWN_PROVIDERS),
        # When the env var is set it overrides the saved choice, so the
        # settings UI shows the picker as locked.
        "provider_locked_by_env": "LLM_PROVIDER" in os.environ,
    }


class SettingsPayload(BaseModel):
    provider: str


@app.put("/api/settings")
def update_settings(payload: SettingsPayload):
    try:
        config.set_llm_provider(payload.provider.lower())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return get_settings()


class FolderCreatePayload(BaseModel):
    path: str


@app.post("/api/folder")
def create_folder(payload: FolderCreatePayload):
    """Create a (possibly nested) folder inside the workspace."""
    name = payload.path.strip().strip("/\\")
    if not name:
        raise HTTPException(status_code=400, detail="Folder name is empty")
    target = resolve_in_workspace(name)
    if target == config.WORKSPACE_ROOT:
        raise HTTPException(status_code=400, detail="Folder name is empty")
    if target.exists():
        raise HTTPException(status_code=409, detail="That name already exists")
    target.mkdir(parents=True)
    return {"path": target.relative_to(config.WORKSPACE_ROOT).as_posix()}


@app.get("/api/graph")
def get_graph():
    """The wiki-link graph: every markdown note is a node (orphans included),
    resolved links become edges to real files, unresolved [[targets]] become
    dim ghost nodes — Obsidian-style."""
    with engine.connect() as conn:
        files = dict(conn.execute(sql("SELECT path, type FROM files")).fetchall())
        links = conn.execute(sql("SELECT src, target, resolved FROM note_links")).fetchall()

    def label(path: str) -> str:
        name = path.rsplit("/", 1)[-1]
        return name.rsplit(".", 1)[0] if "." in name else name

    nodes: dict[str, dict] = {
        path: {"id": path, "label": label(path), "type": ftype, "ghost": False}
        for path, ftype in files.items()
        if ftype == "markdown"
    }
    edges: set[tuple[str, str]] = set()
    for src, target, resolved in links:
        if src not in nodes:
            continue
        if resolved:
            if resolved not in nodes:  # a link to a non-markdown file
                nodes[resolved] = {
                    "id": resolved, "label": label(resolved),
                    "type": files.get(resolved, "other"), "ghost": False,
                }
            if resolved != src:
                edges.add((src, resolved))
        else:
            ghost = f"ghost:{target.strip().lower()}"
            nodes.setdefault(
                ghost, {"id": ghost, "label": target.strip(), "type": "ghost", "ghost": True}
            )
            edges.add((src, ghost))

    return {
        "nodes": list(nodes.values()),
        "edges": [{"source": s, "target": t} for s, t in sorted(edges)],
    }


@app.get("/api/tags")
def list_tags():
    """Every tag in the workspace with how many files carry it."""
    with engine.connect() as conn:
        rows = conn.execute(sql(
            "SELECT tag, COUNT(DISTINCT path) FROM file_tags GROUP BY tag ORDER BY tag"
        )).fetchall()
    return {"tags": [{"tag": t, "count": c} for t, c in rows]}


SEARCH_RESULT_LIMIT = 30


@app.get("/api/search")
def search(q: str = Query(..., description="Search words; #tokens filter by tag")):
    """Workspace-wide search over the FTS5 index (BM25 ranked). Tokens
    starting with # are tag filters; the rest is full-text matched. Snippets
    mark matches with \x02…\x03 so the frontend can escape-then-highlight."""
    tag_filters = {t.lower() for t in re.findall(r"#([\w/\-]+)", q)}
    text_tokens = re.findall(r"[\w\-åäöÅÄÖüÜéÉ]+", re.sub(r"#[\w/\-]+", " ", q))

    results = []
    with engine.connect() as conn:
        if text_tokens:
            match = " OR ".join(f'"{t}"' for t in text_tokens)
            rows = conn.execute(
                sql(
                    "SELECT f.path, f.type, snippet(files_fts, 1, char(2), char(3), ' … ', 14) AS snip "
                    "FROM files_fts JOIN files f ON f.path = files_fts.path "
                    "WHERE files_fts MATCH :q ORDER BY bm25(files_fts) LIMIT :n"
                ),
                {"q": match, "n": SEARCH_RESULT_LIMIT * 2},
            ).fetchall()
            results = [{"path": p, "type": t, "snippet": s} for p, t, s in rows]
        elif tag_filters:
            # Tag-only query: list every file carrying the first tag
            rows = conn.execute(
                sql(
                    "SELECT f.path, f.type FROM file_tags ft JOIN files f ON f.path = ft.path "
                    "WHERE ft.tag = :t ORDER BY f.path LIMIT :n"
                ),
                {"t": sorted(tag_filters)[0], "n": SEARCH_RESULT_LIMIT * 2},
            ).fetchall()
            results = [{"path": p, "type": t, "snippet": ""} for p, t in rows]

        if tag_filters and results:
            # Keep only files that carry ALL requested tags
            placeholders = ", ".join(f":t{i}" for i in range(len(tag_filters)))
            params = {f"t{i}": t for i, t in enumerate(sorted(tag_filters))}
            params["n"] = len(tag_filters)
            tagged = {
                p for (p,) in conn.execute(
                    sql(
                        f"SELECT path FROM file_tags WHERE tag IN ({placeholders}) "
                        "GROUP BY path HAVING COUNT(DISTINCT tag) = :n"
                    ),
                    params,
                ).fetchall()
            }
            results = [r for r in results if r["path"] in tagged]

    return {"query": q, "results": results[:SEARCH_RESULT_LIMIT]}


@app.get("/api/files")
def list_indexed_files():
    session = SessionLocal()
    try:
        records = session.query(FileRecord).order_by(FileRecord.path).all()
        return {"files": [r.as_dict() for r in records]}
    finally:
        session.close()


@app.post("/api/scan")
def rescan():
    return scan_workspace()


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
