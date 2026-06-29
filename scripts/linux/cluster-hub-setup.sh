#!/usr/bin/env bash
#
# cluster-hub-setup.sh — интерактивная настройка кластера на ГЛАВНОМ сервере.
# Ничего не захардкожено: все параметры спрашиваются (дефолты можно подтвердить
# Enter) и запоминаются в /etc/ionik/cluster.env.
#
#   sudo bash scripts/linux/cluster-hub-setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DJANGO_DIR="$PROJECT_ROOT/django-server"
SERVERS_CONF="$PROJECT_ROOT/loadbalancer/servers.conf"
WG_DIR=/etc/wireguard
SECRETS=/etc/ionik/secrets.env
CLUSTER_ENV=/etc/ionik/cluster.env

[ "$(id -u)" -eq 0 ] || { echo "Запусти под root (sudo)."; exit 1; }

pubip() { curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}'; }

# ask <varname> <prompt> <default>
ask() {
    local ans def="$3"
    read -rp "$2 [$def]: " ans
    printf -v "$1" '%s' "${ans:-$def}"
}

load_config() { [ -f "$CLUSTER_ENV" ] && { set -a; . "$CLUSTER_ENV"; set +a; } || true; }

save_config() {
    mkdir -p /etc/ionik
    cat > "$CLUSTER_ENV" <<EOF
WG_HUB_IP=$WG_HUB_IP
WG_SUBNET=$WG_SUBNET
WG_PORT=$WG_PORT
WG_ENDPOINT=$WG_ENDPOINT
AUTHZ_URL=$AUTHZ_URL
EOF
    chmod 600 "$CLUSTER_ENV"
}

# Спрашивает все параметры кластера (с дефолтами из прошлого запуска/окружения).
gather_config() {
    load_config
    WG_HUB_IP="${WG_HUB_IP:-10.77.0.1}"
    WG_SUBNET="${WG_SUBNET:-10.77.0.0/24}"
    WG_PORT="${WG_PORT:-51820}"
    WG_ENDPOINT="${WG_ENDPOINT:-$(pubip):$WG_PORT}"
    local domain_def; domain_def="$(sed -n 's/^IONIK_DOMAIN=//p' "$SECRETS" 2>/dev/null)"
    AUTHZ_URL="${AUTHZ_URL:-https://${domain_def:-$(pubip)}:8000/api/ws/authorize/}"

    echo "--- Параметры кластера (Enter — оставить значение в скобках) ---"
    ask WG_HUB_IP   "WG-адрес хаба"                              "$WG_HUB_IP"
    ask WG_SUBNET   "WG-подсеть"                                 "$WG_SUBNET"
    ask WG_PORT     "WG UDP-порт"                                "$WG_PORT"
    ask WG_ENDPOINT "Публичный endpoint WireGuard (IP:порт)"    "${WG_ENDPOINT%%:*}:$WG_PORT"
    ask AUTHZ_URL   "URL авторизации WS (публичный API)"         "$AUTHZ_URL"
    save_config
    echo "Сохранено в $CLUSTER_ENV."
}

lb_reload() {
    ( cd "$DJANGO_DIR" && docker compose exec -T loadbalancer nginx -s reload >/dev/null 2>&1 ) \
        || ( cd "$DJANGO_DIR" && docker compose restart loadbalancer >/dev/null 2>&1 ) || true
}

