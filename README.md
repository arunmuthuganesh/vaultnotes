# VaultNotes

Obsidian-style markdown notes as an installable web app (PWA) for Windows and Android.
Works offline; syncs the same `.md` files with OneDrive or Dropbox.

Features: folders, markdown preview, `[[wiki links]]`, backlinks, full-text search (Ctrl+K),
autosave, conflict copies, offline storage, light/dark theme.

## 1. Host it (needs HTTPS so it can install on Android)
Free option: GitHub Pages / Netlify / Cloudflare Pages. Upload the files in this folder.
Your URL will look like `https://yourname.github.io/vaultnotes/`.
For testing on a PC only: `python -m http.server 8777` here, open http://localhost:8777/

## 2. Sync with OneDrive (personal account)
1. Go to https://entra.microsoft.com -> App registrations -> New registration.
2. Supported account types: **Personal Microsoft accounts only** (or "any directory + personal").
3. Redirect URI: platform **Single-page application (SPA)**, value = your app URL exactly
   (shown in the app under Settings, e.g. `https://yourname.github.io/vaultnotes/`). Register.
4. API permissions -> Microsoft Graph -> Delegated: `Files.ReadWrite` (and `offline_access`).
5. Copy the **Application (client) ID**.
6. In the app: Settings -> Provider OneDrive, paste the client ID, folder = `Obsidian/Vault`, Save & connect.

## 3. Sync with Dropbox (alternative)
1. https://www.dropbox.com/developers/apps -> Create app -> Scoped access -> **App folder**.
2. Permissions tab: enable `files.metadata.read`, `files.content.read`, `files.content.write`; Submit.
3. Settings tab: add the redirect URI (your app URL). Copy the **App key**.
4. In the app: Provider Dropbox, paste app key, leave folder empty, Save & connect.
   Notes live in Dropbox/Apps/<your app name>/.

## 4. Install
- Android (Chrome): menu -> Install app / Add to Home screen.
- Windows (Edge/Chrome): address-bar install icon -> Install.

## Notes
- Only `.md` files are synced; folders/files starting with `.` (like `.obsidian`) are skipped.
- If a note was edited on two devices, the cloud version wins and your local text is kept as
  `name (conflict YYYYMMDDHHMM).md`.
- Sign-in tokens are stored in the browser's localStorage on that device; use Disconnect to remove them.
- Sync runs after edits, every 2 minutes, and when the app regains focus.
