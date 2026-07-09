#!/bin/bash
# Запускает Kafka worker в цикле с автоперезапуском.
# Args: $1 = DJANGO_DIR, $2 = VENV path
DJANGO_DIR="$1"
VENV="$2"

if [ -d "$VENV" ]; then
    # shellcheck disable=SC1091
    source "$VENV/bin/activate"
fi

cd "$DJANGO_DIR" || exit 1

while true; do
    echo "[sfera-kafka-worker] Starting kafka_worker ..."
    KAFKA_ENABLED=true python manage.py kafka_worker
    echo "[sfera-kafka-worker] Worker exited ($?). Restarting in 5s... (kill this wrapper to stop)"
    sleep 5
done
