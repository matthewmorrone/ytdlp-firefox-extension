# Design: Capture HLS streams via response-body sniffing

**Date:** 2026-06-11
**Status:** Approved — implementing

## Goal

Download the actual video a user is watching on sites where the real stream is
loaded at runtime by a JS player and is invisible to yt-dlp's static-HTML
generic extractor (it grabs a preview instead). Proven necessary and viable
against rawfuckclub.com during debugging (see notes below).

## Proven facts (from debugging)

- The site's `generic`/`HTML5MediaEmbed` extractor only sees a preview clip
  (`/previews/small/…mp4`) + a player UI sound — never the full video.
- The full video is HLS: a media playlist of ~576 muxed h264/1080p + AAC
  `.ts` segments on CloudFront.
- The **manifest URL** (`/hlsv/…m3u8`) is session-gated — returns `#blocked`
  to anything outside the live player (cookies/Referer/Origin/Sec-Fetch all
  insufficient). So sniffing the URL is useless.
- The **segments** carry self-contained signed tokens and are freely fetchable
  until `exp` (no cookies needed).
- Feeding the captured media-playlist **text** to `yt-dlp --enable-file-urls`
  via a local file downloads all tokenized segments and muxes a correct MP4.
  Verified with a 5-segment truncated playlist → 1080p+AAC mp4.

## Approach

`webRequest.filterResponseData` (Firefox MV2) reads the manifest **body** as
the browser receives it — riding the already-authorized session. Rejected
alternatives: sniffing the manifest *URL* (proven dead — gated); content-script
`fetch`/XHR monkeypatching (fragile vs CSP / native-HLS players).

Capture model: **always-on, manifests only** — listen across all sites but only
ever read responses whose content-type is an HLS/DASH manifest; ignore all
other traffic.

## Architecture

```
play video → browser fetches .m3u8
  └─ capture.js (filterResponseData on manifest content-types) reads body,
       writes it back through (playback undisturbed), classifies, absolutizes
       segment/sub URIs → stores per-tab in background memory
toolbar click → popup asks background for this tab's streams
  └─ shows detected media playlists (auto-selects best), video/audio buttons
       └─ background forwards the stored playlist TEXT to the native host
            └─ host sanitizes, writes temp .m3u8, runs `yt-dlp --enable-file-urls`
                 └─ yt-dlp pulls tokenized CDN segments → muxed MP4 in Downloads
```

## Components

### New: `extension/capture.js` (added to `background.scripts`)
- `webRequest.onHeadersReceived` over `<all_urls>` with
  `["blocking","responseHeaders"]`. Attach `filterResponseData` **only** when
  content-type matches HLS/DASH manifest types (or URL ends `.m3u8`).
- `filter.ondata` buffers chunks **and** writes them straight back so the page
  keeps playing; `filter.onstop` decodes UTF-8, requires `#EXTM3U`.
- Classify **master** (`#EXT-X-STREAM-INF`) vs **media** (`#EXTINF`).
  - media: rewrite relative segment + `URI="…"` (KEY/MAP) references to
    absolute against the manifest URL; compute `durationSec` (Σ `#EXTINF`) and
    `segmentCount`.
  - master: parse variant `{RESOLUTION, uri}` list (used only to label media
    playlists whose URL matches a variant).
- Store per-tab: `Map(url → {id,url,kind,resolution,segmentCount,durationSec,text})`.
  Dedup by URL. Clear a tab's store on its `main_frame` request
  (`webRequest.onBeforeRequest`, type `main_frame`) and on `tabs.onRemoved`.
- Shared-scope API for background.js: `list(tabId)` (metadata, no text),
  `getText(tabId,id)`.

### `extension/background.js`
- New messages: `getStreams {tabId}` → `HLSCapture.list(tabId)`.
- `start` extended: if `req.streamId`, resolve text via `HLSCapture.getText`
  and post `{playlist:text,…}` to the host instead of `{url,…}`. History item
  stores the manifest URL + filename for display.

### `extension/popup.js` / `popup.html`
- On open, request the active tab's streams. If any: render a **Detected
  streams** section (resolution + duration + segment count), auto-select the
  best (max resolution height, tie-break segment count). video/audio buttons
  download the selected stream via `streamId`.
- If none captured: **fall back to the existing page-URL flow** (YouTube and
  other yt-dlp-supported sites unchanged).

### `host/ytdlp_host.py`
- If `req.playlist` present: **sanitize** (must start `#EXTM3U`; every
  non-comment line and every tag `URI="…"` must be `http(s)`; size cap), write
  to a temp `.m3u8`, run `yt-dlp --enable-file-urls … file://<tmp>`, delete
  temp after. No `--cookies-from-browser` on this path (segments are
  token-authed). mp4: `--merge-output-format mp4` (default best); mp3:
  `-x --audio-format mp3`; skip `--embed-thumbnail` (no local thumb).
- Existing `url` path unchanged.

## Security

`--enable-file-urls` is needed to read the local temp playlist, which means a
malicious manifest could list `file://` "segments" to exfiltrate local files.
**Mitigation:** the host rejects any playlist whose segment lines or tag URIs
are not `http(s)`. The extension already absolutizes against the https manifest
URL, so legitimate playlists pass.

## Permissions (manifest.json)

Add `webRequest`, `webRequestBlocking`, `<all_urls>`; add `capture.js` to
`background.scripts`. Keep `nativeMessaging`, `activeTab`, `storage`.

## Scope

**In:** HLS (`.m3u8`) VOD capture; always-on/manifests-only; best-quality
auto-select + pick list; page-URL fallback; file:// sanitizer.

**Out (later):** DASH (`.mpd`) — classifier stays format-aware but impl is HLS;
live streams; DRM (impossible); gzip/br-encoded manifests (skip if body isn't
decodable text); >1 MB native-message playlists (cap + warn); private-browsing
windows (listener default-off there).

## Testing

- Real-world e2e: rawfuckclub — play → popup shows stream → download → verify
  1080p+AAC mp4.
- Pure-function tests: classifier (master vs media), relative→absolute URL
  rewriter, playlist sanitizer (rejects `file://`/relative).

## Success criteria

Playing an HLS VOD on a non-extractor site surfaces the stream in the popup and
downloads the correct full video with audio; YouTube/direct-URL behavior
unchanged.
