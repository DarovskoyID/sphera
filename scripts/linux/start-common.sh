#!/bin/bash
set -euo pipefail

MODE="${1:-}"
if [ "$MODE" != "http" ] && [ "$MODE" != "ssl" ]; then
    echo "Usage: $0 http|ssl [--cert PATH --key PATH] [--api-port PORT] [--django-port PORT]"
    exit 1
fi
shift || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DJANGO_DIR="$PROJECT_ROOT/django-server/ionik_server"
FRONTEND_DIR="$PROJECT_ROOT"
VENV="$PROJECT_ROOT/django-server/.venv"

APP_NAME="${IONIK_APP_NAME:-ionik}"
DOMAIN="${IONIK_DOMAIN:-start-ionik.ru}"
WEB_ROOT="${IONIK_WEB_ROOT:-/var/www/ionik}"
NGINX_CONF="/etc/nginx/sites-available/$APP_NAME.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/$APP_NAME.conf"
DJANGO_BIND_HOST="${IONIK_DJANGO_BIND_HOST:-127.0.0.1}"
DJANGO_PROXY_HOST="${IONIK_DJANGO_PROXY_HOST:-127.0.0.1}"
# Внутренний порт Daphne. 8001 отдан публичному WebSocket/балансировщику,
# поэтому Daphne слушает на отдельном внутреннем порту.
DJANGO_PORT="${IONIK_DJANGO_PORT:-8010}"
API_PUBLIC_PORT="${IONIK_API_PUBLIC_PORT:-8000}"
# Публичный WebSocket-порт: этот nginx терминирует TLS и проксирует на балансировщик
WS_PUBLIC_PORT="${IONIK_WS_PUBLIC_PORT:-8001}"
# Локальный порт балансировщика нагрузки (docker, см. loadbalancer/)
LB_LOCAL_PORT="${IONIK_LB_LOCAL_PORT:-8081}"
SSL_CERT="${IONIK_SSL_CERT:-/etc/letsencrypt/live/$DOMAIN/fullchain.pem}"
SSL_KEY="${IONIK_SSL_KEY:-/etc/letsencrypt/live/$DOMAIN/privkey.pem}"
COTURN_MIN_PORT="${IONIK_COTURN_MIN_PORT:-49152}"
COTURN_MAX_PORT="${IONIK_COTURN_MAX_PORT:-65535}"
COTURN_CONF="${IONIK_COTURN_CONF:-/etc/turnserver.conf}"
PID_FILE="/tmp/ionik-daphne.pid"
KAFKA_PID_FILE="/tmp/ionik-kafka-worker.pid"
DOCKER_DIR="$PROJECT_ROOT/django-server"
# Postgres: значения совпадают с docker-compose.yml. Daphne/kafka_worker —
# host-процессы, ходят на 127.0.0.1:5432. Должен быть задан POSTGRES_DB, иначе
# Django (settings.py) откатится на sqlite.
PG_DB="${IONIK_POSTGRES_DB:-ionik}"
PG_USER="${IONIK_POSTGRES_USER:-ionik}"
PG_PASSWORD="${IONIK_POSTGRES_PASSWORD:-}"
PG_HOST="${IONIK_POSTGRES_HOST:-127.0.0.1}"
PG_PORT="${IONIK_POSTGRES_PORT:-5432}"
# Elasticsearch: поиск по сообщениям. Host-процессы ходят на 127.0.0.1:9200.
ES_URL="${IONIK_ELASTICSEARCH_URL:-http://127.0.0.1:9200}"
# Почта (отправка кодов подтверждения). Режим выбирается флагом --mail:
#   yandex (по умолчанию) — внешний релей Yandex SMTP (465). Исходящий TCP/25
#                           заблокирован файрволом (анти-спам харднинг на случай
#                           компрометации сервера).
#   own                   — свой Postfix на 127.0.0.1:25 (нужен установленный
#                           mail-install.sh). Блок 25 при этом снимается.
#   off                   — письма не шлём (console backend).
# Креды Yandex НЕ в репозитории: положи их в $PROJECT_ROOT/.mail.env (в .gitignore)
# либо передай через окружение IONIK_SMTP_USER / IONIK_SMTP_PASSWORD.
MAIL_MODE="${IONIK_MAIL_MODE:-yandex}"
# Число параллельных kafka_worker'ов (consumer-группа делит партиции между ними).
# Один воркер упирался ~190 сообщ/с в PG; N≈числу ядер кратно поднимает потолок.
WORKERS="${IONIK_WORKERS:-2}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --cert|-c)
            if [ -z "${2:-}" ]; then
                echo "ERROR: $1 requires a certificate path."
                exit 1
            fi
            SSL_CERT="$2"
            shift 2
            ;;
        --key|-k)
            if [ -z "${2:-}" ]; then
                echo "ERROR: $1 requires a private key path."
                exit 1
            fi
            SSL_KEY="$2"
            shift 2
            ;;
        --api-port)
            if [ -z "${2:-}" ]; then
                echo "ERROR: $1 requires a public API port."
                exit 1
            fi
            API_PUBLIC_PORT="$2"
            shift 2
            ;;
        --django-port)
            if [ -z "${2:-}" ]; then
                echo "ERROR: $1 requires an internal Django port."
                exit 1
            fi
            DJANGO_PORT="$2"
            shift 2
            ;;
        --django-bind)
            if [ -z "${2:-}" ]; then
                echo "ERROR: $1 requires a bind host."
                exit 1
            fi
            DJANGO_BIND_HOST="$2"
            shift 2
            ;;
        --mail)
            if [ -z "${2:-}" ]; then
                echo "ERROR: --mail requires a mode: yandex | own | off."
                exit 1
            fi
            MAIL_MODE="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 http|ssl [--cert PATH --key PATH] [--api-port PORT] [--django-port PORT]"
            echo ""
            echo "SSL options:"
            echo "  --cert, -c PATH   Path to fullchain/certificate PEM file"
            echo "  --key,  -k PATH   Path to private key PEM file"
            echo ""
            echo "API options:"
            echo "  --api-port PORT      Public nginx API port (default: 8000)"
            echo "  --django-port PORT   Internal Daphne port (default: 8010)"
            echo "  --django-bind HOST   Internal Daphne bind host (default: 127.0.0.1)"
            echo ""
            echo "Mail options:"
            echo "  --mail MODE   Email sending mode (default: yandex):"
            echo "                  yandex — Yandex SMTP relay (465); outbound :25 firewalled"
            echo "                  own    — local Postfix (needs mail-install.sh); opens :25"
            echo "                  off    — no email (console backend)"
            echo "                Yandex creds: \$PROJECT_ROOT/.mail.env or IONIK_SMTP_USER/PASSWORD env"
            echo ""
            echo "WebSocket / load balancer:"
            echo "  IONIK_WS_PUBLIC_PORT  Public WS port proxied to the load balancer (default: 8001)"
            echo "  IONIK_LB_LOCAL_PORT   Local load balancer port from docker (default: 8081)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage."
            exit 1
            ;;
    esac
