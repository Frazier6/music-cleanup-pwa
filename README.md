# 🎵 MusicCleanup PWA

A fully client-side Progressive Web App for detecting and removing duplicate music files. **Zero server. Zero uploads. 100% private** — everything runs in your browser via the File System Access API.

**[→ Live App](https://YOUR-USERNAME.github.io/music-cleanup-pwa)**

---

## What's in this repo

```
music-cleanup-pwa/
├── index.html              ← Complete single-file app (HTML + CSS + JS)
├── worker.js               ← Web Worker: scanning, hashing, metadata, dedup
├── service-worker.js       ← PWA offline cache
├── manifest.json           ← PWA install manifest
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── .github/workflows/
    └── deploy.yml          ← GitHub Actions auto-deploy to Pages
```

---

## Deploy to GitHub Pages

### Option A — GitHub Actions (recommended, automatic)

```bash
# 1. Create a new repo on GitHub (e.g. "music-cleanup-pwa")

# 2. Push these files
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/music-cleanup-pwa.git
git push -u origin main

# 3. Enable Pages with Actions
# GitHub → Settings → Pages → Source → GitHub Actions
```

Every push to `main` auto-deploys. Your app will be live at:
```
https://YOUR-USERNAME.github.io/music-cleanup-pwa/
```

### Option B — Deploy from branch (no Actions needed)

```bash
git init && git add . && git commit -m "Initial"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/music-cleanup-pwa.git
git push -u origin main
```
Then: **GitHub → Settings → Pages → Source → Deploy from branch → main → / (root)**

---

## How it works

All processing runs in a **Web Worker** so the UI stays responsive on any size library.

| Stage | What it does |
|-------|-------------|
| **Index** | Recursively walks the folder, collects all audio file handles |
| **Meta**  | Parses ID3v2/FLAC/MP4/OGG tags from raw bytes — no libraries needed |
| **Hash**  | SHA-1 of full file + SHA-1 of audio payload (strips ID3/FLAC headers) |
| **Dedup** | Groups by exact hash → audio hash → normalized title+artist |

**"Keep" recommendation** prefers: FLAC > WAV > M4A > MP3, then higher bitrate.

**Trash Review** — files are never deleted. You get a `.txt` delete-list with `rm` / `Remove-Item` commands to run yourself.

---

## Browser support

| Browser | Status |
|---------|--------|
| Chrome 86+ | ✅ Full support |
| Edge 86+   | ✅ Full support |
| Firefox    | ❌ No `showDirectoryPicker` |
| Safari     | ❌ No `showDirectoryPicker` |

---

## Privacy

- No backend, no API calls (except Google Fonts on first load)
- File System Access API grants **read-only** access — the app cannot modify or delete files
- Nothing is stored remotely or sent anywhere
