#!/bin/bash
set -e

echo "=== Installing coturn (TURN server) on Linux ==="

# Detect package manager
if command -v apt-get &>/dev/null; then
    sudo apt-get update -y
    sudo apt-get install -y coturn
elif command -v yum &>/dev/null; then
    sudo yum install -y epel-release
    sudo yum install -y coturn
elif command -v dnf &>/dev/null; then
    sudo dnf install -y coturn
else
    echo "ERROR: Unsupported package manager. Install coturn manually."
    exit 1
fi

# Enable coturn service on boot
sudo systemctl enable coturn

# Write default config if not exists
CONF=/etc/turnserver.conf
if [ ! -f "$CONF" ]; then
    sudo tee "$CONF" > /dev/null <<'EOF'
# coturn config for ionik
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
user=ionik:changeme
realm=ionik.local
log-file=/var/log/coturn/turnserver.log
no-cli
EOF
    echo "Default config written to $CONF"
    echo "IMPORTANT: Change the 'user' and 'realm' values before production use."
fi

echo ""
echo "=== coturn installed ==="
echo "Config: $CONF"
echo "Start:  sudo systemctl start coturn"
echo "Status: sudo systemctl status coturn"
