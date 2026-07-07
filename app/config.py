"""Configuration. Workspace root comes from the WORKSPACE_ROOT env var,
falling back to the folder that contains this project — so task folders
live next to (not inside) the app's code."""

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

WORKSPACE_ROOT = Path(
    os.environ.get("WORKSPACE_ROOT", PROJECT_ROOT.parent)
).resolve()

DB_PATH = PROJECT_ROOT / "index.db"

# File extensions the workspace understands. Everything else is listed
# but tagged "other" so the UI can grey it out.
KNOWN_TYPES = {
    ".md": "markdown",
    ".html": "slides",
    ".csv": "data",
}


def file_type(path: Path) -> str:
    return KNOWN_TYPES.get(path.suffix.lower(), "other")
