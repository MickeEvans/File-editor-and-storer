"""Agent v1 context building: whole-folder-in-context.

Every readable text file under the scoped folder is loaded and stuffed
into the system prompt. No retrieval, no embeddings — that's Phase 4,
when folders outgrow the context window.
"""

from pathlib import Path

from ..config import WORKSPACE_ROOT, file_type
from ..scanner import iter_workspace_files

# Rough guard so a huge folder can't blow the request. ~200K chars is far
# below the 1M-token context window; revisit when Phase 4 adds retrieval.
MAX_CONTEXT_CHARS = 200_000

SYSTEM_TEMPLATE = """You are the workspace agent in a local-first notes app. \
The user's workspace holds Markdown notes (.md), HTML slide decks (.html), and CSV data (.csv). \
You are scoped to one folder; its full contents are below. Answer questions about these files, \
summarize them, and help the user think. Be concise and concrete; refer to files by their path. \
If the answer isn't in the folder, say so.

Scoped folder: {folder}

{files}"""


def build_folder_context(folder: Path) -> str:
    """Render the system prompt with every text file in `folder` inlined."""
    rel_folder = folder.relative_to(WORKSPACE_ROOT).as_posix() if folder != WORKSPACE_ROOT else "/"

    parts = []
    used = 0
    skipped = []
    for path in iter_workspace_files(folder):
        rel = path.relative_to(WORKSPACE_ROOT).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            skipped.append(f"{rel} (not readable as text)")
            continue
        if used + len(content) > MAX_CONTEXT_CHARS:
            skipped.append(f"{rel} (folder too large for context)")
            continue
        used += len(content)
        parts.append(f'<file path="{rel}" type="{file_type(path)}">\n{content}\n</file>')

    if skipped:
        parts.append("Files not included: " + ", ".join(skipped))
    if not parts:
        parts.append("(The folder is empty.)")

    return SYSTEM_TEMPLATE.format(folder=rel_folder, files="\n\n".join(parts))
