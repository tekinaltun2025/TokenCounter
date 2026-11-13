#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$PROJECT_DIR/systemd/local-llm-token-sayaci.service"
UNIT_DST_DIR="$HOME/.config/systemd/user"
UNIT_DST="$UNIT_DST_DIR/local-llm-token-sayaci.service"

mkdir -p "$UNIT_DST_DIR"
cp "$UNIT_SRC" "$UNIT_DST"

systemctl --user daemon-reload
systemctl --user enable --now local-llm-token-sayaci.service

echo "Servis kuruldu ve baslatildi."
echo "Durum icin:   systemctl --user status local-llm-token-sayaci"
echo "Loglar icin:  journalctl --user -u local-llm-token-sayaci -f"
echo "Panel:        http://127.0.0.1:7879"

if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  echo
  echo "NOT: Bu servis simdi oturum acikken calisir. Bilgisayar yeniden baslatildiginda"
  echo "giris yapmadan ONCE de otomatik calismasi icin 'linger' etkinlestirilmeli:"
  echo "  sudo loginctl enable-linger $USER"
fi
