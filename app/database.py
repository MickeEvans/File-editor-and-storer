"""SQLite index via SQLAlchemy. The DB never stores document content —
only metadata about what exists on disk (and, later, agent memory)."""

import json

from sqlalchemy import Column, Float, Integer, String, create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import DB_PATH

engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False)

Base = declarative_base()


class ChatMessage(Base):
    """Agent chat history, per scoped folder. This is agent memory, not
    document storage — documents stay on disk."""

    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True)
    folder = Column(String, nullable=False, index=True)  # "" = workspace root
    role = Column(String, nullable=False)  # user | assistant
    content = Column(String, nullable=False)
    created_at = Column(Float, nullable=False)  # unix timestamp
    extra = Column(String, nullable=True)  # JSON: {"proposals": [...]} for agent edits

    def as_dict(self) -> dict:
        extra = json.loads(self.extra) if self.extra else {}
        return {
            "id": self.id,
            "folder": self.folder,
            "role": self.role,
            "content": self.content,
            "created_at": self.created_at,
            "proposals": extra.get("proposals", []),
        }


class FileRecord(Base):
    __tablename__ = "files"

    id = Column(Integer, primary_key=True)
    path = Column(String, unique=True, nullable=False, index=True)  # relative to workspace root, posix-style
    type = Column(String, nullable=False)  # markdown | slides | data | other
    size = Column(Integer, nullable=False)
    modified = Column(Float, nullable=False)  # mtime as unix timestamp

    def as_dict(self) -> dict:
        return {
            "path": self.path,
            "type": self.type,
            "size": self.size,
            "modified": self.modified,
        }


def init_db() -> None:
    Base.metadata.create_all(engine)
    # Lightweight migration for DBs created before the `extra` column existed
    with engine.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN extra VARCHAR"))
            conn.commit()
        except OperationalError:
            pass  # column already there
    with engine.connect() as conn:
        # Full-text index over file contents (BM25 ranking via FTS5) and the
        # wiki-link graph between notes — both maintained by the scanner.
        conn.execute(text(
            "CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(path UNINDEXED, content)"
        ))
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS note_links ("
            "src VARCHAR NOT NULL, target VARCHAR NOT NULL, resolved VARCHAR)"
        ))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_note_links_src ON note_links(src)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_note_links_resolved ON note_links(resolved)"))
        conn.commit()
