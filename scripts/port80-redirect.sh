#!/usr/bin/env bash
# tokendashboard:80 -> 127.0.0.1:7879 yonlendirmesi (idempotent).
set -euo pipefail

if ! iptables -t nat -C OUTPUT -p tcp -d 127.0.0.1 --dport 80 -j REDIRECT --to-ports 7879 2>/dev/null; then
  iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport 80 -j REDIRECT --to-ports 7879
fi
