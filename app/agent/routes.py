"""Chat API for the folder-scoped agent.

  GET    /api/chat?folder=...  — history for a folder
  POST   /api/chat             — send a message, get the agent's reply
  DELETE /api/chat?folder=...  — clear a folder's history
"""

import json
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config
from ..database import ChatMessage, FileRecord, SessionLocal
from ..scanner import scan_workspace
from ..workspace import resolve_in_workspace
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


def extract_referenced_files(message: str, session) -> list[Path]:
    """Find @path mentions by matching the message against the indexed file
    paths — handles spaces in filenames without any quoting rules."""
    referenced = []
    for record in session.query(FileRecord).all():
        if f"@{record.path}" in message:
            path = config.WORKSPACE_ROOT / record.path
            if path.is_file():
                referenced.append(path)
    return referenced


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

        referenced = extract_referenced_files(req.message, session)
        system = build_folder_context(target, referenced=referenced)
        try:
            reply = get_provider().complete(system, model_messages)
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=str(exc))

        now = time.time()
        session.add(ChatMessage(folder=req.folder, role="user", content=req.message, created_at=now))
        assistant_row = ChatMessage(
            folder=req.folder,
            role="assistant",
            content=reply.text,
            created_at=time.time(),
            extra=json.dumps({"proposals": reply.proposals}) if reply.proposals else None,
        )
        session.add(assistant_row)
        session.commit()
        return assistant_row.as_dict()
    finally:
        session.close()


class ProposalAction(BaseModel):
    message_id: int
    index: int  # which proposal in the message
    action: str  # "apply" | "dismiss"


@router.post("/proposal")
def act_on_proposal(req: ProposalAction):
    """Apply (write to disk) or dismiss a proposed file edit."""
    if req.action not in ("apply", "dismiss"):
        raise HTTPException(status_code=400, detail="action must be apply or dismiss")

    session = SessionLocal()
    try:
        row = session.query(ChatMessage).filter_by(id=req.message_id).one_or_none()
        if row is None or not row.extra:
            raise HTTPException(status_code=404, detail="No such proposal")
        extra = json.loads(row.extra)
        proposals = extra.get("proposals", [])
        if not 0 <= req.index < len(proposals):
            raise HTTPException(status_code=404, detail="No such proposal")
        proposal = proposals[req.index]
        if proposal["status"] != "pending":
            raise HTTPException(status_code=409, detail=f"Already {proposal['status']}")

        if req.action == "apply":
            target = resolve_in_workspace(proposal["path"])
            if target.is_dir():
                raise HTTPException(status_code=400, detail="Path is a folder")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(proposal["content"], encoding="utf-8")
            scan_workspace()
            proposal["status"] = "applied"
        else:
            proposal["status"] = "dismissed"

        row.extra = json.dumps(extra)
        session.commit()
        return {"status": proposal["status"], "path": proposal["path"]}
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