next_free_ip() {
    local base used max n
    base="$(echo "$WG_HUB_IP" | cut -d. -f1-3)"
    used="$( { cat "$WG_DIR/wg0.conf" "$SERVERS_CONF" 2>/dev/null; } | grep -oE "${base//./\\.}\.[0-9]+" | grep -oE '[0-9]+$' )"
    max="$(echo "$WG_HUB_IP" | cut -d. -f4)"
    for n in $used; do [ "$n" -gt "$max" ] && max="$n"; done
    echo "$base.$(( max + 1 ))"
}

do_init() {
    gather_config
    IONIK_WG_HUB_IP="$WG_HUB_IP" IONIK_WG_SUBNET="$WG_SUBNET" IONIK_WG_PORT="$WG_PORT" \
        bash "$SCRIPT_DIR/wg-hub.sh" install
    echo ""
    echo "[hub] Открываю Redis/Kafka в VPN на $WG_HUB_IP (пересоздаю redis+kafka, ~10с)…"
    ( cd "$DJANGO_DIR" && IONIK_WG_HUB_IP="$WG_HUB_IP" docker compose \
        -f docker-compose.yml -f docker-compose.cluster.yml up -d redis kafka )
    echo "[hub] Готово. Теперь пункт 2 — «Добавить ноду»."
}

do_add_node() {
    [ -s "$WG_DIR/hub.pub" ] || { echo "Сначала пункт 1 (инициализация хаба)."; return; }
    load_config
    [ -n "${WG_HUB_IP:-}" ] || { echo "Нет конфига — запусти пункт 1."; return; }

    local jwt; jwt="$(sed -n 's/^IONIK_SECRET_KEY=//p' "$SECRETS" 2>/dev/null)"
    [ -n "$jwt" ] || { echo "Не нашёл IONIK_SECRET_KEY в $SECRETS."; return; }

    local node_ip; node_ip="$(next_free_ip)"
    ask node_ip "WG-IP для новой ноды" "$node_ip"

    local npriv npub
    npriv="$(wg genkey)"; npub="$(printf '%s' "$npriv" | wg pubkey)"
    IONIK_WG_HUB_IP="$WG_HUB_IP" bash "$SCRIPT_DIR/wg-hub.sh" add-peer "$npub" "$node_ip" >/dev/null
    grep -q "server $node_ip:8001" "$SERVERS_CONF" 2>/dev/null \
        || echo "server $node_ip:8001 max_fails=3 fail_timeout=10s;" >> "$SERVERS_CONF"
    lb_reload

    local token
    token="$(printf 'HUB_PUB=%s\nHUB_ENDPOINT=%s\nHUB_IP=%s\nWG_SUBNET=%s\nNODE_IP=%s\nNODE_PRIVKEY=%s\nJWT_SECRET=%s\nAUTHZ_URL=%s\n' \
        "$(cat "$WG_DIR/hub.pub")" "$WG_ENDPOINT" "$WG_HUB_IP" "$WG_SUBNET" "$node_ip" "$npriv" "$jwt" "$AUTHZ_URL" | base64 -w0 )"

    cat <<EOF

================= НОДА $node_ip ДОБАВЛЕНА =================
Пир в VPN зарегистрирован, нода вписана в балансировщик.

На ВТОРОМ сервере (после git clone + install-deps.sh --skip-coturn) выполни:

  sudo bash scripts/linux/cluster-node-setup.sh '$token'

⚠️  Токен содержит секреты (JWT + WG-ключ) — передавай по SSH.
   Открой на хостере UDP $WG_PORT к этому серверу.
==========================================================
EOF
}

do_remove_node() {
    local node_ip; ask node_ip "WG-IP ноды для удаления" ""
    [ -n "$node_ip" ] || return
    local pub; pub="$(wg show wg0 dump 2>/dev/null | awk -v ip="$node_ip/32" '$4==ip{print $1}')"
    [ -n "$pub" ] && wg set wg0 peer "$pub" remove 2>/dev/null || true
    sed -i "\#AllowedIPs = $node_ip/32#d" "$WG_DIR/wg0.conf" 2>/dev/null || true
    sed -i "\#server $node_ip:8001#d" "$SERVERS_CONF" 2>/dev/null || true
    lb_reload
    echo "Нода $node_ip убрана."
}

do_status() {
    load_config
    echo "=== WireGuard ==="; wg show wg0 2>/dev/null | sed 's/^/  /' || echo "  wg0 не поднят"
    echo "=== Ноды в балансировщике ==="; grep -E '^\s*server ' "$SERVERS_CONF" 2>/dev/null | sed 's/^/  /'
    echo "=== Redis/Kafka в VPN ==="; ss -ltn 2>/dev/null | grep -E "${WG_HUB_IP:-10.77.0.1}:(6379|9094)" | sed 's/^/  /' || echo "  (не открыты — пункт 1)"
}

while true; do
    cat <<MENU

==== ionik cluster (хаб) ====
  1) Инициализировать хаб (WireGuard + Redis/Kafka в VPN)
  2) Добавить ноду  (выдать команду для второго сервера)
  3) Убрать ноду
  4) Статус
  0) Выход
MENU
    read -rp "Выбор: " choice
    case "$choice" in
        1) do_init ;;
        2) do_add_node ;;
        3) do_remove_node ;;
        4) do_status ;;
        0|"") exit 0 ;;
        *) echo "??" ;;
    esac
done
