#!/bin/bash
# Запускает Daphne в цикле с автоперезапуском (аналог systemd Restart=always
# на Linux / run-daphne.bat на Windows). Если процесс упал или завис и был
# закрыт — поднимается заново.
# Args: $1 = DJANGO_DIR, $2 = VENV path
DJANGO_DIR="$1"
VENV="$2"

if [ -d "$VENV" ]; then
    # shellcheck disable=SC1091
    source "$VENV/bin/activate"
fi

cd "$DJANGO_DIR" || exit 1
python manage.py migrate --run-syncdb --noinput 2>/dev/null || true

while true; do
    echo "[ionik-django] Starting Daphne on 0.0.0.0:8000 ..."
    KAFKA_ENABLED=true daphne -b 0.0.0.0 -p 8000 ionik_server.asgi:application
    echo "[ionik-django] Daphne exited ($?). Restarting in 3s... (kill this wrapper to stop)"
    sleep 3
done
