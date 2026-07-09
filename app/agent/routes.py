"""Chat API for the folder-scoped agent.

  GET    /api/chat?folder=...  — history for a folder
  POST   /api/chat             — send a message, get the agent's reply
  DELETE /api/chat?folder=...  — clear a folder's history
"""

import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config
from ..database import ChatMessage, SessionLocal
from .context import build_folder_context
from .providers import ProviderError, get_provider

router = APIRouter(prefix="/api/chat", tags=["chat"])

# Only the most recent turns go to the model; everything stays in the DB.
HISTORY_TURNS_FOR_MODEL = 20


def resolve_folder(folder: str) -> Path:
    target = (config.WORKSPACE_ROOT / folder).resolve()
    if target != config.WORKSPACE_ROOT and config.WORKSPACE_ROOT not in target.parents:
        raise HTTPException(status_code=400, detail="Folder escapes workspace root")
    if not target.is_dir():
        raise HTTPException(status_code=404, detail=f"No such folder: {folder or '/'}")
    return target


class ChatRequest(BaseModel):
    folder: str = ""  # relative to workspace root; "" = whole workspace
    message: str


@router.get("")
def get_history(folder: str = ""):
    resolve_folder(folder)
    session = SessionLocal()
    try:
        rows = (
            session.query(ChatMessage)
            .filter_by(folder=folder)
            .order_by(ChatMessage.created_at, ChatMessage.id)
            .all()
        )
        return {"folder": folder, "messages": [r.as_dict() for r in rows]}
    finally:
        session.close()


@router.post("")
def send_message(req: ChatRequest):
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Message is empty")
    target = resolve_folder(req.folder)

    session = SessionLocal()
    try:
        history = (
            session.query(ChatMessage)
            .filter_by(folder=req.folder)
            .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
            .limit(HISTORY_TURNS_FOR_MODEL)
            .all()
        )
        history.reverse()

        model_messages = [{"role": r.role, "content": r.content} for r in history]
        model_messages.append({"role": "user", "content": req.message})

        system = build_folder_context(target)
        try:
            reply = get_provider().complete(system, model_messages)
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=str(exc))

        now = time.time()
        session.add(ChatMessage(folder=req.folder, role="user", content=req.message, created_at=now))
        assistant_row = ChatMessage(
            folder=req.folder, role="assistant", content=reply, created_at=time.time()
        )
        session.add(assistant_row)
        session.commit()
        return assistant_row.as_dict()
    finally:
        session.close()


@router.delete("")
def clear_history(folder: str = ""):
    resolve_folder(folder)
    session = SessionLocal()
    try:
        deleted = session.query(ChatMessage).filter_by(folder=folder).delete()
        session.commit()
        return {"deleted": deleted}
    finally:
        session.close()
