#!/bin/bash
set -e

echo "=== Installing coturn (TURN server) on Linux ==="

MIN_PORT="${IONIK_COTURN_MIN_PORT:-49152}"
MAX_PORT="${IONIK_COTURN_MAX_PORT:-65535}"
REALM="${IONIK_TURN_REALM:-bottomweb.ru}"
TURN_USER="${IONIK_TURN_USER:-ionikuser}"
TURN_PASS="${IONIK_TURN_PASS:-ionikturn123}"
EXTERNAL_IP="${IONIK_TURN_EXTERNAL_IP:-}"
SSL_CERT="${IONIK_SSL_CERT:-/etc/letsencrypt/live/$REALM/fullchain.pem}"
SSL_KEY="${IONIK_SSL_KEY:-/etc/letsencrypt/live/$REALM/privkey.pem}"

# Detect package manager
if command -v apt-get &>/dev/null; then
    sudo apt-get update -y
    sudo apt-get install -y coturn nginx
elif command -v yum &>/dev/null; then
    sudo yum install -y epel-release
    sudo yum install -y coturn nginx
elif command -v dnf &>/dev/null; then
    sudo dnf install -y coturn nginx
else
    echo "ERROR: Unsupported package manager. Install coturn manually."
    exit 1
fi

# Enable coturn service on boot
sudo systemctl enable coturn

# Write default config if not exists
CONF=/etc/turnserver.conf
if [ ! -f "$CONF" ]; then
    if [ -z "$EXTERNAL_IP" ]; then
        EXTERNAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    fi

    sudo tee "$CONF" > /dev/null <<'EOF'
# coturn config for ionik
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
fingerprint
lt-cred-mech
no-cli
no-multicast-peers
no-loopback-peers
no-stun-backward-compatibility
verbose
log-file=/var/log/coturn/turnserver.log
EOF
    {
        echo "external-ip=$EXTERNAL_IP"
        echo "relay-ip=0.0.0.0"
        echo "min-port=$MIN_PORT"
        echo "max-port=$MAX_PORT"
        echo "realm=$REALM"
        echo "user=$TURN_USER:$TURN_PASS"
        if [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
            echo "cert=$SSL_CERT"
            echo "pkey=$SSL_KEY"
        fi
    } | sudo tee -a "$CONF" > /dev/null
    echo "Default config written to $CONF"
    echo "IMPORTANT: Change IONIK_TURN_USER/IONIK_TURN_PASS for production."
else
    sudo sed -i -E \
        -e "/^min-port=/d" \
        -e "/^max-port=/d" \
        "$CONF"
    printf "\nmin-port=%s\nmax-port=%s\n" "$MIN_PORT" "$MAX_PORT" \
        | sudo tee -a "$CONF" > /dev/null
    echo "Updated relay port range in $CONF"
fi

echo ""
echo "=== coturn installed ==="
echo "Config: $CONF"
echo "Ports : 3478, 5349, relay $MIN_PORT-$MAX_PORT"
echo "Start:  sudo systemctl start coturn"
echo "Status: sudo systemctl status coturn"
