#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    echo "Usage: scripts/linux/start-ssl.sh --cert PATH --key PATH [--api-port PORT] [--django-port PORT]"
    echo ""
    echo "Starts production SSL:"
    echo "  Frontend: https://start-ionik.ru"
    echo "  Public API: https://start-ionik.ru:8000"
    echo "  Internal Daphne: 127.0.0.1:8001"
    echo ""
    echo "Options are forwarded to start-common.sh."
    exit 0
fi

"$SCRIPT_DIR/start-common.sh" ssl "$@"
