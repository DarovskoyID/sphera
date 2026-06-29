#!/usr/bin/env bash
#
# cluster-hub-setup.sh — интерактивная настройка кластера на ГЛАВНОМ сервере.
# Меню:
#   1) Инициализировать хаб         — поднять WireGuard + открыть Redis/Kafka в VPN
#   2) Добавить ноду                — выдаёт ОДНУ команду для второго сервера
#   3) Убрать ноду
#   4) Статус
#
#   sudo bash scripts/linux/cluster-hub-setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DJANGO_DIR="$PROJECT_ROOT/django-server"
SERVERS_CONF="$PROJECT_ROOT/loadbalancer/servers.conf"
WG_DIR=/etc/wireguard
WG_HUB_IP="${IONIK_WG_HUB_IP:-10.77.0.1}"
WG_PORT="${IONIK_WG_PORT:-51820}"
SECRETS=/etc/ionik/secrets.env

[ "$(id -u)" -eq 0 ] || { echo "Запусти под root (sudo)."; exit 1; }

pubip() { curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}'; }

lb_reload() {
    ( cd "$DJANGO_DIR" && docker compose exec -T loadbalancer nginx -s reload >/dev/null 2>&1 ) \
        || ( cd "$DJANGO_DIR" && docker compose restart loadbalancer >/dev/null 2>&1 ) || true
}

next_free_ip() {
    # Берём максимальный занятый 10.77.0.X из конфигов и прибавляем 1 (минимум .2).
    local used max=1 n
    used="$( { cat "$WG_DIR/wg0.conf" "$SERVERS_CONF" 2>/dev/null; } | grep -oE '10\.77\.0\.[0-9]+' | grep -oE '[0-9]+$' )"
    for n in $used; do [ "$n" -gt "$max" ] && max="$n"; done
    echo "10.77.0.$(( max + 1 ))"
}

do_init() {
    bash "$SCRIPT_DIR/wg-hub.sh" install
    echo ""
    echo "[hub] Открываю Redis/Kafka в VPN (пересоздаю redis+kafka, ~10с)…"
    ( cd "$DJANGO_DIR" && IONIK_WG_HUB_IP="$WG_HUB_IP" docker compose \
        -f docker-compose.yml -f docker-compose.cluster.yml up -d redis kafka )
    echo "[hub] Готово. Теперь пункт 2 — «Добавить ноду»."
}

do_add_node() {
    [ -s "$WG_DIR/hub.pub" ] || { echo "Сначала пункт 1 (инициализация хаба)."; return; }
    local jwt; jwt="$(sed -n 's/^IONIK_SECRET_KEY=//p' "$SECRETS" 2>/dev/null)"
    [ -n "$jwt" ] || { echo "Не нашёл IONIK_SECRET_KEY в $SECRETS — запусти start-сервер сначала."; return; }

    local node_ip; node_ip="$(next_free_ip)"
    read -rp "WG-IP для новой ноды [$node_ip]: " ans; node_ip="${ans:-$node_ip}"

    # Генерируем пару ключей ДЛЯ ноды на хабе (оба сервера под твоим контролем).
    local npriv npub
    npriv="$(wg genkey)"; npub="$(printf '%s' "$npriv" | wg pubkey)"

    # Регистрируем пира и добавляем в балансировщик.
    bash "$SCRIPT_DIR/wg-hub.sh" add-peer "$npub" "$node_ip" >/dev/null
    if ! grep -q "server $node_ip:8001" "$SERVERS_CONF" 2>/dev/null; then
        echo "server $node_ip:8001 max_fails=3 fail_timeout=10s;" >> "$SERVERS_CONF"
    fi
    lb_reload

    local token
    token="$(printf 'HUB_PUB=%s\nHUB_ENDPOINT=%s\nHUB_IP=%s\nNODE_IP=%s\nNODE_PRIVKEY=%s\nJWT_SECRET=%s\nAUTHZ_URL=%s\n' \
        "$(cat "$WG_DIR/hub.pub")" "$(pubip):$WG_PORT" "$WG_HUB_IP" "$node_ip" "$npriv" "$jwt" \
        "https://${IONIK_DOMAIN:-start-ionik.ru}:8000/api/ws/authorize/" | base64 -w0 )"

    cat <<EOF

================= НОДА $node_ip ДОБАВЛЕНА =================
Пир в VPN зарегистрирован, нода вписана в балансировщик.

На ВТОРОМ сервере (после git clone + install-deps.sh --skip-coturn) выполни ОДНУ команду:

  sudo bash scripts/linux/cluster-node-setup.sh '$token'

⚠️  Токен содержит секреты (JWT + WG-ключ) — передавай по защищённому каналу (SSH).
   Открой на хостере UDP $WG_PORT к этому серверу, иначе VPN не поднимется.
==========================================================
EOF
}

do_remove_node() {
    read -rp "WG-IP ноды для удаления (напр. 10.77.0.2): " node_ip
    [ -n "$node_ip" ] || return
    # Снять пира по AllowedIPs
    local pub
    pub="$(wg show wg0 dump 2>/dev/null | awk -v ip="$node_ip/32" '$4==ip{print $1}')"
    [ -n "$pub" ] && wg set wg0 peer "$pub" remove 2>/dev/null || true
    # Почистить wg0.conf от peer-блока с этим IP (грубо: убрать строки AllowedIPs и осиротевший Peer не трогаем — проще пересоздать)
    sed -i "\#AllowedIPs = $node_ip/32#d" "$WG_DIR/wg0.conf" 2>/dev/null || true
    # Убрать из балансировщика
    sed -i "\#server $node_ip:8001#d" "$SERVERS_CONF" 2>/dev/null || true
    lb_reload
    echo "Нода $node_ip убрана из VPN и балансировщика."
}

do_status() {
    echo "=== WireGuard ==="; wg show wg0 2>/dev/null | sed 's/^/  /' || echo "  wg0 не поднят"
    echo "=== Ноды в балансировщике ==="; grep -E '^\s*server ' "$SERVERS_CONF" 2>/dev/null | sed 's/^/  /'
    echo "=== Redis/Kafka слушают на WG? ==="; ss -ltn 2>/dev/null | grep -E "$WG_HUB_IP:(6379|9094)" | sed 's/^/  /' || echo "  (не открыты — пункт 1)"
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
