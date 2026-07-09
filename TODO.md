# Project TODO — Unified Notes / Slides / Data Workspace

A local-first web app: folder tree on the left, tabs in the middle (Markdown notes,
HTML slides, CSV data), with a swappable AI agent scoped to the current folder.

The **filesystem is the source of truth** for content (`.md` / `.html` / `.csv`).
**SQLite is the index + the agent's memory** — never the store for the documents themselves.

## Guiding principle: walking skeleton

Build one thin slice end-to-end first (list folder → open a file → view it), then widen.
Always keep the app runnable. Do phases in order; within a phase, top to bottom.

## Decisions locked for v1

- [x] CSV = **view / edit only**. No formula evaluation in v1.
- [x] Frontend = **plain HTML / CSS / JavaScript**. No framework yet.
- [x] Agent = **simple**. Whole-folder-in-context (read files, stuff into prompt). No embeddings yet.

## Stack

- [x] Backend: Python + **FastAPI**
- [x] DB: **SQLite** via SQLAlchemy (single file, zero-config)
- [ ] Frontend: plain JS, with libraries for the editors:
  - [x] Markdown → CodeMirror or EasyMDE (EasyMDE, vendored in static/vendor)
  - [x] Slides → **reveal.js** (vendored; sections wrapped in a reveal scaffold at preview time)
  - [x] Data → grid library (v1: lightweight custom grid, no library; revisit if it outgrows it)

---

## Phase 0 — Skeleton

- [x] Create repo + Python virtualenv
- [x] Install FastAPI + an ASGI server (uvicorn)
- [x] FastAPI app that serves one static `index.html`
- [x] Confirm "hello world" renders in the browser

## Phase 1 — File backbone (no editing yet)  ← walking skeleton

- [x] Choose a workspace root folder (config value / env var for now)
- [x] Backend: endpoint to list the folder tree (recursive)
- [x] Backend: endpoint to read a single file's contents
- [x] Frontend: render the folder tree in a left sidebar
- [x] Frontend: click a file → show its raw text in the main area
- [x] SQLite: `files` table (path, type, size, modified) indexing what's on disk
- [x] Backend: a "scan" that syncs the folder into the `files` table

## Phase 2 — The tabs (one editor at a time)

### 2a. Markdown tab (do first — easiest, highest value)
- [x] Wire in the markdown editor library
- [x] Live preview alongside the editor
- [x] Backend: endpoint to write/save file contents
- [x] Save edits back to the `.md` file on disk
- [x] Re-sync `files` table on save

### 2b. Data tab (CSV — view/edit only)
- [x] Text/Grid switch in the tab bar (raw CSV ↔ grid with separated cells)
- [x] Load a `.csv` into the grid (read)
- [x] Edit cells in the grid (contenteditable, proper CSV quoting on save)
- [x] Save the grid back to the `.csv` file
- [ ] (Deferred to a later version: formula evaluation)

### 2c. Slides tab (HTML)
- [x] Wire in reveal.js
- [x] Render an `.html` file as a slideshow (files with `<section>` slides; plain HTML previews as-is)
- [x] Code/Preview switch in the tab bar (source ↔ sandboxed iframe render)
- [x] Edit the underlying source
- [x] Preview updates after edit + save (preview reflects unsaved edits too)

### 2d. Extras
- [x] "New file" button in the sidebar (creates parents, refuses overwrite, opens the file)
- [x] Plain-text editing + save for any other text file

## Phase 3 — Agent v1 (simple)

- [x] Define an LLM-provider adapter interface (so the provider is swappable)
- [x] Implement one concrete provider behind the adapter (Anthropic / Claude Opus 4.8; plus an offline `echo` provider for dev)
- [x] Chat panel in the UI (Agent button in the tab bar; scoped to the open file's folder)
- [x] "Read the folder" = load every file's contents into the prompt context (capped at ~200K chars until Phase 4)
- [x] Command: summarize the current folder
- [x] Command: answer questions about the folder's contents
- [x] Store chat history in SQLite (`chat_messages` table, per folder)

## Phase 4 — Agent v2 (scale + editing)

- [ ] Add embeddings + vector search in SQLite (for folders too big for context)
- [ ] Retrieve only relevant files instead of dumping everything
- [x] Let the agent *propose* edits to files (propose_file_edit tool; full-file rewrites)
- [x] Require explicit user confirmation before any file is written (Apply/Dismiss cards in chat; proposals persist in chat history)
- [x] @file references in chat with autocomplete (pulls out-of-scope files into context)

## Phase 5 — Polish  [later]

- [ ] Tags on files
- [ ] Folder-wide search
- [ ] Settings screen (workspace root, chosen LLM provider)
- [ ] Support multiple workspaces

---

## Open questions to revisit later

- [ ] When to migrate off plain JS (revisit if shared tab-state gets painful)
- [ ] CSV formulas — design when/if they enter scope
- [ ] Whole-folder-context → embeddings threshold (what folder size forces the switch?)
