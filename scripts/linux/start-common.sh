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
DJANGO_PORT="${IONIK_DJANGO_PORT:-8001}"
API_PUBLIC_PORT="${IONIK_API_PUBLIC_PORT:-8000}"
SSL_CERT="${IONIK_SSL_CERT:-/etc/letsencrypt/live/$DOMAIN/fullchain.pem}"
SSL_KEY="${IONIK_SSL_KEY:-/etc/letsencrypt/live/$DOMAIN/privkey.pem}"
COTURN_MIN_PORT="${IONIK_COTURN_MIN_PORT:-49152}"
COTURN_MAX_PORT="${IONIK_COTURN_MAX_PORT:-65535}"
COTURN_CONF="${IONIK_COTURN_CONF:-/etc/turnserver.conf}"
PID_FILE="/tmp/ionik-daphne.pid"
KAFKA_PID_FILE="/tmp/ionik-kafka-worker.pid"
DOCKER_DIR="$PROJECT_ROOT/django-server"

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
        --help|-h)
            echo "Usage: $0 http|ssl [--cert PATH --key PATH] [--api-port PORT] [--django-port PORT]"
            echo ""
            echo "SSL options:"
            echo "  --cert, -c PATH   Path to fullchain/certificate PEM file"
            echo "  --key,  -k PATH   Path to private key PEM file"
            echo ""
            echo "API options:"
            echo "  --api-port PORT      Public nginx API port (default: 8000)"
            echo "  --django-port PORT   Internal Daphne port (default: 8001)"
            echo "  --django-bind HOST   Internal Daphne bind host (default: 127.0.0.1)"
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

    location /ws/ {
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

    location /ws/ {
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

start_django() {
    log "Starting Django/Daphne on $DJANGO_BIND_HOST:$DJANGO_PORT"

    if [ -d "$VENV" ]; then
        # shellcheck disable=SC1091
        source "$VENV/bin/activate"
    else
        echo "      WARNING: no .venv found at $VENV - using system Python."
    fi

    require_command daphne "Install Python dependencies first, or run scripts/install-deps.sh."

    cd "$DJANGO_DIR"
    python manage.py migrate --run-syncdb 2>/dev/null || true

    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        sleep 1
    fi

    nohup daphne -b "$DJANGO_BIND_HOST" -p "$DJANGO_PORT" ionik_server.asgi:application \
        > /tmp/ionik-daphne.log 2>&1 &
    echo "$!" > "$PID_FILE"
    echo "      Daphne PID: $(cat "$PID_FILE")  (log: /tmp/ionik-daphne.log)"
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
    log "Starting Docker services (Redis, Kafka)"
    if command -v docker >/dev/null 2>&1; then
        cd "$DOCKER_DIR"
        docker compose up -d redis kafka zookeeper kafka-init
        echo "      Redis and Kafka started."
    else
        echo "      WARNING: Docker not found. Messages may be lost under high load."
    fi
}

start_kafka_worker() {
    log "Starting Kafka worker"
    if ! command -v docker >/dev/null 2>&1; then
        echo "      Skipped (no Docker/Kafka)."
        return
    fi

    if [ -d "$VENV" ]; then
        # shellcheck disable=SC1091
        source "$VENV/bin/activate"
    fi

    if [ -f "$KAFKA_PID_FILE" ] && kill -0 "$(cat "$KAFKA_PID_FILE")" 2>/dev/null; then
        kill "$(cat "$KAFKA_PID_FILE")" 2>/dev/null || true
        sleep 1
    fi

    cd "$DJANGO_DIR"
    KAFKA_ENABLED=true nohup python manage.py kafka_worker \
        > /tmp/ionik-kafka-worker.log 2>&1 &
    echo "$!" > "$KAFKA_PID_FILE"
    echo "      Kafka worker PID: $(cat "$KAFKA_PID_FILE")  (log: /tmp/ionik-kafka-worker.log)"
}

echo "=== Starting ionik on Linux ($MODE) ==="
echo "Project root: $PROJECT_ROOT"

require_command npm "Install Node.js/npm first, or run scripts/install-deps.sh."
require_command nginx "Install nginx first, or run scripts/install-deps.sh."

start_docker
start_coturn
start_django
start_kafka_worker
build_frontend
start_nginx

echo ""
echo "=== All services started ==="
echo "  Docker      : Redis :6379, Kafka :9092"
echo "  TURN server : 3478, 5349, relay UDP/TCP $COTURN_MIN_PORT-$COTURN_MAX_PORT"
echo "  Django API  : http://$DJANGO_BIND_HOST:$DJANGO_PORT internal, public port $API_PUBLIC_PORT"
echo "  Kafka worker: processing messages"
if [ "$MODE" = "ssl" ]; then
    echo "  Frontend    : https://$DOMAIN"
else
    echo "  Frontend    : http://<server-ip>/"
fi
echo ""
echo "Logs:"
echo "  Daphne       : /tmp/ionik-daphne.log"
echo "  Kafka worker : /tmp/ionik-kafka-worker.log"
echo "  nginx        : journalctl -u nginx"
echo "  coturn       : journalctl -u coturn"
echo ""
echo "Stop all: scripts/linux/stop-all.sh"
