"""Sync what's on disk into SQLite: the `files` table (metadata index),
the `files_fts` full-text index (BM25 search), and the `note_links`
wiki-link graph ([[target]] links between notes).

The filesystem is the source of truth: the scan upserts every file found
under the workspace root and deletes rows for files that no longer exist.
Content indexing is incremental — only added/changed files are re-read.
"""

import re
from pathlib import Path

from sqlalchemy import text as sql

from . import config
from .config import PROJECT_ROOT, file_type
from .database import FileRecord, SessionLocal, engine

# Don't index the content of files bigger than this (metadata still tracked)
MAX_INDEXED_SIZE = 512_000
WIKI_LINK_RE = re.compile(r"\[\[([^\]|#\n]+)(?:[#|][^\]]*)?\]\]")

# Obsidian-style inline tags: #tag, #nested/tag, #multi-word-tag. Must start
# with a letter (so "# Heading" and "#123" don't count) and not be glued to
# a preceding word character or another #.
INLINE_TAG_RE = re.compile(r"(?<![\w#])#([A-Za-zÅÄÖåäöÜü][\w/\-]*)")
FRONTMATTER_TAGS_RE = re.compile(
    r"^tags:\s*(?:\[([^\]]*)\]|(.+))$", re.MULTILINE | re.IGNORECASE
)


def extract_tags(content: str) -> set[str]:
    """Tags for one markdown file: frontmatter `tags:` plus inline #tags
    outside code fences. Normalized to lowercase."""
    tags: set[str] = set()

    body = content
    if content.startswith("---\n"):
        end = content.find("\n---", 4)
        if end != -1:
            frontmatter = content[4:end]
            body = content[end + 4:]
            m = FRONTMATTER_TAGS_RE.search(frontmatter)
            if m:
                raw = m.group(1) if m.group(1) is not None else m.group(2)
                tags.update(
                    t.strip().strip("#\"'").lower()
                    for t in raw.split(",") if t.strip().strip("#\"'")
                )

    # Drop fenced code blocks so `#include` etc. don't become tags
    body = re.sub(r"```.*?```", "", body, flags=re.DOTALL)
    tags.update(m.group(1).lower() for m in INLINE_TAG_RE.finditer(body))
    return tags

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


def _index_content(conn, rel: str, path: Path) -> None:
    """(Re)build the FTS row, outgoing wiki-links, and tags for one file."""
    conn.execute(sql("DELETE FROM files_fts WHERE path = :p"), {"p": rel})
    conn.execute(sql("DELETE FROM note_links WHERE src = :p"), {"p": rel})
    conn.execute(sql("DELETE FROM file_tags WHERE path = :p"), {"p": rel})
    try:
        if path.stat().st_size > MAX_INDEXED_SIZE:
            return
        content = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return
    conn.execute(sql("INSERT INTO files_fts (path, content) VALUES (:p, :c)"), {"p": rel, "c": content})
    if rel.lower().endswith(".md"):
        for target in {m.group(1).strip() for m in WIKI_LINK_RE.finditer(content)}:
            conn.execute(
                sql("INSERT INTO note_links (src, target, resolved) VALUES (:s, :t, NULL)"),
                {"s": rel, "t": target},
            )
        for tag in extract_tags(content):
            conn.execute(
                sql("INSERT INTO file_tags (path, tag) VALUES (:p, :t)"), {"p": rel, "t": tag}
            )


def _resolve_links(conn, all_paths: set[str]) -> None:
    """Point each [[target]] at an actual file: exact path match first,
    then Obsidian-style match on the file's name without extension."""
    by_stem: dict[str, str] = {}
    for p in sorted(all_paths):
        stem = p.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()
        by_stem.setdefault(stem, p)
    rows = conn.execute(sql("SELECT rowid, target FROM note_links")).fetchall()
    for rowid, target in rows:
        t = target.strip().lower()
        resolved = None
        if target in all_paths:
            resolved = target
        elif t in by_stem:
            resolved = by_stem[t]
        elif t.rsplit(".", 1)[0] in by_stem:
            resolved = by_stem[t.rsplit(".", 1)[0]]
        conn.execute(sql("UPDATE note_links SET resolved = :r WHERE rowid = :id"), {"r": resolved, "id": rowid})


def scan_workspace() -> dict:
    """Upsert all files on disk into the index; prune rows for deleted files;
    keep the full-text index and wiki-link graph in sync."""
    session = SessionLocal()
    changed: list[tuple[str, Path]] = []
    removed_paths: list[str] = []
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
                changed.append((rel, path))
            elif record.size != stat.st_size or record.modified != stat.st_mtime:
                record.size = stat.st_size
                record.modified = stat.st_mtime
                record.type = file_type(path)
                updated += 1
                changed.append((rel, path))

        removed = 0
        for record in session.query(FileRecord).all():
            if record.path not in seen:
                removed_paths.append(record.path)
                session.delete(record)
                removed += 1

        session.commit()
    finally:
        session.close()

    with engine.connect() as conn:
        for rel in removed_paths:
            conn.execute(sql("DELETE FROM files_fts WHERE path = :p"), {"p": rel})
            conn.execute(sql("DELETE FROM note_links WHERE src = :p"), {"p": rel})
            conn.execute(sql("DELETE FROM file_tags WHERE path = :p"), {"p": rel})
        for rel, path in changed:
            _index_content(conn, rel, path)
        if changed or removed_paths:
            _resolve_links(conn, seen)
        conn.commit()

    return {"added": added, "updated": updated, "removed": removed, "total": len(seen)}
