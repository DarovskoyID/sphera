#!/usr/bin/env bash
#
# mail-install.sh — поднимает СВОЙ отправляющий SMTP на сервере ionik.
#
# Ставит Postfix (только исходящая почта, слушает 127.0.0.1) + OpenDKIM
# (DKIM-подпись писем). Django шлёт код подтверждения на 127.0.0.1:25 —
# наружу не торчит ничего, кроме самих писем. Скрипт идемпотентный: можно
# гонять повторно.
#
# Запуск на сервере (из /root/ionik):
#     sudo bash scripts/linux/mail-install.sh
#   проверка доставки (отправит тестовое письмо):
#     sudo bash scripts/linux/mail-install.sh you@gmail.com
#
# После установки скрипт печатает DNS-записи (SPF / DKIM / DMARC), которые
# НУЖНО добавить в зоне домена, и напоминает про PTR (rDNS) у хостера —
# без них Gmail/Mail.ru/Yandex отправят письма в спам.
#
set -euo pipefail

# ── Настройки (можно переопределить через окружение) ─────────────────────────
MAIL_DOMAIN="${MAIL_DOMAIN:-start-ionik.ru}"
MAIL_HOSTNAME="${MAIL_HOSTNAME:-mail.${MAIL_DOMAIN}}"
DKIM_SELECTOR="${DKIM_SELECTOR:-mail}"
DMARC_RUA="${DMARC_RUA:-postmaster@${MAIL_DOMAIN}}"
SERVER_IP="${SERVER_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
TEST_TO="${1:-}"

KEYDIR="/etc/opendkim/keys/${MAIL_DOMAIN}"

