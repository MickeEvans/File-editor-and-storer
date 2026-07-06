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

function renderTree(nodes, container) {
  for (const node of nodes) {
    container.appendChild(node.kind === "folder" ? renderFolder(node) : renderFile(node));
  }
}

function renderFolder(node) {
  const wrapper = document.createElement("div");

  const item = document.createElement("div");
  item.className = "tree-item folder";
  item.innerHTML = `<span class="twisty">&#9660;</span><span>&#128193; ${node.name}</span>`;

  const children = document.createElement("div");
  children.className = "tree-children";
  children.style.paddingLeft = "14px";
  renderTree(node.children, children);

  item.addEventListener("click", () => {
    const collapsed = children.classList.toggle("collapsed");
    item.querySelector(".twisty").innerHTML = collapsed ? "&#9654;" : "&#9660;";
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

async function loadTree() {
  treeEl.innerHTML = "";
  try {
    const data = await api("/api/tree");
    if (data.tree.length === 0) {
      treeEl.innerHTML = '<div class="tree-item">Workspace is empty</div>';
      return;
    }
    renderTree(data.tree, treeEl);
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

// ---------- New file ----------

addFileBtn.addEventListener("click", async () => {
  const path = prompt(
    "New file path (relative to the workspace root):\n" +
    "e.g.  notes/idea.md   slides/deck.html   data/table.csv",
    "untitled.md"
  );
  if (!path || !path.trim()) return;
  try {
    const created = await api("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: path.trim(),
        content: "",
        create_parents: true,
        overwrite: false,
      }),
    });
    await loadTree();
    const item = [...document.querySelectorAll(".tree-item.file")]
      .find((i) => i.dataset.path === created.path);
    if (item) item.click();
  } catch (err) {
    alert(`Could not create file: ${err.message}`);
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

loadTree();
