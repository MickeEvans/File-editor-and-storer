"""Agent v1 context building: whole-folder-in-context.

Every readable text file under the scoped folder is loaded and stuffed
into the system prompt. No retrieval, no embeddings — that's Phase 4,
when folders outgrow the context window.
"""

from pathlib import Path

from .. import config
from ..config import file_type
from ..scanner import iter_workspace_files

# Rough guard so a huge folder can't blow the request. ~200K chars is far
# below the 1M-token context window; revisit when Phase 4 adds retrieval.
MAX_CONTEXT_CHARS = 200_000

SYSTEM_TEMPLATE = """You are the workspace agent in a local-first notes app. \
The user's workspace holds Markdown notes (.md), HTML slide decks (.html), and CSV data (.csv). \
You are scoped to one folder; its full contents are below. Answer questions about these files, \
summarize them, and help the user think. Be concise and concrete; refer to files by their path. \
If the answer isn't in the folder, say so.

You can change files: use the propose_file_edit tool with the complete new file contents. \
The user reviews each proposal and applies it with one click, so propose edits whenever the \
user asks you to write, change, fix, or add something — don't just describe what they could do. \
Files the user mentioned with @ are included under <referenced-file> tags.

Scoped folder: {folder}

{files}"""


def build_folder_context(folder: Path, referenced: list[Path] | None = None) -> str:
    """Render the system prompt with every text file in `folder` inlined,
    plus any explicitly @-referenced files from elsewhere in the workspace."""
    rel_folder = folder.relative_to(config.WORKSPACE_ROOT).as_posix() if folder != config.WORKSPACE_ROOT else "/"

    parts = []
    used = 0
    skipped = []
    scoped_files = set()
    for path in iter_workspace_files(folder):
        scoped_files.add(path)
        rel = path.relative_to(config.WORKSPACE_ROOT).as_posix()
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

    for path in referenced or []:
        if path in scoped_files:
            continue  # already included above
        rel = path.relative_to(config.WORKSPACE_ROOT).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            skipped.append(f"{rel} (not readable as text)")
            continue
        if used + len(content) > MAX_CONTEXT_CHARS:
            skipped.append(f"{rel} (too large for context)")
            continue
        used += len(content)
        parts.append(f'<referenced-file path="{rel}" type="{file_type(path)}">\n{content}\n</referenced-file>')

    if skipped:
        parts.append("Files not included: " + ", ".join(skipped))
    if not parts:
        parts.append("(The folder is empty.)")

    return SYSTEM_TEMPLATE.format(folder=rel_folder, files="\n\n".join(parts))
