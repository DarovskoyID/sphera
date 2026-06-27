#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DJANGO_DIR="$PROJECT_ROOT/django-server/ionik_server"
DOCKER_DIR="$PROJECT_ROOT/django-server"
FRONTEND_DIR="$PROJECT_ROOT"
COTURN_CONF="$HOME/.coturn/turnserver.conf"

echo "=== Starting ionik (macOS) ==="
echo "Project root: $PROJECT_ROOT"

# ── 1. Docker services ─────────────────────────────────────────────────────
echo ""
echo "[1/5] Starting Docker services (Redis, Kafka, ws-gateway, load balancer) ..."
if command -v docker &>/dev/null; then
    cd "$DOCKER_DIR"
    docker compose up -d --build \
        redis kafka zookeeper kafka-init prometheus grafana \
        ws-gateway loadbalancer
    echo "      Done. Load balancer on 127.0.0.1:8081 (edit ../loadbalancer/servers.conf to add nodes)."
else
    echo "      WARNING: Docker not found. Messages may be lost under high load."
fi

# ── 2. coturn ────────────────────────────────────────────────────────────────
echo ""
echo "[2/5] Starting coturn TURN server..."

if ! command -v turnserver &>/dev/null; then
    echo "      ERROR: coturn not found. Run scripts/macos/coturn-install.sh first."
    exit 1
fi

pkill -f "turnserver" 2>/dev/null || true

if [ ! -f "$COTURN_CONF" ]; then
    echo "      WARNING: $COTURN_CONF not found — run coturn-install.sh first."
fi

nohup turnserver -c "$COTURN_CONF" > /tmp/coturn.log 2>&1 &
COTURN_PID=$!
echo "      coturn PID: $COTURN_PID  (log: /tmp/coturn.log)"

# ── 3. Django / Daphne ───────────────────────────────────────────────────────
echo ""
echo "[3/5] Starting Django (Daphne ASGI, auto-restart) on port 8000..."

VENV="$PROJECT_ROOT/django-server/.venv"
if [ ! -d "$VENV" ]; then
    echo "      WARNING: no .venv found at $VENV — wrapper will use system Python."
fi

# Запускаем через обёртку с автоперезапуском (run-daphne.sh), а не голым nohup,
# чтобы зависший/упавший Daphne поднимался сам.
nohup bash "$SCRIPT_DIR/run-daphne.sh" "$DJANGO_DIR" "$VENV" \
    > /tmp/ionik-daphne.log 2>&1 &
DAPHNE_PID=$!
echo "      Daphne supervisor PID: $DAPHNE_PID  (log: /tmp/ionik-daphne.log)"

# ── 4. Kafka worker ──────────────────────────────────────────────────────────
echo ""
echo "[4/5] Starting Kafka worker (auto-restart)..."
if command -v docker &>/dev/null; then
    nohup bash "$SCRIPT_DIR/run-kafka-worker.sh" "$DJANGO_DIR" "$VENV" \
        > /tmp/ionik-kafka-worker.log 2>&1 &
    KAFKA_PID=$!
    echo "      Kafka worker supervisor PID: $KAFKA_PID  (log: /tmp/ionik-kafka-worker.log)"
else
    KAFKA_PID=""
    echo "      Skipped (no Docker/Kafka)."
fi

# ── 5. Vite frontend ─────────────────────────────────────────────────────────
echo ""
echo "[5/5] Starting Vite dev server on port 5173..."
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
echo "  Docker      : Redis :6379, Kafka :9092"
echo "  Load bal.   : 127.0.0.1:8081 -> ws-gateway nodes (loadbalancer/servers.conf)"
echo "  TURN server : localhost:3478"
echo "  Django API  : http://localhost:8000"
echo "  Kafka worker: processing messages"
echo "  Frontend    : http://localhost:5173"
echo ""
KILL_PIDS="$COTURN_PID $DAPHNE_PID $VITE_PID"
[ -n "$KAFKA_PID" ] && KILL_PIDS="$KILL_PIDS $KAFKA_PID"
echo "Stop with:  scripts/macos/stop-all.sh"
echo "  or:       kill $KILL_PIDS"
