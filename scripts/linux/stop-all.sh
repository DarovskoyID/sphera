#!/bin/bash
#
# stop-all.sh — ПОЛНАЯ остановка всего, что относится к ionik.
#
# Делает всё, что делает stop.sh (Daphne+watchdog, Kafka-воркеры, coturn, nginx),
# и ДОПОЛНИТЕЛЬНО:
#   - глушит почтовый сервер (Postfix + OpenDKIM);
#   - сносит docker-контейнеры целиком (`docker compose down`, не просто stop);
#   - убивает осиротевшие процессы и чистит PID-файлы.
#
# Данные сохраняются: `compose down` БЕЗ `-v` не трогает тома (Postgres/ES/…).
# Для обычной быстрой остановки используй stop.sh.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOCKER_DIR="$PROJECT_ROOT/django-server"

echo "=== Stopping ABSOLUTELY ALL ionik services ==="

# ── 1. Базовая остановка приложения ─────────────────────────────────────────
# Переиспользуем stop.sh: Daphne(+watchdog timer), Kafka-воркеры, coturn, nginx,
# docker compose stop.
"$SCRIPT_DIR/stop.sh"

# ── 2. Почтовый сервер ──────────────────────────────────────────────────────
echo ""
echo "[+] Stopping mail server (Postfix + OpenDKIM) ..."
if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl stop postfix  2>/dev/null || true
    sudo systemctl stop opendkim 2>/dev/null || true
else
    pkill -f "postfix"  2>/dev/null || true
    pkill -f "opendkim" 2>/dev/null || true
fi
echo "      Stopped."

# ── 3. Docker: полный снос контейнеров и сетей ──────────────────────────────
echo "[+] Removing Docker containers (compose down, volumes kept) ..."
if command -v docker >/dev/null 2>&1; then
    cd "$DOCKER_DIR"
    # --remove-orphans подчищает контейнеры от старых версий compose-файла.
    docker compose down --remove-orphans 2>/dev/null || true
    echo "      Containers removed (data volumes preserved)."
else
    echo "      Docker not found, skipping."
fi

# ── 4. Зачистка осиротевших процессов и PID-файлов ──────────────────────────
echo "[+] Cleaning up stray processes ..."
pkill -f "daphne.*ionik_server" 2>/dev/null || true
pkill -f "kafka_worker"         2>/dev/null || true
pkill -f "turnserver"           2>/dev/null || true
rm -f /tmp/ionik-daphne.pid /tmp/ionik-kafka-worker.pid
echo "      Done."

echo ""
echo "=== Everything stopped ==="
echo "Note: services are stopped, not disabled — a reboot or start-*.sh brings"
echo "      them back. Data volumes (Postgres/Elasticsearch) are preserved."
