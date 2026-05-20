#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    echo "Usage: scripts/linux/start-http.sh [--api-port PORT] [--django-port PORT]"
    echo ""
    echo "Starts non-SSL nginx:"
    echo "  Frontend: http://<server-ip>/"
    echo "  Public API: http://<server-ip>:8000"
    echo "  Internal Daphne: 127.0.0.1:8001"
    echo ""
    echo "Options are forwarded to start-common.sh."
    exit 0
fi

"$SCRIPT_DIR/start-common.sh" http "$@"
