/* ===== LabNotes — client-side app backed by a private GitHub repo =====
 *
 * No server. All data lives in one file, db.json, in your private data repo,
 * read/written through the GitHub REST Contents API. Images live under images/.
 */
const $ = (sel) => document.querySelector(sel);

/* ---------------- utilities ---------------- */

function pad(n) { return String(n).padStart(2, "0"); }
function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function tsStamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function encodeB64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function decodeB64Utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function guessMime(path) {
  const ext = path.split(".").pop().toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
           webp: "image/webp", svg: "image/svg+xml" }[ext] || "application/octet-stream";
}

/* ---------------- cultivation (修仙) system ---------------- */

const REALMS = [
  { name: "炼气期", at: 0,     color: "#8a8f98", emoji: "🌱" },
  { name: "筑基期", at: 100,   color: "#4a9eea", emoji: "🧱" },
  { name: "金丹期", at: 300,   color: "#e0a12b", emoji: "🟡" },
  { name: "元婴期", at: 700,   color: "#e0533d", emoji: "👶" },
  { name: "化神期", at: 1500,  color: "#9b59b6", emoji: "🌀" },
  { name: "合体期", at: 3000,  color: "#16a085", emoji: "🤝" },
  { name: "大乘期", at: 6000,  color: "#c0392b", emoji: "☸️" },
  { name: "仙人",   at: 12000, color: "#f1c40f", emoji: "🧙" },
];
const STAGES = ["初期", "中期", "后期", "圆满"];

function taskAward(t) {
  return { low: 5, normal: 10, high: 20 }[t.priority] ?? 10;
}
function realmInfo(xp) {
  let idx = 0;
  for (let i = 0; i < REALMS.length; i++) if (xp >= REALMS[i].at) idx = i;
  const realm = REALMS[idx];
  const next = REALMS[idx + 1];
  if (!next) return { idx, realm, next: null, stage: "", prog: 1, into: xp - realm.at, span: null };
  const span = next.at - realm.at;
  const into = xp - realm.at;
  const prog = into / span;
  const stage = STAGES[Math.min(STAGES.length - 1, Math.floor(prog * STAGES.length))];
  return { idx, realm, next, stage, prog, into, span };
}
function progressRank(xp) {
  const i = realmInfo(xp);
  const s = i.next ? Math.min(3, Math.floor(i.prog * 4)) : 4;
  return i.idx * 10 + s;
}

/* ---------------- GitHub API layer ---------------- */

