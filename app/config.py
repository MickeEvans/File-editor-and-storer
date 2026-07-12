"""Configuration. The workspace root is switchable at runtime (folder
picker in the UI) and persisted in settings.json. Precedence at startup:
WORKSPACE_ROOT env var > settings.json > the folder containing this project.

Modules must read it via `config.WORKSPACE_ROOT` (module attribute) or
`get_workspace_root()` — never `from .config import WORKSPACE_ROOT`, which
would freeze the value at import time."""

import json
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SETTINGS_PATH = PROJECT_ROOT / "settings.json"


def _load_settings() -> dict:
    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_settings(settings: dict) -> None:
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def _initial_workspace_root() -> Path:
    if os.environ.get("WORKSPACE_ROOT"):
        return Path(os.environ["WORKSPACE_ROOT"]).resolve()
    saved = _load_settings().get("workspace_root")
    if saved and Path(saved).is_dir():
        return Path(saved).resolve()
    return PROJECT_ROOT.parent


WORKSPACE_ROOT = _initial_workspace_root()


def get_workspace_root() -> Path:
    return WORKSPACE_ROOT


def set_workspace_root(path: Path) -> None:
    """Switch the workspace at runtime and remember it for next start.
    Every root ever switched to is kept in the known-workspaces list."""
    global WORKSPACE_ROOT
    path = path.resolve()
    if not path.is_dir():
        raise ValueError(f"Not a folder: {path}")
    previous = str(WORKSPACE_ROOT)
    WORKSPACE_ROOT = path
    settings = _load_settings()
    settings["workspace_root"] = str(path)
    known = settings.get("workspaces", [])
    # Remember both sides of the switch — the old root was possibly only
    # ever implicit (startup default) and would otherwise vanish.
    for root in (str(path), previous):
        if root not in known:
            known.insert(0, root)
    settings["workspaces"] = known
    _save_settings(settings)


def list_workspaces() -> list[str]:
    """Every workspace the app knows about, current one included."""
    known = _load_settings().get("workspaces", [])
    current = str(WORKSPACE_ROOT)
    return ([current] if current not in known else []) + known


def forget_workspace(path: str) -> None:
    """Drop a root from the known-workspaces list (doesn't touch the folder)."""
    settings = _load_settings()
    settings["workspaces"] = [w for w in settings.get("workspaces", []) if w != path]
    _save_settings(settings)


# ----- LLM provider (settings screen) -----

KNOWN_PROVIDERS = ("anthropic", "echo")


def get_llm_provider() -> str:
    """The LLM_PROVIDER env var wins (keeps the dev echo server on port 8001
    pinned to echo); otherwise the value chosen in the settings screen."""
    return (
        os.environ.get("LLM_PROVIDER")
        or _load_settings().get("llm_provider")
        or "anthropic"
    ).lower()


def set_llm_provider(name: str) -> None:
    if name not in KNOWN_PROVIDERS:
        raise ValueError(f"Unknown provider: {name!r} (supported: {', '.join(KNOWN_PROVIDERS)})")
    settings = _load_settings()
    settings["llm_provider"] = name
    _save_settings(settings)

DB_PATH = PROJECT_ROOT / "index.db"

# File extensions the workspace understands. Everything else is listed
# but tagged "other" so the UI can grey it out.
KNOWN_TYPES = {
    ".md": "markdown",
    ".txt": "text",
    ".html": "slides",
    ".csv": "data",
    ".pdf": "pdf",
}


def file_type(path: Path) -> str:
    return KNOWN_TYPES.get(path.suffix.lower(), "other")
