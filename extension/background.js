// Persistent download manager. Survives popup close.

const HISTORY_KEY = "history";
const MAX_HISTORY = 50;
const PROGRESS_RE = /^\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+(?:~?\s*)?(\S+)(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/;
const DEST_RE = /^\[(?:download|ExtractAudio|Merger)\]\s+Destination:\s+(.+)$/;
const ERROR_RE = /^ERROR:\s+(.+)$/;

async function getHistory() {
  const obj = await browser.storage.local.get(HISTORY_KEY);
  return obj[HISTORY_KEY] || [];
}

async function saveHistory(items) {
  await browser.storage.local.set({ [HISTORY_KEY]: items.slice(0, MAX_HISTORY) });
}

async function upsert(id, patch) {
  const items = await getHistory();
  const i = items.findIndex((x) => x.id === id);
  if (i === -1) {
    items.unshift({ id, ...patch });
  } else {
    items[i] = { ...items[i], ...patch };
  }
  await saveHistory(items);
}

// yt-dlp launched by Firefox can't read Firefox's profile dir (macOS sandbox).
// We have first-class cookie access via the WebExtension API — gather the
// cookies ourselves and hand them to yt-dlp as a Netscape cookies.txt blob.
function netscapeCookies(cookies) {
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of cookies) {
    const domain = (c.httpOnly ? "#HttpOnly_" : "") + c.domain;
    const includeSubdomains = c.hostOnly ? "FALSE" : "TRUE";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push([domain, includeSubdomains, c.path, secure, expiry, c.name, c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

// Extra origins to pull cookies from for known sites whose auth lives elsewhere
// (e.g. YouTube → accounts.google.com). Returns [] for everything else.
function extraCookieUrls(url) {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)youtube\.com$/.test(host) || /(^|\.)youtu\.be$/.test(host)) {
      return ["https://accounts.google.com/", "https://www.google.com/"];
    }
  } catch {}
  return [];
}

async function gatherCookies(url) {
  if (!url) return "";
  const urls = [url, ...extraCookieUrls(url)];
  const seen = new Set();
  const all = [];
  for (const u of urls) {
    let list = [];
    try { list = await browser.cookies.getAll({ url: u }); } catch {}
    for (const c of list) {
      const key = `${c.domain}\t${c.path}\t${c.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(c);
    }
  }
  return all.length ? netscapeCookies(all) : "";
}

function parseLine(line) {
  let m;
  if ((m = PROGRESS_RE.exec(line))) {
    return { progress: parseFloat(m[1]), size: m[2], speed: m[3] || "", eta: m[4] || "" };
  }
  if ((m = DEST_RE.exec(line))) {
    return { destination: m[1] };
  }
  if ((m = ERROR_RE.exec(line))) {
    return { error: m[1] };
  }
  return null;
}

async function startDownload(req) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // A captured HLS stream is referenced by streamId; resolve it to the stored
  // playlist text here so the popup never has to shuttle ~100 KB of manifest.
  let playlist = null;
  if (req.streamId != null) {
    playlist = HLSCapture.getText(req.tabId, req.streamId);
    if (!playlist) {
      await upsert(id, {
        url: req.url || "",
        title: req.title || "",
        format: req.format,
        filename: req.filename,
        status: "failed",
        error: "stream no longer captured — reload the page and play it again",
        startedAt: Date.now(),
        finishedAt: Date.now(),
      });
      return id;
    }
  }

  await upsert(id, {
    url: req.url,
    title: req.title || "",
    thumbnail: req.thumbnail || "",
    format: req.format,
    filename: req.filename,
    status: "starting",
    progress: 0,
    startedAt: Date.now(),
  });

  let port;
  try {
    port = browser.runtime.connectNative("ytdlp_host");
  } catch (e) {
    await upsert(id, { status: "failed", error: "connectNative threw: " + (e?.message || String(e)) });
    return id;
  }

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "log") {
      const parsed = parseLine(msg.line);
      if (parsed) await upsert(id, { ...parsed, status: "downloading" });
    } else if (msg.type === "done") {
      const items = await getHistory();
      const cur = items.find((x) => x.id === id);
      const failed = msg.code !== 0;
      await upsert(id, {
        status: failed ? "failed" : "done",
        progress: failed ? cur?.progress || 0 : 100,
        finishedAt: Date.now(),
        exitCode: msg.code,
      });
      port.disconnect();
    } else if (msg.type === "error") {
      await upsert(id, { status: "failed", error: msg.message });
    }
  });

  port.onDisconnect.addListener(async () => {
    const items = await getHistory();
    const cur = items.find((x) => x.id === id);
    if (cur && cur.status !== "done" && cur.status !== "failed") {
      await upsert(id, {
        status: "failed",
        error: browser.runtime.lastError?.message || "host disconnected unexpectedly",
        finishedAt: Date.now(),
      });
    }
  });

  const cookies = await gatherCookies(req.url);

  port.postMessage({
    url: req.url,
    playlist, // present for captured HLS streams; host prefers it over url
    cookies,  // Netscape cookies.txt text; host writes a temp file and passes --cookies
    format: req.format,
    filename: req.filename,
    embedThumbnail: req.embedThumbnail,
    embedMetadata: req.embedMetadata,
  });

  return id;
}

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg?.action === "start") return startDownload(msg.req);
  if (msg?.action === "getStreams") return HLSCapture.list(msg.tabId);
  if (msg?.action === "clearHistory") return saveHistory([]);
  if (msg?.action === "removeItem") {
    const items = (await getHistory()).filter((x) => x.id !== msg.id);
    await saveHistory(items);
    return true;
  }
});