done

log() {
    echo ""
    echo "==> $1"
}

require_command() {
    local command_name="$1"
    local install_hint="$2"

    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "ERROR: '$command_name' not found."
        echo "$install_hint"
        exit 1
    fi
}

write_nginx_config() {
    local tmp_conf
    tmp_conf="$(mktemp)"

    if [ "$MODE" = "ssl" ]; then
        if [ ! -f "$SSL_CERT" ] || [ ! -f "$SSL_KEY" ]; then
            echo "ERROR: SSL certificate files not found."
            echo "Expected cert: $SSL_CERT"
            echo "Expected key : $SSL_KEY"
            echo "Pass --cert and --key, or set IONIK_SSL_CERT and IONIK_SSL_KEY."
            exit 1
        fi

        cat > "$tmp_conf" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    root $WEB_ROOT;
    index index.html;

    ssl_certificate $SSL_CERT;
    ssl_certificate_key $SSL_KEY;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 100m;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /media/ {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # WebSocket идёт через балансировщик нагрузки (loadbalancer/ -> ws-gateway)
    location /ws/ {
        proxy_pass http://127.0.0.1:$LB_LOCAL_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 86400;
    }

    location /status- {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /metrics/ {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /grafana/ {
        proxy_pass http://127.0.0.1:3000/grafana/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /grafana/api/live/ {
        proxy_pass http://127.0.0.1:3000/grafana/api/live/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
    }
}

server {
    listen $API_PUBLIC_PORT ssl http2;
    listen [::]:$API_PUBLIC_PORT ssl http2;
    server_name $DOMAIN;

    ssl_certificate $SSL_CERT;
    ssl_certificate_key $SSL_KEY;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 100m;

    location / {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 86400;
    }
}

# Публичный WebSocket-порт -> балансировщик нагрузки -> ноды ws-gateway
server {
    listen $WS_PUBLIC_PORT ssl http2;
    listen [::]:$WS_PUBLIC_PORT ssl http2;
    server_name $DOMAIN;

    ssl_certificate $SSL_CERT;
    ssl_certificate_key $SSL_KEY;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    # presence/signaling/voice обслуживает Django (Daphne), а не Rust ws-gateway
    location ~ ^/ws/(signaling/|guild/[0-9a-fA-F-]+/(voice/[0-9a-fA-F-]+/)?\$) {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 86400;
    }

    # chat + guild-channel -> балансировщик -> ноды ws-gateway
    location / {
        proxy_pass http://127.0.0.1:$LB_LOCAL_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 86400;
    }
}
EOF
    else
        cat > "$tmp_conf" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name _;

    root $WEB_ROOT;
    index index.html;

    client_max_body_size 100m;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto http;
    }

    location /media/ {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto http;
    }

    # WebSocket идёт через балансировщик нагрузки (loadbalancer/ -> ws-gateway)
    location /ws/ {
        proxy_pass http://127.0.0.1:$LB_LOCAL_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto http;
        proxy_read_timeout 86400;
    }

    location /status- {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location /metrics/ {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location /grafana/ {
        proxy_pass http://127.0.0.1:3000/grafana/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location /grafana/api/live/ {
        proxy_pass http://127.0.0.1:3000/grafana/api/live/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
    }
}

server {
    listen $API_PUBLIC_PORT;
    listen [::]:$API_PUBLIC_PORT;
    server_name _;

    client_max_body_size 100m;

    location / {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto http;
        proxy_read_timeout 86400;
    }
}

# Публичный WebSocket-порт -> балансировщик нагрузки -> ноды ws-gateway
server {
    listen $WS_PUBLIC_PORT;
    listen [::]:$WS_PUBLIC_PORT;
    server_name _;

    # presence/signaling/voice обслуживает Django (Daphne), а не Rust ws-gateway
    location ~ ^/ws/(signaling/|guild/[0-9a-fA-F-]+/(voice/[0-9a-fA-F-]+/)?\$) {
        proxy_pass http://$DJANGO_PROXY_HOST:$DJANGO_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto http;
        proxy_read_timeout 86400;
    }

    # chat + guild-channel -> балансировщик -> ноды ws-gateway
    location / {
        proxy_pass http://127.0.0.1:$LB_LOCAL_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto http;
        proxy_read_timeout 86400;
    }
}
EOF
    fi

    sudo install -m 0644 "$tmp_conf" "$NGINX_CONF"
    rm -f "$tmp_conf"
    sudo ln -sfn "$NGINX_CONF" "$NGINX_ENABLED"
}

configure_coturn_ports() {
    if [ ! -f "$COTURN_CONF" ]; then
        echo "      WARNING: $COTURN_CONF not found. Run scripts/linux/coturn-install.sh first."
        return
    fi

    sudo sed -i -E \
        -e "/^min-port=/d" \
        -e "/^max-port=/d" \
        "$COTURN_CONF"
    printf "\nmin-port=%s\nmax-port=%s\n" "$COTURN_MIN_PORT" "$COTURN_MAX_PORT" \
        | sudo tee -a "$COTURN_CONF" >/dev/null
}

start_coturn() {
    log "Starting coturn with relay ports $COTURN_MIN_PORT-$COTURN_MAX_PORT"
    configure_coturn_ports
    sudo systemctl restart coturn
    echo "      coturn restarted."
}

SMTP_GUARD_NFT="/etc/ionik/smtp-guard.nft"
SMTP_GUARD_UNIT="ionik-smtp-guard.service"
EMAIL_DROPIN="/etc/systemd/system/ionik-daphne.service.d/email.conf"

# Изолированная nft-таблица, режущая исходящий TCP/25 (IPv4+IPv6) с хоста —
# чтобы взломанный сервер нельзя было использовать как спам-релей. Не трогает
# Docker (FORWARD). systemd-юнит переживает перезагрузку.
_write_smtp_guard_files() {
    sudo mkdir -p /etc/ionik
    sudo tee "$SMTP_GUARD_NFT" >/dev/null <<'NFT'
#!/usr/sbin/nft -f
table inet ionik_mail
delete table inet ionik_mail
table inet ionik_mail {
    chain output {
        type filter hook output priority 0; policy accept;
        tcp dport 25 counter reject with tcp reset
    }
}
NFT
    sudo tee "/etc/systemd/system/$SMTP_GUARD_UNIT" >/dev/null <<UNIT
[Unit]
Description=ionik: block outbound SMTP/25 (anti-spam hardening)
After=network-pre.target
Before=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $SMTP_GUARD_NFT
ExecStop=/usr/sbin/nft delete table inet ionik_mail

[Install]
WantedBy=multi-user.target
UNIT
    sudo systemctl daemon-reload
}

block_smtp_out() {
    _write_smtp_guard_files
    sudo systemctl enable --now "$SMTP_GUARD_UNIT" >/dev/null 2>&1 \
        || sudo systemctl restart "$SMTP_GUARD_UNIT"
    echo "      outbound TCP/25 blocked (anti-spam guard active)."
}

unblock_smtp_out() {
    if systemctl list-unit-files 2>/dev/null | grep -q "^$SMTP_GUARD_UNIT"; then
        sudo systemctl disable --now "$SMTP_GUARD_UNIT" >/dev/null 2>&1 || true
    fi
    sudo nft delete table inet ionik_mail 2>/dev/null || true
    echo "      outbound TCP/25 allowed (own server can deliver direct-to-MX)."
}

# Пишет drop-in с EMAIL_* (контент со stdin). Права 600 — внутри пароль SMTP.
_write_email_dropin() {
    sudo mkdir -p /etc/systemd/system/ionik-daphne.service.d
    sudo tee "$EMAIL_DROPIN" >/dev/null
    sudo chmod 600 "$EMAIL_DROPIN"
}

start_mail() {
    # Креды Yandex — из необязательного gitignore-файла .mail.env (или окружения).
    if [ -f "$PROJECT_ROOT/.mail.env" ]; then
        set -a; . "$PROJECT_ROOT/.mail.env"; set +a
    fi
    local SMTP_HOST="${IONIK_SMTP_HOST:-smtp.yandex.ru}"
    local SMTP_PORT="${IONIK_SMTP_PORT:-465}"
    local SMTP_SSL="${IONIK_SMTP_SSL:-true}"
    local SMTP_USER="${IONIK_SMTP_USER:-}"
    local SMTP_PASS="${IONIK_SMTP_PASSWORD:-}"
    local SMTP_FROM="${IONIK_SMTP_FROM:-$SMTP_USER}"
    local USE_TLS; USE_TLS=$([ "$SMTP_SSL" = "true" ] && echo false || echo true)

    case "$MAIL_MODE" in
        yandex)
            log "Mail mode: Yandex SMTP relay ($SMTP_HOST:$SMTP_PORT, SSL=$SMTP_SSL)"
            sudo systemctl stop postfix opendkim 2>/dev/null || true
            block_smtp_out
            if [ -z "$SMTP_USER" ] || [ -z "$SMTP_PASS" ]; then
                echo "      ВНИМАНИЕ: нет кред Yandex — письма отправляться НЕ будут."
                echo "      Заполни $PROJECT_ROOT/.mail.env (см. .mail.env.example):"
                echo "        IONIK_SMTP_USER=you@yandex.ru"
                echo "        IONIK_SMTP_PASSWORD=<пароль приложения Яндекс>"
            fi
            _write_email_dropin <<EOF
[Service]
Environment=EMAIL_HOST=$SMTP_HOST
Environment=EMAIL_PORT=$SMTP_PORT
Environment=EMAIL_USE_SSL=$SMTP_SSL
Environment=EMAIL_USE_TLS=$USE_TLS
Environment=EMAIL_HOST_USER=$SMTP_USER
Environment="EMAIL_HOST_PASSWORD=$SMTP_PASS"
Environment="DEFAULT_FROM_EMAIL=$SMTP_FROM"
EOF
            echo "      Daphne wired to Yandex SMTP via email.conf drop-in."
            ;;
        own)
            log "Mail mode: own Postfix server (127.0.0.1:25)"
            unblock_smtp_out
            if ! command -v postfix >/dev/null 2>&1; then
                echo "      ВНИМАНИЕ: Postfix не установлен — codes won't be emailed."
                echo "      Поставь: scripts/linux/mail-install.sh (или install-deps.sh --with-mail)."
            else
                sudo systemctl enable --now opendkim postfix >/dev/null 2>&1 || true
                sudo systemctl restart opendkim postfix 2>/dev/null || true
                echo "      Postfix + OpenDKIM up."
            fi
            _write_email_dropin <<EOF
[Service]
Environment=EMAIL_HOST=127.0.0.1
Environment=EMAIL_PORT=25
Environment=EMAIL_USE_TLS=false
Environment="DEFAULT_FROM_EMAIL=Ionik <no-reply@${DOMAIN}>"
EOF
            ;;
        off|none)
            log "Mail mode: off (console backend — письма не отправляются)"
            sudo systemctl stop postfix opendkim 2>/dev/null || true
            block_smtp_out
            sudo rm -f "$EMAIL_DROPIN"
            ;;
        *)
            echo "ERROR: неизвестный режим --mail '$MAIL_MODE' (yandex|own|off)."
            exit 1
            ;;
    esac
}

