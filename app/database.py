"""SQLite index via SQLAlchemy. The DB never stores document content —
only metadata about what exists on disk (and, later, agent memory)."""

from sqlalchemy import Column, Float, Integer, String, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import DB_PATH

engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False)

Base = declarative_base()


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
