#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DJANGO_DIR="$PROJECT_ROOT/django-server"
STUN_DIR="$PROJECT_ROOT/stun-server"
TURN_GO_DIR="$PROJECT_ROOT/turn-server-go"

INSTALL_COTURN=1

for arg in "$@"; do
    case "$arg" in
        --skip-coturn)
            INSTALL_COTURN=0
            ;;
        -h|--help)
            echo "Usage: scripts/install-deps.sh [--skip-coturn]"
            echo ""
            echo "Installs project dependencies for:"
            echo "  - root Vite/React app"
            echo "  - stun-server Node app"
            echo "  - django-server Python virtualenv"
            echo "  - turn-server-go Go modules"
            echo "  - coturn via scripts/<platform>/coturn-install.sh"
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

npm_install() {
    local dir="$1"

    cd "$dir"
    if [ -f package-lock.json ]; then
        npm ci
    else
        npm install
    fi
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

log "Checking required tools"
require_command npm "Install Node.js from https://nodejs.org or via your package manager."
PYTHON_BIN="$(detect_python || true)"
if [ -z "$PYTHON_BIN" ]; then
    echo "ERROR: python3/python not found."
    echo "Install Python 3.11+ and re-run this script."
    exit 1
fi
echo "Node: $(node --version 2>/dev/null || echo unknown)"
echo "npm : $(npm --version)"
echo "Python: $("$PYTHON_BIN" --version)"

log "Installing root Node dependencies"
npm_install "$PROJECT_ROOT"

log "Installing stun-server Node dependencies"
npm_install "$STUN_DIR"

log "Installing Django Python dependencies"
install_python_deps "$PYTHON_BIN"

if command -v go >/dev/null 2>&1; then
    log "Downloading Go modules"
    cd "$TURN_GO_DIR"
    go mod download
else
    log "Skipping Go modules"
    echo "Go is not installed. Install Go 1.21+ if you need turn-server-go."
fi

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