ensure_swap() {
    # На маленьких серверах (напр. 2 ГБ) без swap любой всплеск памяти приводит
    # к срабатыванию OOM-killer'а, который убивает крупные процессы (Kafka/java),
    # а Daphne при этом может зависнуть. Включаем swap-файл, если его ещё нет.
    # 6G по умолчанию: стек теперь включает Postgres + Elasticsearch (JVM heap 512MB),
    # на 2 ГБ RAM им нужен запас свопа.
    local swap_size="${IONIK_SWAP_SIZE:-6G}"
    local swap_file="${IONIK_SWAP_FILE:-/swapfile}"

    if [ "$(swapon --show --noheadings 2>/dev/null | wc -l)" -gt 0 ]; then
        echo "      swap already active:"
        swapon --show 2>/dev/null | sed 's/^/        /'
        return
    fi

    log "No swap detected — creating $swap_size swap at $swap_file"
    if ! sudo fallocate -l "$swap_size" "$swap_file" 2>/dev/null; then
        # fallocate может не поддерживаться ФС — fallback на dd
        local mb; mb="$(numfmt --from=iec "$swap_size" 2>/dev/null)"; mb=$(( ${mb:-4294967296} / 1048576 ))
        sudo dd if=/dev/zero of="$swap_file" bs=1M count="$mb" status=none
    fi
    sudo chmod 600 "$swap_file"
    sudo mkswap "$swap_file" >/dev/null
    sudo swapon "$swap_file"
    if ! grep -q "^$swap_file " /etc/fstab 2>/dev/null; then
        echo "$swap_file none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
    fi
    # Снижаем агрессивность вытеснения: swap как страховка, не как основной носитель
    sudo sysctl -w vm.swappiness=10 >/dev/null 2>&1 || true
    if ! grep -q '^vm.swappiness' /etc/sysctl.conf 2>/dev/null; then
        echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
    fi
    echo "      swap enabled ($swap_size)."
}

