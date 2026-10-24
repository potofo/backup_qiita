# Qiita Article Backup Tool

English | [日本語](README.ja-JP.md)

A local web tool that backs up all your Qiita articles (including private/limited-share ones) — Markdown and images — to your local PC via Qiita API v2 (personal access token). It tracks backup states, detects updates on Qiita, and keeps generation history as run-by-run commits in an independent Git repository under the `backups/` folder.

In addition to downloading (backup), the tool also supports **uploading from local to Qiita**: registering articles newly written under `backups/` (always as limited-share / private) and updating the body of existing articles edited locally — always through an explicit action with a pre-run confirmation.

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
| `QIITA_ACCESS_TOKEN` | Qiita personal access token (scopes: see below) | (none) |
| `BACKUP_DIR` | Backup destination folder | `backups` |
| `SERVER_PORT` | Local web server port | `3000` |

To issue a token: sign in to Qiita → Settings → Applications → Personal access tokens → "Generate new token".

Choose scopes depending on the features you use:

- **Backup only**: `read_qiita`
- **With the upload feature**: `read_qiita` + `write_qiita`

## Getting Started

```powershell
npm start
```

Open the displayed URL (default: `http://localhost:3000`) in your browser. The server listens on the loopback address only, so it is not reachable from outside your machine.

## Usage

1. **Connection screen** — Verifies your token. If it is missing or invalid, the screen shows issuance instructions and an input field (the token is saved to `.env` only with your consent). The connection badge shows the write-permission state (read-only / read-write / unverified).
2. **Article list / dashboard** — Shows all articles classified into 8 states (Not backed up / Up to date / Updated on Qiita / Modified locally / New local / Conflict / Missing locally / Deleted on Qiita). Backups run in three modes: differential (default), full, or selected articles. Uploads run in two modes: "Upload changes" and "Upload selected".
3. **Progress view** — Progress bar, per-article result log, and a cancel button. On completion it shows a result summary and the run history (including run direction and Git commit info).

## Upload (Local → Qiita)

Local changes can be pushed to Qiita. Writes happen only through an explicit action followed by a pre-run confirmation — there is no automatic synchronization.

- **Registering new articles** — Articles written under the convention below are registered on Qiita as **limited-share (private)** (see "About the limited-share registration" below for details).
- **Updating existing articles** — Editing the viewable Markdown (`{article title}.md`) locally marks the article as "Modified locally", making it an upload candidate (title/tag changes are not synchronized). Relative image references are automatically restored to their original URLs on upload.
- **Conflict protection** — Articles changed on both Qiita and locally become "Conflict" and are excluded from both "Upload changes" and differential backups (they can only be handled via explicit selection and approval).

### Upload walkthrough

1. Create an article folder directly under `backups/` and write the Markdown following the convention below
2. Click "**一覧再取得**" (refresh) on the dashboard and confirm the article appears as "New local"
3. Check the article and click "**選択をアップロード**" (upload selected) — or "変更点をアップロード" (upload changes) for all candidates
4. Review the confirmation dialog (targets, warnings about live public articles, conflicts, and local images) and click "アップロードを実行" (run upload)
5. Check the result summary. On success the folder is automatically converted to the standard layout (`{article title}_{article id}/`), the state becomes "Up to date", and the article becomes a regular backup target from then on

### About the limited-share registration

Qiita API v2 has **no endpoint for creating drafts**, so this tool registers new articles as **limited-share (private)** as the closest equivalent of a draft. Keep the following in mind:

- **The article does NOT appear in Qiita's draft list (qiita.com/drafts).** It appears in your own article list with a "限定共有" (limited-share) label, and can be opened directly via the limited-share URL (`https://qiita.com/{user}/private/{article id}`) recorded in the result summary and `meta.json`.
- **Limited-share is not fully private.** Anyone who knows the URL can read the article (it does not appear in search or timelines). As long as you don't share the URL while drafting it is effectively private, but be careful with sensitive content.
- **Publishing is done on Qiita**: open the limited-share URL → "編集する" (edit) → switch the visibility to "全体に公開" (public) and post. The tool intentionally has no publish feature, to prevent accidental publication.
- Updating an existing article never changes its visibility (a public article stays public and the update goes live immediately — the confirmation dialog warns about this).

