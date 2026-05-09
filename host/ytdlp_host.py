#!/usr/bin/python3
import json
import os
import re
import struct
import subprocess
import sys
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


def build_args(req):
    url = req.get("url", "")
    fmt = req.get("format", "mp4")
    filename = (req.get("filename") or "").strip()
    embed_thumb = req.get("embedThumbnail", True)
    embed_meta = req.get("embedMetadata", True)

    if not url or not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError(f"refusing to run on non-http url: {url!r}")

    if filename:
        if FILENAME_BAD.search(filename) or filename in (".", "..") or len(filename) > 200:
            raise ValueError(f"invalid filename: {filename!r}")

    args = [YTDLP, "--newline", "-P", DOWNLOAD_DIR, "--cookies-from-browser", "firefox"]
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
    return args


def stream_proc(proc):
    for line in proc.stdout:
        line = line.rstrip("\n")
        # message size guard
        if len(line) > 8000:
            line = line[:8000] + " …(truncated)"
        send({"type": "log", "line": line})


def main():
    dlog(f"--- start pid={os.getpid()}")
    try:
        req = read_message()
        if req is None:
            return
        dlog(f"req: {req}")

        try:
            args = build_args(req)
        except ValueError as e:
            send({"type": "error", "message": str(e)})
            send({"type": "done", "code": 2})
            return

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


if __name__ == "__main__":
    main()
