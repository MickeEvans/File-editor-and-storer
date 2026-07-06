# Unified Notes / Slides / Data Workspace

Local-first web app: folder tree on the left, tabs for Markdown notes,
HTML slides and CSV data, with a folder-scoped AI agent (later phases).

- The **filesystem is the source of truth** (`workspace/` by default).
- **SQLite (`index.db`) is only the index** + agent memory — never document storage.

## Run

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000

Set a different workspace root with the `WORKSPACE_ROOT` environment variable.

## Layout

| Path         | What                                              |
| ------------ | ------------------------------------------------- |
| `app/`       | FastAPI backend (API + SQLite index + scanner)    |
| `static/`    | Plain HTML/CSS/JS frontend                        |
| `workspace/` | Default workspace content (`.md`/`.html`/`.csv`)  |
| `TODO.md`    | Phased roadmap — walking-skeleton style           |
