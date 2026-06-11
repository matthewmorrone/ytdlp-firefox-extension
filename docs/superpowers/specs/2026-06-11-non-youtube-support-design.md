# Design: Make the yt-dlp launcher work on any site (not just YouTube)

**Date:** 2026-06-11
**Status:** Approved (pending spec review)

## Goal

Let the extension download media from any page the user is viewing — not only
YouTube — by handing the current tab's URL to yt-dlp, which already has
extractors for ~1800 sites plus a generic extractor that scrapes embedded
media. Network sniffing for hidden HLS manifests is explicitly **deferred**;
we first see how far bare-URL yt-dlp gets on real sites.

## Background

The download pipeline (popup → background → native host → yt-dlp) was never
YouTube-specific. The only hard restriction is `page_action.show_matches`,
which limits where the icon appears. A secondary issue: the address-bar
page action has become unreliable ("doesn't seem to work anymore"), so we also
switch to a persistent toolbar button.

## Scope

### In scope

1. **Switch `page_action` → `browser_action`** in `extension/manifest.json`.
   - Persistent toolbar button, visible and clickable on every site.
   - Reuses the same `default_popup`, `default_title`, `default_icon`.
   - Removes the YouTube-only `show_matches` restriction entirely (the key
     does not apply to `browser_action`).
   - Fixes both the YouTube lock-in and the disappearing-address-bar-icon
     problem in one change.

2. **Graceful no-thumbnail state** in `extension/popup.js` / `popup.html`.
   - On non-YouTube pages there is no `i.ytimg.com` preview, so the `#thumb`
     `<img>` would render as a broken-image box.
   - When no preview URL is available: show a neutral placeholder instead of a
     broken image, and keep the embed-thumbnail toggle (the `×` overlay)
     functional so the user can still choose whether yt-dlp embeds the
     source's own thumbnail via `--embed-thumbnail`.

### Out of scope (deferred)

- Network-request sniffing (`webRequest`) for hidden `.m3u8` manifests.
- DASH/`.mpd`-specific handling.
- Multi-stream / quality picker when several variants are detected.
- Per-site permission model.

These get revisited only after the user tests bare-URL yt-dlp on real sites
and reports where it falls short.

## Components & changes

| File | Change |
|------|--------|
| `extension/manifest.json` | Replace `page_action` block with `browser_action`; drop `show_matches`. |
| `extension/popup.html` | Support a placeholder appearance for the thumb area when no preview exists. |
| `extension/popup.js` | Set thumbnail only when a preview URL exists; otherwise apply placeholder state; ensure `embedThumbnail` still derives correctly and the toggle works. |
| `host/ytdlp_host.py` | **No change** — already generic, already passes `--cookies-from-browser firefox`. |

## What stays as-is (already degrades correctly off-YouTube)

- `canonicalize()` — rewrites YouTube URLs, falls through to the raw URL for
  everything else.
- Title cleanup — stripping `- YouTube` is a harmless no-op elsewhere.
- Filename — `title [videoId]` becomes just the cleaned title when there is no
  video ID.

## Error handling

- Non-media pages: clicking simply runs yt-dlp on a URL it can't extract; the
  existing failure path already surfaces yt-dlp's error in history. No new
  handling required.
- yt-dlp already reports unsupported-URL errors through the `ERROR:` line that
  `background.js` parses.

## Testing

- Manual: load the extension, confirm the toolbar button appears and opens the
  popup on a non-YouTube page (e.g. a Vimeo or Twitter/X video), and that a
  download starts and completes.
- Regression: confirm YouTube still works — thumbnail preview, filename with
  video ID, format buttons, history.
- No-preview state: confirm a non-YouTube page shows the placeholder rather
  than a broken image, and the embed-thumbnail toggle still works.

## Success criteria

The toolbar button is available on every site, and downloading works on at
least one non-YouTube site that yt-dlp supports, with YouTube behavior
unchanged.
