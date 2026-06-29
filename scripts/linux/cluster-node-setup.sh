#!/usr/bin/env bash
#
# cluster-node-setup.sh — настраивает ДОП-НОДУ ЦЕЛИКОМ из join-токена, который
# выдал cluster-hub-setup.sh на главном сервере. Ставит WireGuard, прописывает
# доступ к Redis/Kafka главного и поднимает ws-gateway. Обратных шагов на хабе
# не требуется — пир там уже зарегистрирован.
#
#   sudo bash scripts/linux/cluster-node-setup.sh '<join-токен>'
#   (без аргумента — спросит токен)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WG_DIR=/etc/wireguard
WG_IF=wg0
SUBNET="${IONIK_WG_SUBNET:-10.77.0.0/24}"

[ "$(id -u)" -eq 0 ] || { echo "Запусти под root (sudo)."; exit 1; }

token="${1:-}"
[ -n "$token" ] || read -rp "Вставь join-токен с главного сервера: " token

tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
printf '%s' "$token" | base64 -d > "$tmp" 2>/dev/null || { echo "Битый токен."; exit 1; }
# Значения токена — KEY=VALUE без пробелов (ключи/секреты в base64, IP, URL).
set -a; . "$tmp"; set +a
: "${HUB_PUB:?}"; : "${HUB_ENDPOINT:?}"; : "${HUB_IP:?}"; : "${NODE_IP:?}"; : "${NODE_PRIVKEY:?}"; : "${JWT_SECRET:?}"; : "${AUTHZ_URL:?}"

echo "[node] Ставлю WireGuard…"
command -v wg >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq wireguard; }
umask 077; mkdir -p "$WG_DIR"
cat > "$WG_DIR/$WG_IF.conf" <<EOF
[Interface]
Address = $NODE_IP/24
PrivateKey = $NODE_PRIVKEY

[Peer]
PublicKey = $HUB_PUB
Endpoint = $HUB_ENDPOINT
AllowedIPs = $SUBNET
PersistentKeepalive = 25
EOF
chmod 600 "$WG_DIR/$WG_IF.conf"
systemctl enable --now "wg-quick@$WG_IF" 2>/dev/null || systemctl restart "wg-quick@$WG_IF"

echo "[node] Проверяю VPN до хаба ($HUB_IP)…"
ping -c1 -W4 "$HUB_IP" >/dev/null 2>&1 || { echo "Нет связи с $HUB_IP. Проверь, что на хостере открыт UDP-порт WireGuard."; exit 1; }

echo "[node] Пишу /etc/ionik/node.env…"
mkdir -p /etc/ionik
cat > /etc/ionik/node.env <<EOF
IONIK_WG_HUB_IP=$HUB_IP
IONIK_WG_NODE_IP=$NODE_IP
JWT_SECRET=$JWT_SECRET
DJANGO_WS_AUTHZ_URL=$AUTHZ_URL
EOF
chmod 600 /etc/ionik/node.env

echo "[node] Поднимаю ws-gateway…"
bash "$SCRIPT_DIR/node-up.sh"

echo ""
echo "✅ Нода $NODE_IP в кластере. Балансировщик главного уже знает о ней."
echo "   Проверь с главного:  curl -s http://$NODE_IP:8001/metrics | head"
