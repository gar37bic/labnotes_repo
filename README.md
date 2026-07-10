# 🧪 LabNotes

A tiny, personal Notion-style notebook for experiment progress, ideas, and tasks.
It runs entirely in your browser and stores everything in a **private GitHub repo**,
so you can open it from any computer and your data follows you.

- **Frontend**: static site (this repo) → hosted free on **GitHub Pages**
- **Database**: one `db.json` file in a **separate private repo**, read/written through
  the GitHub API. Every save is a normal git commit — so you get full version history
  of your notes for free.
- **Images**: stored under `images/` in the same private data repo.
- **Auth**: a fine-grained GitHub token you paste once per browser (stored only in that
  browser's localStorage — never committed, never sent anywhere except GitHub).

## Features

- Markdown notes with live preview (headings, tables, code, checklists, images)
- Notebooks (folders) — drag the sidebar headings to reorder
- Dark mode, full-text search, pinned notes
- Tasks with due dates & priority, grouped into Overdue / Today / Upcoming / Done
- `- [ ] todo` lines in a note automatically become linked tasks
- Paste / drag-drop / upload images; export any note as `.md`
- Autosave (`Cmd+S` to force-save, `Cmd+E` to toggle preview)

## One-time setup

### 1. Create two repos on GitHub
- **This app** → a repo (can be public), e.g. `labnotes`. Push these files to it.
- **Your data** → a **private** repo, e.g. `labnotes-data`. Leave it empty.

### 2. Turn on GitHub Pages for the app repo
Repo → **Settings → Pages** → *Build and deployment* → Source: **Deploy from a branch**,
Branch: `main` / `/ (root)` → Save. After a minute your app is live at
`https://<your-username>.github.io/labnotes/`.

### 3. Make a fine-grained access token
GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token**:
- **Repository access** → *Only select repositories* → your `labnotes-data` repo
- **Permissions → Repository → Contents** → **Read and write**
- Generate and copy the `github_pat_…` value.

### 4. Open the app and connect
Open your Pages URL, enter your username, the data repo name, and the token, then
**Connect**. On first run it creates `db.json` in the data repo. Done — bookmark it.

Repeat step 4 (paste the token) once on each new computer/browser you use.

## Run it locally (optional)
It's just static files, so any static server works:
```bash
python3 -m http.server 5099   # then open http://localhost:5099
```

## Notes on privacy & safety
- Keep the **data** repo private. The app repo can be public — it contains no data.
- The token is like a password. If a device is lost, delete that token in GitHub
  settings; it can't be recovered or reused elsewhere.
- Markdown preview is sanitized (DOMPurify) so pasted HTML can't run scripts.

> The original local-only Flask + SQLite version lives in this repo's git history
> (commit `b0fb2d0` and earlier) if you ever want it back.
