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
let buttons;

async function init() {
  buttons = document.querySelectorAll("button.fmt");

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0] || {};
  currentUrl = canonicalize(tab.url || "");

  currentTitle = (tab.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
  const id = videoIdFromUrl(currentUrl);
  $("filename").value = cleanFilename(currentTitle ? (id ? `${currentTitle} [${id}]` : currentTitle) : id);

  if (id) {
    currentThumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    $("thumb").src = currentThumb;
  }

  $("thumbX").addEventListener("click", () => {
    $("thumbWrap").classList.toggle("disabled");
  });

  buttons.forEach((b) => b.addEventListener("click", () => start(b.dataset.format)));

  $("clear").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ action: "clearHistory" });
  });

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
  if (!currentUrl) return;
  const req = {
    url: currentUrl,
    title: currentTitle,
    thumbnail: currentThumb,
    format,
    filename: $("filename").value.trim(),
    embedThumbnail: !$("thumbWrap").classList.contains("disabled"),
    embedMetadata: $("metadata").checked,
  };
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
