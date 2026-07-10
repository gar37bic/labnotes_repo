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
    // throws with a friendly message if the token/repo aren't usable
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

let DB = { notes: [], tasks: [], notebook_order: [], seq: 1 };

const state = { currentId: null, view: "empty", mode: "edit", saveTimer: null };

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

/* ---------------- theme ---------------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = $("#theme-btn");
  if (b) b.textContent = t === "dark" ? "☀️" : "🌙";
}
applyTheme(localStorage.getItem("theme") || "light");

/* ---------------- sidebar ---------------- */

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

function notebookOrder() {
  const present = [...new Set(DB.notes.map((n) => n.notebook))];
  const rank = (nb) => {
    const i = DB.notebook_order.indexOf(nb);
    return i === -1 ? 1e9 : i;
  };
  return present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function refreshSidebar() {
  const q = $("#search").value.trim();
  const notes = notesFiltered(q);
  const tree = $("#note-tree");
  tree.innerHTML = "";

  const groups = {};
  for (const n of notes) (groups[n.notebook] ||= []).push(n);
  const names = notebookOrder().filter((nb) => groups[nb]);

  for (const nb of names) {
    const g = document.createElement("div");
    g.className = "nb-group";
    const h = document.createElement("div");
    h.className = "nb-name";
    h.textContent = nb;
    h.draggable = true;
    h.dataset.nb = nb;
    attachNotebookDrag(h, nb);
    g.appendChild(h);
    for (const n of groups[nb]) {
      const b = document.createElement("button");
      b.className = "note-item" + (n.id === state.currentId ? " active" : "");
      b.innerHTML = `<div class="ni-title">${n.pinned ? "📌 " : ""}${esc(n.title)}</div>
                     <div class="ni-date">${(n.updated_at || "").slice(0, 16)}</div>`;
      b.onclick = () => openNote(n.id);
      g.appendChild(b);
    }
    tree.appendChild(g);
  }
  if (!notes.length) {
    tree.innerHTML = `<div style="padding:12px;font-size:13px;color:var(--text-dim)">
      ${q ? "No matches." : "No notes yet."}</div>`;
  }
}

let dragNb = null;
function attachNotebookDrag(h, nb) {
  h.addEventListener("dragstart", (e) => {
    dragNb = nb;
    h.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  h.addEventListener("dragend", () => h.classList.remove("dragging"));
  h.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (dragNb && dragNb !== nb) h.classList.add("drop-target");
  });
  h.addEventListener("dragleave", () => h.classList.remove("drop-target"));
  h.addEventListener("drop", (e) => {
    e.preventDefault();
    h.classList.remove("drop-target");
    if (!dragNb || dragNb === nb) return;
    const names = [...document.querySelectorAll(".nb-name")].map((el) => el.dataset.nb);
    names.splice(names.indexOf(dragNb), 1);
    names.splice(names.indexOf(nb), 0, dragNb);
    dragNb = null;
    DB.notebook_order = names;
    refreshSidebar();
    persist("Reorder notebooks");
  });
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

function findNote(id) { return DB.notes.find((n) => n.id === id); }

function openNote(id) {
  const n = findNote(id);
  if (!n) return;
  state.currentId = id;
  $("#note-title").value = n.title;
  $("#note-content").value = n.content;
  $("#notebook-input").value = n.notebook;
  $("#pin-btn").classList.toggle("pinned", !!n.pinned);
  $("#note-meta").textContent = `Created ${n.created_at} · Updated ${n.updated_at}`;
  setStatus("");
  setMode("edit");
  showView("note");
  refreshSidebar();
}

function newNote() {
  const ts = nowStr();
  const n = { id: DB.seq++, title: "Untitled", content: "", notebook: "General",
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
  syncChecklistTasks(n.id, extractChecklist(n.content));
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
    const t = byTitle.get(title);
    if (t) {
      if (!!t.done !== !!it.done) {
        t.done = it.done ? 1 : 0;
        t.completed_at = it.done ? nowStr() : null;
      }
    } else {
      DB.tasks.push({ id: DB.seq++, title, done: it.done ? 1 : 0, due_date: null,
                      priority: "normal", note_id: noteId, source: "checklist",
                      created_at: nowStr(), completed_at: it.done ? nowStr() : null });
    }
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
    $("#note-content").focus();
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
    if (/^(https?:|data:|\/)/.test(src)) continue; // external or data URIs left alone
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
    t.done = cb.checked ? 1 : 0;
    t.completed_at = cb.checked ? nowStr() : null;
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
    persist("Delete task");
  };
  row.appendChild(del);
  return row;
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
    // drop this note's checklist tasks; unlink manual tasks
    DB.tasks = DB.tasks.filter((t) => !(t.note_id === id && t.source === "checklist"));
    DB.tasks.forEach((t) => { if (t.note_id === id) t.note_id = null; });
    state.currentId = null;
    showView("empty");
    refreshSidebar();
    refreshTaskCount();
    persist("Delete note");
  };

  $("#mode-edit").onclick = () => setMode("edit");
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
                    source: "manual", created_at: nowStr(), completed_at: null });
    $("#task-title").value = "";
    $("#task-due").value = "";
    $("#task-priority").value = "normal";
    renderTasks();
    persist("Add task");
  });

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
    // first run: create an empty db.json in the data repo
    DB = { notes: [], tasks: [], notebook_order: [], seq: 1 };
    await persist("Initialize LabNotes database");
  } else {
    DB = Object.assign({ notes: [], tasks: [], notebook_order: [], seq: 1 }, db);
    if (!DB.seq) {
      const ids = [...DB.notes, ...DB.tasks].map((x) => x.id || 0);
      DB.seq = (ids.length ? Math.max(...ids) : 0) + 1;
    }
  }

  refreshSidebar();
  refreshTaskCount();
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
