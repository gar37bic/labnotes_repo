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
  listTasks: () => api.req("/api/tasks"),
  createTask: (body) => api.req("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id, body) => api.req("/api/tasks/" + id, { method: "PUT", body: JSON.stringify(body) }),
  deleteTask: (id) => api.req("/api/tasks/" + id, { method: "DELETE" }),
};

/* ---------------- sidebar ---------------- */

async function refreshSidebar() {
  const q = $("#search").value.trim();
  state.notes = await api.listNotes(q);
  const tree = $("#note-tree");
  tree.innerHTML = "";

  const groups = {};
  for (const n of state.notes) (groups[n.notebook] ||= []).push(n);

  for (const nb of Object.keys(groups).sort()) {
    const g = document.createElement("div");
    g.className = "nb-group";
    const h = document.createElement("div");
    h.className = "nb-name";
    h.textContent = nb;
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
  const n = await api.updateNote(state.currentId, {
    title: $("#note-title").value || "Untitled",
    content: $("#note-content").value,
    notebook: $("#notebook-input").value.trim() || "General",
  });
  $("#note-meta").textContent = `Created ${n.created_at} · Updated ${n.updated_at}`;
  $("#save-status").textContent = "Saved ✓";
  refreshSidebar();
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
