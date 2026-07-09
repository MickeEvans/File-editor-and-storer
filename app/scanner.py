"""Sync what's on disk into the SQLite `files` table.

The filesystem is the source of truth: the scan upserts every file found
under the workspace root and deletes rows for files that no longer exist.
"""

from pathlib import Path

from . import config
from .config import PROJECT_ROOT, file_type
from .database import FileRecord, SessionLocal

# Folders that should never be indexed or shown in the tree.
IGNORED_DIRS = {".git", "__pycache__", "node_modules", ".venv"}


def is_hidden_from_workspace(path: Path) -> bool:
    """True for the app's own code folder, ignored dirs, and dot-folders —
    none of these belong in the user's workspace view or the agent context."""
    if path == PROJECT_ROOT or PROJECT_ROOT in path.parents:
        return True
    rel_parts = path.relative_to(config.WORKSPACE_ROOT).parts
    return any(part in IGNORED_DIRS or part.startswith(".") for part in rel_parts)


def iter_workspace_files(root: Path):
    for path in sorted(root.rglob("*")):
        if is_hidden_from_workspace(path):
            continue
        if path.is_file():
            yield path


def scan_workspace() -> dict:
    """Upsert all files on disk into the index; prune rows for deleted files."""
    session = SessionLocal()
    try:
        seen: set[str] = set()
        added = updated = 0

        for path in iter_workspace_files(config.WORKSPACE_ROOT):
            rel = path.relative_to(config.WORKSPACE_ROOT).as_posix()
            seen.add(rel)
            stat = path.stat()

            record = session.query(FileRecord).filter_by(path=rel).one_or_none()
            if record is None:
                session.add(
                    FileRecord(
                        path=rel,
                        type=file_type(path),
                        size=stat.st_size,
                        modified=stat.st_mtime,
                    )
                )
                added += 1
            elif record.size != stat.st_size or record.modified != stat.st_mtime:
                record.size = stat.st_size
                record.modified = stat.st_mtime
                record.type = file_type(path)
                updated += 1

        removed = 0
        for record in session.query(FileRecord).all():
            if record.path not in seen:
                session.delete(record)
                removed += 1

        session.commit()
        return {"added": added, "updated": updated, "removed": removed, "total": len(seen)}
    finally:
        session.close()
