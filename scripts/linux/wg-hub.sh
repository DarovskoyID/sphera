#!/usr/bin/env bash
#
# wg-hub.sh — WireGuard «хаб» на ГЛАВНОМ сервере. Поднимает приватный VPN, через
# который доп-ноды кластера ходят к Redis/Kafka, не выставляя их в интернет.
#
#   sudo bash scripts/linux/wg-hub.sh install                  # поставить и поднять хаб
#   sudo bash scripts/linux/wg-hub.sh add-peer <pubkey> <ip>   # добавить ноду (её pubkey + WG-IP)
#   sudo bash scripts/linux/wg-hub.sh info                     # показать pubkey/endpoint для ноды
#
# Сеть VPN: хаб 10.77.0.1, ноды 10.77.0.2, .3, … (меняется через SFERA_WG_*).
set -euo pipefail

WG_IF=wg0
WG_SUBNET="${SFERA_WG_SUBNET:-10.77.0.0/24}"
WG_HUB_IP="${SFERA_WG_HUB_IP:-10.77.0.1}"
WG_PORT="${SFERA_WG_PORT:-51820}"
WG_DIR=/etc/wireguard
conf="$WG_DIR/$WG_IF.conf"
cmd="${1:-install}"

[ "$(id -u)" -eq 0 ] || { echo "Запусти под root (sudo)."; exit 1; }

ensure_installed() {
    command -v wg >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq wireguard; }
}

case "$cmd" in
  install)
    ensure_installed
    umask 077; mkdir -p "$WG_DIR"
    [ -s "$WG_DIR/hub.key" ] || wg genkey > "$WG_DIR/hub.key"
    wg pubkey < "$WG_DIR/hub.key" > "$WG_DIR/hub.pub"
    if [ ! -f "$conf" ]; then
        cat > "$conf" <<EOF
[Interface]
Address = $WG_HUB_IP/24
ListenPort = $WG_PORT
PrivateKey = $(cat "$WG_DIR/hub.key")
EOF
    fi
    chmod 600 "$conf"
    systemctl enable --now "wg-quick@$WG_IF" 2>/dev/null || systemctl restart "wg-quick@$WG_IF"
    # Открыть UDP-порт WireGuard на вход (изолированная nft-таблица).
    nft list table inet sfera_wg >/dev/null 2>&1 || nft -f - <<NFT
table inet sfera_wg {
    chain input {
        type filter hook input priority 0; policy accept;
        udp dport $WG_PORT counter accept
    }
}
NFT
    echo "WireGuard хаб поднят на $WG_HUB_IP (порт $WG_PORT/udp)."
    "$0" info
    ;;
  add-peer)
    pub="${2:?нужен public key ноды}"; ip="${3:?нужен WG-IP ноды, напр. 10.77.0.2}"
    if ! grep -q "$pub" "$conf" 2>/dev/null; then
        cat >> "$conf" <<EOF

[Peer]
PublicKey = $pub
AllowedIPs = $ip/32
EOF
    fi
    wg set "$WG_IF" peer "$pub" allowed-ips "$ip/32"
    echo "Нода $ip добавлена в VPN. Проверь: ping $ip"
    ;;
  info)
    ip4="$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
    echo "----------------------------------------------------------------"
    echo "HUB public key : $(cat "$WG_DIR/hub.pub")"
    echo "HUB endpoint   : $ip4:$WG_PORT"
    echo "HUB wg ip      : $WG_HUB_IP   (Redis/Kafka слушают тут)"
    echo "----------------------------------------------------------------"
    echo "На НОДЕ запусти (подставив значения выше):"
    echo "  sudo SFERA_WG_HUB_PUBKEY='<pubkey>' SFERA_WG_HUB_ENDPOINT='$ip4:$WG_PORT' \\"
    echo "       SFERA_WG_NODE_IP=10.77.0.2 bash scripts/linux/wg-node.sh"
    ;;
  *)
    echo "Usage: $0 install | add-peer <pubkey> <ip> | info"; exit 1;;
esac
