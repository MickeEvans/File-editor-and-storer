// Frontend: folder tree in the sidebar; main pane shows a raw viewer for
// most files and a full Markdown editor (EasyMDE, side-by-side preview)
// for .md files. Phase 2a.

const treeEl = document.getElementById("tree");
const viewerEl = document.getElementById("viewer");
const editorPaneEl = document.getElementById("editor-pane");
const emptyStateEl = document.getElementById("empty-state");
const currentFileEl = document.getElementById("current-file");
const currentTypeEl = document.getElementById("current-type");
const dirtyDotEl = document.getElementById("dirty-dot");
const saveBtn = document.getElementById("save-btn");
const rescanBtn = document.getElementById("rescan-btn");

let activeItem = null;
let openPath = null;      // path of the file in the editor (null = raw view / nothing)
let savedContent = "";    // last content known to be on disk
let dirty = false;
let easyMDE = null;

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

// ---------- Opening files ----------

function showPane(pane) {
  emptyStateEl.hidden = pane !== "empty";
  viewerEl.hidden = pane !== "viewer";
  editorPaneEl.hidden = pane !== "editor";
}

function setTab(path, type) {
  currentFileEl.textContent = path;
  currentFileEl.classList.remove("placeholder");
  currentTypeEl.textContent = type;
}

async function openFile(node, item) {
  if (dirty && !confirm("You have unsaved changes. Discard them?")) return;

  let data;
  try {
    data = await api(`/api/file?path=${encodeURIComponent(node.path)}`);
  } catch (err) {
    showPane("viewer");
    viewerEl.textContent = `Could not open ${node.path}: ${err.message}`;
    return;
  }

  if (activeItem) activeItem.classList.remove("active");
  item.classList.add("active");
  activeItem = item;
  setTab(data.path, data.type);
  setDirty(false);

  if (data.type === "markdown") {
    openMarkdown(data);
  } else {
    openPath = null;
    saveBtn.hidden = true;
    showPane("viewer");
    viewerEl.textContent = data.content;
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
  openPath = null; // silence the change listener while we swap content
  editor.value(data.content);
  savedContent = data.content;
  openPath = data.path;
  saveBtn.hidden = false;
  saveBtn.disabled = true;
  // Live preview alongside the editor, on by default.
  if (!editor.isSideBySideActive()) editor.toggleSideBySide();
  editor.codemirror.refresh();
  editor.codemirror.focus();
}

function setDirty(value) {
  dirty = value;
  dirtyDotEl.hidden = !value;
  saveBtn.disabled = !value;
}

async function saveCurrentFile() {
  if (!openPath || !dirty) return;
  const content = easyMDE.value();
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
