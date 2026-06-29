#!/usr/bin/env bash
#
# wg-node.sh — WireGuard клиент на ДОП-НОДЕ. Подключает её в приватный VPN к хабу.
#
#   sudo IONIK_WG_HUB_PUBKEY='<pubkey хаба>' \
#        IONIK_WG_HUB_ENDPOINT='<публичный IP хаба>:51820' \
#        IONIK_WG_NODE_IP=10.77.0.2 \
#        bash scripts/linux/wg-node.sh
#
# После запуска выведет public key ноды — его нужно добавить на ХАБЕ:
#   sudo bash scripts/linux/wg-hub.sh add-peer <node_pubkey> 10.77.0.2
set -euo pipefail

WG_IF=wg0
WG_DIR=/etc/wireguard
NODE_IP="${IONIK_WG_NODE_IP:?задай IONIK_WG_NODE_IP (напр. 10.77.0.2)}"
HUB_PUB="${IONIK_WG_HUB_PUBKEY:?задай IONIK_WG_HUB_PUBKEY (из 'wg-hub.sh info')}"
HUB_EP="${IONIK_WG_HUB_ENDPOINT:?задай IONIK_WG_HUB_ENDPOINT (IP:51820)}"
SUBNET="${IONIK_WG_SUBNET:-10.77.0.0/24}"

[ "$(id -u)" -eq 0 ] || { echo "Запусти под root (sudo)."; exit 1; }
command -v wg >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq wireguard; }

umask 077; mkdir -p "$WG_DIR"
[ -s "$WG_DIR/node.key" ] || wg genkey > "$WG_DIR/node.key"
wg pubkey < "$WG_DIR/node.key" > "$WG_DIR/node.pub"

cat > "$WG_DIR/$WG_IF.conf" <<EOF
[Interface]
Address = $NODE_IP/24
PrivateKey = $(cat "$WG_DIR/node.key")

[Peer]
PublicKey = $HUB_PUB
Endpoint = $HUB_EP
AllowedIPs = $SUBNET
PersistentKeepalive = 25
EOF
chmod 600 "$WG_DIR/$WG_IF.conf"
systemctl enable --now "wg-quick@$WG_IF" 2>/dev/null || systemctl restart "wg-quick@$WG_IF"

echo "----------------------------------------------------------------"
echo "NODE public key: $(cat "$WG_DIR/node.pub")"
echo "Теперь на ГЛАВНОМ сервере выполни:"
echo "  sudo bash scripts/linux/wg-hub.sh add-peer $(cat "$WG_DIR/node.pub") $NODE_IP"
echo "Затем проверь связь:  ping ${IONIK_WG_HUB_IP:-10.77.0.1}"
echo "----------------------------------------------------------------"