log()  { printf '\033[1;36m[mail]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[mail] WARN:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[mail] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запусти под root (sudo)."

# ── 1. Пакеты ────────────────────────────────────────────────────────────────
log "Устанавливаю postfix + opendkim…"
export DEBIAN_FRONTEND=noninteractive
# Преднастройка debconf, чтобы postfix не задавал интерактивных вопросов.
echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections
echo "postfix postfix/mailname string ${MAIL_DOMAIN}"          | debconf-set-selections
apt-get update -qq
apt-get install -y -qq postfix opendkim opendkim-tools >/dev/null

# ── 2. Postfix: только исходящая, слушаем loopback ───────────────────────────
log "Настраиваю Postfix (send-only, loopback-only)…"
echo "${MAIL_DOMAIN}" > /etc/mailname
postconf -e "myhostname = ${MAIL_HOSTNAME}"
postconf -e "myorigin = /etc/mailname"
postconf -e "mydestination = localhost"
postconf -e "relayhost ="
postconf -e "inet_interfaces = loopback-only"
postconf -e "inet_protocols = ipv4"
postconf -e "smtp_tls_security_level = may"
postconf -e "smtp_tls_loglevel = 1"
# Подпись DKIM через milter
postconf -e "milter_default_action = accept"
postconf -e "milter_protocol = 6"
postconf -e "smtpd_milters = inet:127.0.0.1:8891"
postconf -e "non_smtpd_milters = inet:127.0.0.1:8891"

# ── 3. OpenDKIM: ключ + конфиг ───────────────────────────────────────────────
log "Настраиваю OpenDKIM (selector=${DKIM_SELECTOR})…"
mkdir -p "$KEYDIR"
if [ ! -f "${KEYDIR}/${DKIM_SELECTOR}.private" ]; then
    log "Генерирую DKIM-ключ 2048 бит…"
    opendkim-genkey -b 2048 -d "$MAIL_DOMAIN" -D "$KEYDIR" -s "$DKIM_SELECTOR" -v
else
    log "DKIM-ключ уже существует — оставляю как есть."
fi
chown -R opendkim:opendkim /etc/opendkim
# OpenDKIM отказывается грузить ключ, если каталог доступен на запись «чужим».
chmod 750 /etc/opendkim "$(dirname "$KEYDIR")" "$KEYDIR"
chmod 600 "${KEYDIR}/${DKIM_SELECTOR}.private"

cat > /etc/opendkim.conf <<EOF
Syslog                  yes
# Без UserID демон работает под root (uid 0), а ключ принадлежит opendkim (uid 111).
# OpenDKIM тогда считает ключ «небезопасным» (key data is not secure) и режет
# письмо (milter-reject 4.7.1). Запускаем под opendkim — совпадает с владельцем ключа.
UserID                  opendkim
UMask                   002
Mode                    sv
SubDomains              no
AutoRestart             yes
AutoRestartRate         10/1h
Canonicalization        relaxed/simple
Socket                  inet:8891@127.0.0.1
PidFile                 /run/opendkim/opendkim.pid
OversignHeaders         From
Selector                ${DKIM_SELECTOR}
KeyTable                refile:/etc/opendkim/KeyTable
SigningTable            refile:/etc/opendkim/SigningTable
ExternalIgnoreList      refile:/etc/opendkim/TrustedHosts
InternalHosts           refile:/etc/opendkim/TrustedHosts
EOF

cat > /etc/opendkim/KeyTable <<EOF
${DKIM_SELECTOR}._domainkey.${MAIL_DOMAIN} ${MAIL_DOMAIN}:${DKIM_SELECTOR}:${KEYDIR}/${DKIM_SELECTOR}.private
EOF

cat > /etc/opendkim/SigningTable <<EOF
*@${MAIL_DOMAIN} ${DKIM_SELECTOR}._domainkey.${MAIL_DOMAIN}
EOF

cat > /etc/opendkim/TrustedHosts <<EOF
127.0.0.1
::1
localhost
${MAIL_HOSTNAME}
${MAIL_DOMAIN}
EOF

# На части дистрибутивов сокет берётся из /etc/default/opendkim — синхронизируем.
if [ -f /etc/default/opendkim ]; then
    sed -i '/^SOCKET=/d' /etc/default/opendkim
    echo 'SOCKET="inet:8891@127.0.0.1"' >> /etc/default/opendkim
fi
mkdir -p /run/opendkim && chown opendkim:opendkim /run/opendkim

# ── 4. Запуск ────────────────────────────────────────────────────────────────
log "Перезапускаю сервисы…"
systemctl enable --now opendkim >/dev/null 2>&1 || true
systemctl restart opendkim
systemctl enable --now postfix  >/dev/null 2>&1 || true
systemctl restart postfix

# ── 4b. Подключаем Django к локальному Postfix (systemd drop-in) ─────────────
# Drop-in переживает регенерацию ionik-daphne.service из start-common.sh,
# поэтому почта не отвалится при следующем деплое.
if systemctl list-unit-files | grep -q '^ionik-daphne.service'; then
    log "Прописываю EMAIL_* в ionik-daphne.service (drop-in) и перезапускаю Daphne…"
    mkdir -p /etc/systemd/system/ionik-daphne.service.d
    cat > /etc/systemd/system/ionik-daphne.service.d/email.conf <<EOF
[Service]
Environment=EMAIL_HOST=127.0.0.1
Environment=EMAIL_PORT=25
Environment=EMAIL_USE_TLS=false
Environment="DEFAULT_FROM_EMAIL=Ionik <no-reply@${MAIL_DOMAIN}>"
EOF
    systemctl daemon-reload
    systemctl restart ionik-daphne.service || warn "Не удалось перезапустить Daphne — сделай это вручную."
else
    warn "Юнит ionik-daphne.service не найден. Задай Django'у переменные вручную:"
    warn "  EMAIL_HOST=127.0.0.1  EMAIL_PORT=25  EMAIL_USE_TLS=false"
fi

# ── 5. Проверка исходящего 25 порта ──────────────────────────────────────────
log "Проверяю, открыт ли исходящий TCP/25 (нужен для прямой доставки)…"
if timeout 6 bash -c 'cat < /dev/null > /dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then
    log "Порт 25 наружу открыт — прямая доставка возможна."
else
    warn "Исходящий порт 25 закрыт (часто блокируется хостером)."
    warn "Без него письма НЕ уйдут. Попроси хостера открыть TCP/25 на отправку,"
    warn "или используй smarthost (тогда смысл «своего сервера» теряется)."
fi

# ── 6. Тестовое письмо (если указан адрес) ───────────────────────────────────
if [ -n "$TEST_TO" ]; then
    log "Шлю тестовое письмо на ${TEST_TO}…"
    printf 'Subject: Ionik mail test\nFrom: no-reply@%s\nTo: %s\n\nЕсли ты это читаешь — свой SMTP работает.\n' \
        "$MAIL_DOMAIN" "$TEST_TO" | sendmail -t
    log "Отправлено. Проверь Входящие/Спам. Очередь: postqueue -p ; лог: journalctl -u postfix -n 50"
fi

# ── 7. DNS-записи ────────────────────────────────────────────────────────────
# Склеиваем ТОЛЬКО содержимое кавычек (без разделителей), иначе отступы genkey
# вставят пробел в середину base64 и DKIM-ключ будет битым.
DKIM_TXT="$(grep -o '"[^"]*"' "${KEYDIR}/${DKIM_SELECTOR}.txt" | sed 's/"//g' | tr -d '\n')"

cat <<EOF

==================================================================
  ГОТОВО. Теперь добавь эти DNS-записи в зоне ${MAIL_DOMAIN}:
==================================================================

1) A — хост почтового сервера
   ${MAIL_HOSTNAME}.   A    ${SERVER_IP}

2) SPF (TXT на корне домена). Если запись TXT с v=spf1 уже есть — НЕ плоди вторую,
   добавь ip4 в существующую.
   ${MAIL_DOMAIN}.   TXT   "v=spf1 a mx ip4:${SERVER_IP} -all"

3) DKIM (TXT)
   ${DKIM_SELECTOR}._domainkey.${MAIL_DOMAIN}.   TXT   "${DKIM_TXT}"

4) DMARC (TXT)
   _dmarc.${MAIL_DOMAIN}.   TXT   "v=DMARC1; p=none; rua=mailto:${DMARC_RUA}; fo=1"

5) PTR / rDNS — ЭТО В ПАНЕЛИ ХОСТЕРА, не в DNS-зоне:
   ${SERVER_IP}  ->  ${MAIL_HOSTNAME}
   Без корректного PTR крупные почтовики режут отправку.

------------------------------------------------------------------
Проверка после применения DNS (подождать до ~часа на распространение):
   dig +short TXT ${DKIM_SELECTOR}._domainkey.${MAIL_DOMAIN}
   dig +short -x ${SERVER_IP}
   echo test | mail -s ping you@gmail.com   # и глянь заголовки: spf=pass dkim=pass
==================================================================
EOF
