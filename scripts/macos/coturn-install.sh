#!/bin/bash
set -e

echo "=== Installing coturn (TURN server) on macOS ==="

# Require Homebrew
if ! command -v brew &>/dev/null; then
    echo "ERROR: Homebrew is required. Install it from https://brew.sh"
    exit 1
fi

brew install coturn

# Write default config if not exists
CONF="$HOME/.coturn/turnserver.conf"
mkdir -p "$(dirname "$CONF")"

if [ ! -f "$CONF" ]; then
    cat > "$CONF" <<'EOF'
# coturn config for sfera (macOS dev)
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
user=sfera:changeme
realm=sfera.local
log-file=/tmp/coturn.log
no-cli
EOF
    echo "Default config written to $CONF"
    echo "IMPORTANT: Change the 'user' and 'realm' values before production use."
fi

echo ""
echo "=== coturn installed ==="
echo "Config : $CONF"
echo "Start  : turnserver -c $CONF"
echo "Or via launchctl (brew services): brew services start coturn"
