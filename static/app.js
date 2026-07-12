// Frontend. Markdown -> EasyMDE with side-by-side preview.
// HTML -> text editor with a Code/Preview toggle (sandboxed iframe).
// CSV -> text editor with a Text/Grid toggle (editable table).
// PDF -> read-only viewer (browser's built-in renderer).
// Everything else (incl. .txt) -> plain text editor. All editable views
// save back to disk.

const treeEl = document.getElementById("tree");
const editorPaneEl = document.getElementById("editor-pane");
const textEditorEl = document.getElementById("text-editor");
const htmlPreviewEl = document.getElementById("html-preview");
const pdfViewerEl = document.getElementById("pdf-viewer");
const gridPaneEl = document.getElementById("grid-pane");
const csvGridEl = document.getElementById("csv-grid");
const emptyStateEl = document.getElementById("empty-state");
const currentFileEl = document.getElementById("current-file");
const currentTypeEl = document.getElementById("current-type");
const dirtyDotEl = document.getElementById("dirty-dot");
const saveBtn = document.getElementById("save-btn");
const rescanBtn = document.getElementById("rescan-btn");
const addFileBtn = document.getElementById("add-file-btn");
const viewToggleEl = document.getElementById("view-toggle");
const toggleABtn = document.getElementById("toggle-a");
const toggleBBtn = document.getElementById("toggle-b");

let activeItem = null;
let openPath = null;       // file currently open (null = nothing)
let openType = null;       // markdown | slides | data | other
let savedContent = "";     // last content known to be on disk
let dirty = false;
let easyMDE = null;
let currentView = null;    // code | preview | text | grid (non-markdown only)
let csvRows = [];          // grid model while the grid view is active

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---------- Tree ----------

// VS Code-style selection: the last clicked folder (or an opened file's
// parent) is where new files/folders are created and what the agent scopes to.
let selectedFolder = "";

function selectFolder(path) {
  selectedFolder = path;
  document.querySelectorAll(".tree-item.folder.selected")
    .forEach((el) => el.classList.remove("selected"));
  const item = [...document.querySelectorAll(".tree-item.folder")]
    .find((el) => el.dataset.path === path);
  if (item) item.classList.add("selected");
  if (!chatPanelEl.hidden) setChatScope(path);
}

function renderTree(nodes, container) {
  for (const node of nodes) {
    container.appendChild(node.kind === "folder" ? renderFolder(node) : renderFile(node));
  }
}

function renderFolder(node) {
  const wrapper = document.createElement("div");

  const item = document.createElement("div");
  item.className = "tree-item folder";
  item.dataset.path = node.path;
  item.innerHTML = `<span class="twisty">&#9660;</span><span>&#128193; ${node.name}</span>`;

  const children = document.createElement("div");
  children.className = "tree-children";
  children.style.paddingLeft = "14px";
  renderTree(node.children, children);

  item.addEventListener("click", () => {
    const collapsed = children.classList.toggle("collapsed");
    item.querySelector(".twisty").innerHTML = collapsed ? "&#9654;" : "&#9660;";
    selectFolder(node.path);
  });

  wrapper.append(item, children);
  return wrapper;
}

function renderFile(node) {
  const item = document.createElement("div");
  item.className = "tree-item file";
  item.dataset.path = node.path;
  item.innerHTML =
    `<span class="twisty"></span><span>${node.name}</span>` +
    `<span class="badge ${node.type}">${node.type}</span>`;
  item.addEventListener("click", () => openFile(node, item));
  return item;
}

function setWorkspaceTitle(rootPath) {
  const nameEl = document.getElementById("workspace-name");
  const name = rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath;
  nameEl.textContent = name;
  nameEl.title = rootPath + "\n(click to select the workspace root)";
}

async function loadTree() {
  treeEl.innerHTML = "";
  try {
    const data = await api("/api/tree");
    setWorkspaceTitle(data.root);
    if (data.tree.length === 0) {
      treeEl.innerHTML = '<div class="tree-item">Workspace is empty</div>';
      return;
    }
    renderTree(data.tree, treeEl);
    // Restore the folder highlight after a re-render
    const sel = [...document.querySelectorAll(".tree-item.folder")]
      .find((el) => el.dataset.path === selectedFolder);
    if (sel) sel.classList.add("selected");
  } catch (err) {
    treeEl.innerHTML = `<div class="tree-item">Failed to load tree: ${err.message}</div>`;
  }
}

// ---------- Workspace search ----------

const searchInputEl = document.getElementById("search-input");
const searchResultsEl = document.getElementById("search-results");
const fileTagsEl = document.getElementById("file-tags");
let searchTimer = null;

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Snippets mark matches with \x02…\x03 (set server-side) so we can escape
// the content first and only then inject the highlight tags.
function snippetHtml(snippet) {
  return escapeHtml(snippet).replace(/\u0002/g, "<mark>").replace(/\u0003/g, "</mark>");
}

function showSearchResults(show) {
  searchResultsEl.hidden = !show;
  treeEl.hidden = show;
}

