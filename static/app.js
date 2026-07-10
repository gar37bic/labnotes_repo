/* ===== LabNotes frontend ===== */
const $ = (sel) => document.querySelector(sel);

const state = {
  notes: [],
  tasks: [],
  currentId: null,
  view: "empty", // note | tasks | empty
  mode: "edit",  // edit | preview
  saveTimer: null,
};

const api = {
  async req(url, opts = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  listNotes: (q) => api.req("/api/notes" + (q ? "?q=" + encodeURIComponent(q) : "")),
  getNote: (id) => api.req("/api/notes/" + id),
  createNote: (body) => api.req("/api/notes", { method: "POST", body: JSON.stringify(body) }),
  updateNote: (id, body) => api.req("/api/notes/" + id, { method: "PUT", body: JSON.stringify(body) }),
  deleteNote: (id) => api.req("/api/notes/" + id, { method: "DELETE" }),
  listNotebooks: () => api.req("/api/notebooks"),
  setNotebookOrder: (order) => api.req("/api/notebooks/order", { method: "PUT", body: JSON.stringify({ order }) }),
  listTasks: () => api.req("/api/tasks"),
  createTask: (body) => api.req("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id, body) => api.req("/api/tasks/" + id, { method: "PUT", body: JSON.stringify(body) }),
  deleteTask: (id) => api.req("/api/tasks/" + id, { method: "DELETE" }),
  syncTasks: (id, items) => api.req("/api/notes/" + id + "/sync-tasks", { method: "POST", body: JSON.stringify({ items }) }),
  async upload(file) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
};

/* ---------------- theme ---------------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("#theme-btn").textContent = t === "dark" ? "☀️" : "🌙";
}
applyTheme(localStorage.getItem("theme") || "light");
$("#theme-btn").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", t);
  applyTheme(t);
};

/* ---------------- sidebar ---------------- */

async function refreshSidebar() {
  const q = $("#search").value.trim();
  const [notes, notebooks] = await Promise.all([api.listNotes(q), api.listNotebooks()]);
  state.notes = notes;
  const tree = $("#note-tree");
  tree.innerHTML = "";

  const groups = {};
  for (const n of state.notes) (groups[n.notebook] ||= []).push(n);

  // order groups by the saved notebook order; unknown notebooks fall to the end
  const orderList = notebooks.map((x) => x.notebook);
  const rank = (nb) => { const i = orderList.indexOf(nb); return i === -1 ? 1e9 : i; };
  const names = Object.keys(groups).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

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
                     <div class="ni-date">${n.updated_at.slice(0, 16)}</div>`;
      b.onclick = () => openNote(n.id);
      g.appendChild(b);
    }
    tree.appendChild(g);
  }
  if (!state.notes.length) {
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
  h.addEventListener("drop", async (e) => {
    e.preventDefault();
    h.classList.remove("drop-target");
    if (!dragNb || dragNb === nb) return;
    const names = [...document.querySelectorAll(".nb-name")].map((el) => el.dataset.nb);
    names.splice(names.indexOf(dragNb), 1);
    names.splice(names.indexOf(nb), 0, dragNb);
    dragNb = null;
    await api.setNotebookOrder(names);
    refreshSidebar();
  });
}

async function refreshTaskCount() {
  state.tasks = await api.listTasks();
  const open = state.tasks.filter((t) => !t.done).length;
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

async function openNote(id) {
  const n = await api.getNote(id);
  state.currentId = id;
  $("#note-title").value = n.title;
  $("#note-content").value = n.content;
  $("#notebook-input").value = n.notebook;
  $("#pin-btn").classList.toggle("pinned", !!n.pinned);
  $("#note-meta").textContent = `Created ${n.created_at} · Updated ${n.updated_at}`;
  $("#save-status").textContent = "";
  setMode("edit");
  showView("note");
  refreshSidebar();
}

async function newNote() {
  const n = await api.createNote({ title: "Untitled" });
  await openNote(n.id);
  $("#note-title").focus();
  $("#note-title").select();
}

function scheduleSave() {
  $("#save-status").textContent = "…";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNote, 600);
}

async function saveNote() {
  if (state.currentId == null) return;
  const content = $("#note-content").value;
  const n = await api.updateNote(state.currentId, {
    title: $("#note-title").value || "Untitled",
    content,
    notebook: $("#notebook-input").value.trim() || "General",
  });
  // turn markdown checklist items into real tasks (one-way: note is source of truth)
  await api.syncTasks(state.currentId, extractChecklist(content));
  $("#note-meta").textContent = `Created ${n.created_at} · Updated ${n.updated_at}`;
  $("#save-status").textContent = "Saved ✓";
  refreshSidebar();
  refreshTaskCount();
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

function setMode(mode) {
  state.mode = mode;
  $("#mode-edit").classList.toggle("active", mode === "edit");
  $("#mode-preview").classList.toggle("active", mode === "preview");
  $("#note-content").classList.toggle("hidden", mode !== "edit");
  $("#note-preview").classList.toggle("hidden", mode !== "preview");
  if (mode === "preview") {
    $("#note-preview").innerHTML = marked.parse($("#note-content").value, { breaks: true });
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

/* ---------------- tasks ---------------- */

function taskGroupOf(t) {
  if (t.done) return "Done";
  if (!t.due_date) return "No due date";
  const today = new Date().toISOString().slice(0, 10);
  if (t.due_date < today) return "Overdue";
  if (t.due_date === today) return "Today";
  return "Upcoming";
}

async function renderTasks() {
  state.tasks = await api.listTasks();
  const order = ["Overdue", "Today", "Upcoming", "No due date", "Done"];
  const groups = {};
  for (const t of state.tasks) (groups[taskGroupOf(t)] ||= []).push(t);

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
  if (!state.tasks.length) {
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
  cb.onchange = async () => {
    await api.updateTask(t.id, { done: cb.checked ? 1 : 0 });
    renderTasks();
  };

  const title = document.createElement("span");
  title.className = "t-title";
  title.textContent = t.title;
  title.title = "Double-click to edit";
  title.ondblclick = async () => {
    const v = prompt("Edit task:", t.title);
    if (v && v.trim()) {
      await api.updateTask(t.id, { title: v.trim() });
      renderTasks();
    }
  };

  row.append(cb, title);

  if (t.priority !== "normal") {
    const pill = document.createElement("span");
    pill.className = "t-pill " + t.priority;
    pill.textContent = t.priority;
    row.appendChild(pill);
  }
  if (t.due_date) {
    const due = document.createElement("span");
    const today = new Date().toISOString().slice(0, 10);
    due.className = "t-due" + (!t.done && t.due_date < today ? " overdue" : "");
    due.textContent = "📅 " + t.due_date;
    row.appendChild(due);
  }
  if (t.note_id && t.note_title) {
    const src = document.createElement("button");
    src.className = "t-src";
    src.textContent = "↩ " + t.note_title;
    src.title = "Open source note";
    src.onclick = () => openNote(t.note_id);
    row.appendChild(src);
  }

  const del = document.createElement("button");
  del.className = "t-del";
  del.textContent = "✕";
  del.title = "Delete task";
  del.onclick = async () => {
    await api.deleteTask(t.id);
    renderTasks();
  };
  row.appendChild(del);
  return row;
}

/* ---------------- helpers & events ---------------- */

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

$("#new-note").onclick = newNote;
$("#empty-new").onclick = newNote;
$("#nav-tasks").onclick = () => { state.currentId = null; showView("tasks"); renderTasks(); refreshSidebar(); };

$("#note-title").addEventListener("input", scheduleSave);
$("#note-content").addEventListener("input", () => { scheduleSave(); autoGrow(); });
$("#notebook-input").addEventListener("change", scheduleSave);
$("#search").addEventListener("input", refreshSidebar);

$("#pin-btn").onclick = async () => {
  if (state.currentId == null) return;
  const pinned = !$("#pin-btn").classList.contains("pinned");
  $("#pin-btn").classList.toggle("pinned", pinned);
  await api.updateNote(state.currentId, { pinned: pinned ? 1 : 0 });
  refreshSidebar();
};

$("#delete-note").onclick = async () => {
  if (state.currentId == null) return;
  if (!confirm("Delete this note permanently?")) return;
  await api.deleteNote(state.currentId);
  state.currentId = null;
  showView("empty");
  refreshSidebar();
};

$("#mode-edit").onclick = () => setMode("edit");
$("#mode-preview").onclick = () => setMode("preview");

/* ---- image upload: button, paste, drag-drop ---- */
function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
}

async function uploadAndInsert(file) {
  $("#save-status").textContent = "Uploading image…";
  try {
    const { url } = await api.upload(file);
    insertAtCursor($("#note-content"), `\n![${file.name || "image"}](${url})\n`);
    scheduleSave();
    autoGrow();
  } catch (err) {
    $("#save-status").textContent = "Upload failed";
  }
}

$("#img-btn").onclick = () => $("#img-file").click();
$("#img-file").onchange = (e) => {
  [...e.target.files].forEach(uploadAndInsert);
  e.target.value = "";
};

$("#note-content").addEventListener("paste", (e) => {
  for (const it of e.clipboardData?.items || []) {
    if (it.type.startsWith("image/")) {
      e.preventDefault();
      uploadAndInsert(it.getAsFile());
    }
  }
});
$("#note-content").addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
});
$("#note-content").addEventListener("drop", (e) => {
  const imgs = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (imgs.length) {
    e.preventDefault();
    imgs.forEach(uploadAndInsert);
  }
});

/* ---- export current note as .md ---- */
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

$("#task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api.createTask({
    title: $("#task-title").value,
    due_date: $("#task-due").value || null,
    priority: $("#task-priority").value,
  });
  $("#task-title").value = "";
  $("#task-due").value = "";
  $("#task-priority").value = "normal";
  renderTasks();
});

// Ctrl/Cmd+S saves immediately; Ctrl/Cmd+E toggles preview
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveNote(); }
  if ((e.metaKey || e.ctrlKey) && e.key === "e" && state.view === "note") {
    e.preventDefault();
    setMode(state.mode === "edit" ? "preview" : "edit");
  }
});

/* ---------------- init ---------------- */
(async function init() {
  await refreshSidebar();
  await refreshTaskCount();
  if (state.notes.length) openNote(state.notes[0].id);
  else showView("empty");
})();
