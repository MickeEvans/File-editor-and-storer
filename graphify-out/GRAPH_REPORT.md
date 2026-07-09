# Graph Report - .  (2026-07-09)

## Corpus Check
- Corpus is ~10,637 words - fits in a single context window. You may not need a graph.

## Summary
- 606 nodes · 1666 edges · 24 communities (17 shown, 7 thin omitted)
- Extraction: 81% EXTRACTED · 19% INFERRED · 0% AMBIGUOUS · INFERRED: 317 edges (avg confidence: 0.58)
- Token cost: 55,691 input · 0 output

## Community Hubs (Navigation)
- LLM Agent & Providers
- Reveal.js Page Activation (vendor)
- Frontend App UI Logic
- Reveal.js Plugin Loading (vendor)
- Project Docs & Config
- EasyMDE Internals A (vendor, minified)
- EasyMDE Internals B (vendor, minified)
- Reveal.js Overview/Hash Controllers (vendor)
- EasyMDE Internals C (vendor, minified)
- EasyMDE Internals D (vendor, minified)
- Reveal.js Fullscreen/Navigation (vendor)
- EasyMDE Internals E (vendor, minified)
- EasyMDE Internals F (vendor, minified)
- EasyMDE Internals G (vendor, minified)
- EasyMDE Internals H (vendor, minified)
- Reveal.js Auto-Animate (vendor)
- Reveal.js Touch/Swipe Handling (vendor)
- Reveal.js Progress Bar (vendor)
- EasyMDE Internals I (vendor, minified)
- Project Overview
- Workspace Root Config
- Uvicorn Dependency

