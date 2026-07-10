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
    open_file: str | None = None  # file currently open in the editor, if any


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
        open_file = None
        if req.open_file:
            try:
                open_file = resolve_in_workspace(req.open_file)
            except HTTPException:
                open_file = None
        system = build_folder_context(target, referenced=referenced, open_file=open_file)
        try:
            reply = get_provider().complete(system, model_messages)
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=str(exc))

        # Apply the agent's edits immediately; each one keeps the previous
        # contents so the user can undo with one click.
        applied_any = False
        for proposal in reply.proposals:
            try:
                target_file = resolve_in_workspace(proposal["path"])
                if target_file.is_dir():
                    raise HTTPException(status_code=400, detail="Path is a folder")
                proposal["previous"] = (
                    target_file.read_text(encoding="utf-8") if target_file.is_file() else None
                )
                target_file.parent.mkdir(parents=True, exist_ok=True)
                target_file.write_text(proposal["content"], encoding="utf-8")
                proposal["status"] = "applied"
                applied_any = True
            except HTTPException as exc:
                proposal["status"] = "blocked"
                proposal["error"] = exc.detail
        if applied_any:
            scan_workspace()

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
    action: str  # "undo" | "apply" | "dismiss" (last two for legacy pending cards)


@router.post("/proposal")
def act_on_proposal(req: ProposalAction):
    """Undo an applied agent edit (or apply/dismiss a legacy pending one)."""
    if req.action not in ("undo", "apply", "dismiss"):
        raise HTTPException(status_code=400, detail="action must be undo, apply or dismiss")

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

        if req.action == "undo":
            if proposal["status"] != "applied":
                raise HTTPException(status_code=409, detail=f"Can't undo: {proposal['status']}")
            target = resolve_in_workspace(proposal["path"])
            previous = proposal.get("previous")
            if previous is None:
                # The edit created this file — undo removes it
                if target.is_file():
                    target.unlink()
            else:
                target.write_text(previous, encoding="utf-8")
            scan_workspace()
            proposal["status"] = "undone"
        elif req.action == "apply":
            if proposal["status"] != "pending":
                raise HTTPException(status_code=409, detail=f"Already {proposal['status']}")
            target = resolve_in_workspace(proposal["path"])
            if target.is_dir():
                raise HTTPException(status_code=400, detail="Path is a folder")
            proposal["previous"] = target.read_text(encoding="utf-8") if target.is_file() else None
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(proposal["content"], encoding="utf-8")
            scan_workspace()
            proposal["status"] = "applied"
        else:
            if proposal["status"] != "pending":
                raise HTTPException(status_code=409, detail=f"Already {proposal['status']}")
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
