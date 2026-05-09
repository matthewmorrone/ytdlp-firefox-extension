# yt-dlp Firefox extension

A small Firefox extension that downloads the active YouTube tab through `yt-dlp` running locally on your machine. The toolbar (address-bar) icon only appears on YouTube pages.

![icon](extension/icon.svg)

## Features

- One-click `video` (mp4) or `audio` (mp3) download of the current YouTube video
- Auto-canonicalizes URLs (strips `&list=…&index=…`, rewrites `/shorts/`, `youtu.be/…`)
- Embeds the YouTube thumbnail and metadata into the file (toggleable per download)
- Editable filename, pre-filled with `Title [videoId]` to match yt-dlp's default template
- Persistent download history with live progress bars, parsed from yt-dlp's stdout, that survives popup-close and shows up across all open YouTube tabs
- Uses Firefox cookies (`--cookies-from-browser firefox`) so age-gated / member videos work

## Architecture

```
[page-action click on a YouTube tab]
   └─> popup.html / popup.js
         └─ runtime.sendMessage("start", req) ──> background.js
                                                     └─ runtime.connectNative("ytdlp_host")
                                                           └─ stdio ─> ytdlp_host.py
                                                                          └─ subprocess: yt-dlp …
```

The download lives in the **background script**, not the popup, so closing the popup doesn't kill the native messaging port. Progress is persisted to `browser.storage.local`, which the popup reads and re-renders on `storage.onChanged`.

## Requirements

- macOS (paths in `install.sh` and the host script are macOS-specific)
- Firefox (regular, not Developer Edition / Nightly)
- `yt-dlp`, `ffmpeg`, and `AtomicParsley` in `/opt/homebrew/bin` (Homebrew default):

```sh
brew install yt-dlp ffmpeg atomicparsley
```

## Install

```sh
git clone https://github.com/matthewmorrone/ytdlp-firefox-extension.git
cd ytdlp-firefox-extension
bash install.sh
```

`install.sh` copies the host script to `~/.local/share/ytdlp-host/ytdlp_host.py` and writes a native-messaging-host manifest into `~/Library/Application Support/Mozilla/NativeMessagingHosts/ytdlp_host.json`.

Then in Firefox:

1. `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Pick `extension/manifest.json`.

The extension ID must be `ytdlp@matthewmorrone` (pinned in the manifest); the native-host manifest's `allowed_extensions` matches that.

## Use

Open a YouTube video. Click the download-arrow icon in the address bar. Pick **video** or **audio**. Files land in `~/Downloads`.

- Click the × on the thumbnail to skip embedding it for this download.
- Toggle "Embed metadata" off to skip `--embed-metadata`.
- Edit the filename or leave it for yt-dlp's default template.

## Files

- `extension/` — the WebExtension (MV2)
  - `manifest.json` — page-action restricted to `*.youtube.com` and `youtu.be`
  - `popup.html` / `popup.js` — UI + history rendering
  - `background.js` — owns the native messaging port; parses progress; persists state
  - `icon.svg` / `icon-action.svg` — colored icon for listings, monochrome silhouette for the address bar
- `host/ytdlp_host.py` — native messaging host (4-byte LE length-prefixed JSON over stdio)
- `install.sh` — installs host script + native-messaging-host manifest

## Troubleshooting

- **No log activity, host disconnects** — check `/tmp/ytdlp_host.log`. Most common: host script not in `~/.local/share/ytdlp-host/` (re-run `install.sh`), or `/usr/bin/python3` missing.
- **Address-bar icon not visible** — only shows on URLs matching `*://*.youtube.com/*` or `*://youtu.be/*`. After loading as a temporary add-on, the icon may be hidden behind the protection-shield menu — click the `…` to pin it visibly.
- **"No such native application 'ytdlp_host'"** — `bash install.sh` didn't run, or Firefox is using a non-default profile dir.
- **Temporary add-ons disappear on Firefox restart** — re-load via `about:debugging` each session, or sign the extension for permanent install (out of scope).

## License

MIT
