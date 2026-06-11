// HLS manifest capture. Reads .m3u8 response bodies as the browser receives
// them (via webRequest.filterResponseData) so we ride the page's already-
// authorized session — many sites gate the manifest URL but the bytes flow
// fine to the player. We never touch non-manifest traffic.
//
// Lives in the background scope alongside background.js and shares globals
// with it (HLSCapture is read by background.js's message handlers).

const MANIFEST_CT = /(application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/mpegurl)/i;
const HLS_URL_RE = /\.m3u8(\?|#|$)/i;

// tabId -> Map(manifestUrl -> stream record)
const streamsByTab = new Map();
let streamSeq = 0;

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : "";
}

function looksLikeManifest(details) {
  if (MANIFEST_CT.test(headerValue(details.responseHeaders, "content-type"))) return true;
  if (HLS_URL_RE.test(details.url)) return true;
  return false;
}

function classify(text) {
  if (text.includes("#EXT-X-STREAM-INF")) return "master";
  if (text.includes("#EXTINF")) return "media";
  return "unknown";
}

// Rewrite relative URIs (segment lines and URI="..." attributes on tags like
// EXT-X-KEY / EXT-X-MAP) to absolute, so the captured playlist is
// self-contained when handed to yt-dlp as a local file.
function absolutize(text, baseUrl) {
  const abs = (u) => {
    try { return new URL(u, baseUrl).href; } catch { return u; }
  };
  return text
    .split("\n")
    .map((line) => {
      const withAttrs = line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u)}"`);
      const trimmed = withAttrs.trim();
      if (!trimmed || trimmed.startsWith("#")) return withAttrs;
      return abs(trimmed);
    })
    .join("\n");
}

function parseMediaMeta(text) {
  let durationSec = 0;
  let segmentCount = 0;
  for (const line of text.split("\n")) {
    const m = /^#EXTINF:([\d.]+)/.exec(line.trim());
    if (m) {
      durationSec += parseFloat(m[1]) || 0;
      segmentCount += 1;
    }
  }
  return { durationSec: Math.round(durationSec), segmentCount };
}

// From a master playlist, map each variant's absolute URL -> "WIDTHxHEIGHT".
function parseMasterVariants(text, baseUrl) {
  const variants = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const res = /RESOLUTION=(\d+x\d+)/.exec(line);
    // The URI is the next non-comment line.
    for (let j = i + 1; j < lines.length; j++) {
      const u = lines[j].trim();
      if (!u || u.startsWith("#")) continue;
      try { variants.push({ url: new URL(u, baseUrl).href, resolution: res ? res[1] : null }); } catch {}
      break;
    }
  }
  return variants;
}

function resolutionFromMaster(tabId, url) {
  const store = streamsByTab.get(tabId);
  if (!store) return null;
  for (const s of store.values()) {
    if (s.kind === "master" && s.variants) {
      const hit = s.variants.find((v) => v.url === url);
      if (hit && hit.resolution) return hit.resolution;
    }
  }
  return null;
}

function handleManifest(tabId, url, rawText) {
  const kind = classify(rawText);
  if (kind === "unknown") return;

  const store = streamsByTab.get(tabId) || new Map();
  streamsByTab.set(tabId, store);

  if (kind === "master") {
    const variants = parseMasterVariants(rawText, url);
    store.set(url, { id: `s${++streamSeq}`, url, kind: "master", variants });
    // A master may let us label media playlists already captured.
    for (const s of store.values()) {
      if (s.kind === "media" && !s.resolution) {
        const hit = variants.find((v) => v.url === s.url);
        if (hit) s.resolution = hit.resolution;
      }
    }
    return;
  }

  // media playlist
  const text = absolutize(rawText, url);
  const { durationSec, segmentCount } = parseMediaMeta(text);
  if (!segmentCount) return;
  const existing = store.get(url);
  store.set(url, {
    id: existing ? existing.id : `s${++streamSeq}`,
    url,
    kind: "media",
    resolution: resolutionFromMaster(tabId, url),
    durationSec,
    segmentCount,
    text,
  });
}

function decodeChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return new TextDecoder("utf-8").decode(merged);
}

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return {};
    if (!looksLikeManifest(details)) return {};

    let filter;
    try {
      filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
      return {};
    }
    const chunks = [];
    filter.ondata = (event) => {
      // Copy before writing: filter.write() may detach the source buffer,
      // which would empty a view we kept a reference to.
      try { chunks.push(new Uint8Array(event.data.slice(0))); } catch {}
      filter.write(event.data); // pass through — never disturb playback
    };
    filter.onstop = () => {
      filter.disconnect();
      try {
        const text = decodeChunks(chunks);
        if (text.includes("#EXTM3U")) handleManifest(details.tabId, details.url, text);
      } catch {}
    };
    filter.onerror = () => {};
    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking", "responseHeaders"]
);

// Forget a tab's captures when it navigates to a new page or closes.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === "main_frame" && details.tabId >= 0) streamsByTab.delete(details.tabId);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);
browser.tabs.onRemoved.addListener((tabId) => streamsByTab.delete(tabId));

// Shared-scope API consumed by background.js.
const HLSCapture = {
  list(tabId) {
    const store = streamsByTab.get(tabId);
    if (!store) return [];
    return [...store.values()]
      .filter((s) => s.kind === "media")
      .map((s) => ({
        id: s.id,
        url: s.url,
        resolution: s.resolution || null,
        durationSec: s.durationSec,
        segmentCount: s.segmentCount,
      }));
  },
  getText(tabId, id) {
    const store = streamsByTab.get(tabId);
    if (!store) return null;
    for (const s of store.values()) if (s.id === id && s.kind === "media") return s.text;
    return null;
  },
};
