// Frontend. Markdown -> EasyMDE with side-by-side preview.
// HTML -> text editor with a Code/Preview toggle (sandboxed iframe).
// CSV -> text editor with a Text/Grid toggle (editable table).
// Everything else -> plain text editor. All views save back to disk.

const treeEl = document.getElementById("tree");
const editorPaneEl = document.getElementById("editor-pane");
const textEditorEl = document.getElementById("text-editor");
const htmlPreviewEl = document.getElementById("html-preview");
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

// ---------- Panes & views ----------

const PANES = { empty: emptyStateEl, editor: editorPaneEl, text: textEditorEl, preview: htmlPreviewEl, grid: gridPaneEl };

function showPane(name) {
  for (const [key, el] of Object.entries(PANES)) el.hidden = key !== name;
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
    hint: "New file — e.g. notes.md, deck.html, data.csv. Enter to create, Esc to cancel.",
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

loadTree();