async function runSearch(query) {
  if (!query.trim()) {
    showSearchResults(false);
    return;
  }
  let data;
  try {
    data = await api(`/api/search?q=${encodeURIComponent(query)}`);
  } catch (err) {
    searchResultsEl.innerHTML = `<div class="sr-empty">Search failed: ${escapeHtml(err.message)}</div>`;
    showSearchResults(true);
    return;
  }
  if (query !== searchInputEl.value) return; // stale response; a newer search is underway

  searchResultsEl.innerHTML = "";
  if (data.results.length === 0) {
    searchResultsEl.innerHTML = '<div class="sr-empty">No matches.</div>';
  }
  for (const r of data.results) {
    const div = document.createElement("div");
    div.className = "search-result";
    const name = r.path.split("/").pop();
    div.innerHTML =
      `<div class="sr-name">${escapeHtml(name)} <span class="badge ${r.type}">${r.type}</span></div>` +
      `<div class="sr-path">${escapeHtml(r.path)}</div>` +
      (r.snippet ? `<div class="sr-snippet">${snippetHtml(r.snippet)}</div>` : "");
    div.addEventListener("click", () => {
      const item = [...document.querySelectorAll(".tree-item.file")]
        .find((i) => i.dataset.path === r.path);
      if (item) item.click(); // results stay visible for clicking through hits
    });
    searchResultsEl.appendChild(div);
  }
  showSearchResults(true);
}

searchInputEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(searchInputEl.value), 200);
});
searchInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchInputEl.value = "";
    showSearchResults(false);
    searchInputEl.blur();
  } else if (e.key === "Enter") {
    clearTimeout(searchTimer);
    runSearch(searchInputEl.value);
  }
});

function searchForTag(tag) {
  searchInputEl.value = `#${tag}`;
  runSearch(searchInputEl.value);
  searchInputEl.focus();
}

// Tag chips for the open file, shown next to its name in the tab bar
function renderFileTags(tags) {
  fileTagsEl.innerHTML = "";
  for (const tag of tags || []) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = `#${tag}`;
    chip.title = `Show files tagged #${tag}`;
    chip.addEventListener("click", () => searchForTag(tag));
    fileTagsEl.appendChild(chip);
  }
}

// ---------- Panes & views ----------

const graphPaneEl = document.getElementById("graph-pane");
const PANES = { empty: emptyStateEl, editor: editorPaneEl, text: textEditorEl, preview: htmlPreviewEl, grid: gridPaneEl, pdf: pdfViewerEl, graph: graphPaneEl };

function showPane(name) {
  for (const [key, el] of Object.entries(PANES)) el.hidden = key !== name;
  document.getElementById("graph-btn").classList.toggle("open", name === "graph");
  if (name !== "graph") stopGraphLoop();
}

function setTab(path, type) {
  currentFileEl.textContent = path;
  currentFileEl.classList.remove("placeholder");
  currentTypeEl.textContent = type;
}

// The two views the toggle switches between, per file type.
const TOGGLE_CONFIG = {
  slides: { labels: ["Code", "Preview"], views: ["code", "preview"] },
  data: { labels: ["Text", "Grid"], views: ["text", "grid"] },
};

function configureToggle(type) {
  const config = TOGGLE_CONFIG[type];
  viewToggleEl.hidden = !config;
  if (!config) return;
  toggleABtn.textContent = config.labels[0];
  toggleBBtn.textContent = config.labels[1];
}

function setView(view) {
  const config = TOGGLE_CONFIG[openType];
  currentView = view;

  if (config) {
    const second = view === config.views[1];
    viewToggleEl.classList.toggle("second", second);
    toggleABtn.classList.toggle("active", !second);
    toggleBBtn.classList.toggle("active", second);
  }

  if (view === "preview") {
    htmlPreviewEl.srcdoc = buildPreviewDoc(textEditorEl.value); // reflects unsaved edits too
    showPane("preview");
  } else if (view === "grid") {
    csvRows = parseCSV(textEditorEl.value);
    renderGrid(csvRows);
    showPane("grid");
  } else {
    showPane("text");
    textEditorEl.focus();
  }
}

