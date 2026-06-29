#!/usr/bin/env bash
#
# turn-cluster-setup.sh — управление пулом TURN-нод (балансировка ЗВОНКОВ) на
# ГЛАВНОМ сервере. Отдельно от ws-gateway-кластера. Все параметры спрашиваются.
#
#   sudo bash scripts/linux/turn-cluster-setup.sh
#
# Бэкенд (/api/turn/) раздаёт клиентам TURN-ноду round-robin из IONIK_TURN_NODES
# (хранится в /etc/ionik/secrets.env). После изменений перезапускаем Daphne.
set -euo pipefail

SECRETS=/etc/ionik/secrets.env
[ "$(id -u)" -eq 0 ] || { echo "Запусти под root (sudo)."; exit 1; }

ask() { local ans def="$3"; read -rp "$2 [${def}]: " ans; printf -v "$1" '%s' "${ans:-$def}"; }

getval() { sudo sed -n "s/^$1=//p" "$SECRETS" 2>/dev/null | head -1; }
setval() {  # setval KEY VALUE
    mkdir -p /etc/ionik; touch "$SECRETS"; chmod 640 "$SECRETS"
    if grep -q "^$1=" "$SECRETS"; then
        sed -i "s#^$1=.*#$1=$2#" "$SECRETS"
    else
        echo "$1=$2" >> "$SECRETS"
    fi
}

restart_daphne() {
    systemctl restart ionik-daphne 2>/dev/null && echo "Daphne перезапущен." \
        || echo "Не нашёл ionik-daphne.service — перезапусти Django вручную."
}

show() {
    echo "  IONIK_TURN_REALM = $(getval IONIK_TURN_REALM)"
    echo "  IONIK_TURN_NODES = $(getval IONIK_TURN_NODES)"
    echo "  секрет (use-auth-secret): $([ -n "$(getval IONIK_TURN_SECRET)" ] && echo да || echo нет, статический user/pass)"
}

do_init() {
    local realm; realm="$(getval IONIK_TURN_REALM)"; realm="${realm:-$(getval IONIK_DOMAIN)}"; realm="${realm:-start-ionik.ru}"
    ask realm "Realm/домен TURN" "$realm"
    setval IONIK_TURN_REALM "$realm"

    local sec; sec="$(getval IONIK_TURN_SECRET)"
    local use_sec; ask use_sec "Использовать общий секрет (временные креды, безопаснее)? y/n" "$([ -n "$sec" ] && echo y || echo n)"
    if [ "$use_sec" = y ]; then
        [ -n "$sec" ] || sec="$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')"
        setval IONIK_TURN_SECRET "$sec"
        echo "  Секрет: $sec   (этим же секретом ставь coturn на нодах И на главном!)"
    fi

    # Пул стартует с главной ноды (realm:3478), если пуст.
    local nodes; nodes="$(getval IONIK_TURN_NODES)"; nodes="${nodes:-$realm:3478}"
    setval IONIK_TURN_NODES "$nodes"
    restart_daphne
    echo "Пул инициализирован:"; show
    echo "⚠️ Если включил секрет — переустанови coturn и на ГЛАВНОМ с этим секретом:"
    echo "    sudo IONIK_TURN_SECRET='$sec' bash scripts/linux/turn-node-setup.sh"
}

do_add() {
    local host port realm sec
    realm="$(getval IONIK_TURN_REALM)"; sec="$(getval IONIK_TURN_SECRET)"
    ask host "Публичный адрес TURN-ноды (IP или host)" ""
    [ -n "$host" ] || { echo "Пусто."; return; }
    ask port "Порт TURN" "3478"
    local nodes; nodes="$(getval IONIK_TURN_NODES)"
    case ",$nodes," in *",$host:$port,"*) echo "Уже в пуле.";; *) nodes="${nodes:+$nodes,}$host:$port"; setval IONIK_TURN_NODES "$nodes";; esac
    restart_daphne
    cat <<EOF

Нода $host:$port добавлена в пул. Теперь на НОВОМ TURN-сервере выполни:

  git clone <repo> /root/ionik && cd /root/ionik
  sudo IONIK_TURN_REALM='$realm' \\
       ${sec:+IONIK_TURN_SECRET='$sec' }IONIK_TURN_EXTERNAL_IP='$host' \\
       bash scripts/linux/turn-node-setup.sh

Открой на хостере ноды порты: 3478/udp,3478/tcp,5349/tcp и 49152-65535/udp.
EOF
}

do_remove() {
    local host; ask host "Адрес ноды для удаления (host:port)" ""
    [ -n "$host" ] || return
    local nodes; nodes="$(getval IONIK_TURN_NODES)"
    nodes="$(echo "$nodes" | tr ',' '\n' | grep -vx "$host" | paste -sd, -)"
    setval IONIK_TURN_NODES "$nodes"
    restart_daphne
    echo "Убрано. Текущий пул: $nodes"
}

while true; do
    cat <<MENU

==== ionik TURN-кластер (звонки) ====
  1) Инициализировать пул (realm + опц. секрет)
  2) Добавить TURN-ноду
  3) Убрать TURN-ноду
  4) Показать настройки
  0) Выход
MENU
    read -rp "Выбор: " c
    case "$c" in 1) do_init;; 2) do_add;; 3) do_remove;; 4) show;; 0|"") exit 0;; *) echo "??";; esac
done
