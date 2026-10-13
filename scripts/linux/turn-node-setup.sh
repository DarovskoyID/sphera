#!/usr/bin/env bash
#
# turn-node-setup.sh — интерактивно поднимает TURN-ноду (coturn) на ОТДЕЛЬНОМ
# публичном сервере. Спрашивает все параметры (дефолты можно подтвердить Enter).
# TURN публичный, VPN ему не нужен — клиенты ходят к ноде напрямую.
#
#   sudo bash scripts/linux/turn-node-setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Запусти под root (sudo)."; exit 1; }

ask() { local ans def="$3"; read -rp "$2 [${def}]: " ans; printf -v "$1" '%s' "${ans:-$def}"; }
detect_ip() { curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}'; }

echo "--- Параметры TURN-ноды (Enter — значение в скобках) ---"
ask REALM    "Realm/домен (как на главном)"     "${SFERA_TURN_REALM:-${SFERA_DOMAIN:-}}"
ask EXT_IP   "Публичный IP этой ноды"           "${SFERA_TURN_EXTERNAL_IP:-$(detect_ip)}"
ask MINP     "Начало relay-диапазона портов"    "${SFERA_COTURN_MIN_PORT:-49152}"
ask MAXP     "Конец relay-диапазона портов"     "${SFERA_COTURN_MAX_PORT:-65535}"

SECRET="${SFERA_TURN_SECRET:-}"
ask SECRET "Общий секрет TURN (Enter — статич. user/pass)" "$SECRET"
USER_VAL=""; PASS_VAL=""
if [ -z "$SECRET" ]; then
    ask USER_VAL "TURN user (как на главном)" "${SFERA_TURN_USER:-sferauser}"
    ask PASS_VAL "TURN pass (как на главном)" "${SFERA_TURN_PASS:-sferaturn123}"
fi

echo "[turn] Ставлю coturn…"
SFERA_TURN_REALM="$REALM" \
SFERA_TURN_EXTERNAL_IP="$EXT_IP" \
SFERA_COTURN_MIN_PORT="$MINP" SFERA_COTURN_MAX_PORT="$MAXP" \
${SECRET:+SFERA_TURN_SECRET="$SECRET"} \
${USER_VAL:+SFERA_TURN_USER="$USER_VAL"} ${PASS_VAL:+SFERA_TURN_PASS="$PASS_VAL"} \
    bash "$SCRIPT_DIR/coturn-install.sh"

systemctl restart coturn 2>/dev/null || true
systemctl enable coturn 2>/dev/null || true

cat <<EOF

✅ TURN-нода поднята: $EXT_IP:3478
На ГЛАВНОМ добавь её в пул:
    sudo bash scripts/linux/turn-cluster-setup.sh   →  пункт «Добавить TURN-ноду» → $EXT_IP : 3478

⚠️ Открой на хостере этой ноды порты:
    3478/udp, 3478/tcp, 5349/tcp, $MINP-$MAXP/udp
Проверка: с любого хоста  turnutils_uclient -v -u <user> -w <pass> $EXT_IP   (или через приложение)
EOF
