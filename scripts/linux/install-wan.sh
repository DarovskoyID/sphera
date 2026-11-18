#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$(id -u)" != 0 ]; then exec sudo bash "$0" "$@"; fi
printf 'SPHERE: preparing trial node; no network admission is claimed yet.\n'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-cryptography ca-certificates curl tar
printf 'SPHERE: platform\n'
git -C "$ROOT" rev-parse HEAD
uname -sm
free -m
df -h /opt
python3 -B "$ROOT/scripts/server_wan_prepare.py" --profile "$ROOT/release/wan-preparation.json" --trust "$ROOT/release/trust.public.json" "$@"
