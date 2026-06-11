const $ = (id) => document.getElementById(id);

function canonicalize(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com") {
      const v = u.searchParams.get("v");
      if (u.pathname === "/watch" && v) return `https://www.youtube.com/watch?v=${v}`;
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/);
      if (m) return `https://www.youtube.com/watch?v=${m[2]}`;
    }
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

function videoIdFromUrl(canonical) {
  try { return new URL(canonical).searchParams.get("v") || ""; } catch { return ""; }
}

function cleanFilename(s) {
  return s.replace(/[/\x00-\x1f"'`$]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c]));
}

let currentUrl = "";
let currentTitle = "";
let currentThumb = "";
let currentTabId = null;
let buttons;

// Captured HLS streams for the active tab.
let streams = [];
let selectedStreamId = null;

const streamById = (id) => streams.find((s) => s.id === id);

function fmtDuration(sec) {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function streamLabel(s) {
  const parts = [s.resolution ? s.resolution.replace("x", " × ") : "HLS stream"];
  if (s.durationSec) parts.push(fmtDuration(s.durationSec));
  parts.push(`${s.segmentCount} seg`);
  return parts.join(" · ");
}

// Highest resolution wins, then most segments (the full-length playlist).
function pickBest(list) {
  return [...list].sort((a, b) => {
    const ha = a.resolution ? parseInt(a.resolution.split("x")[1] || "0", 10) : 0;
    const hb = b.resolution ? parseInt(b.resolution.split("x")[1] || "0", 10) : 0;
    if (hb !== ha) return hb - ha;
    return (b.segmentCount || 0) - (a.segmentCount || 0);
  })[0];
}

async function loadStreams() {
  try {
    streams = (await browser.runtime.sendMessage({ action: "getStreams", tabId: currentTabId })) || [];
  } catch {
    streams = [];
  }
  if (streams.length) {
    const best = pickBest(streams);
    selectedStreamId = best ? best.id : null;
  }
  renderStreams();
}

function renderStreams() {
  const wrap = $("streams");
  if (!streams.length) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");
  wrap.innerHTML =
    `<div class="streams-head">detected streams</div>` +
    streams
      .map(
        (s) => `
      <div class="stream${s.id === selectedStreamId ? " sel" : ""}" data-id="${escape(s.id)}">
        <span class="stream-dot"></span>
        <span class="stream-label">${escape(streamLabel(s))}</span>
      </div>`
      )
      .join("");
  wrap.querySelectorAll(".stream").forEach((el) => {
    el.addEventListener("click", () => {
      selectedStreamId = el.dataset.id;
      renderStreams();
    });
  });
}

async function init() {
  buttons = document.querySelectorAll("button.fmt");

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0] || {};
  currentTabId = tab.id;
  currentUrl = canonicalize(tab.url || "");

  currentTitle = (tab.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
  const id = videoIdFromUrl(currentUrl);
  $("filename").value = cleanFilename(currentTitle ? (id ? `${currentTitle} [${id}]` : currentTitle) : id);

  if (id) {
    currentThumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    $("thumb").src = currentThumb;
    // If the preview fails to load, fall back to the placeholder state.
    $("thumb").addEventListener("error", () => {
      currentThumb = "";
      $("thumbWrap").classList.add("no-preview");
    });
  } else {
    // No preview available off-YouTube; show a placeholder. yt-dlp can still
    // embed the source's own thumbnail via --embed-thumbnail.
    $("thumbWrap").classList.add("no-preview");
  }

  $("thumbX").addEventListener("click", () => {
    $("thumbWrap").classList.toggle("disabled");
  });

  buttons.forEach((b) => b.addEventListener("click", () => start(b.dataset.format)));

  $("clear").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ action: "clearHistory" });
  });

  await loadStreams();
  await render();
  await markDownloaded();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.history) {
      render();
      markDownloaded();
    }
  });
}

async function markDownloaded() {
  const obj = await browser.storage.local.get("history");
  const items = obj.history || [];
  const formats = new Set(
    items
      .filter((it) => it.status === "done" && it.url === currentUrl)
      .map((it) => it.format)
  );
  buttons.forEach((b) => {
    b.classList.toggle("downloaded", formats.has(b.dataset.format));
    b.title = formats.has(b.dataset.format) ? "already downloaded — click to re-download" : "";
  });
}

async function start(format) {
  // Prefer a captured HLS stream when one is selected; otherwise fall back to
  // handing the page URL to yt-dlp (YouTube and other supported sites).
  const stream = selectedStreamId != null ? streamById(selectedStreamId) : null;
  if (!stream && !currentUrl) return;

  const req = {
    url: stream ? stream.url : currentUrl,
    title: currentTitle,
    thumbnail: stream ? "" : currentThumb,
    format,
    filename: $("filename").value.trim(),
    embedThumbnail: !$("thumbWrap").classList.contains("disabled"),
    embedMetadata: $("metadata").checked,
  };
  if (stream) {
    req.streamId = stream.id;
    req.tabId = currentTabId;
  }
  await browser.runtime.sendMessage({ action: "start", req });
}

function statusLabel(item) {
  if (item.status === "done") return "done";
  if (item.status === "failed") return "failed";
  if (item.status === "starting") return "starting…";
  if (item.progress >= 99.5) return "finalizing";
  return `${(item.progress || 0).toFixed(1)}%`;
}

async function render() {
  const obj = await browser.storage.local.get("history");
  const items = obj.history || [];
  const root = $("history");

  if (!items.length) {
    root.innerHTML = `<div class="empty">no downloads yet</div>`;
    return;
  }

  root.innerHTML = items.map((it) => {
    const pillClass = it.status === "done" ? "pill done" : it.status === "failed" ? "pill failed" : "pill";
    const fillClass = it.status === "done" ? "progress-fill done" : it.status === "failed" ? "progress-fill failed" : "progress-fill";
    const pct = it.status === "done" ? 100 : it.progress || 0;
    const detail = it.status === "failed"
      ? (it.error || `exit ${it.exitCode}`)
      : it.status === "done"
        ? (it.size ? `${it.size}` : "complete")
        : (it.speed ? `${it.speed} · ETA ${it.eta || "—"}` : statusLabel(it));
    const thumb = it.thumbnail
      ? `<img class="item-thumb" src="${escape(it.thumbnail)}" alt="">`
      : `<div class="item-thumb"></div>`;
    return `
      <div class="item" data-id="${escape(it.id)}">
        ${thumb}
        <div class="item-body">
          <div class="item-title" title="${escape(it.filename || it.title || it.url)}">${escape(it.filename || it.title || it.url)}</div>
          <div class="item-sub">
            <span class="${pillClass}">${escape(it.format)}</span>
            <span>${escape(statusLabel(it))}</span>
            <span style="margin-left:auto">${escape(detail)}</span>
          </div>
          <div class="progress-bar"><div class="${fillClass}" style="width:${pct}%"></div></div>
        </div>
        <button class="item-x" data-id="${escape(it.id)}" title="remove from history">×</button>
      </div>
    `;
  }).join("");

  root.querySelectorAll(".item-x").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      await browser.runtime.sendMessage({ action: "removeItem", id: el.dataset.id });
    });
  });
}

init();
