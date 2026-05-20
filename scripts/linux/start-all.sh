#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    echo "Usage: scripts/linux/start-all.sh [--api-port PORT] [--django-port PORT]"
    echo ""
    echo "Compatibility wrapper for scripts/linux/start-http.sh."
    echo "For SSL use scripts/linux/start-ssl.sh."
    exit 0
fi

echo "scripts/linux/start-all.sh is kept for compatibility."
echo "Use scripts/linux/start-http.sh or scripts/linux/start-ssl.sh explicitly."
"$SCRIPT_DIR/start-http.sh" "$@"
