#!/bin/bash
# Полное удаление ionik с сервера: systemd-юниты, docker-стек + тома (БД!),
# nginx-конфиг, swap, логи, venv.
#
# По умолчанию НЕ трогает:
#   - код-репозиторий ($PROJECT_ROOT)  → удалить флагом --purge-code
#   - coturn                            → удалить флагом --purge-coturn
#   - docker-образы                     → удалить флагом --purge-images
#
# Использование:
#   scripts/linux/uninstall.sh                 # спросит подтверждение
#   scripts/linux/uninstall.sh --yes           # без вопросов
#   scripts/linux/uninstall.sh --yes --purge-code --purge-images --purge-coturn
#   scripts/linux/uninstall.sh --keep-swap     # оставить swap-файлы
set -uo pipefail

YES=0; PURGE_CODE=0; PURGE_COTURN=0; PURGE_IMAGES=0; PURGE_SWAP=1
for a in "$@"; do
    case "$a" in
        --yes|-y)        YES=1 ;;
        --purge-code)    PURGE_CODE=1 ;;
        --purge-coturn)  PURGE_COTURN=1 ;;
        --purge-images)  PURGE_IMAGES=1 ;;
        --keep-swap)     PURGE_SWAP=0 ;;
        -h|--help)
            sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "Неизвестный аргумент: $a"; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOCKER_DIR="$PROJECT_ROOT/django-server"
APP_NAME="${IONIK_APP_NAME:-ionik}"
WEB_ROOT="${IONIK_WEB_ROOT:-/var/www/ionik}"

echo "=== Полное удаление ionik ==="
echo "  Код:    $PROJECT_ROOT $([ "$PURGE_CODE" = 1 ] && echo '→ БУДЕТ УДАЛЁН' || echo '(останется)')"
echo "  Docker: стек + тома (PostgreSQL/Elasticsearch/Kafka данные) → УДАЛЯЮТСЯ"
echo "  Образы: $([ "$PURGE_IMAGES" = 1 ] && echo 'удаляются' || echo 'остаются')"
echo "  Swap:   $([ "$PURGE_SWAP" = 1 ] && echo 'удаляется' || echo 'остаётся')"
echo "  coturn: $([ "$PURGE_COTURN" = 1 ] && echo 'отключается' || echo 'не трогается')"
echo ""

if [ "$YES" != 1 ]; then
    read -r -p "Это НЕОБРАТИМО удалит данные. Введите 'yes' для продолжения: " ans
    [ "$ans" = "yes" ] || { echo "Отмена."; exit 1; }
fi

step() { echo ""; echo "==> $1"; }

# ── 1. systemd-юниты + watchdog + drop-in'ы ──────────────────────────────────
step "Останавливаю и удаляю systemd-юниты"
for u in ionik-daphne-healthcheck.timer ionik-daphne-healthcheck.service \
         ionik-daphne.service ionik-kafka-worker.service; do
    sudo systemctl disable --now "$u" 2>/dev/null || true
done
sudo rm -f /etc/systemd/system/ionik-daphne.service \
           /etc/systemd/system/ionik-kafka-worker.service \
           /etc/systemd/system/ionik-daphne-healthcheck.service \
           /etc/systemd/system/ionik-daphne-healthcheck.timer
sudo rm -rf /etc/systemd/system/ionik-daphne.service.d \
            /etc/systemd/system/ionik-kafka-worker.service.d
sudo rm -f /usr/local/bin/ionik-daphne-healthcheck.sh
sudo systemctl daemon-reload

# Добиваем возможные «голые» процессы
pkill -9 -f 'daphne.*ionik_server' 2>/dev/null || true
pkill -9 -f 'manage.py kafka_worker' 2>/dev/null || true
rm -f /tmp/ionik-daphne.pid /tmp/ionik-kafka-worker.pid

# ── 2. Docker-стек + тома (+ опционально образы) ─────────────────────────────
step "Останавливаю docker-стек и удаляю тома (данные БД/ES/Kafka)"
if command -v docker >/dev/null 2>&1 && [ -f "$DOCKER_DIR/docker-compose.yml" ]; then
    DOWN_ARGS="-v --remove-orphans"
    [ "$PURGE_IMAGES" = 1 ] && DOWN_ARGS="$DOWN_ARGS --rmi all"
    (cd "$DOCKER_DIR" && docker compose down $DOWN_ARGS 2>&1 | tail -8) || true
else
    echo "      docker/compose не найдены — пропуск."
fi

# ── 3. nginx-конфиг ──────────────────────────────────────────────────────────
step "Удаляю nginx-конфиг сайта"
sudo rm -f "/etc/nginx/sites-enabled/$APP_NAME.conf" "/etc/nginx/sites-available/$APP_NAME.conf"
if command -v nginx >/dev/null 2>&1; then
    sudo nginx -t 2>/dev/null && sudo systemctl reload nginx 2>/dev/null || true
fi

# ── 4. Фронтенд, логи, временные файлы, loadtest.env ─────────────────────────
step "Удаляю фронтенд, логи и временные файлы"
sudo rm -rf "$WEB_ROOT" /var/log/ionik
rm -f /tmp/ionik-daphne.log /tmp/ionik-kafka-worker.log /tmp/ionik-vite.log /tmp/coturn.log
rm -f "$PROJECT_ROOT/load-tests/loadtest.env"

# ── 5. Swap ──────────────────────────────────────────────────────────────────
if [ "$PURGE_SWAP" = 1 ]; then
    step "Удаляю swap-файлы"
    for sf in /swapfile /swapfile2; do
        if [ -f "$sf" ]; then
            sudo swapoff "$sf" 2>/dev/null || true
            sudo rm -f "$sf"
            sudo sed -i "\|^$sf |d" /etc/fstab
            echo "      удалён $sf"
        fi
    done
fi

# ── 6. coturn ────────────────────────────────────────────────────────────────
if [ "$PURGE_COTURN" = 1 ]; then
    step "Отключаю coturn"
    sudo systemctl disable --now coturn 2>/dev/null || true
fi

# ── 7. venv ──────────────────────────────────────────────────────────────────
step "Удаляю Python venv"
sudo rm -rf "$DOCKER_DIR/.venv"

# ── 8. Код-репозиторий (только по флагу) ─────────────────────────────────────
if [ "$PURGE_CODE" = 1 ]; then
    step "Удаляю код-репозиторий $PROJECT_ROOT"
    cd /tmp || cd /
    sudo rm -rf "$PROJECT_ROOT"
fi

echo ""
echo "=== ionik удалён с сервера ==="
[ "$PURGE_CODE" != 1 ] && echo "Код остался в $PROJECT_ROOT (удалить: rm -rf $PROJECT_ROOT)."
[ "$PURGE_IMAGES" != 1 ] && echo "Docker-образы остались (очистить: docker system prune -a)."
