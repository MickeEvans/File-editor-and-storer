"""Tool implementations the agent can call during a chat turn.

All read tools are safe by construction (path-validated, size-capped).
apply_edit writes immediately but records the previous contents so the
user can undo from the chat card.
"""

import re

from fastapi import HTTPException
from sqlalchemy import text as sql

from .. import config
from ..database import engine
from ..workspace import resolve_in_workspace

MAX_READ_CHARS = 50_000
SEARCH_LIMIT = 8


class ToolContext:
    """Per-chat-turn tool executor. Collects the edits the agent applied."""

    def __init__(self, folder_rel: str = ""):
        self.folder_rel = folder_rel
        self.edits: list[dict] = []

    # ----- search -----

    def search_files(self, query: str) -> list[dict]:
        tokens = re.findall(r"[\w\-åäöÅÄÖüÜéÉ]+", query)
        if not tokens:
            return []
        match = " OR ".join(f'"{t}"' for t in tokens)
        prefix = self.folder_rel + "/" if self.folder_rel else ""
        with engine.connect() as conn:
            rows = conn.execute(
                sql(
                    "SELECT path, snippet(files_fts, 1, '>>', '<<', ' … ', 12) AS snip, bm25(files_fts) AS score "
                    "FROM files_fts WHERE files_fts MATCH :q ORDER BY score LIMIT 50"
                ),
                {"q": match},
            ).fetchall()
        results = []
        for path, snip, score in rows:
            in_scope = path.startswith(prefix) if prefix else True
            results.append({"path": path, "snippet": snip, "in_scope": in_scope})
        # Prefer in-scope hits, keep overall relevance order
        results.sort(key=lambda r: (not r["in_scope"],))
        return results[:SEARCH_LIMIT]

    # ----- read -----

    def read_file(self, path: str) -> str:
        target = resolve_in_workspace(path)
        if not target.is_file():
            return f"Error: no such file: {path}"
        try:
            content = target.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            return f"Error: {path} is not readable as text"
        if len(content) > MAX_READ_CHARS:
            return content[:MAX_READ_CHARS] + f"\n…[truncated — file has {len(content)} chars total]"
        return content

    # ----- graph -----

    def get_links(self, path: str) -> dict:
        rel = resolve_in_workspace(path).relative_to(config.WORKSPACE_ROOT).as_posix()
        with engine.connect() as conn:
            outgoing = conn.execute(
                sql("SELECT target, resolved FROM note_links WHERE src = :p"), {"p": rel}
            ).fetchall()
            backlinks = conn.execute(
                sql("SELECT DISTINCT src FROM note_links WHERE resolved = :p"), {"p": rel}
            ).fetchall()
        return {
            "outgoing": [{"target": t, "resolved": r} for t, r in outgoing],
            "backlinks": [b for (b,) in backlinks],
        }

    # ----- edit -----

    def apply_edit(self, path: str, content: str) -> str:
        """Write a file immediately; record previous contents for undo.
        Returns a result string for the model."""
        record = {"path": path, "content": content, "status": "blocked"}
        try:
            target = resolve_in_workspace(path)
            if target.is_dir():
                raise HTTPException(status_code=400, detail="Path is a folder")
            record["previous"] = target.read_text(encoding="utf-8") if target.is_file() else None
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            record["status"] = "applied"
            result = f"Applied: wrote {len(content)} chars to {path}."
        except HTTPException as exc:
            record["error"] = exc.detail
            result = f"Error: {exc.detail}"
        self.edits.append(record)
        return result
