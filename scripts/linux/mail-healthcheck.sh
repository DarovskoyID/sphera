#!/usr/bin/env bash
#
# mail-healthcheck.sh — проверяет, что отправка почты реально работает.
#
# Ничего не переустанавливает и по умолчанию НИЧЕГО не отправляет: смотрит,
# как Django настроен на отправку (EMAIL_* в systemd drop-in демона), и что
# SMTP на том конце отвечает. Для own-режима дополнительно проверяет, что
# Postfix/OpenDKIM подняты, а исходящий 25 не зарублен локальным guard'ом.
#
# Запуск на сервере:
#     sudo bash scripts/linux/mail-healthcheck.sh
#   с реальной отправкой тестового письма (проверка доставки до конца):
#     sudo bash scripts/linux/mail-healthcheck.sh --send you@example.com
#
# Коды выхода: 0 — всё хорошо; 1 — есть проблема (в CI шаг помечается warning'ом,
# но деплой не валится).
set -uo pipefail

DAEMON="${SFERA_DAEMON:-sfera-daphne}"
SEND_TO=""
if [ "${1:-}" = "--send" ]; then
    SEND_TO="${2:-}"
    [ -n "$SEND_TO" ] || { echo "ERROR: --send требует адрес получателя." >&2; exit 2; }
fi

ok()   { printf '\033[1;32m[ok]\033[0m   %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; PROBLEMS=$((PROBLEMS+1)); }
info() { printf '\033[1;36m[..]\033[0m   %s\n' "$*"; }
PROBLEMS=0

# ── Как Django настроен на отправку ─────────────────────────────────────────
# Грузим EMAIL_* из systemd drop-in в окружение — тогда и проверки видят
# конфиг, и реальная отправка (--send) идёт через тот же SMTP, что и демон.
DROPIN="/etc/systemd/system/${DAEMON}.service.d/email.conf"
if [ -f "$DROPIN" ]; then
    while IFS= read -r line; do
        [ "${line#Environment=}" = "$line" ] && continue
        kv="${line#Environment=}"
        kv="$(printf '%s' "$kv" | sed -E 's/^"(.*)"$/\1/')"   # снять внешние кавычки
        export "$kv" 2>/dev/null || true
    done < "$DROPIN"
fi
# Фолбэк: если drop-in недоступен, тянем из живого окружения демона.
ENV_LINE="$(systemctl show "$DAEMON" -p Environment --value 2>/dev/null)"
get() { printf '%s' "$ENV_LINE" | grep -oE "(^| )$1=[^ \"]+" | head -1 | sed "s/.*$1=//"; }
HOST="${EMAIL_HOST:-$(get EMAIL_HOST)}"
PORT="${EMAIL_PORT:-$(get EMAIL_PORT)}"
USE_SSL="${EMAIL_USE_SSL:-$(get EMAIL_USE_SSL)}"
USE_TLS="${EMAIL_USE_TLS:-$(get EMAIL_USE_TLS)}"

info "Демон: $DAEMON"
if [ -z "$HOST" ]; then
    warn "EMAIL_HOST не задан → Django в console-режиме, письма НЕ отправляются."
    echo "      Настрой почту: start-common.sh с SFERA_MAIL_MODE=own|yandex."
    echo "Итог: проблем — $PROBLEMS"
    exit 1
fi
ok "Django шлёт через ${HOST}:${PORT:-25} (SSL=${USE_SSL:-false} TLS=${USE_TLS:-false})"

[ -f "$DROPIN" ] && ok "drop-in на месте: $DROPIN" || warn "нет drop-in $DROPIN — конфиг мог не примениться."

# ── own-режим: локальный Postfix ────────────────────────────────────────────
IS_LOCAL=false
[ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ] && IS_LOCAL=true

if $IS_LOCAL; then
    systemctl is-active --quiet postfix  && ok "postfix активен"  || warn "postfix не активен (systemctl status postfix)"
    systemctl is-active --quiet opendkim && ok "opendkim активен" || warn "opendkim не активен (DKIM-подписи не будет)"

    # Локальный guard рубит исходящий 25 через reject — для own это фатально.
    if nft list table inet sfera_mail >/dev/null 2>&1; then
        warn "активна таблица sfera_mail — исходящий 25 зарублен, письма НЕ уйдут."
        echo "      Сними: systemctl disable --now sfera-smtp-guard.service; nft delete table inet sfera_mail"
    else
        ok "исходящий 25 локально не блокируется"
    fi

    # Пробуем достучаться до чужого MX — ловим блок хостера.
    if timeout 8 bash -c 'exec 3<>/dev/tcp/aspmx.l.google.com/25' 2>/dev/null; then
        ok "исходящий TCP/25 наружу открыт"
    else
        warn "исходящий TCP/25 наружу недоступен (блок хостера?) — письма зависнут в очереди."
    fi
fi

# ── SMTP на том конце отвечает баннером 220 ──────────────────────────────────
BANNER="$(timeout 8 bash -c "exec 3<>/dev/tcp/${HOST}/${PORT:-25} && head -1 <&3" 2>/dev/null)"
case "$BANNER" in
    220*) ok "SMTP-баннер получен: $(printf '%s' "$BANNER" | tr -d '\r')" ;;
    *)    warn "нет баннера 220 от ${HOST}:${PORT:-25} — SMTP не отвечает." ;;
esac

# ── PTR / rDNS (частая причина спама для own) ────────────────────────────────
if $IS_LOCAL; then
    MYHOST="$(postconf -h myhostname 2>/dev/null)"
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    PTR="$(dig +short -x "$IP" 2>/dev/null | sed 's/\.$//')"
    info "HELO/myhostname=${MYHOST:-?}  IP=${IP:-?}  PTR=${PTR:-<нет>}"
    if [ -n "$PTR" ] && [ "$PTR" = "$MYHOST" ]; then
        FWD="$(dig +short "$PTR" 2>/dev/null | tail -1)"
        [ "$FWD" = "$IP" ] && ok "FCrDNS сходится ($PTR ↔ $IP)" \
                           || warn "PTR $PTR не резолвится обратно на $IP — почтовики будут метить в спам."
    else
        warn "PTR (${PTR:-<нет>}) ≠ myhostname (${MYHOST:-?}) — настрой rDNS в панели хостера на $MYHOST."
    fi
fi

# ── Необязательная реальная отправка ────────────────────────────────────────
if [ -n "$SEND_TO" ]; then
    info "Шлю тестовое письмо на $SEND_TO через Django (тот же путь, что и коды)…"
    APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
    if ( cd "$APP_DIR/django-server/sfera_server" 2>/dev/null &&
         python manage.py sendtestemail "$SEND_TO" >/dev/null 2>&1 ); then
        ok "Django принял письмо к отправке."
    else
        warn "Django не смог отправить (см. journalctl -u $DAEMON). Пробую локальный Postfix напрямую…"
        printf 'Subject: Sfera healthcheck\nFrom: no-reply@%s\nTo: %s\n\nok\n' \
            "$(postconf -h mydomain 2>/dev/null)" "$SEND_TO" | sendmail -t 2>/dev/null || true
    fi
    sleep 2
    info "Очередь Postfix (пусто = ушло):"
    postqueue -p 2>/dev/null || true
fi

echo "-----------------------------------------------"
if [ "$PROBLEMS" -eq 0 ]; then
    ok "Почта настроена корректно."
    exit 0
else
    warn "Обнаружено проблем: $PROBLEMS — см. пометки [warn] выше."
    exit 1
fi
