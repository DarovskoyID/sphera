#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DJANGO_DIR="$PROJECT_ROOT/django-server"

INSTALL_COTURN=1
INSTALL_SYSTEM=1
# Почтовый сервер (Postfix+OpenDKIM для кодов подтверждения) — только на проде,
# поэтому по умолчанию ВЫКЛ. Включается через --with-mail (Linux only).
INSTALL_MAIL=0

for arg in "$@"; do
    case "$arg" in
        --skip-coturn)
            INSTALL_COTURN=0
            ;;
        --skip-system)
            INSTALL_SYSTEM=0
            ;;
        --with-mail)
            INSTALL_MAIL=1
            ;;
        -h|--help)
            echo "Usage: scripts/install-deps.sh [--skip-coturn] [--skip-system] [--with-mail]"
            echo ""
            echo "Installs system tools and project dependencies:"
            echo "  - Node.js / npm"
            echo "  - Python / pip / venv"
            echo "  - nginx"
            echo "  - coturn"
            echo "  - root Vite/React app"
            echo "  - django-server Python virtualenv"
            echo ""
            echo "Options:"
            echo "  --skip-coturn   don't install/configure coturn"
            echo "  --skip-system   don't install OS packages (node/python/nginx/...)"
            echo "  --with-mail     also set up the send-only SMTP server"
            echo "                  (Postfix + OpenDKIM, Linux only — for the prod box)"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
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

random_token() {
    head -c 24 /dev/urandom | base64 | tr -d '/+=\n'
}

random_secret_key() {
    head -c 50 /dev/urandom | base64 | tr -d '\n'
}

random_fernet_key() {
    head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '\n'
}

ensure_key_value_file_entry() {
    local file="$1"
    local key="$2"
    local value="$3"

    if ! grep -q "^$key=" "$file" 2>/dev/null; then
        printf '%s=%s\n' "$key" "$value" >> "$file"
    fi
}

read_key_value_file_entry() {
    local file="$1"
    local key="$2"
    awk -F= -v key="$key" '$1 == key { print $2; exit }' "$file"
}

ensure_docker_secrets() {
    local os_name
    os_name="$(uname -s)"

    if [ "$os_name" = "Linux" ]; then
        local secrets="/etc/ionik/secrets.env"
        sudo install -d -m 0750 /etc/ionik
        if [ ! -f "$secrets" ]; then
            sudo install -m 0640 /dev/null "$secrets"
            sudo tee "$secrets" >/dev/null <<EOF
# Generated automatically $(date -u +%FT%TZ). Do not commit.
IONIK_SECRET_KEY=$(random_secret_key)
IONIK_STATUS_TOKEN=$(random_token)
IONIK_MESSAGE_ENCRYPTION_KEY=$(random_fernet_key)
IONIK_OLD_MESSAGE_ENCRYPTION_KEYS=
IONIK_ACCESS_TOKEN_MINUTES=15
GRAFANA_PASSWORD=$(random_token)
IONIK_POSTGRES_PASSWORD=$(random_token)
EOF
        else
            local tmp
            tmp="$(mktemp)"
            sudo cp "$secrets" "$tmp"
            ensure_key_value_file_entry "$tmp" IONIK_SECRET_KEY "$(random_secret_key)"
            ensure_key_value_file_entry "$tmp" IONIK_STATUS_TOKEN "$(random_token)"
            ensure_key_value_file_entry "$tmp" IONIK_MESSAGE_ENCRYPTION_KEY "$(random_fernet_key)"
            ensure_key_value_file_entry "$tmp" IONIK_OLD_MESSAGE_ENCRYPTION_KEYS ""
            ensure_key_value_file_entry "$tmp" IONIK_ACCESS_TOKEN_MINUTES "15"
            ensure_key_value_file_entry "$tmp" GRAFANA_PASSWORD "$(random_token)"
            ensure_key_value_file_entry "$tmp" IONIK_POSTGRES_PASSWORD "$(random_token)"
            sudo install -m 0640 "$tmp" "$secrets"
            rm -f "$tmp"
        fi

        POSTGRES_PASSWORD="$(sudo awk -F= '$1=="IONIK_POSTGRES_PASSWORD"{print $2; exit}' "$secrets")"
        GRAFANA_PASSWORD="$(sudo awk -F= '$1=="GRAFANA_PASSWORD"{print $2; exit}' "$secrets")"
        JWT_SECRET="$(sudo awk -F= '$1=="IONIK_SECRET_KEY"{print $2; exit}' "$secrets")"
        export POSTGRES_PASSWORD GRAFANA_PASSWORD JWT_SECRET
        echo "      Docker secrets ready: $secrets"
        return
    fi

    local env_file="$DJANGO_DIR/.env"
    if [ ! -f "$env_file" ]; then
        cat > "$env_file" <<EOF
# Generated automatically $(date -u +%FT%TZ). Do not commit.
IONIK_SECRET_KEY=$(random_secret_key)
IONIK_STATUS_TOKEN=$(random_token)
IONIK_MESSAGE_ENCRYPTION_KEY=$(random_fernet_key)
IONIK_OLD_MESSAGE_ENCRYPTION_KEYS=
IONIK_ACCESS_TOKEN_MINUTES=15
GRAFANA_PASSWORD=$(random_token)
POSTGRES_PASSWORD=$(random_token)
JWT_SECRET=ionik-local-development-secret-key-not-for-production
EOF
    else
        ensure_key_value_file_entry "$env_file" IONIK_SECRET_KEY "$(random_secret_key)"
        ensure_key_value_file_entry "$env_file" IONIK_STATUS_TOKEN "$(random_token)"
        ensure_key_value_file_entry "$env_file" IONIK_MESSAGE_ENCRYPTION_KEY "$(random_fernet_key)"
        ensure_key_value_file_entry "$env_file" IONIK_OLD_MESSAGE_ENCRYPTION_KEYS ""
        ensure_key_value_file_entry "$env_file" IONIK_ACCESS_TOKEN_MINUTES "15"
        ensure_key_value_file_entry "$env_file" GRAFANA_PASSWORD "$(random_token)"
        ensure_key_value_file_entry "$env_file" POSTGRES_PASSWORD "$(random_token)"
        ensure_key_value_file_entry "$env_file" JWT_SECRET "ionik-local-development-secret-key-not-for-production"
    fi

    POSTGRES_PASSWORD="$(read_key_value_file_entry "$env_file" POSTGRES_PASSWORD)"
    GRAFANA_PASSWORD="$(read_key_value_file_entry "$env_file" GRAFANA_PASSWORD)"
    JWT_SECRET="$(read_key_value_file_entry "$env_file" JWT_SECRET)"
    export POSTGRES_PASSWORD GRAFANA_PASSWORD JWT_SECRET
    echo "      Docker secrets ready: $env_file"
}

