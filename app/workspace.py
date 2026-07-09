"""Shared workspace path safety: every client- or model-supplied path
goes through here before touching disk."""

from pathlib import Path

from fastapi import HTTPException

from . import config
from .config import PROJECT_ROOT


def resolve_in_workspace(rel_path: str) -> Path:
    """Resolve a relative path, rejecting anything that escapes the
    workspace root or points into the app's own code folder."""
    target = (config.WORKSPACE_ROOT / rel_path).resolve()
    if target != config.WORKSPACE_ROOT and config.WORKSPACE_ROOT not in target.parents:
        raise HTTPException(status_code=400, detail="Path escapes workspace root")
    if target == PROJECT_ROOT or PROJECT_ROOT in target.parents:
        raise HTTPException(status_code=400, detail="The app's code folder is off-limits")
    return target
