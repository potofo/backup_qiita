# Qiita Article Backup Tool

English | [日本語](README.ja-JP.md)

A local web tool that performs one-way backups of all your Qiita articles (including private/limited-share ones) — Markdown and images — to your local PC via Qiita API v2 (personal access token). It tracks backup states, detects updates on Qiita, and keeps generation history as run-by-run commits in an independent Git repository under the `backups/` folder.

## Requirements

- Windows 11 (also works on macOS / Linux)
- Node.js 24 or later
- Git (optional — without it the tool still works, just without generation history)

## Setup

```powershell
npm install
copy .env.example .env   # optional (the token can also be entered and saved from the UI)
```

`.env` settings:

| Key | Description | Default |
|---|---|---|
| `QIITA_ACCESS_TOKEN` | Qiita personal access token (scope: `read_qiita` only) | (none) |
| `BACKUP_DIR` | Backup destination folder | `backups` |
| `SERVER_PORT` | Local web server port | `3000` |

To issue a token: sign in to Qiita → Settings → Applications → Personal access tokens → "Generate new token" (scope: `read_qiita` only).

## Getting Started

```powershell
npm start
```

Open the displayed URL (default: `http://localhost:3000`) in your browser. The server listens on the loopback address only, so it is not reachable from outside your machine.

## Usage

1. **Connection screen** — Verifies your token. If it is missing or invalid, the screen shows issuance instructions and an input field (the token is saved to `.env` only with your consent).
2. **Article list / dashboard** — Shows all articles classified into 5 states (Not backed up / Up to date / Updated on Qiita / Modified locally / Deleted on Qiita). Backups run in three modes: differential (default), full, or selected articles.
3. **Progress view** — Progress bar, per-article result log, and a cancel button. On completion it shows a result summary and the run history (including Git commit info).

## Backup Layout

```text
backups/
├── .git/                      # Auto-committed per run (independent from this repo; commits always go to the "backup" branch)
├── index.json                 # Management data (states and history)
└── {article title}_{article id}/
    ├── {article title}.md     # Viewable Markdown with image references rewritten to relative paths
    ├── original.md            # Markdown exactly as fetched
    ├── meta.json              # Article metadata (reaction counts, image download results, etc.)
    └── images/                # Named like 001_{original filename}.png
```

The viewable Markdown renders with images as-is in any Markdown viewer such as VS Code.

## Development

```powershell
npm test          # unit + integration tests (vitest)
npm run typecheck # TypeScript type check
npm run perf      # performance test (mock: 300 articles x 10 images, ~15 min)
node scripts/mock-qiita.mjs  # mock Qiita server for development (token: mock-token)
```

To run the app against the mock server, start it with the environment variable `QIITA_API_BASE_URL=http://127.0.0.1:4510/api/v2`.

## Security

- The token is kept only in `.env` and in memory; the UI and logs show a masked form (last 4 characters) only
- The `Authorization` header is sent only to the Qiita API (`qiita.com`) — never to image hosts
- The web server binds to `127.0.0.1` only. No remote operations (push/pull) are implemented for the backup repository
- The `backup` branch is local-only: a pre-push hook is installed automatically in the backup repository and rejects any push of the branch (even manual ones), preventing accidental publication of private articles

## License

[MIT License](LICENSE.txt) — Copyright (c) 2026 potofo
