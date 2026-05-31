#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOCKER_DIR="$PROJECT_ROOT/django-server"

echo "=== Stopping all ionik services ==="

echo "[1/5] Stopping Django (Daphne) ..."
pkill -f "daphne.*ionik_server" 2>/dev/null || echo "      Not running."

echo "[2/5] Stopping Kafka worker ..."
pkill -f "kafka_worker" 2>/dev/null || echo "      Not running."

echo "[3/5] Stopping Vite dev server ..."
pkill -f "vite" 2>/dev/null || echo "      Not running."

echo "[4/5] Stopping coturn ..."
pkill -f "turnserver" 2>/dev/null || echo "      Not running."

echo "[5/5] Stopping Docker services (Redis, Kafka) ..."
if command -v docker &>/dev/null; then
    cd "$DOCKER_DIR"
    docker compose stop 2>/dev/null || true
    echo "      Stopped."
else
    echo "      Docker not found, skipping."
fi

echo ""
echo "=== All services stopped ==="