## God Nodes (most connected - your core abstractions)
1. `i()` - 46 edges
2. `$()` - 46 edges
3. `t()` - 43 edges
4. `o()` - 42 edges
5. `n()` - 38 edges
6. `r()` - 35 edges
7. `C` - 35 edges
8. `a()` - 31 edges
9. `Y()` - 31 edges
10. `s()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `SQLite (index.db) is only the index + agent memory, never document storage` --semantically_similar_to--> `Decisions locked for v1`  [INFERRED] [semantically similar]
  README.md → TODO.md
- `Agent section (folder-scoped chat panel)` --semantically_similar_to--> `Phase 3 — Agent v1 (simple)`  [INFERRED] [semantically similar]
  README.md → TODO.md
- `LLM_PROVIDER environment variable` --semantically_similar_to--> `LLM-provider adapter interface (swappable provider)`  [INFERRED] [semantically similar]
  README.md → TODO.md
- `LLM_MODEL environment variable (default claude-opus-4-8)` --semantically_similar_to--> `Anthropic / Claude Opus 4.8 provider`  [INFERRED] [semantically similar]
  README.md → TODO.md
- `LLM_PROVIDER=echo offline dev provider` --semantically_similar_to--> `Offline echo provider for dev`  [INFERRED] [semantically similar]
  README.md → TODO.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Swappable LLM provider system (env config, adapter, Anthropic + echo providers)** — readme_llm_provider_env, todo_llm_provider_adapter, todo_anthropic_provider, todo_echo_provider, requirements_anthropic [INFERRED 0.85]
- **Folder-scoped agent chat feature (UI + phase + storage)** — readme_agent_section, todo_phase3_agent_v1, static_index_chat_panel, todo_chat_messages_table [INFERRED 0.85]
- **Three-tab editor pattern (markdown/CSV/slides) implemented across TODO phases and index.html panes** — todo_phase2a_markdown_tab, todo_phase2b_data_tab, todo_phase2c_slides_tab, static_index_editor_pane, static_index_csv_grid, static_index_html_preview [INFERRED 0.85]

## Communities (24 total, 7 thin omitted)

### Community 0 - "LLM Agent & Providers"
Cohesion: 0.05
Nodes (59): ABC, build_folder_context(), Path, Agent v1 context building: whole-folder-in-context.  Every readable text file un, Render the system prompt with every text file in `folder` inlined., AnthropicProvider, EchoProvider, get_provider() (+51 more)

### Community 1 - "Reveal.js Page Activation (vendor)"
Cohesion: 0.06
Nodes (4): C, N, T, U

### Community 2 - "Frontend App UI Logic"
Cohesion: 0.05
Nodes (60): addChatBubble(), addFileBtn, addFolderBtn, api(), buildPreviewDoc(), chatClearBtn, chatInputEl, chatMessagesEl (+52 more)

### Community 3 - "Reveal.js Plugin Loading (vendor)"
Cohesion: 0.05
Nodes (6): F, H, k(), P, R(), v

### Community 4 - "Project Docs & Config"
Cohesion: 0.07
Nodes (41): Agent section (folder-scoped chat panel), ANTHROPIC_API_KEY environment variable, LLM_PROVIDER=echo offline dev provider, Filesystem is the source of truth, app/ — FastAPI backend (API + SQLite index + scanner), static/ — Plain HTML/CSS/JS frontend, TODO.md — Phased roadmap reference, LLM_MODEL environment variable (default claude-opus-4-8) (+33 more)

### Community 5 - "EasyMDE Internals A (vendor, minified)"
Cohesion: 0.09
Nodes (35): ae(), ar(), br(), De(), ee(), eo(), fr(), ge() (+27 more)

### Community 6 - "EasyMDE Internals B (vendor, minified)"
Cohesion: 0.26
Nodes (34): _(), an(), B(), c(), d(), E(), f(), g() (+26 more)

### Community 7 - "Reveal.js Overview/Hash Controllers (vendor)"
Cohesion: 0.09
Nodes (3): E, M, S

### Community 8 - "EasyMDE Internals C (vendor, minified)"
Cohesion: 0.11
Nodes (32): $(), at(), bo(), co(), ct(), da(), Do(), dt() (+24 more)

### Community 9 - "EasyMDE Internals D (vendor, minified)"
Cohesion: 0.15
Nodes (28): ao(), dn(), fo(), go(), hn(), ho(), io(), jr() (+20 more)

### Community 11 - "EasyMDE Internals E (vendor, minified)"
Cohesion: 0.19
Nodes (21): ba(), be(), ca(), et(), Fe(), ga(), ha(), hi() (+13 more)

### Community 12 - "EasyMDE Internals F (vendor, minified)"
Cohesion: 0.23
Nodes (16): a(), aa(), ai(), bi(), ce(), ei(), en(), he() (+8 more)

### Community 13 - "EasyMDE Internals G (vendor, minified)"
Cohesion: 0.24
Nodes (14): cr(), dr(), fi(), gi(), hr(), jt(), pi(), pr() (+6 more)

### Community 14 - "EasyMDE Internals H (vendor, minified)"
Cohesion: 0.24
Nodes (12): bn(), Cn(), fn(), gn(), kn(), mn(), nt(), pn() (+4 more)

### Community 18 - "EasyMDE Internals I (vendor, minified)"
Cohesion: 0.33
Nodes (7): ci(), di(), li(), Qe(), ta(), yn(), yo()

## Knowledge Gaps
- **44 isolated node(s):** `treeEl`, `editorPaneEl`, `textEditorEl`, `htmlPreviewEl`, `gridPaneEl` (+39 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `$()` connect `EasyMDE Internals C (vendor, minified)` to `Reveal.js Page Activation (vendor)`, `Reveal.js Plugin Loading (vendor)`, `EasyMDE Internals A (vendor, minified)`, `EasyMDE Internals B (vendor, minified)`, `Reveal.js Overview/Hash Controllers (vendor)`, `EasyMDE Internals D (vendor, minified)`, `Reveal.js Fullscreen/Navigation (vendor)`, `EasyMDE Internals E (vendor, minified)`, `EasyMDE Internals F (vendor, minified)`, `EasyMDE Internals H (vendor, minified)`, `Reveal.js Auto-Animate (vendor)`?**
  _High betweenness centrality (0.156) - this node is a cross-community bridge._
- **Why does `tr()` connect `EasyMDE Internals E (vendor, minified)` to `Frontend App UI Logic`, `EasyMDE Internals A (vendor, minified)`, `EasyMDE Internals B (vendor, minified)`, `EasyMDE Internals C (vendor, minified)`, `EasyMDE Internals D (vendor, minified)`, `EasyMDE Internals F (vendor, minified)`, `EasyMDE Internals G (vendor, minified)`?**
  _High betweenness centrality (0.144) - this node is a cross-community bridge._
- **Why does `renderGrid()` connect `Frontend App UI Logic` to `EasyMDE Internals E (vendor, minified)`?**
  _High betweenness centrality (0.142) - this node is a cross-community bridge._
- **Are the 32 inferred relationships involving `i()` (e.g. with `$()` and `B()`) actually correct?**
  _`i()` has 32 INFERRED edges - model-reasoned connections that need verification._
- **Are the 31 inferred relationships involving `$()` (e.g. with `at()` and `be()`) actually correct?**
  _`$()` has 31 INFERRED edges - model-reasoned connections that need verification._
- **Are the 28 inferred relationships involving `t()` (e.g. with `$()` and `an()`) actually correct?**
  _`t()` has 28 INFERRED edges - model-reasoned connections that need verification._
- **Are the 32 inferred relationships involving `o()` (e.g. with `a()` and `an()`) actually correct?**
  _`o()` has 32 INFERRED edges - model-reasoned connections that need verification._