#!/usr/bin/python3
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import threading
import traceback
from pathlib import Path

try:
    with open("/tmp/ytdlp_host.log", "a") as _f:
        _f.write(f"=== invoked argv={sys.argv} python={sys.executable}\n")
except Exception:
    pass

YTDLP = "/opt/homebrew/bin/yt-dlp"
DOWNLOAD_DIR = str(Path.home() / "Downloads")
LOG_FILE = "/tmp/ytdlp_host.log"
FILENAME_BAD = re.compile(r'[/\x00-\x1f"\'`$]')
MAX_PLAYLIST_BYTES = 5 * 1024 * 1024


def sanitize_playlist(text):
    """Reject anything that isn't a plain HLS playlist of http(s) URLs.

    We run yt-dlp with --enable-file-urls so it can read our local temp
    playlist; that flag also means a malicious manifest could point at
    file:// "segments" to read local files. So every segment line and every
    tag URI ("URI=...") must be http(s).
    """
    if "#EXTM3U" not in text:
        raise ValueError("not an m3u8 playlist")
    if len(text.encode("utf-8")) > MAX_PLAYLIST_BYTES:
        raise ValueError("playlist too large")
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            for uri in re.findall(r'URI="([^"]+)"', line):
                if not (uri.startswith("http://") or uri.startswith("https://")):
                    raise ValueError("playlist tag URI must be http(s)")
            continue
        if not (line.startswith("http://") or line.startswith("https://")):
            raise ValueError("playlist segment must be http(s)")
    return text


def dlog(msg):
    try:
        with open(LOG_FILE, "a") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def write_cookies_file(text):
    """Write Netscape cookies.txt text to a 0600 temp file and return its path."""
    fd, path = tempfile.mkstemp(suffix=".txt", prefix="ytdlp_cookies_")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    return path


def build_args(req):
    """Return (args, cleanup_paths). cleanup_paths is a list of files to unlink."""
    url = req.get("url", "")
    fmt = req.get("format", "mp4")
    filename = (req.get("filename") or "").strip()
    playlist = req.get("playlist")
    cookies = req.get("cookies")
    embed_thumb = req.get("embedThumbnail", True)
    embed_meta = req.get("embedMetadata", True)

    if filename:
        if FILENAME_BAD.search(filename) or filename in (".", "..") or len(filename) > 200:
            raise ValueError(f"invalid filename: {filename!r}")

    cleanup = []

    # Captured HLS stream: write the manifest text to a temp file and let
    # yt-dlp pull the (token-authed) segments. No browser cookies needed.
    if playlist:
        sanitize_playlist(playlist)
        fd, tmpfile = tempfile.mkstemp(suffix=".m3u8")
        with os.fdopen(fd, "w") as f:
            f.write(playlist)
        cleanup.append(tmpfile)

        args = [YTDLP, "--newline", "-P", DOWNLOAD_DIR, "--enable-file-urls"]
        if filename:
            args += ["-o", f"{filename}.%(ext)s"]
        if fmt == "mp4":
            args += ["--merge-output-format", "mp4"]
        elif fmt == "mp3":
            args += ["-x", "--audio-format", "mp3"]
        else:
            raise ValueError(f"unknown format: {fmt!r}")
        if embed_meta:
            args += ["--embed-metadata"]
        # No --embed-thumbnail: a local HLS playlist has no thumbnail source.
        args.append(f"file://{tmpfile}")
        return args, cleanup

    # Direct-URL path (e.g. YouTube and other yt-dlp-supported sites).
    if not url or not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError(f"refusing to run on non-http url: {url!r}")

    args = [YTDLP, "--newline", "-P", DOWNLOAD_DIR]

    # Cookies are gathered by the extension (browser.cookies.getAll) and shipped
    # as Netscape cookies.txt text. Reading Firefox's profile from here doesn't
    # work because Firefox-spawned children can't access ~/Library/Application
    # Support/Firefox/ on macOS.
    if cookies:
        cookies_file = write_cookies_file(cookies)
        cleanup.append(cookies_file)
        args += ["--cookies", cookies_file]

    if filename:
        args += ["-o", f"{filename}.%(ext)s"]

    if fmt == "mp4":
        args += [
            "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
            "--merge-output-format", "mp4",
        ]
    elif fmt == "mp3":
        args += ["-x", "--audio-format", "mp3"]
    else:
        raise ValueError(f"unknown format: {fmt!r}")

    if embed_thumb:
        args += ["--embed-thumbnail", "--convert-thumbnails", "jpg"]
    if embed_meta:
        args += ["--embed-metadata"]

    args.append(url)
    return args, cleanup


def stream_proc(proc):
    for line in proc.stdout:
        line = line.rstrip("\n")
        dlog("yt: " + line)
        # message size guard
        if len(line) > 8000:
            line = line[:8000] + " …(truncated)"
        send({"type": "log", "line": line})


def main():
    dlog(f"--- start pid={os.getpid()}")
    cleanup = []
    try:
        req = read_message()
        if req is None:
            return
        # Don't dump the whole manifest or cookie blob into the log.
        redact = {"playlist", "cookies"}
        safe = {k: (f"<{len(v)} bytes>" if k in redact and isinstance(v, str) else v) for k, v in req.items()}
        dlog(f"req: {safe}")

        try:
            args, cleanup = build_args(req)
        except ValueError as e:
            send({"type": "error", "message": str(e)})
            send({"type": "done", "code": 2})
            return

        dlog("args: " + " ".join(args))
        send({"type": "log", "line": "$ " + " ".join(args)})

        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            text=True,
            env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "HOME": os.environ.get("HOME", "")},
        )

        t = threading.Thread(target=stream_proc, args=(proc,), daemon=True)
        t.start()
        proc.wait()
        t.join(timeout=2.0)
        send({"type": "done", "code": proc.returncode})
        dlog(f"done code={proc.returncode}")
    except Exception as e:
        dlog("EXC: " + traceback.format_exc())
        try:
            send({"type": "error", "message": f"{type(e).__name__}: {e}"})
            send({"type": "done", "code": 1})
        except Exception:
            pass
    finally:
        for p in cleanup:
            try:
                os.unlink(p)
            except Exception:
                pass


if __name__ == "__main__":
    main()