### Convention for new articles

Create a **folder with any name** directly under `backups/` and put exactly **one Markdown file (.md)** in it. The file must start with a frontmatter block containing `title` (required) and `tags` (required, one or more):

```markdown
---
title: Article title
tags: [tag1, tag2]
---
Write your article body here.
```

`tags` accepts any of these forms: `[a, b]`, `a b c` (space-separated), or a `- tag` list (Qiita tag names cannot contain spaces, so a space-separated value is interpreted as multiple tags).

Refreshing the article list detects it as "New local" (articles violating the convention are shown as non-uploadable with the reasons).

### Automatic image upload (optional feature)

Qiita API v2 has no way to upload images, so local images referenced from the body (`![fig](images/a.png)` or `<img src="images/a.png">`) are not displayed on Qiita as-is. When this optional feature is enabled, the tool **feeds the images into Qiita's editor page in a browser it opens** before uploading the article, and replaces the image references in **the body it sends** with the image URLs issued by Qiita.

- **This is an unofficial method**: it automates Qiita's web UI, so it may stop working without notice when the UI changes (the tool then stops and explains the manual steps). If Qiita judges the use to be a problem under its Terms of Service, your account could be suspended. You are asked for consent when enabling the feature for the first time.
- **Prerequisites**: `npm install` installs the optional dependency `playwright-core` (no browser is bundled). Microsoft Edge or Google Chrome is required. Restart the server after installing.
- **Enabling**: turn it on under "画像の自動アップロード(任意機能)" on the dashboard and accept the notes. You can also choose whether to keep the login session (stored in `.image-upload/browser-profile/`, outside Git; it can be deleted from the UI).
- **Usage**: the pre-run confirmation lists the images (count, total size, and images that cannot be sent with reasons). Check "ローカル画像をQiitaへアップロードしてから記事をアップロードする" and run; a browser opens. If you are not logged in to Qiita, **log in yourself in the opened browser** (the tool never handles your ID or password).
- **Local files are not rewritten**: only the body sent to Qiita is rewritten; the viewable Markdown keeps its relative references and still renders with images locally. The image-to-URL mapping is recorded in `uploadedImages` in `meta.json` (for new articles, in `.image-uploads.json` in the folder until registration), so identical images are never sent twice.
- **Fails safe**: an article with even one failed image is not uploaded. If login does not finish in time, the browser is closed, or the run is cancelled, no article is uploaded.
- **Work draft**: one work draft remains on Qiita for feeding images (reused next time). Delete it on Qiita when no longer needed. Uploaded images can be viewed by anyone who knows their URLs.

### If an upload fails with 403

Qiita returns **403 Forbidden for reasons other than missing scopes** as well. Check the following together with the Qiita response message shown in the failure reason:

- **Token scopes**: make sure `write_qiita` is granted (if the badge shows "読み取りのみ" / read-only, a 403 was recorded; verify or reissue the token and re-run the connection check to reset it to "unverified")
- **Invalid tags or body**: Qiita rejects invalid tag names and similar problems with 403 (not 400)
- If you edited the token in `.env` directly, **restart the server** (the token is loaded at startup)

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
- Writes to Qiita happen only through the explicit upload action (no automatic or scheduled sync); articles are never deleted
- New articles are always registered as limited-share (private); publishing can only be done on Qiita (structural protection against accidental publication)
- The web server binds to `127.0.0.1` only. No remote operations (push/pull) are implemented for the backup repository
- The `backup` branch is local-only: a pre-push hook is installed automatically in the backup repository and rejects any push of the branch (even manual ones), preventing accidental publication of private articles
- The browser session of the optional automatic image upload is not kept by default and is discarded after each run. Even when you consent to keep it, it is stored only under `.image-upload/` (outside Git) and never logged. The access token is never passed to the browser automation

## License

[MIT License](LICENSE.txt) — Copyright (c) 2026 potofo
