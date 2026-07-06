"""FastAPI app: serves the static frontend and the file-backbone API.

API:
  GET  /api/tree          — recursive folder tree of the workspace
  GET  /api/file?path=... — one file's raw contents
  PUT  /api/file          — write a file's contents back to disk
  GET  /api/files         — what the SQLite index currently holds
  POST /api/scan          — re-sync disk -> files table
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import PROJECT_ROOT, WORKSPACE_ROOT, file_type
from .database import FileRecord, SessionLocal, init_db
from .scanner import IGNORED_DIRS, scan_workspace

STATIC_DIR = PROJECT_ROOT / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    init_db()
    scan_workspace()
    yield


app = FastAPI(title="Workspace", lifespan=lifespan)


def resolve_in_workspace(rel_path: str) -> Path:
    """Resolve a client-supplied relative path, rejecting anything that
    escapes the workspace root (e.g. ../../secrets)."""
    target = (WORKSPACE_ROOT / rel_path).resolve()
    if target != WORKSPACE_ROOT and WORKSPACE_ROOT not in target.parents:
        raise HTTPException(status_code=400, detail="Path escapes workspace root")
    return target


def build_tree(directory: Path) -> list[dict]:
    entries = []
    for path in sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if path.name in IGNORED_DIRS:
            continue
        rel = path.relative_to(WORKSPACE_ROOT).as_posix()
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
    return {"root": str(WORKSPACE_ROOT), "tree": build_tree(WORKSPACE_ROOT)}


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
        "path": target.relative_to(WORKSPACE_ROOT).as_posix(),
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
        "path": target.relative_to(WORKSPACE_ROOT).as_posix(),
        "type": file_type(target),
        "size": stat.st_size,
        "modified": stat.st_mtime,
    }


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
