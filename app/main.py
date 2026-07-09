"""FastAPI app: serves the static frontend and the file-backbone API.

API:
  GET  /api/tree           — recursive folder tree of the workspace
  GET  /api/file?path=...  — one file's raw contents
  PUT  /api/file           — write a file's contents back to disk
  POST /api/folder         — create a folder
  GET  /api/files          — what the SQLite index currently holds
  POST /api/scan           — re-sync disk -> files table
  GET  /api/workspace      — current workspace root
  POST /api/workspace/pick — open the native folder picker and switch root
"""

import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .agent.routes import router as chat_router
from .config import PROJECT_ROOT, file_type
from .database import FileRecord, SessionLocal, init_db
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
    return {
        "path": target.relative_to(config.WORKSPACE_ROOT).as_posix(),
        "type": file_type(target),
        "content": content,
    }


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

    new_root = Path(chosen)
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
