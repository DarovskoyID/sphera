#!/usr/bin/env bash
# Installation entry point. Mesh cannot fall back silently to standalone.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE=""
CONFIG="${SFERA_INSTALL_CONFIG:-/etc/sfera/deployment.env}"
ARGS=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --mode) MODE="${2:?Specify corporate, personal or mesh}"; shift 2 ;;
        --config) CONFIG="${2:?Specify configuration path}"; shift 2 ;;
        --help|-h) echo "Usage: install.sh [--mode corporate|personal|mesh] [--config PATH] [install-deps options]"; exit 0 ;;
        *) ARGS+=("$1"); shift ;;
    esac
done
if [ -z "$MODE" ]; then
    if [ ! -t 0 ]; then echo "Non-interactive installation requires --mode." >&2; exit 2; fi
    printf 'Выберите режим:\n1. Корпоративный\n2. Личный\n3. Mesh point\n'
    read -r -p '> ' MODE
fi
case "$MODE" in
    1|corporate) MODE=corporate ;;
    2|personal) MODE=personal ;;
    3|mesh) MODE=mesh ;;
    *) echo "Unknown deployment mode." >&2; exit 2 ;;
esac
if [ -f "$CONFIG" ]; then
    OLD="$(sed -n 's/^SFERA_DEPLOYMENT_MODE=//p' "$CONFIG")"
    if [ "$OLD" != "$MODE" ]; then echo "Mode change requires a separate migration; configuration preserved." >&2; exit 2; fi
fi
if [ "$MODE" = mesh ]; then
    echo "Mesh protocol is under implementation. Production mesh installation is not available yet; no services or configuration changed." >&2
    exit 3
fi
umask 077
mkdir -p "$(dirname "$CONFIG")"
if [ ! -e "$CONFIG" ]; then
    (set -o noclobber; printf 'SFERA_DEPLOYMENT_MODE=%s\n' "$MODE" > "$CONFIG")
fi
export SFERA_DEPLOYMENT_MODE="$MODE"
bash "$ROOT/scripts/install-deps.sh" "${ARGS[@]}"