ensure_secrets_file() {
    # Секреты Django живут вне репозитория и кода: генерируются один раз и
    # переживают передеплой. SECRET_KEY и STATUS_TOKEN можно безопасно
    # ротировать (максимум — разовый релогин пользователей). Новые установки
    # получают свежий ключ шифрования сообщений; существующие базы ротируются
    # через manage.py rotate_message_encryption с прежним ключом в OLD_KEYS.
    local secrets="/etc/ionik/secrets.env"
    sudo install -d -m 0750 /etc/ionik
    if [ ! -f "$secrets" ]; then
        local sk st mk gp pgp
        sk="$(head -c 50 /dev/urandom | base64 | tr -d '\n')"
        st="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')"
        mk="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '\n')"
        gp="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')"
        pgp="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')"
        sudo tee "$secrets" >/dev/null <<EOF
# Сгенерировано автоматически $(date -u +%FT%TZ). НЕ коммитить.
IONIK_SECRET_KEY=$sk
IONIK_STATUS_TOKEN=$st
# Ключ шифрования сообщений. Для существующей БД добавьте прежний ключ в
# IONIK_OLD_MESSAGE_ENCRYPTION_KEYS, запустите rotate_message_encryption,
# затем удалите старый ключ из OLD_KEYS.
IONIK_MESSAGE_ENCRYPTION_KEY=$mk
IONIK_OLD_MESSAGE_ENCRYPTION_KEYS=
IONIK_ACCESS_TOKEN_MINUTES=15
GRAFANA_PASSWORD=$gp
IONIK_POSTGRES_PASSWORD=$pgp
EOF
        sudo chmod 0640 "$secrets"
        log "Сгенерированы секреты Django → $secrets (STATUS_TOKEN=$st)"
    fi
    if ! sudo grep -q '^GRAFANA_PASSWORD=' "$secrets"; then
        local gp
        gp="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')"
        echo "GRAFANA_PASSWORD=$gp" | sudo tee -a "$secrets" >/dev/null
    fi
    if ! sudo grep -q '^IONIK_POSTGRES_PASSWORD=' "$secrets"; then
        local pgp
        pgp="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')"
        echo "IONIK_POSTGRES_PASSWORD=$pgp" | sudo tee -a "$secrets" >/dev/null
    fi
    if [ -z "${IONIK_POSTGRES_PASSWORD:-}" ]; then
        IONIK_POSTGRES_PASSWORD="$(sudo awk -F= '$1=="IONIK_POSTGRES_PASSWORD"{print $2; exit}' "$secrets")"
    fi
    PG_PASSWORD="$IONIK_POSTGRES_PASSWORD"
}