const gh = {
  cfg: null,      // { owner, repo, token }
  sha: null,      // current db.json blob sha

  loadCfg() {
    const raw = localStorage.getItem("labnotes.cfg");
    this.cfg = raw ? JSON.parse(raw) : null;
    return this.cfg;
  },
  saveCfg(cfg) {
    this.cfg = cfg;
    localStorage.setItem("labnotes.cfg", JSON.stringify(cfg));
  },
  clearCfg() {
    this.cfg = null;
    localStorage.removeItem("labnotes.cfg");
  },

  async api(path, opts = {}) {
    const res = await fetch("https://api.github.com" + path, {
      ...opts,
      headers: {
        Authorization: "Bearer " + this.cfg.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).message || ""; } catch {}
      const err = new Error(`GitHub ${res.status}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  },

  contents(file) {
    return `/repos/${this.cfg.owner}/${this.cfg.repo}/contents/${file}`;
  },

  async checkRepo() {
    await this.api(`/repos/${this.cfg.owner}/${this.cfg.repo}`);
  },

  async getDb() {
    try {
      const r = await this.api(this.contents("db.json"));
      this.sha = r.sha;
      return JSON.parse(decodeB64Utf8(r.content));
    } catch (e) {
      if (e.status === 404) { this.sha = null; return null; }
      throw e;
    }
  },

  async putDb(db, message) {
    const body = {
      message: message || "Update notes",
      content: encodeB64Utf8(JSON.stringify(db, null, 2)),
    };
    if (this.sha) body.sha = this.sha;
    const r = await this.api(this.contents("db.json"), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    this.sha = r.content.sha;
    return r;
  },

  async putImage(path, base64) {
    return this.api(this.contents(path), {
      method: "PUT",
      body: JSON.stringify({ message: "Add image " + path, content: base64 }),
    });
  },

  async getImageDataUrl(path) {
    const r = await this.api(this.contents(path));
    return `data:${guessMime(path)};base64,${r.content.replace(/\s/g, "")}`;
  },
};

/* ---------------- in-memory database + persistence ---------------- */

let DB = { notes: [], tasks: [], folders: [], notebook_order: [], xp: 0, seq: 1 };

const state = { currentId: null, view: "empty", mode: "edit", saveTimer: null, activeFolder: "General" };

const collapsed = new Set(JSON.parse(localStorage.getItem("labnotes.collapsed") || "[]"));
function saveCollapsed() {
  localStorage.setItem("labnotes.collapsed", JSON.stringify([...collapsed]));
}

let _saving = false, _dirty = false, _lastMsg = "Update notes";
async function persist(message) {
  _lastMsg = message || _lastMsg;
  if (_saving) { _dirty = true; return; }
  _saving = true;
  setStatus("Saving…");
  try {
    await gh.putDb(DB, _lastMsg);
    setStatus("Saved ✓");
  } catch (e) {
    setStatus("Save failed — check connection");
    console.error(e);
  } finally {
    _saving = false;
    if (_dirty) { _dirty = false; persist(_lastMsg); }
  }
}
function setStatus(msg) {
  const el = $("#save-status");
  if (el) el.textContent = msg;
}

/* run an action that may change XP; show a breakthrough toast if a realm/stage is gained */
function xpTransaction(fn) {
  const beforeRank = progressRank(DB.xp || 0);
  const beforeIdx = realmInfo(DB.xp || 0).idx;
  fn();
  renderCharacter();
  const info = realmInfo(DB.xp || 0);
  if (info.idx > beforeIdx) {
    toast(`突破！进入 ${info.realm.name}`, "up");
    $("#char-avatar").classList.remove("breakthrough");
    void $("#char-avatar").offsetWidth;
    $("#char-avatar").classList.add("breakthrough");
  } else if (progressRank(DB.xp || 0) > beforeRank) {
    toast(`修为精进 · ${info.realm.name}${info.stage}`, "up");
  }
}

function setDone(t, done) {
  done = done ? 1 : 0;
  if (done && !t.done) {
    t.done = 1;
    t.completed_at = nowStr();
    if (!t.awarded) { t.awarded = taskAward(t); DB.xp = (DB.xp || 0) + t.awarded; }
  } else if (!done && t.done) {
    t.done = 0;
    t.completed_at = null;
    if (t.awarded) { DB.xp = (DB.xp || 0) - t.awarded; t.awarded = 0; }
  }
}

/* ---------------- theme ---------------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = $("#theme-btn");
  if (b) b.textContent = t === "dark" ? "☀️" : "🌙";
}
applyTheme(localStorage.getItem("theme") || "light");

/* ---------------- notes helpers ---------------- */

function findNote(id) { return DB.notes.find((n) => n.id === id); }

function notesFiltered(q) {
  let list = DB.notes.slice();
  if (q) {
    const lq = q.toLowerCase();
    list = list.filter(
      (n) => (n.title || "").toLowerCase().includes(lq) ||
             (n.content || "").toLowerCase().includes(lq)
    );
  }
  list.sort((a, b) =>
    (b.pinned - a.pinned) || (b.updated_at < a.updated_at ? -1 : b.updated_at > a.updated_at ? 1 : 0)
  );
  return list;
}

function folderRank(path) {
  const i = DB.notebook_order.indexOf(path);
  return i === -1 ? 1e9 : i;
}

/* ---------------- folder tree ---------------- */

function ancestorsOf(path) {
  const parts = path.split("/");
  const out = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function buildTree(q) {
  const notes = notesFiltered(q);
  const paths = new Set();
  if (q) {
    for (const n of notes) paths.add(n.notebook || "General");
  } else {
    DB.folders.forEach((p) => p && paths.add(p));
    for (const n of DB.notes) paths.add(n.notebook || "General");
  }
  for (const p of [...paths]) ancestorsOf(p).forEach((a) => paths.add(a));

  const root = { name: "", path: "", children: {}, notes: [] };
  for (const p of [...paths].filter(Boolean)) {
    const parts = p.split("/");
    let cur = root, acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      cur.children[part] = cur.children[part] || { name: part, path: acc, children: {}, notes: [] };
      cur = cur.children[part];
    }
  }
  for (const n of notes) {
    const parts = (n.notebook || "General").split("/");
    let cur = root;
    for (const part of parts) {
      cur.children[part] = cur.children[part] ||
        { name: part, path: (cur.path ? cur.path + "/" : "") + part, children: {}, notes: [] };
      cur = cur.children[part];
    }
    cur.notes.push(n);
  }
  return { root, forceExpand: !!q };
}

function subtreeNoteCount(node) {
  let c = node.notes.length;
  for (const k in node.children) c += subtreeNoteCount(node.children[k]);
  return c;
}

let dragNoteId = null, dragFolderPath = null;

function refreshSidebar() {
  const q = $("#search").value.trim();
  const { root, forceExpand } = buildTree(q);
  const tree = $("#note-tree");
  tree.innerHTML = "";
  renderBranch(root, 0, tree, forceExpand);

  if (!DB.notes.length && !q) {
    tree.innerHTML = `<div style="padding:12px;font-size:13px;color:var(--text-dim)">No notes yet.</div>`;
  } else if (q && !notesFiltered(q).length) {
    tree.innerHTML = `<div style="padding:12px;font-size:13px;color:var(--text-dim)">No matches.</div>`;
  }
}

function renderBranch(node, depth, container, forceExpand) {
  const names = Object.keys(node.children).sort(
    (a, b) => folderRank(node.children[a].path) - folderRank(node.children[b].path) || a.localeCompare(b)
  );
  for (const name of names) {
    const child = node.children[name];
    container.appendChild(folderRow(child, depth, forceExpand));
    const open = forceExpand || !collapsed.has(child.path);
    if (open) {
      renderBranch(child, depth + 1, container, forceExpand);
      for (const n of child.notes) container.appendChild(noteItem(n, depth + 1));
    }
  }
}

function folderRow(node, depth, forceExpand) {
  const row = document.createElement("div");
  row.className = "tree-row" + (node.path === state.activeFolder ? " active-folder" : "");
  row.style.paddingLeft = 6 + depth * 13 + "px";
  const hasKids = Object.keys(node.children).length || node.notes.length;
  const open = forceExpand || !collapsed.has(node.path);

  const tri = document.createElement("span");
  tri.className = "tri" + (hasKids ? (open ? " open" : "") : " leaf");
  tri.textContent = "▶";
  tri.onclick = (e) => { e.stopPropagation(); toggleFolder(node.path); };

  const nameEl = document.createElement("span");
  nameEl.className = "folder-name";
  nameEl.textContent = node.name;

  const count = document.createElement("span");
  count.className = "folder-count";
  const c = subtreeNoteCount(node);
  count.textContent = c ? " " + c : "";

  const acts = document.createElement("span");
  acts.className = "folder-acts";
  acts.append(
    mkActBtn("＋", "New subfolder", (e) => { e.stopPropagation(); createFolder(node.path); }),
    mkActBtn("✏", "Rename", (e) => { e.stopPropagation(); renamePrompt(node); }),
    mkActBtn("🗑", "Delete (empty only)", (e) => { e.stopPropagation(); deleteFolder(node); })
  );

  row.append(tri, nameEl, count, acts);
  row.onclick = () => { state.activeFolder = node.path; toggleFolder(node.path); };

  // drag: folder can be re-parented; folders accept dropped notes/folders
  row.draggable = true;
  row.addEventListener("dragstart", (e) => { dragFolderPath = node.path; dragNoteId = null; e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (dragNoteId != null || (dragFolderPath && dragFolderPath !== node.path)) row.classList.add("drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    row.classList.remove("drop-target");
    if (dragNoteId != null) moveNoteToFolder(dragNoteId, node.path);
    else if (dragFolderPath) reparentFolder(dragFolderPath, node.path);
    dragNoteId = dragFolderPath = null;
  });
  return row;
}

function mkActBtn(txt, title, onclick) {
  const b = document.createElement("button");
  b.textContent = txt;
  b.title = title;
  b.onclick = onclick;
  return b;
}

function noteItem(n, depth) {
  const b = document.createElement("button");
  b.className = "note-item" + (n.id === state.currentId ? " active" : "");
  b.style.paddingLeft = 8 + depth * 13 + "px";
  b.innerHTML = `<div class="ni-title">${n.pinned ? "📌 " : ""}${esc(n.title)}</div>
                 <div class="ni-date">${(n.updated_at || "").slice(0, 16)}</div>`;
  b.onclick = () => openNote(n.id);
  b.draggable = true;
  b.addEventListener("dragstart", (e) => { dragNoteId = n.id; dragFolderPath = null; b.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  b.addEventListener("dragend", () => b.classList.remove("dragging"));
  return b;
}

function toggleFolder(path) {
  if (collapsed.has(path)) collapsed.delete(path);
  else collapsed.add(path);
  saveCollapsed();
  refreshSidebar();
}

function createFolder(parentPath) {
  const name = (prompt("New folder name:", "") || "").trim();
  if (!name || name.includes("/")) return;
  const path = parentPath ? parentPath + "/" + name : name;
  if (!DB.folders.includes(path)) DB.folders.push(path);
  if (parentPath) collapsed.delete(parentPath), saveCollapsed();
  state.activeFolder = path;
  refreshSidebar();
  persist("Create folder " + path);
}

function renamePrompt(node) {
  const name = (prompt("Rename folder:", node.name) || "").trim();
  if (!name || name === node.name || name.includes("/")) return;
  const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
  const newPath = parent ? parent + "/" + name : name;
  applyFolderPrefixChange(node.path, newPath);
  refreshSidebar();
  persist("Rename folder");
}

function deleteFolder(node) {
  if (subtreeNoteCount(node) > 0 || Object.keys(node.children).length > 0) {
    alert("This folder isn't empty. Move or delete its notes/subfolders first.");
    return;
  }
  DB.folders = DB.folders.filter((p) => p !== node.path);
  if (state.activeFolder === node.path) state.activeFolder = "General";
  refreshSidebar();
  persist("Delete folder");
}

function moveNoteToFolder(noteId, folderPath) {
  const n = findNote(noteId);
  if (!n) return;
  n.notebook = folderPath;
  n.updated_at = nowStr();
  if (state.currentId === noteId) $("#notebook-input").value = folderPath;
  refreshSidebar();
  persist("Move note");
}

function reparentFolder(fromPath, toPath) {
  if (toPath === fromPath || toPath.startsWith(fromPath + "/")) return; // no cycles
  const seg = fromPath.split("/").pop();
  const newPath = toPath ? toPath + "/" + seg : seg;
  if (newPath === fromPath) return;
  applyFolderPrefixChange(fromPath, newPath);
  collapsed.delete(toPath); saveCollapsed();
  refreshSidebar();
  persist("Move folder");
}

/* rewrite a folder path prefix across DB.folders, notes, order and collapsed state */
function applyFolderPrefixChange(oldPath, newPath) {
  const remap = (p) =>
    p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p;
  DB.folders = [...new Set(DB.folders.map(remap))];
  if (!DB.folders.includes(newPath)) DB.folders.push(newPath);
  for (const n of DB.notes) n.notebook = remap(n.notebook || "General");
  DB.notebook_order = DB.notebook_order.map(remap);
  for (const p of [...collapsed]) { const np = remap(p); if (np !== p) { collapsed.delete(p); collapsed.add(np); } }
  saveCollapsed();
  if (state.activeFolder) state.activeFolder = remap(state.activeFolder);
}

function refreshTaskCount() {
  const open = DB.tasks.filter((t) => !t.done).length;
  $("#task-count").textContent = open ? open : "";
}

/* ---------------- views ---------------- */

function showView(view) {
  state.view = view;
  $("#note-view").classList.toggle("hidden", view !== "note");
  $("#tasks-view").classList.toggle("hidden", view !== "tasks");
  $("#empty-view").classList.toggle("hidden", view !== "empty");
}

/* ---------------- note editing ---------------- */

function openNote(id) {
  const n = findNote(id);
  if (!n) return;
  state.currentId = id;
  state.activeFolder = n.notebook || "General";
  $("#note-title").value = n.title;
  $("#note-content").value = n.content;
  $("#notebook-input").value = n.notebook;
  $("#pin-btn").classList.toggle("pinned", !!n.pinned);
  $("#note-meta").textContent = `Created ${n.created_at} · Updated ${n.updated_at}`;
  setStatus("");
  setMode("edit");
  showView("note");
  $(".note-scroll").scrollTop = 0;
  refreshSidebar();
}

function newNote() {
  const ts = nowStr();
  const n = { id: DB.seq++, title: "Untitled", content: "", notebook: state.activeFolder || "General",
              pinned: 0, created_at: ts, updated_at: ts };
  DB.notes.push(n);
  persist("Create note");
  openNote(n.id);
  $("#note-title").focus();
  $("#note-title").select();
}

function scheduleSave() {
  setStatus("…");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNote, 900);
}

function saveNote() {
  if (state.currentId == null) return;
  const n = findNote(state.currentId);
  if (!n) return;
  n.title = $("#note-title").value || "Untitled";
  n.content = $("#note-content").value;
  n.notebook = $("#notebook-input").value.trim() || "General";
  n.updated_at = nowStr();
  state.activeFolder = n.notebook;
  xpTransaction(() => syncChecklistTasks(n.id, extractChecklist(n.content)));
  $("#note-meta").textContent = `Created ${n.created_at} · Updated ${n.updated_at}`;
  refreshSidebar();
  refreshTaskCount();
  persist("Update note: " + n.title);
}

function extractChecklist(text) {
  const items = [];
  const re = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;
  for (const line of text.split("\n")) {
    const m = line.match(re);
    if (m) items.push({ title: m[2], done: m[1].toLowerCase() === "x" });
  }
  return items;
}

function syncChecklistTasks(noteId, items) {
  const existing = DB.tasks.filter((t) => t.note_id === noteId && t.source === "checklist");
  const byTitle = new Map(existing.map((t) => [t.title, t]));
  const seen = new Set();
  for (const it of items) {
    const title = (it.title || "").trim();
    if (!title) continue;
    seen.add(title);
    let t = byTitle.get(title);
    if (!t) {
      t = { id: DB.seq++, title, done: 0, due_date: null, priority: "normal",
            note_id: noteId, source: "checklist", created_at: nowStr(), completed_at: null, awarded: 0 };
      DB.tasks.push(t);
    }
    setDone(t, it.done);
  }
  for (const [title, t] of byTitle) {
    if (!seen.has(title)) DB.tasks = DB.tasks.filter((x) => x.id !== t.id);
  }
}

function setMode(mode) {
  state.mode = mode;
  $("#mode-edit").classList.toggle("active", mode === "edit");
  $("#mode-preview").classList.toggle("active", mode === "preview");
  $("#note-content").classList.toggle("hidden", mode !== "edit");
  $("#note-preview").classList.toggle("hidden", mode !== "preview");
  if (mode === "preview") {
    const el = $("#note-preview");
    const html = marked.parse($("#note-content").value, { breaks: true });
    el.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : html;
    resolveImages(el);
  } else {
    autoGrow();
  }
}

function autoGrow() {
  const ta = $("#note-content");
  ta.style.height = "auto";
  ta.style.height = Math.max(ta.scrollHeight, window.innerHeight * 0.6) + "px";
}

const imageCache = new Map();
async function resolveImages(container) {
  for (const img of container.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (/^(https?:|data:|\/)/.test(src)) continue;
    if (imageCache.has(src)) { img.src = imageCache.get(src); continue; }
    try {
      const url = await gh.getImageDataUrl(src);
      imageCache.set(src, url);
      img.src = url;
    } catch (e) { /* leave broken image icon */ }
  }
}

/* ---------------- tasks ---------------- */

function taskGroupOf(t) {
  if (t.done) return "Done";
  if (!t.due_date) return "No due date";
  const today = todayStr();
  if (t.due_date < today) return "Overdue";
  if (t.due_date === today) return "Today";
  return "Upcoming";
}

function sortedTasks() {
  return DB.tasks.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done - b.done;
    const ad = a.due_date || "9999", bd = b.due_date || "9999";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return b.id - a.id;
  });
}

function renderTasks() {
  const order = ["Overdue", "Today", "Upcoming", "No due date", "Done"];
  const groups = {};
  for (const t of sortedTasks()) (groups[taskGroupOf(t)] ||= []).push(t);

  const box = $("#task-groups");
  box.innerHTML = "";
  for (const name of order) {
    if (!groups[name]) continue;
    const g = document.createElement("div");
    g.className = "task-group";
    const h = document.createElement("h3");
    h.textContent = `${name} · ${groups[name].length}`;
    if (name === "Overdue") h.classList.add("overdue");
    g.appendChild(h);
    for (const t of groups[name]) g.appendChild(taskRow(t));
    box.appendChild(g);
  }
  if (!DB.tasks.length) {
    box.innerHTML = `<p style="color:var(--text-dim)">No tasks yet — add your first one above.</p>`;
  }
  refreshTaskCount();
}

function taskRow(t) {
  const row = document.createElement("div");
  row.className = "task-row" + (t.done ? " done" : "");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!t.done;
  cb.onchange = () => {
    const willComplete = cb.checked && !t.done;
    const award = taskAward(t);
    xpTransaction(() => { setDone(t, cb.checked); });
    if (willComplete) toast(`+${award} 灵气`, "xp");
    renderTasks();
    persist("Toggle task");
  };

  const title = document.createElement("span");
  title.className = "t-title";
  title.textContent = t.title;
  title.title = "Double-click to edit";
  title.ondblclick = () => {
    const v = prompt("Edit task:", t.title);
    if (v && v.trim()) { t.title = v.trim(); renderTasks(); persist("Edit task"); }
  };

  row.append(cb, title);

  if (t.priority && t.priority !== "normal") {
    const pill = document.createElement("span");
    pill.className = "t-pill " + t.priority;
    pill.textContent = t.priority;
    row.appendChild(pill);
  }
  if (t.due_date) {
    const due = document.createElement("span");
    due.className = "t-due" + (!t.done && t.due_date < todayStr() ? " overdue" : "");
    due.textContent = "📅 " + t.due_date;
    row.appendChild(due);
  }
  if (t.note_id != null) {
    const note = findNote(t.note_id);
    if (note) {
      const src = document.createElement("button");
      src.className = "t-src";
      src.textContent = "↩ " + note.title;
      src.title = "Open source note";
      src.onclick = () => openNote(note.id);
      row.appendChild(src);
    }
  }

  const del = document.createElement("button");
  del.className = "t-del";
  del.textContent = "✕";
  del.title = "Delete task";
  del.onclick = () => {
    DB.tasks = DB.tasks.filter((x) => x.id !== t.id);
    renderTasks();
    renderCharacter();
    persist("Delete task");
  };
  row.appendChild(del);
  return row;
}

/* ---------------- character panel ---------------- */

function renderCharacter() {
  const xp = DB.xp || 0;
  const info = realmInfo(xp);
  const color = info.realm.color;
  const panel = $("#character");
  panel.style.setProperty("--realm-color", color);

  $("#char-avatar").textContent = info.realm.emoji;
  $("#char-realm").textContent = info.realm.name;
  $("#char-stage").textContent = info.next ? info.stage : "已臻化境 ✦";
  $("#char-bar-fill").style.width = Math.round(info.prog * 100) + "%";
  $("#char-xp").textContent = info.next
    ? `${info.into} / ${info.span} 灵气 · 距 ${info.next.name} 还需 ${info.span - info.into}`
    : `${xp} 灵气 · 修为圆满`;
  $("#char-total").textContent = xp;
  $("#char-done").textContent = DB.tasks.filter((t) => t.done).length;

  const ladder = $("#char-ladder");
  ladder.innerHTML = "";
  REALMS.forEach((r, i) => {
    const item = document.createElement("div");
    const cls = i === info.idx ? "current" : xp >= r.at ? "reached" : "";
    item.className = "ladder-item " + cls;
    item.innerHTML = `<span class="l-emoji">${r.emoji}</span><span>${r.name}</span>`;
    ladder.appendChild(item);
  });
}

let _toastN = 0;
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  const id = ++_toastN;
  el.dataset.id = id;
  setTimeout(() => el.remove(), 2600);
}

/* ---------------- image upload ---------------- */

function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
async function uploadAndInsert(file) {
  setStatus("Uploading image…");
  try {
    const base64 = await fileToBase64(file);
    const safe = (file.name || "image.png").replace(/[^\w.\-]/g, "_");
    const path = `images/${tsStamp()}_${safe}`;
    await gh.putImage(path, base64);
    insertAtCursor($("#note-content"), `\n![${file.name || "image"}](${path})\n`);
    scheduleSave();
    autoGrow();
  } catch (e) {
    setStatus("Image upload failed");
    console.error(e);
  }
}

/* ---------------- event wiring ---------------- */

function wireEvents() {
  $("#theme-btn").onclick = () => {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", t);
    applyTheme(t);
  };

  $("#new-note").onclick = newNote;
  $("#empty-new").onclick = newNote;
  $("#new-folder").onclick = () => createFolder("");
  $("#nav-tasks").onclick = () => {
    state.currentId = null;
    showView("tasks");
    renderTasks();
    refreshSidebar();
  };

  $("#note-title").addEventListener("input", scheduleSave);
  $("#note-content").addEventListener("input", () => { scheduleSave(); autoGrow(); });
  $("#notebook-input").addEventListener("change", scheduleSave);
  $("#search").addEventListener("input", refreshSidebar);

  $("#pin-btn").onclick = () => {
    if (state.currentId == null) return;
    const n = findNote(state.currentId);
    n.pinned = n.pinned ? 0 : 1;
    $("#pin-btn").classList.toggle("pinned", !!n.pinned);
    refreshSidebar();
    persist("Pin note");
  };

  $("#delete-note").onclick = () => {
    if (state.currentId == null) return;
    if (!confirm("Delete this note permanently?")) return;
    const id = state.currentId;
    DB.notes = DB.notes.filter((n) => n.id !== id);
    DB.tasks = DB.tasks.filter((t) => !(t.note_id === id && t.source === "checklist"));
    DB.tasks.forEach((t) => { if (t.note_id === id) t.note_id = null; });
    state.currentId = null;
    showView("empty");
    refreshSidebar();
    refreshTaskCount();
    renderCharacter();
    persist("Delete note");
  };

  $("#mode-edit").onclick = () => { setMode("edit"); $("#note-content").focus(); };
  $("#mode-preview").onclick = () => setMode("preview");

  $("#img-btn").onclick = () => $("#img-file").click();
  $("#img-file").onchange = (e) => {
    [...e.target.files].forEach(uploadAndInsert);
    e.target.value = "";
  };
  $("#note-content").addEventListener("paste", (e) => {
    for (const it of e.clipboardData?.items || []) {
      if (it.type.startsWith("image/")) { e.preventDefault(); uploadAndInsert(it.getAsFile()); }
    }
  });
  $("#note-content").addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  $("#note-content").addEventListener("drop", (e) => {
    const imgs = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (imgs.length) { e.preventDefault(); imgs.forEach(uploadAndInsert); }
  });

  $("#export-btn").onclick = () => {
    if (state.currentId == null) return;
    const title = $("#note-title").value || "Untitled";
    const md = `# ${title}\n\n${$("#note-content").value}\n`;
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = title.replace(/[\\/:*?"<>|]/g, "_") + ".md";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $("#task-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("#task-title").value.trim();
    if (!title) return;
    DB.tasks.push({ id: DB.seq++, title, done: 0,
                    due_date: $("#task-due").value || null,
                    priority: $("#task-priority").value, note_id: null,
                    source: "manual", created_at: nowStr(), completed_at: null, awarded: 0 });
    $("#task-title").value = "";
    $("#task-due").value = "";
    $("#task-priority").value = "normal";
    renderTasks();
    persist("Add task");
  });

  // character panel collapse / expand
  const charCollapsed = localStorage.getItem("labnotes.char") === "collapsed";
  $("#character").classList.toggle("collapsed", charCollapsed);
  $("#char-toggle").onclick = () => {
    $("#character").classList.add("collapsed");
    localStorage.setItem("labnotes.char", "collapsed");
  };
  $("#char-expand").onclick = () => {
    $("#character").classList.remove("collapsed");
    localStorage.setItem("labnotes.char", "open");
  };

  $("#settings-btn").onclick = () => {
    if (confirm("Sign out on this browser? Your notes stay safe in GitHub; you'll re-enter your token to reconnect.")) {
      gh.clearCfg();
      location.reload();
    }
  };

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveNote(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "e" && state.view === "note") {
      e.preventDefault();
      setMode(state.mode === "edit" ? "preview" : "edit");
    }
  });
}

/* ---------------- setup gate + boot ---------------- */

function showSetup(msg, cls) {
  $("#app").classList.add("hidden");
  $("#setup").classList.remove("hidden");
  const m = $("#cfg-msg");
  m.textContent = msg || "";
  m.className = "setup-msg" + (cls ? " " + cls : "");
  const cfg = gh.cfg || {};
  $("#cfg-owner").value = cfg.owner || "";
  $("#cfg-repo").value = cfg.repo || "labnotes-data";
}

$("#cfg-connect").onclick = async () => {
  const owner = $("#cfg-owner").value.trim();
  const repo = $("#cfg-repo").value.trim();
  const token = $("#cfg-token").value.trim();
  if (!owner || !repo || !token) {
    return showSetup("Please fill in all three fields.", "err");
  }
  const btn = $("#cfg-connect");
  btn.disabled = true;
  $("#cfg-msg").textContent = "Connecting…";
  $("#cfg-msg").className = "setup-msg";
  gh.cfg = { owner, repo, token };
  try {
    await gh.checkRepo();
    gh.saveCfg(gh.cfg);
    await boot();
  } catch (e) {
    btn.disabled = false;
    const hint = e.status === 404
      ? "Repo not found. Check the username/repo name, and that the token can access this repo."
      : e.status === 401
      ? "Token rejected. Check the token is correct and not expired."
      : e.message;
    showSetup(hint, "err");
  }
};

async function boot() {
  $("#setup").classList.add("hidden");
  $("#app").classList.remove("hidden");
  applyTheme(localStorage.getItem("theme") || "light");
  $("#sync-state").textContent = `${gh.cfg.owner}/${gh.cfg.repo}`;

  let db = null;
  try {
    db = await gh.getDb();
  } catch (e) {
    console.error(e);
  }
  if (db == null) {
    DB = { notes: [], tasks: [], folders: ["General"], notebook_order: [], xp: 0, seq: 1 };
    await persist("Initialize LabNotes database");
  } else {
    DB = Object.assign({ notes: [], tasks: [], folders: [], notebook_order: [], xp: null, seq: 1 }, db);
    if (!DB.seq) {
      const ids = [...DB.notes, ...DB.tasks].map((x) => x.id || 0);
      DB.seq = (ids.length ? Math.max(...ids) : 0) + 1;
    }
    if (!DB.folders || !DB.folders.length) {
      DB.folders = [...new Set(DB.notes.map((n) => n.notebook || "General"))];
      if (!DB.folders.length) DB.folders = ["General"];
    }
    if (DB.xp == null) { // migrate: award XP retroactively for completed tasks
      DB.xp = 0;
      for (const t of DB.tasks) {
        if (t.done) { if (!t.awarded) t.awarded = taskAward(t); DB.xp += t.awarded; }
        else t.awarded = t.awarded || 0;
      }
    }
  }

  refreshSidebar();
  refreshTaskCount();
  renderCharacter();
  const first = notesFiltered("")[0];
  if (first) openNote(first.id);
  else showView("empty");
}

wireEvents();
if (gh.loadCfg()) {
  boot().catch(() => showSetup("Couldn’t connect with the saved token. Re-enter your details.", "err"));
} else {
  showSetup("");
}
