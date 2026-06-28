#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOCKER_DIR="$PROJECT_ROOT/django-server"
PID_FILE="/tmp/ionik-daphne.pid"
KAFKA_PID_FILE="/tmp/ionik-kafka-worker.pid"

# Обычная остановка приложения: Daphne(+watchdog), Kafka-воркеры, coturn, nginx
# и `docker compose stop` (контейнеры остаются — быстрый рестарт). Для полного
# сноса (compose down + почта + зачистка процессов) есть stop-all.sh.
echo "=== Stopping ionik services ==="

# ── Django / Daphne ────────────────────────────────────────────────────────────
echo "[1/5] Stopping Django (Daphne) ..."
# Останавливаем и отключаем watchdog, иначе он перезапустит Daphne обратно
if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl stop ionik-daphne-healthcheck.timer 2>/dev/null || true
    sudo systemctl stop ionik-daphne.service 2>/dev/null || true
fi
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
fi
pkill -f "daphne.*ionik_server" 2>/dev/null || true
echo "      Stopped."

# ── Kafka worker ──────────────────────────────────────────────────────────────
echo "[2/5] Stopping Kafka worker ..."
if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl stop ionik-kafka-worker.service 2>/dev/null || true
    # Шаблонные инстансы (параллельные воркеры)
    for u in $(systemctl list-units --all --no-legend 'ionik-kafka-worker@*.service' 2>/dev/null | awk '{print $1}'); do
        sudo systemctl stop "$u" 2>/dev/null || true
    done
fi
if [ -f "$KAFKA_PID_FILE" ] && kill -0 "$(cat "$KAFKA_PID_FILE")" 2>/dev/null; then
    kill "$(cat "$KAFKA_PID_FILE")" 2>/dev/null || true
    rm -f "$KAFKA_PID_FILE"
fi
pkill -f "kafka_worker" 2>/dev/null || true
echo "      Stopped."

# ── coturn ────────────────────────────────────────────────────────────────────
echo "[3/5] Stopping coturn ..."
if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl stop coturn 2>/dev/null || true
else
    pkill -f "turnserver" 2>/dev/null || true
fi
echo "      Stopped."

# ── nginx ─────────────────────────────────────────────────────────────────────
echo "[4/5] Stopping nginx ..."
if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl stop nginx 2>/dev/null || true
else
    sudo nginx -s stop 2>/dev/null || true
fi
echo "      Stopped."

# ── Docker services ───────────────────────────────────────────────────────────
echo "[5/5] Stopping Docker services (Redis, Kafka) ..."
if command -v docker >/dev/null 2>&1; then
    cd "$DOCKER_DIR"
    docker compose stop 2>/dev/null || true
    echo "      Stopped."
else
    echo "      Docker not found, skipping."
fi

echo ""
echo "=== All services stopped ==="