install_daphne_service() {
    ensure_secrets_file
    # systemd-юнит вместо голого nohup: автоперезапуск при падении +
    # health-check таймер, который перезапускает Daphne, если он завис
    # (процесс жив, но не отвечает — именно так он «упал» в инциденте).
    sudo install -d -m 0755 /var/log/ionik

    local healthcheck="/usr/local/bin/ionik-daphne-healthcheck.sh"
    sudo tee "$healthcheck" >/dev/null <<EOF
#!/bin/bash
# Перезапускает Daphne, если он не отвечает (зависание event-loop).
url="http://$DJANGO_PROXY_HOST:$DJANGO_PORT/metrics/"
if ! curl -fsS --max-time 8 -o /dev/null "\$url"; then
    sleep 5
    if ! curl -fsS --max-time 8 -o /dev/null "\$url"; then
        logger -t ionik-daphne-healthcheck "Daphne unresponsive on $DJANGO_PORT — restarting"
        systemctl restart ionik-daphne.service
    fi
fi
EOF
    sudo chmod 0755 "$healthcheck"

    sudo tee /etc/systemd/system/ionik-daphne.service >/dev/null <<EOF
[Unit]
Description=ionik Daphne (Django ASGI)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DJANGO_DIR
# Секреты (SECRET_KEY, STATUS_TOKEN, ключ шифрования) — из защищённого файла.
EnvironmentFile=-/etc/ionik/secrets.env
# Прод: DEBUG выключен, Host/Origin ограничены доменом, HTTPS-редирект включён.
Environment=IONIK_DEBUG=0
Environment=IONIK_DOMAIN=$DOMAIN
Environment=IONIK_ALLOWED_HOSTS=$DOMAIN
Environment=KAFKA_ENABLED=true
Environment=POSTGRES_DB=$PG_DB
Environment=POSTGRES_USER=$PG_USER
Environment=POSTGRES_PASSWORD=$PG_PASSWORD
Environment=POSTGRES_HOST=$PG_HOST
Environment=POSTGRES_PORT=$PG_PORT
Environment=ELASTICSEARCH_URL=$ES_URL
ExecStartPre=$VENV/bin/python manage.py migrate --run-syncdb --noinput
ExecStart=$VENV/bin/daphne -b $DJANGO_BIND_HOST -p $DJANGO_PORT ionik_server.asgi:application
Restart=always
RestartSec=3
# Защищаем Daphne от OOM-killer'а: пусть жертвой станет Kafka (восстановим из топика)
OOMScoreAdjust=-500
StandardOutput=append:/var/log/ionik/daphne.log
StandardError=append:/var/log/ionik/daphne.log

[Install]
WantedBy=multi-user.target
EOF

    sudo tee /etc/systemd/system/ionik-daphne-healthcheck.service >/dev/null <<EOF
[Unit]
Description=ionik Daphne healthcheck
After=ionik-daphne.service

[Service]
Type=oneshot
ExecStart=$healthcheck
EOF

    sudo tee /etc/systemd/system/ionik-daphne-healthcheck.timer >/dev/null <<EOF
[Unit]
Description=ionik Daphne healthcheck (every minute)

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
}

