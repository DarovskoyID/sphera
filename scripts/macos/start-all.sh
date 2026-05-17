#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DJANGO_DIR="$PROJECT_ROOT/django-server/ionik_server"
FRONTEND_DIR="$PROJECT_ROOT"
COTURN_CONF="$HOME/.coturn/turnserver.conf"

echo "=== Starting ionik (macOS) ==="
echo "Project root: $PROJECT_ROOT"

# ── 1. coturn ────────────────────────────────────────────────────────────────
echo ""
echo "[1/3] Starting coturn TURN server..."

if ! command -v turnserver &>/dev/null; then
    echo "      ERROR: coturn not found. Run scripts/macos/coturn-install.sh first."
    exit 1
fi

# Kill existing instance if any
pkill -f "turnserver" 2>/dev/null || true

if [ ! -f "$COTURN_CONF" ]; then
    echo "      WARNING: $COTURN_CONF not found — run coturn-install.sh first."
fi

nohup turnserver -c "$COTURN_CONF" > /tmp/coturn.log 2>&1 &
COTURN_PID=$!
echo "      coturn PID: $COTURN_PID  (log: /tmp/coturn.log)"

# ── 2. Django / Daphne ───────────────────────────────────────────────────────
echo ""
echo "[2/3] Starting Django (Daphne ASGI) on port 8000..."

VENV="$PROJECT_ROOT/django-server/.venv"
if [ -d "$VENV" ]; then
    source "$VENV/bin/activate"
else
    echo "      WARNING: no .venv found at $VENV — using system Python."
fi

cd "$DJANGO_DIR"
python manage.py migrate --run-syncdb 2>/dev/null || true
nohup daphne -b 0.0.0.0 -p 8000 ionik_server.asgi:application \
    > /tmp/ionik-daphne.log 2>&1 &
DAPHNE_PID=$!
echo "      Daphne PID: $DAPHNE_PID  (log: /tmp/ionik-daphne.log)"

# ── 3. Vite frontend ─────────────────────────────────────────────────────────
echo ""
echo "[3/3] Starting Vite dev server on port 5173..."
cd "$FRONTEND_DIR"

if ! command -v npm &>/dev/null; then
    echo "      ERROR: npm not found. Install Node.js via https://nodejs.org or: brew install node"
    exit 1
fi

[ ! -d node_modules ] && npm install
nohup npm run dev -- --host \
    > /tmp/ionik-vite.log 2>&1 &
VITE_PID=$!
echo "      Vite PID: $VITE_PID  (log: /tmp/ionik-vite.log)"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== All services started ==="
echo "  TURN server : localhost:3478"
echo "  Django API  : http://localhost:8000"
echo "  Frontend    : http://localhost:5173"
echo ""
echo "Stop with:  kill $COTURN_PID $DAPHNE_PID $VITE_PID"
