// Phase 1 frontend: folder tree in the sidebar, raw text view in the main pane.

const treeEl = document.getElementById("tree");
const viewerEl = document.getElementById("viewer");
const emptyStateEl = document.getElementById("empty-state");
const currentFileEl = document.getElementById("current-file");
const currentTypeEl = document.getElementById("current-type");
const rescanBtn = document.getElementById("rescan-btn");

let activeItem = null;

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
    if (node.kind === "folder") {
      container.appendChild(renderFolder(node));
    } else {
      container.appendChild(renderFile(node));
    }
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

// ---------- File viewing ----------

async function openFile(node, item) {
  try {
    const data = await api(`/api/file?path=${encodeURIComponent(node.path)}`);
    emptyStateEl.hidden = true;
    viewerEl.hidden = false;
    viewerEl.textContent = data.content;
    currentFileEl.textContent = data.path;
    currentFileEl.classList.remove("placeholder");
    currentTypeEl.textContent = data.type;
    if (activeItem) activeItem.classList.remove("active");
    item.classList.add("active");
    activeItem = item;
  } catch (err) {
    viewerEl.hidden = false;
    emptyStateEl.hidden = true;
    viewerEl.textContent = `Could not open ${node.path}: ${err.message}`;
  }
}

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