start_django() {
    log "Starting Django/Daphne on $DJANGO_BIND_HOST:$DJANGO_PORT (systemd, auto-restart)"

    # systemd-юнит запускает daphne по полному пути из venv ($VENV/bin/daphne),
    # поэтому активировать окружение и искать daphne в PATH не нужно — проверяем
    # сам бинарь в venv.
    if [ ! -x "$VENV/bin/daphne" ]; then
        echo "ERROR: daphne не найден в $VENV/bin/daphne"
        echo "Установите зависимости: pip install -r django-server/requirements.txt"
        echo "или запустите scripts/install-deps.sh."
        exit 1
    fi

    # Старый голый процесс (nohup) больше не нужен — гасим, если остался
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        sleep 1
        rm -f "$PID_FILE"
    fi

    install_daphne_service
    sudo systemctl daemon-reload
    sudo systemctl enable --now ionik-daphne.service
    sudo systemctl restart ionik-daphne.service
    sudo systemctl enable --now ionik-daphne-healthcheck.timer
    echo "      Daphne under systemd: ionik-daphne.service (log: /var/log/ionik/daphne.log)"
    echo "      Hang watchdog: ionik-daphne-healthcheck.timer (every 1 min)"
}

build_frontend() {
    log "Building frontend"
    cd "$FRONTEND_DIR"
    npm run build

    sudo install -d -m 0755 "$WEB_ROOT"
    sudo find "$WEB_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    sudo cp -a "$FRONTEND_DIR/dist/." "$WEB_ROOT/"
    echo "      Frontend deployed to $WEB_ROOT"
}

