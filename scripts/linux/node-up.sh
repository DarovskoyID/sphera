#!/usr/bin/env bash
#
# node-up.sh — поднять ДОП-НОДУ (ws-gateway) на втором сервере.
# Требует: WireGuard уже поднят (wg-node.sh) и заполнен /etc/ionik/node.env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENVF="${IONIK_NODE_ENV:-/etc/ionik/node.env}"

[ -f "$ENVF" ] || { echo "Нет $ENVF — создай из scripts/linux/node.env.example."; exit 1; }
set -a; . "$ENVF"; set +a
: "${JWT_SECRET:?JWT_SECRET не задан в $ENVF (= IONIK_SECRET_KEY главного)}"
: "${IONIK_WG_HUB_IP:?IONIK_WG_HUB_IP не задан в $ENVF}"
: "${IONIK_WG_NODE_IP:?IONIK_WG_NODE_IP не задан в $ENVF}"

echo "[node] проверяю связь с хабом по VPN ($IONIK_WG_HUB_IP)…"
ping -c1 -W3 "$IONIK_WG_HUB_IP" >/dev/null 2>&1 || { echo "Нет пинга до $IONIK_WG_HUB_IP — сначала подними WireGuard (wg-node.sh) и add-peer на хабе."; exit 1; }

cd "$PROJECT_ROOT/django-server"
echo "[node] поднимаю ws-gateway…"
docker compose -f docker-compose.node.yml up -d --build
docker compose -f docker-compose.node.yml ps

cat <<EOF

Готово. Осталось зарегистрировать ноду в балансировщике на ГЛАВНОМ сервере:
  echo 'server $IONIK_WG_NODE_IP:8001 max_fails=3 fail_timeout=10s;' >> loadbalancer/servers.conf
  docker compose exec loadbalancer nginx -s reload

Проверка с главного:  curl -s http://$IONIK_WG_NODE_IP:8001/metrics | head
EOF
