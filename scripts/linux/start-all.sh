#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "scripts/linux/start-all.sh is kept for compatibility."
echo "Use scripts/linux/start-http.sh or scripts/linux/start-ssl.sh explicitly."
"$SCRIPT_DIR/start-http.sh"
