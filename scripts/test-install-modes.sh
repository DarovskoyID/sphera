#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -f -- "$TEMP/corporate.env" "$TEMP/existing.env" "$TEMP/mesh.env" "$TEMP/invalid.env" "$TEMP/noninteractive.env"; rmdir -- "$TEMP"' EXIT
INSTALL="$ROOT/scripts/linux/install.sh"
# --help is passed to install-deps; no dependency/service installation occurs.
bash "$INSTALL" --mode corporate --config "$TEMP/corporate.env" --help >/dev/null
# Installer's own --help exits before writing config, as expected.
[ ! -e "$TEMP/corporate.env" ]
if bash "$INSTALL" --mode mesh --config "$TEMP/mesh.env"; then exit 1; else [ "$?" -eq 3 ]; fi
[ ! -e "$TEMP/mesh.env" ]
if bash "$INSTALL" --mode invalid --config "$TEMP/invalid.env"; then exit 1; else [ "$?" -eq 2 ]; fi
[ ! -e "$TEMP/invalid.env" ]
printf 'SFERA_DEPLOYMENT_MODE=corporate\n' > "$TEMP/existing.env"
if bash "$INSTALL" --mode personal --config "$TEMP/existing.env"; then exit 1; else [ "$?" -eq 2 ]; fi
grep -qx 'SFERA_DEPLOYMENT_MODE=corporate' "$TEMP/existing.env"
if bash "$INSTALL" --config "$TEMP/noninteractive.env" </dev/null; then exit 1; else [ "$?" -eq 2 ]; fi
[ ! -e "$TEMP/noninteractive.env" ]
echo 'PASS: deployment modes reject implicit conversion and unfinished mesh without installation side effects.'
