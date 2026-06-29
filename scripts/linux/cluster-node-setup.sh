#!/usr/bin/env bash
#
# cluster-node-setup.sh — настраивает ДОП-НОДУ ЦЕЛИКОМ. Спрашивает все параметры
# (с дефолтами). Можно ускорить, вставив join-токен с главного — тогда поля будут
# предзаполнены, останется жать Enter.
#
#   sudo bash scripts/linux/cluster-node-setup.sh '<join-токен>'   # с предзаполнением
#   sudo bash scripts/linux/cluster-node-setup.sh                  # спросит всё (можно вставить токен или вводить руками)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WG_DIR=/etc/wireguard
WG_IF=wg0

[ "$(id -u)" -eq 0 ] || { echo "Запусти под root (sudo)."; exit 1; }

# ask <varname> <prompt> <default>
ask() {
    local ans def="$3"
    read -rp "$2 [${def}]: " ans
    printf -v "$1" '%s' "${ans:-$def}"
}

# --- токен (необязательно): предзаполняет поля ---
token="${1:-}"
if [ -z "$token" ]; then
    read -rp "Вставь join-токен с главного (или Enter — вводить вручную): " token
fi
if [ -n "$token" ]; then
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    if printf '%s' "$token" | base64 -d > "$tmp" 2>/dev/null; then
        set -a; . "$tmp"; set +a
    else
        echo "Токен не распознан — спрошу всё вручную."
    fi
fi

# --- спрашиваем все параметры (дефолты — из токена, если был) ---
echo "--- Параметры ноды (Enter — оставить значение в скобках) ---"
ask HUB_PUB      "Public key хаба"                         "${HUB_PUB:-}"
ask HUB_ENDPOINT "Endpoint хаба (публ. IP:порт)"           "${HUB_ENDPOINT:-}"
ask HUB_IP       "WG-адрес хаба"                           "${HUB_IP:-10.77.0.1}"
ask WG_SUBNET    "WG-подсеть"                              "${WG_SUBNET:-10.77.0.0/24}"
ask NODE_IP      "WG-адрес этой ноды"                      "${NODE_IP:-10.77.0.2}"
ask JWT_SECRET   "JWT_SECRET (= IONIK_SECRET_KEY главного)" "${JWT_SECRET:-}"
ask AUTHZ_URL    "URL авторизации WS (публ. API главного)" "${AUTHZ_URL:-https://${HUB_ENDPOINT%%:*}:8000/api/ws/authorize/}"

for v in HUB_PUB HUB_ENDPOINT HUB_IP NODE_IP JWT_SECRET AUTHZ_URL; do
    [ -n "${!v}" ] || { echo "Поле $v пустое — повтори запуск и заполни."; exit 1; }
done

echo "[node] Ставлю WireGuard…"
command -v wg >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq wireguard; }
umask 077; mkdir -p "$WG_DIR"

# Приватный ключ ноды: из токена, либо генерируем новый (тогда его pubkey надо
# добавить на хабе — скрипт подскажет команду).
GEN_PUB=""
if [ -z "${NODE_PRIVKEY:-}" ]; then
    NODE_PRIVKEY="$(wg genkey)"
    GEN_PUB="$(printf '%s' "$NODE_PRIVKEY" | wg pubkey)"
fi

cat > "$WG_DIR/$WG_IF.conf" <<EOF
[Interface]
Address = $NODE_IP/24
PrivateKey = $NODE_PRIVKEY

[Peer]
PublicKey = $HUB_PUB
Endpoint = $HUB_ENDPOINT
AllowedIPs = $WG_SUBNET
PersistentKeepalive = 25
EOF
chmod 600 "$WG_DIR/$WG_IF.conf"
systemctl enable --now "wg-quick@$WG_IF" 2>/dev/null || systemctl restart "wg-quick@$WG_IF"

if [ -n "$GEN_PUB" ]; then
    echo ""
    echo "⚠️  Ключ ноды сгенерирован здесь. Добавь его на ГЛАВНОМ сервере:"
    echo "     sudo bash scripts/linux/wg-hub.sh add-peer $GEN_PUB $NODE_IP"
    read -rp "Нажми Enter, когда выполнишь это на главном… " _
fi

echo "[node] Проверяю VPN до хаба ($HUB_IP)…"
ping -c1 -W4 "$HUB_IP" >/dev/null 2>&1 || { echo "Нет связи с $HUB_IP. Проверь UDP-порт WG на хостере и регистрацию пира на хабе."; exit 1; }

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
echo "✅ Нода $NODE_IP в кластере. Проверь с главного:  curl -s http://$NODE_IP:8001/metrics | head"