start_nginx() {
    log "Configuring nginx"
    write_nginx_config
    sudo rm -f /etc/nginx/sites-enabled/default
    sudo nginx -t
    sudo systemctl reload nginx 2>/dev/null || sudo systemctl restart nginx
    echo "      nginx is serving from $WEB_ROOT"
}

start_docker() {
    log "Starting Docker services (Redis, Kafka, ws-gateway, load balancer)"
    if command -v docker >/dev/null 2>&1; then
        ensure_secrets_file
        cd "$DOCKER_DIR"
        local jwt_secret grafana_password pg_password
        jwt_secret="$(sudo awk -F= '$1=="IONIK_SECRET_KEY"{print $2; exit}' /etc/ionik/secrets.env)"
        grafana_password="$(sudo awk -F= '$1=="GRAFANA_PASSWORD"{print $2; exit}' /etc/ionik/secrets.env)"
        pg_password="$(sudo awk -F= '$1=="IONIK_POSTGRES_PASSWORD"{print $2; exit}' /etc/ionik/secrets.env)"
        POSTGRES_PASSWORD="$pg_password" \
        GRAFANA_PASSWORD="$grafana_password" \
        JWT_SECRET="$jwt_secret" \
        docker compose up -d --build \
            postgres elasticsearch redis kafka zookeeper kafka-init prometheus grafana alertmanager \
            ws-gateway loadbalancer
        echo "      Postgres, Elasticsearch, Redis, Kafka, ws-gateway, load balancer, alertmanager started."
        echo "      Load balancer: 127.0.0.1:$LB_LOCAL_PORT (edit ../loadbalancer/servers.conf to add nodes)."
    else
        echo "      WARNING: Docker not found. Messages may be lost under high load."
    fi
}

start_kafka_worker() {
    log "Starting Kafka worker (systemd, auto-restart)"
    if ! command -v docker >/dev/null 2>&1; then
        echo "      Skipped (no Docker/Kafka)."
        return
    fi

    # Гасим старый голый процесс, если остался от прежней версии скрипта
    if [ -f "$KAFKA_PID_FILE" ] && kill -0 "$(cat "$KAFKA_PID_FILE")" 2>/dev/null; then
        kill "$(cat "$KAFKA_PID_FILE")" 2>/dev/null || true
        sleep 1
        rm -f "$KAFKA_PID_FILE"
    fi

    sudo install -d -m 0755 /var/log/ionik
    ensure_secrets_file

    # Шаблонный юнит: N процессов воркера в ОДНОЙ consumer-группе Kafka. Брокер
    # раскидывает партиции между ними → параллельная запись в PG (потолок одного
    # воркера был ~190 сообщ/с). %i — номер инстанса.
    sudo tee /etc/systemd/system/ionik-kafka-worker@.service >/dev/null <<EOF
[Unit]
Description=ionik Kafka worker #%i (Django)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DJANGO_DIR
# Секреты (SECRET_KEY, STATUS_TOKEN, ключ шифрования) — из защищённого файла.
EnvironmentFile=-/etc/ionik/secrets.env
# Прод: DEBUG выключен, Host/Origin ограничены доменом, HTTPS-редирект включён.
Environment=IONIK_DEBUG=0
Environment=IONIK_DOMAIN=$DOMAIN
Environment=IONIK_ALLOWED_HOSTS=$DOMAIN
Environment=KAFKA_ENABLED=true
Environment=POSTGRES_DB=$PG_DB
Environment=POSTGRES_USER=$PG_USER
Environment=POSTGRES_PASSWORD=$PG_PASSWORD
Environment=POSTGRES_HOST=$PG_HOST
Environment=POSTGRES_PORT=$PG_PORT
Environment=ELASTICSEARCH_URL=$ES_URL
ExecStart=$VENV/bin/python manage.py kafka_worker
Restart=always
RestartSec=5
StandardOutput=append:/var/log/ionik/kafka-worker.log
StandardError=append:/var/log/ionik/kafka-worker.log

[Install]
WantedBy=multi-user.target
EOF

    # Убираем старый ОДИНОЧНЫЙ (не шаблонный) сервис, чтобы не было двойного потребления
    sudo systemctl disable --now ionik-kafka-worker.service 2>/dev/null || true
    sudo rm -f /etc/systemd/system/ionik-kafka-worker.service
    sudo rm -rf /etc/systemd/system/ionik-kafka-worker.service.d
    sudo systemctl daemon-reload

    # Гасим инстансы свыше N (если раньше запускали больше)
    for u in $(systemctl list-units --all --no-legend 'ionik-kafka-worker@*.service' 2>/dev/null | awk '{print $1}'); do
        idx="${u##*@}"; idx="${idx%.service}"
        if [ -n "$idx" ] && [ "$idx" -gt "$WORKERS" ] 2>/dev/null; then
            sudo systemctl disable --now "$u" 2>/dev/null || true
        fi
    done

    local i
    for i in $(seq 1 "$WORKERS"); do
        sudo systemctl enable --now "ionik-kafka-worker@$i.service"
        sudo systemctl restart "ionik-kafka-worker@$i.service"
    done
    echo "      Kafka workers under systemd: $WORKERS × ionik-kafka-worker@N (log: /var/log/ionik/kafka-worker.log)"
}

