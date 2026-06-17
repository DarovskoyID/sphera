#!/usr/bin/env bash
# Запуск генератора тестовой нагрузки по профилю.
#
# Использование:
#   ./run.sh light            лёгкий профиль
#   ./run.sh medium           средний
#   ./run.sh high             высокий
#   ./run.sh custom           спросит N M H J K G интерактивно
#   ./run.sh light --purge    сначала удалить старые тестовые данные
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGE="$HERE/../ionik_server/manage.py"

# python из venv, если есть
if [ -x "$HERE/../myenv/bin/python" ]; then PY="$HERE/../myenv/bin/python"; else PY="python3"; fi

PROFILE="${1:-light}"
PURGE=0
[ "${2:-}" = "--purge" ] && PURGE=1

if [ "$PURGE" = "1" ]; then
  "$PY" "$MANAGE" seed_load --purge
fi

ARGS=("$MANAGE" seed_load)
if [ "$PROFILE" != "custom" ]; then
  ENV_FILE="$HERE/$PROFILE.env"
  [ -f "$ENV_FILE" ] || { echo "Профиль не найден: $ENV_FILE" >&2; exit 1; }
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  ARGS+=(--accounts "$ACCOUNTS" --servers "$SERVERS" --channels "$CHANNELS" \
         --posts "$POSTS" --server-messages "$SERVER_MESSAGES" --dm-messages "$DM_MESSAGES")
fi

echo "Профиль: $PROFILE"
"$PY" "${ARGS[@]}"
