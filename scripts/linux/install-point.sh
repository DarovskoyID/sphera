#!/usr/bin/env bash
# Ordinary point: GitHub downloads, signed profile, no validator configuration.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$(id -u)" != 0 ]; then exec sudo bash "$0" "$@"; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-cryptography ca-certificates tar
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw allow 8443/tcp; fi
exec python3 -B "$ROOT/scripts/server_point_bootstrap.py" "$@"