write_loadtest_env() {
    # Нагрузочная команда (seed_load через load-tests/run.sh) ДОЛЖНА работать с той
    # же БД/поиском, что и сервер. Пишем loadtest.env с PG/ES — иначе команда уйдёт
    # в sqlite (другая БД → "no such table"/логин 0/N). Файл в .gitignore.
    local f="$PROJECT_ROOT/load-tests/loadtest.env"
    cat > "$f" <<EOF
POSTGRES_DB=$PG_DB
POSTGRES_USER=$PG_USER
POSTGRES_PASSWORD=$PG_PASSWORD
POSTGRES_HOST=$PG_HOST
POSTGRES_PORT=$PG_PORT
ELASTICSEARCH_URL=$ES_URL
EOF
    echo "      loadtest.env написан → нагрузочные тесты пойдут в Postgres/Elasticsearch."
}

echo "=== Starting ionik on Linux ($MODE) ==="
echo "Project root: $PROJECT_ROOT"

require_command npm "Install Node.js/npm first, or run scripts/install-deps.sh."
require_command nginx "Install nginx first, or run scripts/install-deps.sh."

ensure_swap
start_docker
start_coturn
start_mail
start_django
start_kafka_worker
write_loadtest_env
build_frontend
start_nginx

echo ""
echo "=== All services started ==="
echo "  Docker      : Redis :6379, Kafka :9092, Prometheus :9090, Grafana :3000"
echo "  TURN server : 3478, 5349, relay UDP/TCP $COTURN_MIN_PORT-$COTURN_MAX_PORT"
echo "  Django API  : http://$DJANGO_BIND_HOST:$DJANGO_PORT internal, public port $API_PUBLIC_PORT"
echo "  WebSocket   : public port $WS_PUBLIC_PORT -> load balancer 127.0.0.1:$LB_LOCAL_PORT -> ws-gateway nodes"
echo "  Load bal.   : nodes in loadbalancer/servers.conf (reload: docker compose exec loadbalancer nginx -s reload)"
echo "  Kafka worker: processing messages"
echo "  Mail        : mode=$MAIL_MODE ($([ "$MAIL_MODE" = own ] && echo 'own Postfix, :25 open' || echo 'outbound :25 firewalled'))"
if [ "$MODE" = "ssl" ]; then
    echo "  Frontend    : https://$DOMAIN"
    echo "  Status      : https://$DOMAIN:$API_PUBLIC_PORT/status-$(date +%Y-%m-%d)/"
    echo "  Grafana     : https://$DOMAIN/grafana/"
else
    echo "  Frontend    : http://<server-ip>/"
    echo "  Status      : http://<server-ip>:$API_PUBLIC_PORT/status-$(date +%Y-%m-%d)/"
    echo "  Grafana     : http://<server-ip>/grafana/"
fi
echo ""
echo "Logs:"
echo "  Daphne       : /var/log/ionik/daphne.log   (status: systemctl status ionik-daphne)"
echo "  Kafka worker : /var/log/ionik/kafka-worker.log (status: systemctl status ionik-kafka-worker)"
echo "  Daphne watchdog: journalctl -t ionik-daphne-healthcheck"
echo "  nginx        : journalctl -u nginx"
echo "  coturn       : journalctl -u coturn"
if command -v postfix >/dev/null 2>&1; then
    echo "  mail (SMTP)  : journalctl -u postfix / journalctl -u opendkim ; queue: postqueue -p"
fi
echo ""
echo "Stop:     scripts/linux/stop.sh       (обычная остановка, контейнеры остаются)"
echo "Stop all: scripts/linux/stop-all.sh   (полный снос: +почта, docker down, зачистка)"