install_docker() {
    if command -v docker >/dev/null 2>&1; then
        echo "      Docker already installed: $(docker --version)"
        return
    fi

    echo "      Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo systemctl enable docker 2>/dev/null || true
    sudo systemctl start docker 2>/dev/null || true

    if id -nG "$USER" | grep -qw docker; then
        :
    else
        sudo usermod -aG docker "$USER" 2>/dev/null || true
        echo "      Added $USER to docker group (re-login may be needed)."
    fi
}

install_system_deps_linux() {
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -y

        # NodeSource's nodejs package already bundles npm and conflicts with
        # Debian/Ubuntu's separate npm package. Remove/unhold it before install.
        sudo apt-mark unhold nodejs npm 2>/dev/null || true
        sudo apt-get remove -y npm 2>/dev/null || true
        sudo apt-get install -f -y || true

        sudo apt-get install -y \
            curl ca-certificates gnupg build-essential \
            python3 python3-venv python3-pip \
            nginx coturn

        install_nodesource_node
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y \
            curl ca-certificates gcc gcc-c++ make \
            nodejs npm \
            python3 python3-pip \
            nginx coturn
    elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y epel-release
        sudo yum install -y \
            curl ca-certificates gcc gcc-c++ make \
            nodejs npm \
            python3 python3-pip \
            nginx coturn
    else
        echo "ERROR: unsupported Linux package manager."
        echo "Install manually: nodejs npm python3 python3-pip python3-venv nginx coturn"
        exit 1
    fi

    install_docker

    if command -v systemctl >/dev/null 2>&1; then
        sudo systemctl enable nginx 2>/dev/null || true
        sudo systemctl enable coturn 2>/dev/null || true
    fi
}

install_nodesource_node() {
    if [ "$(node_major_version)" -ge 20 ]; then
        return
    fi

    echo "Installing Node.js 22.x from NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
}

node_major_version() {
    if ! command -v node >/dev/null 2>&1; then
        echo 0
        return
    fi

    node --version | sed -E 's/^v([0-9]+).*/\1/'
}

ensure_modern_node_on_apt() {
    if ! command -v apt-get >/dev/null 2>&1; then
        return
    fi

    install_nodesource_node
}

install_system_deps_macos() {
    if ! command -v brew >/dev/null 2>&1; then
        echo "ERROR: Homebrew is required to install system tools on macOS."
        echo "Install it from https://brew.sh and re-run this script."
        exit 1
    fi

    brew update
    brew install node python nginx coturn

    if ! command -v docker >/dev/null 2>&1; then
        echo "      Installing Docker Desktop via brew..."
        brew install --cask docker
        echo "      Open Docker Desktop app to finish setup."
    fi
}

install_system_deps() {
    case "$(uname -s)" in
        Linux)
            install_system_deps_linux
            ;;
        Darwin)
            install_system_deps_macos
            ;;
        *)
            echo "Skipping system dependency install: unsupported OS."
            echo "Use scripts/windows/install-deps.bat on Windows."
            ;;
    esac
}

npm_install() {
    local dir="$1"

    cd "$dir"
    npm install
}

detect_python() {
    if command -v python3 >/dev/null 2>&1; then
        echo "python3"
    elif command -v python >/dev/null 2>&1; then
        echo "python"
    else
        return 1
    fi
}

