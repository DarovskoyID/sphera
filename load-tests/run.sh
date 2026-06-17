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

# ── Ищем manage.py: расположение load-tests может отличаться на разных машинах ──
find_manage() {
  local c
  for c in \
    "$HERE/../django-server/ionik_server/manage.py" \
    "$HERE/../ionik_server/manage.py" \
    "$HERE/ionik_server/manage.py" \
    "$HERE/django-server/ionik_server/manage.py"; do
    [ -f "$c" ] && { echo "$c"; return 0; }
  done
  # запасной вариант — поиск вверх по дереву
  local found
  found="$(find "$HERE/.." "$HERE/../.." -maxdepth 4 -name manage.py -path '*ionik_server*' 2>/dev/null | head -n1)"
  [ -n "$found" ] && { echo "$found"; return 0; }
  return 1
}

MANAGE="$(find_manage)" || { echo "Не найден manage.py (ionik_server). Запусти скрипт рядом с проектом." >&2; exit 1; }
DJANGO_ROOT="$(cd "$(dirname "$MANAGE")/.." && pwd)"   # .../django-server

# ── Python: venv проекта, иначе системный ──
PY="python3"
for c in "$DJANGO_ROOT/.venv/bin/python" "$DJANGO_ROOT/myenv/bin/python" \
         "$DJANGO_ROOT/../.venv/bin/python"; do
  [ -x "$c" ] && { PY="$c"; break; }
done

# ── Аргументы: профиль + флаг очистки (принимаем --purge и -Purge) ──
PROFILE="light"
PURGE=0
for a in "$@"; do
  case "$a" in
    --purge|-Purge|-purge) PURGE=1 ;;
    light|medium|high|custom) PROFILE="$a" ;;
    *) echo "Неизвестный аргумент: $a" >&2; exit 1 ;;
  esac
done

echo "manage.py: $MANAGE"
echo "python:    $PY"
echo "Профиль:   $PROFILE"

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
  # T — реальная отправка ЛС через сервер (если задано в профиле)
  ARGS+=(--send-dm "${SEND_DM:-0}")
  [ -n "${BASE_URL:-}" ] && ARGS+=(--base-url "$BASE_URL")
fi

"$PY" "${ARGS[@]}"
