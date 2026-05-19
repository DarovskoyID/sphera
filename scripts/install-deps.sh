#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DJANGO_DIR="$PROJECT_ROOT/django-server"
STUN_DIR="$PROJECT_ROOT/stun-server"
TURN_GO_DIR="$PROJECT_ROOT/turn-server-go"

INSTALL_COTURN=1
INSTALL_SYSTEM=1

for arg in "$@"; do
    case "$arg" in
        --skip-coturn)
            INSTALL_COTURN=0
            ;;
        --skip-system)
            INSTALL_SYSTEM=0
            ;;
        -h|--help)
            echo "Usage: scripts/install-deps.sh [--skip-coturn] [--skip-system]"
            echo ""
            echo "Installs system tools and project dependencies:"
            echo "  - Node.js / npm"
            echo "  - Python / pip / venv"
            echo "  - Go"
            echo "  - nginx"
            echo "  - coturn"
            echo "  - root Vite/React app"
            echo "  - stun-server Node app"
            echo "  - django-server Python virtualenv"
            echo "  - turn-server-go Go modules"
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
            golang-go \
            nginx coturn

        install_nodesource_node
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y \
            curl ca-certificates gcc gcc-c++ make \
            nodejs npm \
            python3 python3-pip \
            golang \
            nginx coturn
    elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y epel-release
        sudo yum install -y \
            curl ca-certificates gcc gcc-c++ make \
            nodejs npm \
            python3 python3-pip \
            golang \
            nginx coturn
    else
        echo "ERROR: unsupported Linux package manager."
        echo "Install manually: nodejs npm python3 python3-pip python3-venv go nginx coturn"
        exit 1
    fi

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
    brew install node python go nginx coturn
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

log "Installing stun-server Node dependencies"
npm_install "$STUN_DIR"

log "Installing Django Python dependencies"
install_python_deps "$PYTHON_BIN"

log "Downloading Go modules"
require_command go "Install Go 1.21+ and re-run this script."
cd "$TURN_GO_DIR"
go mod download

if [ "$INSTALL_COTURN" -eq 1 ]; then
    log "Installing coturn"
    install_coturn
else
    log "Skipping coturn"
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