// If the HTML file looks like a slide deck (has <section> slides), wrap the
// slides in a reveal.js scaffold so the preview is a real stepped slideshow.
// Anything else previews as the plain page it is.
function buildPreviewDoc(source) {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const slidesContainer = doc.querySelector(".reveal .slides, .slides");
  const sections = slidesContainer
    ? [...slidesContainer.children].filter((el) => el.tagName === "SECTION")
    : [...doc.body.children].filter((el) => el.tagName === "SECTION");
  if (sections.length === 0) return source;

  const slidesHtml = sections.map((s) => s.outerHTML).join("\n");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/static/vendor/reveal/reset.css">
  <link rel="stylesheet" href="/static/vendor/reveal/reveal.css">
  <link rel="stylesheet" href="/static/vendor/reveal/theme/black.css">
</head>
<body>
  <div class="reveal"><div class="slides">${slidesHtml}</div></div>
  <script src="/static/vendor/reveal/reveal.js"></script>
  <script>Reveal.initialize({ hash: false, controls: true, progress: true });</script>
</body>
</html>`;
}

toggleABtn.addEventListener("click", () => {
  const config = TOGGLE_CONFIG[openType];
  if (config && currentView !== config.views[0]) setView(config.views[0]);
});
toggleBBtn.addEventListener("click", () => {
  const config = TOGGLE_CONFIG[openType];
  if (config && currentView !== config.views[1]) setView(config.views[1]);
});

// ---------- Opening files ----------

async function openFile(node, item) {
  if (dirty && !confirm("You have unsaved changes. Discard them?")) return;

  // PDFs are binary and read-only: point the viewer straight at the raw
  // bytes instead of fetching text content.
  if (node.type === "pdf") {
    if (activeItem) activeItem.classList.remove("active");
    item.classList.add("active");
    activeItem = item;
    setTab(node.path, "pdf");
    renderFileTags([]);
    openPath = null; // nothing editable is open
    openType = "pdf";
    savedContent = "";
    setDirty(false);
    saveBtn.hidden = true;
    viewToggleEl.hidden = true;
    selectFolder(scopeOf(node.path));
    pdfViewerEl.src = `/api/file/raw?path=${encodeURIComponent(node.path)}`;
    showPane("pdf");
    return;
  }

  let data;
  try {
    data = await api(`/api/file?path=${encodeURIComponent(node.path)}`);
  } catch (err) {
    showPane("text");
    viewToggleEl.hidden = true;
    saveBtn.hidden = true;
    textEditorEl.value = `Could not open ${node.path}: ${err.message}`;
    return;
  }

  if (activeItem) activeItem.classList.remove("active");
  item.classList.add("active");
  activeItem = item;
  setTab(data.path, data.type);
  renderFileTags(data.tags);

  openPath = null; // silence change listeners while swapping content
  openType = data.type;
  savedContent = data.content;
  setDirty(false);
  saveBtn.hidden = false;
  saveBtn.disabled = true;

  selectFolder(scopeOf(data.path));

  if (data.type === "markdown") {
    viewToggleEl.hidden = true;
    openMarkdown(data);
  } else {
    textEditorEl.value = data.content;
    configureToggle(data.type);
    openPath = data.path;
    setView(TOGGLE_CONFIG[data.type] ? TOGGLE_CONFIG[data.type].views[0] : "text");
  }
}

// ---------- Markdown editor ----------

function ensureEditor() {
  if (easyMDE) return easyMDE;
  easyMDE = new EasyMDE({
    element: document.getElementById("md-textarea"),
    autoDownloadFontAwesome: false, // vendored locally
    spellChecker: false,
    status: false,
    autofocus: false,
    sideBySideFullscreen: false,
    toolbar: [
      "bold", "italic", "strikethrough", "heading", "|",
      "unordered-list", "ordered-list", "quote", "code", "|",
      "link", "image", "table", "horizontal-rule", "|",
      "side-by-side", "preview",
    ],
  });
  easyMDE.codemirror.on("change", () => {
    if (openPath !== null) setDirty(easyMDE.value() !== savedContent);
  });
  const extraKeys = easyMDE.codemirror.getOption("extraKeys") || {};
  extraKeys["Ctrl-S"] = () => saveCurrentFile();
  easyMDE.codemirror.setOption("extraKeys", extraKeys);
  return easyMDE;
}

function openMarkdown(data) {
  showPane("editor");
  const editor = ensureEditor();
  editor.value(data.content);
  openPath = data.path;
  if (!editor.isSideBySideActive()) editor.toggleSideBySide();
  editor.codemirror.refresh();
  editor.codemirror.focus();
}

// ---------- Plain text editing ----------

textEditorEl.addEventListener("input", () => {
  if (openPath !== null) setDirty(textEditorEl.value !== savedContent);
});

// ---------- CSV grid ----------

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function serializeCSV(rows) {
  const quote = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(quote).join(",")).join("\n") + "\n";
}

function renderGrid(rows) {
  csvGridEl.innerHTML = "";
  rows.forEach((cells, r) => {
    const tr = document.createElement("tr");
    cells.forEach((value, c) => {
      const td = document.createElement("td");
      td.textContent = value;
      td.contentEditable = "true";
      td.dataset.r = r;
      td.dataset.c = c;
      tr.appendChild(td);
    });
    csvGridEl.appendChild(tr);
  });
}

csvGridEl.addEventListener("input", (e) => {
  const td = e.target.closest("td");
  if (!td) return;
  csvRows[td.dataset.r][td.dataset.c] = td.textContent;
  textEditorEl.value = serializeCSV(csvRows);
  if (openPath !== null) setDirty(textEditorEl.value !== savedContent);
});

// ---------- Saving ----------

function setDirty(value) {
  dirty = value;
  dirtyDotEl.hidden = !value;
  saveBtn.disabled = !value;
}

function currentContent() {
  return openType === "markdown" ? easyMDE.value() : textEditorEl.value;
}

async function saveCurrentFile() {
  if (!openPath || !dirty) return;
  const content = currentContent();
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";
  try {
    await api("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: openPath, content }),
    });
    savedContent = content;
    setDirty(false);
  } catch (err) {
    alert(`Save failed: ${err.message}`);
    setDirty(true);
  } finally {
    saveBtn.textContent = "Save";
  }
}

saveBtn.addEventListener("click", saveCurrentFile);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveCurrentFile();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

// ---------- Creating files & folders (inline input — native prompt()
// dialogs are unavailable in embedded webviews) ----------

const createRowEl = document.getElementById("create-row");
const createInputEl = document.getElementById("create-input");
const createHintEl = document.getElementById("create-hint");
const createErrorEl = document.getElementById("create-error");
const addFolderBtn = document.getElementById("add-folder-btn");

let createMode = null; // "file" | "folder" | null

const CREATE_CONFIG = {
  file: {
    placeholder: "task-1/notes.md",
    hint: "New file — e.g. notes.md, todo.txt, deck.html, data.csv. Enter to create, Esc to cancel.",
  },
  folder: {
    placeholder: "task-1",
    hint: "New folder (nesting allowed, e.g. projects/task-1). Enter to create, Esc to cancel.",
  },
};

function openCreateRow(mode) {
  createMode = mode;
  createRowEl.hidden = false;
  createErrorEl.hidden = true;
  createInputEl.placeholder = CREATE_CONFIG[mode].placeholder;
  createHintEl.textContent = CREATE_CONFIG[mode].hint;
  // Prefill with the selected folder so new items land inside it
  createInputEl.value = selectedFolder ? selectedFolder + "/" : "";
  createInputEl.focus();
  createInputEl.setSelectionRange(createInputEl.value.length, createInputEl.value.length);
}

function closeCreateRow() {
  createMode = null;
  createRowEl.hidden = true;
  createInputEl.value = "";
  createErrorEl.hidden = true;
}

async function submitCreate() {
  const path = createInputEl.value.trim();
  if (!path) return;
  try {
    if (createMode === "file") {
      const created = await api("/api/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: "", create_parents: true, overwrite: false }),
      });
      closeCreateRow();
      await loadTree();
      const item = [...document.querySelectorAll(".tree-item.file")]
        .find((i) => i.dataset.path === created.path);
      if (item) item.click();
    } else {
      const created = await api("/api/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      closeCreateRow();
      selectedFolder = created.path; // next + File goes straight into it
      await loadTree();
      selectFolder(created.path);
    }
  } catch (err) {
    createErrorEl.textContent = err.message;
    createErrorEl.hidden = false;
  }
}

addFileBtn.addEventListener("click", () => {
  createMode === "file" ? closeCreateRow() : openCreateRow("file");
});
addFolderBtn.addEventListener("click", () => {
  createMode === "folder" ? closeCreateRow() : openCreateRow("folder");
});

createInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitCreate();
  } else if (e.key === "Escape") {
    closeCreateRow();
  }
});

// ---------- Agent chat ----------

const chatPanelEl = document.getElementById("chat-panel");
const chatToggleBtn = document.getElementById("chat-toggle-btn");
const chatMessagesEl = document.getElementById("chat-messages");
const chatScopeEl = document.getElementById("chat-scope");
const chatInputEl = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const chatClearBtn = document.getElementById("chat-clear-btn");
const chatSummarizeBtn = document.getElementById("chat-summarize-btn");

let chatScope = "";      // folder the agent is scoped to ("" = workspace root)
let chatBusy = false;

function scopeOf(path) {
  if (!path || !path.includes("/")) return "";
  return path.slice(0, path.lastIndexOf("/"));
}

function scopeLabel(scope) {
  return scope === "" ? "/" : scope + "/";
}

function addChatBubble(role, text) {
  const empty = document.getElementById("chat-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  div.textContent = text;
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return div;
}

function renderChatEmpty() {
  chatMessagesEl.innerHTML =
    '<div id="chat-empty">Ask the agent about the files in this folder — ' +
    "it reads them all before answering. It can also propose file edits " +
    "for you to approve. Type @ to reference a file.</div>";
}

function renderProposalCard(messageId, index, proposal) {
  const card = document.createElement("div");
  card.className = "proposal-card";

  const head = document.createElement("div");
  head.className = "proposal-head";
  const pathEl = document.createElement("span");
  pathEl.className = "proposal-path";
  pathEl.textContent = proposal.path;
  const statusEl = document.createElement("span");
  statusEl.className = "proposal-status";
  head.append(pathEl, statusEl);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Show proposed contents";
  const pre = document.createElement("pre");
  pre.textContent = proposal.content;
  details.append(summary, pre);

  card.append(head, details);

  const setStatus = (status) => {
    statusEl.textContent =
      status === "applied" ? "✓ applied" :
      status === "blocked" ? `blocked: ${proposal.error || ""}` : status;
    statusEl.classList.toggle("applied", status === "applied");
  };

  const addActions = (buttons) => {
    const actions = document.createElement("div");
    actions.className = "proposal-actions";
    const els = buttons.map(([label, cls]) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (cls) b.className = cls;
      actions.appendChild(b);
      return b;
    });
    card.appendChild(actions);
    return [actions, els];
  };

  const act = async (action, actions, els) => {
    els.forEach((b) => (b.disabled = true));
    try {
      const res = await api("/api/chat/proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: messageId, index, action }),
      });
      proposal.status = res.status;
      setStatus(res.status);
      actions.remove();
      if (action === "apply" || action === "undo") {
        await afterAgentEdit([{ path: res.path, status: "applied" }]);
      }
      if (res.status === "applied") wireUndo(); // legacy apply can still be undone
    } catch (err) {
      els.forEach((b) => (b.disabled = false));
      setStatus(`error: ${err.message}`);
    }
  };

  function wireUndo() {
    const [actions, [undoBtn]] = addActions([["Undo", ""]]);
    undoBtn.addEventListener("click", () => act("undo", actions, [undoBtn]));
  }

  if (proposal.status === "applied") {
    wireUndo();
  } else if (proposal.status === "pending") {
    // Older proposals from before edits became direct
    const [actions, [applyBtn, dismissBtn]] = addActions([["Apply", "apply-btn"], ["Dismiss", ""]]);
    applyBtn.addEventListener("click", () => act("apply", actions, [applyBtn, dismissBtn]));
    dismissBtn.addEventListener("click", () => act("dismiss", actions, [applyBtn, dismissBtn]));
  }
  setStatus(proposal.status);

  return card;
}

// Refresh the tree and reload the open file after agent edits touch disk
async function afterAgentEdit(proposals) {
  await loadTree();
  const editedOpen = proposals.some((p) => p.status === "applied" && p.path === openPath);
  if (editedOpen) {
    const item = [...document.querySelectorAll(".tree-item.file")]
      .find((i) => i.dataset.path === openPath);
    setDirty(false); // disk now holds the agent's version
    if (item) item.click();
  }
}

function addChatMessage(msg) {
  addChatBubble(msg.role, msg.content);
  (msg.proposals || []).forEach((p, i) => {
    chatMessagesEl.appendChild(renderProposalCard(msg.id, i, p));
  });
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

async function setChatScope(scope) {
  if (scope === chatScope && chatMessagesEl.childElementCount > 0) return;
  chatScope = scope;
  chatScopeEl.textContent = "Scope: " + scopeLabel(scope);
  try {
    const data = await api(`/api/chat?folder=${encodeURIComponent(scope)}`);
    // Don't clobber the list if the user already started chatting meanwhile
    if (chatBusy || chatScope !== scope) return;
    chatMessagesEl.innerHTML = "";
    if (data.messages.length === 0) {
      renderChatEmpty();
    } else {
      for (const m of data.messages) addChatMessage(m);
    }
  } catch (err) {
    addChatBubble("error", `Could not load chat history: ${err.message}`);
  }
}

async function sendChat(text) {
  if (chatBusy || !text.trim()) return;
  chatBusy = true;
  chatSendBtn.disabled = true;
  addChatBubble("user", text);
  const pending = addChatBubble("assistant pending", "Thinking…");
  try {
    const reply = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: chatScope, message: text, open_file: openPath }),
    });
    pending.className = "chat-msg assistant";
    pending.textContent = reply.content;
    (reply.proposals || []).forEach((p, i) => {
      chatMessagesEl.appendChild(renderProposalCard(reply.id, i, p));
    });
    if ((reply.proposals || []).some((p) => p.status === "applied")) {
      await afterAgentEdit(reply.proposals);
    }
  } catch (err) {
    pending.className = "chat-msg error";
    pending.textContent = err.message;
  } finally {
    chatBusy = false;
    chatSendBtn.disabled = false;
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }
}

chatToggleBtn.addEventListener("click", () => {
  const open = chatPanelEl.hidden;
  chatPanelEl.hidden = !open;
  chatToggleBtn.classList.toggle("open", open);
  if (open) {
    setChatScope(selectedFolder);
    refreshAcPaths();
    chatInputEl.focus();
  }
});

chatSendBtn.addEventListener("click", () => {
  const text = chatInputEl.value;
  chatInputEl.value = "";
  sendChat(text);
});

// ----- @file autocomplete -----

const chatAcEl = document.getElementById("chat-autocomplete");
let acPaths = [];      // all workspace file paths
let acMatches = [];    // current dropdown entries
let acIndex = 0;       // highlighted entry
let acTokenStart = -1; // position of the "@" being completed

async function refreshAcPaths() {
  try {
    const data = await api("/api/files");
    acPaths = data.files.map((f) => f.path);
  } catch { acPaths = []; }
}

function hideAutocomplete() {
  chatAcEl.hidden = true;
  acMatches = [];
  acTokenStart = -1;
}

function updateAutocomplete() {
  const caret = chatInputEl.selectionStart;
  const before = chatInputEl.value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1 || before.slice(at + 1).includes("\n")) return hideAutocomplete();

  const token = before.slice(at + 1).toLowerCase();
  acMatches = acPaths.filter((p) => p.toLowerCase().includes(token)).slice(0, 8);
  if (acMatches.length === 0) return hideAutocomplete();

  acTokenStart = at;
  acIndex = 0;
  chatAcEl.innerHTML = "";
  acMatches.forEach((path, i) => {
    const item = document.createElement("div");
    item.className = "ac-item" + (i === 0 ? " active" : "");
    item.textContent = path;
    item.addEventListener("mousedown", (e) => { e.preventDefault(); pickAutocomplete(i); });
    chatAcEl.appendChild(item);
  });
  chatAcEl.hidden = false;
}

function pickAutocomplete(i) {
  const caret = chatInputEl.selectionStart;
  const value = chatInputEl.value;
  chatInputEl.value = value.slice(0, acTokenStart) + "@" + acMatches[i] + " " + value.slice(caret);
  const newCaret = acTokenStart + acMatches[i].length + 2;
  chatInputEl.setSelectionRange(newCaret, newCaret);
  hideAutocomplete();
  chatInputEl.focus();
}

function moveAcHighlight(delta) {
  acIndex = (acIndex + delta + acMatches.length) % acMatches.length;
  [...chatAcEl.children].forEach((el, i) => el.classList.toggle("active", i === acIndex));
}

chatInputEl.addEventListener("input", updateAutocomplete);
chatInputEl.addEventListener("blur", () => setTimeout(hideAutocomplete, 150));

chatInputEl.addEventListener("keydown", (e) => {
  if (!chatAcEl.hidden) {
    if (e.key === "ArrowDown") { e.preventDefault(); return moveAcHighlight(1); }
    if (e.key === "ArrowUp") { e.preventDefault(); return moveAcHighlight(-1); }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); return pickAutocomplete(acIndex); }
    if (e.key === "Escape") { e.preventDefault(); return hideAutocomplete(); }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const text = chatInputEl.value;
    chatInputEl.value = "";
    sendChat(text);
  }
});

chatSummarizeBtn.addEventListener("click", () => {
  sendChat("Summarize the contents of this folder.");
});

chatClearBtn.addEventListener("click", async () => {
  if (!confirm("Clear the chat history for this folder?")) return;
  await api(`/api/chat?folder=${encodeURIComponent(chatScope)}`, { method: "DELETE" });
  renderChatEmpty();
});

// ---------- Choose workspace folder ----------

const pickWorkspaceBtn = document.getElementById("pick-workspace-btn");
const sidebarErrorEl = document.getElementById("sidebar-error");

function showSidebarError(message) {
  sidebarErrorEl.textContent = message;
  sidebarErrorEl.hidden = false;
  setTimeout(() => { sidebarErrorEl.hidden = true; }, 6000);
}

function resetWorkspaceState() {
  if (easyMDE) easyMDE.value("");
  openPath = null;
  openType = null;
  setDirty(false);
  saveBtn.hidden = true;
  viewToggleEl.hidden = true;
  if (activeItem) activeItem.classList.remove("active");
  activeItem = null;
  selectedFolder = "";
  currentFileEl.textContent = "No file open";
  currentFileEl.classList.add("placeholder");
  currentTypeEl.textContent = "";
  showPane("empty");
  closeCreateRow();
  if (!chatPanelEl.hidden) {
    chatScope = null; // force a history reload for the new workspace
    setChatScope("");
  }
}

pickWorkspaceBtn.addEventListener("click", async () => {
  if (dirty && !confirm("You have unsaved changes. Discard them?")) return;
  pickWorkspaceBtn.disabled = true;
  try {
    const res = await api("/api/workspace/pick", { method: "POST" });
    if (!res.cancelled) {
      resetWorkspaceState();
      await loadTree();
    }
  } catch (err) {
    showSidebarError(`Could not switch workspace: ${err.message}`);
  } finally {
    pickWorkspaceBtn.disabled = false;
  }
});

// ---------- Rescan ----------

rescanBtn.addEventListener("click", async () => {
  rescanBtn.disabled = true;
  try {
    await api("/api/scan", { method: "POST" });
    await loadTree();
  } finally {
    rescanBtn.disabled = false;
  }
});

// Clicking the workspace title selects the root again
document.getElementById("workspace-name").addEventListener("click", () => selectFolder(""));

// ---------- Settings modal ----------

const settingsOverlayEl = document.getElementById("settings-overlay");
const settingsBtn = document.getElementById("settings-btn");
const settingsCloseBtn = document.getElementById("settings-close-btn");
const workspaceListEl = document.getElementById("workspace-list");
const addWorkspaceBtn = document.getElementById("settings-add-workspace-btn");
const providerSelectEl = document.getElementById("provider-select");
const providerNoteEl = document.getElementById("provider-note");

function wsName(root) {
  return root.split(/[\\/]/).filter(Boolean).pop() || root;
}

async function switchWorkspace(root) {
  if (dirty && !confirm("You have unsaved changes. Discard them?")) return;
  try {
    await api("/api/workspace/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root }),
    });
  } catch (err) {
    providerNoteEl.textContent = ""; // errors surface in the sidebar, not here
    showSidebarError(`Could not switch workspace: ${err.message}`);
    return;
  }
  resetWorkspaceState();
  await loadTree();
  await renderSettings();
}

function renderWorkspaceList(settings) {
  workspaceListEl.innerHTML = "";
  for (const root of settings.workspaces) {
    const current = root === settings.workspace.root;
    const item = document.createElement("div");
    item.className = "workspace-item" + (current ? " current" : "");
    item.title = current ? "The active workspace" : `Switch to ${root}`;

    const info = document.createElement("div");
    info.className = "ws-info";
    info.innerHTML =
      `<div class="ws-name">${escapeHtml(wsName(root))}${current ? " · active" : ""}</div>` +
      `<div class="ws-path">${escapeHtml(root)}</div>`;
    item.appendChild(info);

    if (!current) {
      const forget = document.createElement("button");
      forget.className = "ws-forget";
      forget.textContent = "forget";
      forget.title = "Remove from this list (the folder itself is untouched)";
      forget.addEventListener("click", async (e) => {
        e.stopPropagation();
        await api("/api/workspace/forget", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root }),
        });
        renderSettings();
      });
      item.appendChild(forget);
      item.addEventListener("click", () => switchWorkspace(root));
    }
    workspaceListEl.appendChild(item);
  }
}

async function renderSettings() {
  const settings = await api("/api/settings");
  renderWorkspaceList(settings);

  providerSelectEl.innerHTML = "";
  for (const p of settings.providers) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p === "anthropic" ? "Anthropic (Claude)" : `${p} (offline dev stub)`;
    providerSelectEl.appendChild(opt);
  }
  providerSelectEl.value = settings.provider;
  providerSelectEl.disabled = settings.provider_locked_by_env;
  providerNoteEl.textContent = settings.provider_locked_by_env
    ? "Locked by the LLM_PROVIDER environment variable for this server."
    : "Takes effect on the agent's next message — no restart needed.";
}

providerSelectEl.addEventListener("change", async () => {
  try {
    await api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: providerSelectEl.value }),
    });
    providerNoteEl.textContent = `Agent now uses ${providerSelectEl.value}.`;
  } catch (err) {
    providerNoteEl.textContent = `Could not change provider: ${err.message}`;
  }
});

addWorkspaceBtn.addEventListener("click", async () => {
  if (dirty && !confirm("You have unsaved changes. Discard them?")) return;
  addWorkspaceBtn.disabled = true;
  try {
    const res = await api("/api/workspace/pick", { method: "POST" });
    if (!res.cancelled) {
      resetWorkspaceState();
      await loadTree();
      await renderSettings();
    }
  } catch (err) {
    showSidebarError(`Could not add workspace: ${err.message}`);
  } finally {
    addWorkspaceBtn.disabled = false;
  }
});

function openSettings() {
  settingsOverlayEl.hidden = false;
  renderSettings().catch((err) => {
    workspaceListEl.innerHTML =
      `<div class="settings-note">Could not load settings: ${escapeHtml(err.message)}</div>`;
  });
}
function closeSettings() { settingsOverlayEl.hidden = true; }

settingsBtn.addEventListener("click", openSettings);
settingsCloseBtn.addEventListener("click", closeSettings);
settingsOverlayEl.addEventListener("click", (e) => {
  if (e.target === settingsOverlayEl) closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsOverlayEl.hidden) closeSettings();
});

// ---------- Graph view (wiki-link graph on a canvas) ----------

const graphBtn = document.getElementById("graph-btn");
const graphCanvas = document.getElementById("graph-canvas");
const graphEmptyEl = document.getElementById("graph-empty");
const gctx = graphCanvas.getContext("2d");

const gState = {
  nodes: [],            // {id,label,type,ghost,x,y,vx,vy,degree}
  edges: [],            // {a,b} node references
  byId: new Map(),
  tx: 0, ty: 0, k: 1,   // pan/zoom transform (screen = world*k + t)
  alpha: 0,             // simulation heat; loop stops when it cools
  raf: null,
  hover: null,
  dragNode: null,
  panning: false,
  pointerDownAt: null,
};
let paneBeforeGraph = "empty";

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function loadGraph() {
  const data = await api("/api/graph");
  const old = gState.byId;
  gState.byId = new Map();
  gState.nodes = data.nodes.map((n, i) => {
    const prev = old.get(n.id);
    const angle = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
    const node = {
      ...n,
      x: prev ? prev.x : Math.cos(angle) * 160 + Math.random() * 40,
      y: prev ? prev.y : Math.sin(angle) * 160 + Math.random() * 40,
      vx: 0, vy: 0, degree: 0,
    };
    gState.byId.set(n.id, node);
    return node;
  });
  gState.edges = data.edges
    .map((e) => ({ a: gState.byId.get(e.source), b: gState.byId.get(e.target) }))
    .filter((e) => e.a && e.b);
  for (const e of gState.edges) { e.a.degree++; e.b.degree++; }
  graphEmptyEl.hidden = gState.nodes.length > 0;
}

function sizeGraphCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = graphPaneEl.clientWidth, h = graphPaneEl.clientHeight;
  graphCanvas.width = w * dpr;
  graphCanvas.height = h * dpr;
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function graphTick() {
  const N = gState.nodes;
  // Pairwise repulsion (fine at note-collection scale)
  for (let i = 0; i < N.length; i++) {
    for (let j = i + 1; j < N.length; j++) {
      const a = N[i], b = N[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy || 1;
      const f = 1800 / d2;
      const d = Math.sqrt(d2);
      dx /= d; dy /= d;
      a.vx -= dx * f; a.vy -= dy * f;
      b.vx += dx * f; b.vy += dy * f;
    }
  }
  // Springs along edges
  for (const { a, b } of gState.edges) {
    let dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - 90) * 0.02;
    dx /= d; dy /= d;
    a.vx += dx * f; a.vy += dy * f;
    b.vx -= dx * f; b.vy -= dy * f;
  }
  // Gentle pull to the center + integration with damping
  for (const n of N) {
    n.vx -= n.x * 0.004; n.vy -= n.y * 0.004;
    if (n !== gState.dragNode) {
      n.x += n.vx * gState.alpha; n.y += n.vy * gState.alpha;
    }
    n.vx *= 0.6; n.vy *= 0.6;
  }
  gState.alpha *= 0.995;
}

function nodeRadius(n) { return 4 + Math.sqrt(n.degree) * 2.2; }

function drawGraph() {
  const w = graphPaneEl.clientWidth, h = graphPaneEl.clientHeight;
  gctx.clearRect(0, 0, w, h);
  gctx.fillStyle = cssVar("--bg");
  gctx.fillRect(0, 0, w, h);

  const { tx, ty, k, hover } = gState;
  const toX = (x) => x * k + tx + w / 2;
  const toY = (y) => y * k + ty + h / 2;
  const neighbors = new Set();
  if (hover) {
    neighbors.add(hover);
    for (const { a, b } of gState.edges) {
      if (a === hover) neighbors.add(b);
      if (b === hover) neighbors.add(a);
    }
  }

  const colors = {
    markdown: cssVar("--accent"),
    text: cssVar("--badge-text"),
    slides: cssVar("--badge-slides"),
    data: cssVar("--badge-data"),
    pdf: cssVar("--badge-pdf"),
    other: cssVar("--badge-other"),
  };

  for (const { a, b } of gState.edges) {
    const lit = hover && (a === hover || b === hover);
    gctx.strokeStyle = lit ? cssVar("--accent") : cssVar("--border");
    gctx.globalAlpha = hover && !lit ? 0.25 : 1;
    gctx.lineWidth = lit ? 1.5 : 1;
    gctx.beginPath();
    gctx.moveTo(toX(a.x), toY(a.y));
    gctx.lineTo(toX(b.x), toY(b.y));
    gctx.stroke();
  }

  for (const n of gState.nodes) {
    const r = nodeRadius(n) * k;
    const faded = hover && !neighbors.has(n);
    gctx.globalAlpha = faded ? 0.25 : 1;
    gctx.beginPath();
    gctx.arc(toX(n.x), toY(n.y), Math.max(2, r), 0, Math.PI * 2);
    if (n.ghost) {
      gctx.strokeStyle = cssVar("--text-dim");
      gctx.lineWidth = 1;
      gctx.stroke();
    } else {
      gctx.fillStyle = colors[n.type] || colors.other;
      gctx.fill();
    }
    if (k > 0.55 || n === hover) {
      gctx.fillStyle = n === hover ? cssVar("--text") : cssVar("--text-dim");
      gctx.font = `${n === hover ? "600 " : ""}11px "Segoe UI", sans-serif`;
      gctx.textAlign = "center";
      gctx.fillText(n.label, toX(n.x), toY(n.y) + Math.max(2, r) + 12);
    }
  }
  gctx.globalAlpha = 1;
}

function graphLoop() {
  if (gState.alpha > 0.02 || gState.dragNode) graphTick();
  drawGraph();
  gState.raf = requestAnimationFrame(graphLoop);
}

function startGraphLoop() {
  if (gState.raf === null) gState.raf = requestAnimationFrame(graphLoop);
}
function stopGraphLoop() {
  if (gState.raf !== null) { cancelAnimationFrame(gState.raf); gState.raf = null; }
}

function graphHitTest(mx, my) {
  const w = graphPaneEl.clientWidth, h = graphPaneEl.clientHeight;
  for (let i = gState.nodes.length - 1; i >= 0; i--) {
    const n = gState.nodes[i];
    const sx = n.x * gState.k + gState.tx + w / 2;
    const sy = n.y * gState.k + gState.ty + h / 2;
    const r = Math.max(6, nodeRadius(n) * gState.k) + 2;
    if ((mx - sx) ** 2 + (my - sy) ** 2 <= r * r) return n;
  }
  return null;
}

graphCanvas.addEventListener("pointerdown", (e) => {
  graphCanvas.setPointerCapture(e.pointerId);
  const rect = graphCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  gState.pointerDownAt = { x: mx, y: my, moved: false };
  const hit = graphHitTest(mx, my);
  if (hit) {
    gState.dragNode = hit;
    gState.alpha = Math.max(gState.alpha, 0.5);
  } else {
    gState.panning = true;
    graphCanvas.classList.add("dragging");
  }
});

graphCanvas.addEventListener("pointermove", (e) => {
  const rect = graphCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const w = graphPaneEl.clientWidth, h = graphPaneEl.clientHeight;

  if (gState.pointerDownAt) {
    const dx = mx - gState.pointerDownAt.x, dy = my - gState.pointerDownAt.y;
    if (dx * dx + dy * dy > 16) gState.pointerDownAt.moved = true;
  }
  if (gState.dragNode) {
    gState.dragNode.x = (mx - w / 2 - gState.tx) / gState.k;
    gState.dragNode.y = (my - h / 2 - gState.ty) / gState.k;
    gState.alpha = Math.max(gState.alpha, 0.3);
  } else if (gState.panning) {
    gState.tx += e.movementX;
    gState.ty += e.movementY;
  } else {
    gState.hover = graphHitTest(mx, my);
    graphCanvas.style.cursor = gState.hover && !gState.hover.ghost ? "pointer" : "grab";
  }
});

graphCanvas.addEventListener("pointerup", (e) => {
  const clicked = gState.pointerDownAt && !gState.pointerDownAt.moved && gState.dragNode;
  const node = gState.dragNode;
  gState.dragNode = null;
  gState.panning = false;
  gState.pointerDownAt = null;
  graphCanvas.classList.remove("dragging");
  if (clicked && node && !node.ghost) {
    const item = [...document.querySelectorAll(".tree-item.file")]
      .find((i) => i.dataset.path === node.id);
    if (item) item.click(); // leaves the graph via showPane
  }
});

graphCanvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = graphCanvas.getBoundingClientRect();
  const w = graphPaneEl.clientWidth, h = graphPaneEl.clientHeight;
  const mx = e.clientX - rect.left - w / 2, my = e.clientY - rect.top - h / 2;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const k = Math.min(4, Math.max(0.2, gState.k * factor));
  // Keep the point under the cursor fixed while zooming
  gState.tx = mx - ((mx - gState.tx) / gState.k) * k;
  gState.ty = my - ((my - gState.ty) / gState.k) * k;
  gState.k = k;
}, { passive: false });

window.addEventListener("resize", () => {
  if (!graphPaneEl.hidden) sizeGraphCanvas();
});

graphBtn.addEventListener("click", async () => {
  if (!graphPaneEl.hidden) {           // toggle off -> back to what was there
    showPane(paneBeforeGraph);
    return;
  }
  paneBeforeGraph = Object.entries(PANES).find(([, el]) => !el.hidden)?.[0] || "empty";
  try {
    await loadGraph();
  } catch (err) {
    showSidebarError(`Could not load the graph: ${err.message}`);
    return;
  }
  showPane("graph");
  sizeGraphCanvas();
  gState.alpha = 1;
  startGraphLoop();
});

// ---------- Resizable panels ----------

const LAYOUT_KEY = "workspace-layout";
const MAIN_MIN_WIDTH = 200; // the editor pane never collapses below this

(function initResizers() {
  const mainEl = document.getElementById("main");
  const resizers = [
    {
      handle: document.getElementById("resizer-sidebar"),
      panel: document.getElementById("sidebar"),
      key: "sidebar",
      min: 180,
      grows: 1, // dragging right makes this panel wider
    },
    {
      handle: document.getElementById("resizer-chat"),
      panel: chatPanelEl,
      key: "chat",
      min: 260,
      grows: -1, // dragging right makes this panel narrower
    },
  ];

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { /* corrupt -> defaults */ }

  function persist(key, width) {
    saved[key] = width;
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ }
  }

  for (const r of resizers) {
    if (typeof saved[r.key] === "number") r.panel.style.width = `${saved[r.key]}px`;

    r.handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      r.handle.setPointerCapture(e.pointerId);
      r.handle.classList.add("dragging");
      document.body.classList.add("resizing");

      const startX = e.clientX;
      const startWidth = r.panel.offsetWidth;
      // Whatever this panel gains comes out of the main pane
      const maxWidth = startWidth + mainEl.offsetWidth - MAIN_MIN_WIDTH;

      const onMove = (ev) => {
        const wanted = startWidth + (ev.clientX - startX) * r.grows;
        r.panel.style.width = `${Math.min(maxWidth, Math.max(r.min, wanted))}px`;
      };
      const onUp = () => {
        r.handle.classList.remove("dragging");
        document.body.classList.remove("resizing");
        r.handle.removeEventListener("pointermove", onMove);
        r.handle.removeEventListener("pointerup", onUp);
        r.handle.removeEventListener("pointercancel", onUp);
        persist(r.key, r.panel.offsetWidth);
      };
      r.handle.addEventListener("pointermove", onMove);
      r.handle.addEventListener("pointerup", onUp);
      r.handle.addEventListener("pointercancel", onUp);
    });

    // Double-click snaps the panel back to its stylesheet default
    r.handle.addEventListener("dblclick", () => {
      r.panel.style.width = "";
      delete saved[r.key];
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ }
    });
  }
})();

loadTree();
