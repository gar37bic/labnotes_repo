# 🧪 LabNotes

A tiny, personal Notion-style notebook for recording experiment progress, ideas, and tasks.
Single user, runs locally, no accounts, no cloud — your data stays in one SQLite file.

## Features

- **Markdown notes** with live preview (headings, tables, code blocks, checklists, images)
- **Notebooks** — group notes into folders (e.g. `CRISPR screen`, `Ideas`, `Meetings`)
- **Pin** important notes to the top, **full-text search** across all notes
- **Tasks** with due dates and priority, auto-grouped into Overdue / Today / Upcoming / Done
- **Autosave** — just type; `Cmd+S` to force save, `Cmd+E` to toggle edit/preview

## Run it

```bash
pip install flask          # one-time
python3 app.py
```

Then open **http://localhost:5099** in Chrome. Bookmark it for daily use.

To start it automatically on login (macOS), you can add `python3 /path/to/app.py`
as a Login Item, or just keep a terminal tab running.

## Where is my data?

Everything lives in `notebook.db` (SQLite) next to `app.py`.
Back it up by committing it to this git repo, or copy it anywhere.

## Layout

```
app.py            Flask server + REST API + SQLite schema
static/index.html UI layout
static/style.css  Notion-inspired styling
static/app.js     Frontend logic
notebook.db       Your notes & tasks (created on first run)
```
