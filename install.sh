#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.local/share/ytdlp-host"
NM_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"

mkdir -p "$INSTALL_DIR" "$NM_DIR"

cp "$ROOT/host/ytdlp_host.py" "$INSTALL_DIR/ytdlp_host.py"
chmod +x "$INSTALL_DIR/ytdlp_host.py"

cat > "$NM_DIR/ytdlp_host.json" <<JSON
{
  "name": "ytdlp_host",
  "description": "yt-dlp launcher",
  "path": "$INSTALL_DIR/ytdlp_host.py",
  "type": "stdio",
  "allowed_extensions": ["ytdlp@matthewmorrone"]
}
JSON

echo "Installed:"
echo "  host script:    $INSTALL_DIR/ytdlp_host.py"
echo "  host manifest:  $NM_DIR/ytdlp_host.json"
echo
echo "Next steps:"
echo "  1. Open Firefox → about:debugging → This Firefox → Load Temporary Add-on…"
echo "  2. Select: $ROOT/extension/manifest.json"
echo
echo "Logs (host debug): /tmp/ytdlp_host.log"
