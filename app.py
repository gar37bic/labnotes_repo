#!/usr/bin/env python3
"""LabNotes - a personal notebook & task web app.

Run:  python3 app.py
Open: http://localhost:5099
"""
import os
import re
import sqlite3
from datetime import datetime

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "notebook.db")
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")

app = Flask(__name__, static_folder="static")


# ---------------------------------------------------------------- database

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS notes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL DEFAULT 'Untitled',
            content    TEXT NOT NULL DEFAULT '',
            notebook   TEXT NOT NULL DEFAULT 'General',
            pinned     INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            title        TEXT NOT NULL,
            done         INTEGER NOT NULL DEFAULT 0,
            due_date     TEXT,
            priority     TEXT NOT NULL DEFAULT 'normal',
            note_id      INTEGER REFERENCES notes(id) ON DELETE SET NULL,
            source       TEXT NOT NULL DEFAULT 'manual',
            created_at   TEXT NOT NULL,
            completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS notebook_order (
            name     TEXT PRIMARY KEY,
            position INTEGER NOT NULL
        );
        """
    )
    # migrate older databases that predate the `source` column
    cols = [r[1] for r in db.execute("PRAGMA table_info(tasks)").fetchall()]
    if "source" not in cols:
        db.execute("ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    db.commit()
    db.close()


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ------------------------------------------------------------------- pages

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# --------------------------------------------------------------- notes API

@app.get("/api/notes")
def list_notes():
    q = request.args.get("q", "").strip()
    db = get_db()
    if q:
        rows = db.execute(
            """SELECT id, title, notebook, pinned, created_at, updated_at,
                      substr(content, 1, 200) AS snippet
               FROM notes
               WHERE title LIKE ? OR content LIKE ?
               ORDER BY pinned DESC, updated_at DESC""",
            (f"%{q}%", f"%{q}%"),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT id, title, notebook, pinned, created_at, updated_at,
                      substr(content, 1, 200) AS snippet
               FROM notes
               ORDER BY pinned DESC, updated_at DESC"""
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/notes")
def create_note():
    data = request.get_json(force=True) or {}
    ts = now()
    db = get_db()
    cur = db.execute(
        "INSERT INTO notes (title, content, notebook, created_at, updated_at) VALUES (?,?,?,?,?)",
        (
            data.get("title") or "Untitled",
            data.get("content", ""),
            data.get("notebook") or "General",
            ts,
            ts,
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM notes WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.get("/api/notes/<int:note_id>")
def get_note(note_id):
    row = get_db().execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(dict(row))


@app.put("/api/notes/<int:note_id>")
def update_note(note_id):
    data = request.get_json(force=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    fields = {
        "title": data.get("title", row["title"]),
        "content": data.get("content", row["content"]),
        "notebook": data.get("notebook", row["notebook"]),
        "pinned": int(data.get("pinned", row["pinned"])),
    }
    db.execute(
        "UPDATE notes SET title=?, content=?, notebook=?, pinned=?, updated_at=? WHERE id=?",
        (fields["title"], fields["content"], fields["notebook"], fields["pinned"], now(), note_id),
    )
    db.commit()
    row = db.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    return jsonify(dict(row))


@app.delete("/api/notes/<int:note_id>")
def delete_note(note_id):
    db = get_db()
    db.execute("DELETE FROM notes WHERE id=?", (note_id,))
    db.commit()
    return jsonify({"ok": True})


# ----------------------------------------------------------- notebooks API

@app.get("/api/notebooks")
def list_notebooks():
    db = get_db()
    counts = db.execute(
        "SELECT notebook, COUNT(*) AS n FROM notes GROUP BY notebook"
    ).fetchall()
    order = {
        r["name"]: r["position"]
        for r in db.execute("SELECT name, position FROM notebook_order").fetchall()
    }
    result = sorted(
        (dict(r) for r in counts),
        key=lambda x: (order.get(x["notebook"], 1_000_000), x["notebook"].lower()),
    )
    return jsonify(result)


@app.put("/api/notebooks/order")
def set_notebook_order():
    data = request.get_json(force=True) or {}
    order = data.get("order", [])
    db = get_db()
    db.execute("DELETE FROM notebook_order")
    for i, name in enumerate(order):
        db.execute(
            "INSERT INTO notebook_order (name, position) VALUES (?, ?)", (name, i)
        )
    db.commit()
    return jsonify({"ok": True})


# -------------------------------------------------------------- upload API

@app.post("/api/upload")
def upload():
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify({"error": "no file"}), 400
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    name = f"{stamp}_{secure_filename(f.filename) or 'image.png'}"
    f.save(os.path.join(UPLOAD_DIR, name))
    return jsonify({"url": f"/static/uploads/{name}"})


# --------------------------------------------------------------- tasks API

@app.get("/api/tasks")
def list_tasks():
    rows = get_db().execute(
        """SELECT t.*, n.title AS note_title
           FROM tasks t LEFT JOIN notes n ON n.id = t.note_id
           ORDER BY t.done ASC,
                    CASE WHEN t.due_date IS NULL OR t.due_date = '' THEN 1 ELSE 0 END,
                    t.due_date ASC, t.id DESC"""
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/tasks")
def create_task():
    data = request.get_json(force=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO tasks (title, due_date, priority, note_id, created_at) VALUES (?,?,?,?,?)",
        (title, data.get("due_date") or None, data.get("priority") or "normal",
         data.get("note_id"), now()),
    )
    db.commit()
    row = db.execute("SELECT * FROM tasks WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.put("/api/tasks/<int:task_id>")
def update_task(task_id):
    data = request.get_json(force=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    done = int(data.get("done", row["done"]))
    completed_at = row["completed_at"]
    if done and not row["done"]:
        completed_at = now()
    elif not done:
        completed_at = None
    db.execute(
        "UPDATE tasks SET title=?, done=?, due_date=?, priority=?, completed_at=? WHERE id=?",
        (
            data.get("title", row["title"]),
            done,
            data.get("due_date", row["due_date"]),
            data.get("priority", row["priority"]),
            completed_at,
            task_id,
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    return jsonify(dict(row))


@app.delete("/api/tasks/<int:task_id>")
def delete_task(task_id):
    db = get_db()
    db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    db.commit()
    return jsonify({"ok": True})


@app.post("/api/notes/<int:note_id>/sync-tasks")
def sync_tasks(note_id):
    """Reconcile a note's markdown checklist items with checklist-sourced tasks.

    Manual tasks are never touched. Checklist tasks for this note are created,
    updated (done-state), or deleted to match the items passed in.
    """
    data = request.get_json(force=True) or {}
    items = data.get("items", [])
    db = get_db()
    existing = db.execute(
        "SELECT * FROM tasks WHERE note_id=? AND source='checklist'", (note_id,)
    ).fetchall()
    existing_by_title = {r["title"]: r for r in existing}
    seen = set()
    for it in items:
        title = (it.get("title") or "").strip()
        if not title:
            continue
        seen.add(title)
        done = 1 if it.get("done") else 0
        row = existing_by_title.get(title)
        if row is not None:
            if row["done"] != done:
                db.execute(
                    "UPDATE tasks SET done=?, completed_at=? WHERE id=?",
                    (done, now() if done else None, row["id"]),
                )
        else:
            db.execute(
                """INSERT INTO tasks (title, done, priority, note_id, source, created_at, completed_at)
                   VALUES (?,?, 'normal', ?, 'checklist', ?, ?)""",
                (title, done, note_id, now(), now() if done else None),
            )
    for title, row in existing_by_title.items():
        if title not in seen:
            db.execute("DELETE FROM tasks WHERE id=?", (row["id"],))
    db.commit()
    return jsonify({"ok": True})


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5099, debug=False)
