"""Agent context building — lean by default.

The agent always gets a *map* of the scoped folder (paths, types, sizes).
Full file contents are inlined only when they're cheap or explicitly wanted:
  - the whole folder, if its total content is small enough
  - files the user @-referenced
  - the file currently open in the editor
  - index files (_index.md / README.md) that describe a folder
This keeps requests fast and token-light; the folder map tells the model
what exists so it can ask the user to @-reference what it's missing.
"""

from pathlib import Path

from .. import config
from ..config import file_type
from ..scanner import iter_workspace_files

# If the scoped folder's total content fits under this, just include it all.
INLINE_ALL_BUDGET = 30_000
# Hard cap for everything we inline, however it qualified.
MAX_CONTEXT_CHARS = 200_000
# Folder-describing files that are always included (Obsidian-style indexes).
INDEX_NAMES = {"_index.md", "index.md", "readme.md"}

SYSTEM_TEMPLATE = """You are the workspace agent embedded in the user's local notes app \
(Markdown notes, HTML slide decks, CSV data). Treat this like a normal chat conversation \
that happens to know the user's files.

Behavior:
- Answer the question that was asked, directly. Do NOT summarize files unless the user asks for a summary.
- Match answer length to the request: short question, short answer.
- Refer to files by their path. The folder map lists everything that exists in scope.
- You have tools: search_files (full-text search of the whole workspace), read_file, and get_links \
(wiki-link graph: [[links]] between notes, both directions). If the contents you need aren't inlined \
below, find and read them yourself — don't ask the user to paste anything.
- When the user asks you to write, change, fix, or add content, use the propose_file_edit tool with the COMPLETE \
new file contents. Edits are applied to disk immediately (the user can undo with one click), so act — don't describe \
what the user could do. Read a file before rewriting it unless its current contents are already shown.
- Notes may link to each other with [[wiki-links]]; use get_links to traverse related notes when context helps.

Scoped folder: {folder}

Folder map:
{tree}

{files}"""


def _file_block(path: Path, tag: str = "file") -> str | None:
    rel = path.relative_to(config.WORKSPACE_ROOT).as_posix()
    try:
        content = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None
    return f'<{tag} path="{rel}" type="{file_type(path)}">\n{content}\n</{tag}>'


def build_folder_context(
    folder: Path,
    referenced: list[Path] | None = None,
    open_file: Path | None = None,
) -> str:
    rel_folder = folder.relative_to(config.WORKSPACE_ROOT).as_posix() if folder != config.WORKSPACE_ROOT else "/"

    scoped = list(iter_workspace_files(folder))
    total_size = 0
    tree_lines = []
    for path in scoped[:400]:
        rel = path.relative_to(config.WORKSPACE_ROOT).as_posix()
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        total_size += size
        tree_lines.append(f"- {rel} ({file_type(path)}, {size} bytes)")
    if len(scoped) > 400:
        tree_lines.append(f"...and {len(scoped) - 400} more files")
    tree = "\n".join(tree_lines) or "(empty folder)"

    inline_all = total_size <= INLINE_ALL_BUDGET

    blocks = []
    included: set[Path] = set()
    used = 0

    def try_include(path: Path, tag: str) -> None:
        nonlocal used
        if path in included:
            return
        block = _file_block(path, tag)
        if block is None or used + len(block) > MAX_CONTEXT_CHARS:
            return
        used += len(block)
        blocks.append(block)
        included.add(path)

    for path in scoped:
        if inline_all or path.name.lower() in INDEX_NAMES or path == open_file:
            try_include(path, "file")

    if open_file is not None and open_file.is_file():
        try_include(open_file, "file")  # even when it's outside the scoped folder

    for path in referenced or []:
        try_include(path, "referenced-file")

    if not inline_all:
        blocks.append(
            "Note: the folder's full contents were too large to inline. The folder map above "
            "lists every file — use search_files and read_file to get what you need."
        )
    if not blocks:
        blocks.append("(The folder is empty.)")

    return SYSTEM_TEMPLATE.format(folder=rel_folder, tree=tree, files="\n\n".join(blocks))