# BL Shelf — local MVP

Run the app with a recent Node.js installation:

```bash
node server.mjs
```

Then open http://127.0.0.1:4173.

## What works now

- Minimal light/dark interface with carousel galleries.
- Add titles manually, change a title's status, promote/dismiss discovery candidates, and create auditable research tasks.
- All changes persist locally in the browser with `localStorage`.
- The local seed contains the populated `WATCH` rows from the provided Excel export.
- When Google sync is connected, status changes, progress updates, manual metadata edits, promoted discoveries, and manually added titles are written to the live `WATCH` tab. Offline changes are queued in this browser until they can sync.

## TMDB metadata

The local server exposes a localhost-only TMDB search endpoint. Put a TMDB Read Access Token in `.env.local` (copy `.env.example` if needed); the app can enrich an individual title with **Enrich with TMDB**, or use **Enrich active** for Continue Watching, Ready When You Are, and the review inbox. Bulk enrichment skips weak or ambiguous title matches for manual review. The browser never receives the token.

## Google Sheets connection

This local server uses Google OAuth, so you sign in once and no Google secret is placed in browser code.

1. In Google Cloud Console, create/select a project and enable the **Google Sheets API**.
2. Configure the OAuth consent screen for your own Google account.
3. Create an **OAuth client ID** of type **Web application**. Add this exact authorized redirect URI:

   `http://127.0.0.1:4173/api/google/auth/callback`

4. Add the client ID and client secret to `.env.local` using `.env.example` as the template, then restart `node server.mjs`.
5. In the app, open **Details** in the sync card and choose **Connect Google Sheet**. Approve access with the Google account that owns the Sheet.

The local server keeps the OAuth token in `.google-oauth.json`, which is ignored by Git. The first synced change adds extra metadata headers to the right of the existing WATCH columns; it preserves the original fields and Softr Record ID. Discovery-inbox and task-tab sync can be added next after you decide their tab names and fields.

## Git

The app is safe to put in a private Git repository: `.env.local` and the local Google token are ignored. After a remote repository exists, add it from this folder and push the initial commit.

TMDB and any optional AI provider credentials should also be set only as local environment variables in that server layer.