install_python_deps() {
    local python_bin="$1"
    local venv_dir="$DJANGO_DIR/.venv"
    local requirements="$DJANGO_DIR/requirements.txt"
    local normalized_requirements

    "$python_bin" -m venv "$venv_dir"

    # shellcheck disable=SC1091
    source "$venv_dir/bin/activate"
    python -m pip install --upgrade pip

    normalized_requirements="$(mktemp)"
    python - "$requirements" "$normalized_requirements" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
data = source.read_bytes()

if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
    text = data.decode("utf-16")
else:
    text = data.decode("utf-8-sig")

target.write_text(text, encoding="utf-8", newline="\n")
PY

    python -m pip install -r "$normalized_requirements"
    rm -f "$normalized_requirements"

    # Зависимости нагрузочных тестов (websockets/requests/aiortc для --rate и
    # --active-calls). Без них seed_load падает на импорте websockets.
    local loadtest_req="$PROJECT_ROOT/load-tests/requirements-loadtest.txt"
    if [ -f "$loadtest_req" ]; then
        echo "      Installing load-test deps (websockets, requests, aiortc)..."
        python -m pip install -r "$loadtest_req" || \
            echo "      WARNING: load-test deps failed (aiortc/PyAV?). Звонки могут не работать."
    fi
}

install_coturn() {
    case "$(uname -s)" in
        Darwin)
            "$SCRIPT_DIR/macos/coturn-install.sh"
            ;;
        Linux)
            "$SCRIPT_DIR/linux/coturn-install.sh"
            ;;
        *)
            echo "Skipping coturn: unsupported OS for this script."
            echo "Use scripts/windows/coturn-install.bat on Windows."
            ;;
    esac
}

install_mail() {
    case "$(uname -s)" in
        Linux)
            # Передаём MAIL_TEST_TO как тестовый адрес, если задан в окружении.
            sudo bash "$SCRIPT_DIR/linux/mail-install.sh" "${MAIL_TEST_TO:-}"
            ;;
        *)
            echo "Skipping mail server: Linux only (prod box). Nothing to do on $(uname -s)."
            ;;
    esac
}

echo "=== Installing ionik dependencies ==="
echo "Project root: $PROJECT_ROOT"

if [ "$INSTALL_SYSTEM" -eq 1 ]; then
    log "Installing system tools"
    install_system_deps
    ensure_modern_node_on_apt
else
    log "Skipping system tools"
fi

log "Checking required tools"
require_command node "Install Node.js/npm and re-run this script."
require_command npm "Install Node.js from https://nodejs.org or via your package manager."
if [ "$(node_major_version)" -lt 20 ]; then
    echo "ERROR: Node.js 20+ is required, found $(node --version)."
    echo "Install a newer Node.js and re-run this script."
    exit 1
fi
PYTHON_BIN="$(detect_python || true)"
if [ -z "$PYTHON_BIN" ]; then
    echo "ERROR: python3/python not found."
    echo "Install Python 3.11+ and re-run this script."
    exit 1
fi
echo "Node: $(node --version 2>/dev/null || echo unknown)"
echo "npm : $(npm --version)"
echo "Python: $("$PYTHON_BIN" --version)"
"$PYTHON_BIN" -m pip --version >/dev/null 2>&1 || "$PYTHON_BIN" -m ensurepip --upgrade

log "Installing root Node dependencies"
npm_install "$PROJECT_ROOT"

log "Installing Django Python dependencies"
install_python_deps "$PYTHON_BIN"

log "Starting Docker services (Postgres, Elasticsearch, Redis, Kafka, ws-gateway, LB, monitoring)"
if command -v docker >/dev/null 2>&1; then
    ensure_docker_secrets
    cd "$DJANGO_DIR"
    docker compose up -d --build \
        postgres elasticsearch redis kafka zookeeper kafka-init prometheus grafana alertmanager \
        ws-gateway loadbalancer
    echo "      Postgres, Elasticsearch, Redis, Kafka, ws-gateway, load balancer, alertmanager started."
    echo "      Add WS nodes by editing loadbalancer/servers.conf."
else
    echo "      WARNING: Docker not found. Install Docker to run Redis/Kafka."
    echo "      Without Docker, messages may be lost under high load."
fi

if [ "$INSTALL_COTURN" -eq 1 ]; then
    log "Installing coturn"
    install_coturn
else
    log "Skipping coturn"
fi

if [ "$INSTALL_MAIL" -eq 1 ]; then
    log "Installing mail server (Postfix + OpenDKIM, send-only)"
    install_mail
else
    log "Skipping mail server (pass --with-mail to install it)"
fi

echo ""
echo "=== Dependencies installed ==="
case "$(uname -s)" in
    Darwin)
        echo "Next: run scripts/macos/start-all.sh"
        ;;
    Linux)
        echo "Next: run scripts/linux/start-all.sh"
        ;;
    *)
        echo "Next: run the platform-specific start-all script if available."
        ;;
esac
