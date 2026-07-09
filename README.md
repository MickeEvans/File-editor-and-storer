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

By default the workspace is the folder **containing** this project (`..`), so
task folders live next to the app's code — create them with the "+ Folder"
button. The `code` folder itself is hidden from the workspace and protected
from edits. Set a different root with the `WORKSPACE_ROOT` environment variable.

## Agent

The Agent button (top right) opens a chat panel scoped to the current folder —
the agent reads every file in the folder before answering. Configuration via
environment variables, set before starting the server:

| Variable            | Default          | Meaning                                        |
| ------------------- | ---------------- | ---------------------------------------------- |
| `ANTHROPIC_API_KEY` | —                | Anthropic API key (or log in with `ant auth login`) |
| `LLM_PROVIDER`      | `anthropic`      | Which provider adapter to use (`anthropic` or `echo`) |
| `LLM_MODEL`         | `claude-opus-4-8`| Model for the Anthropic provider               |

`LLM_PROVIDER=echo` needs no credentials and just echoes back — handy for
developing offline. Chat history is stored per folder in SQLite.

## Layout

| Path         | What                                              |
| ------------ | ------------------------------------------------- |
| `app/`       | FastAPI backend (API + SQLite index + scanner)    |
| `static/`    | Plain HTML/CSS/JS frontend                        |
| `../`        | Default workspace root (`.md`/`.html`/`.csv` task folders) |
| `TODO.md`    | Phased roadmap — walking-skeleton style           |


# How to run the graphify nodes

```bash
Invoke-Item "graphify-out\graph.html"
```