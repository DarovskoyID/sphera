#!/usr/bin/env bash
# Запуск генератора тестовой нагрузки по профилю.
#
# Использование:
#   ./run.sh light            лёгкий профиль
#   ./run.sh medium           средний
#   ./run.sh high             высокий
#   ./run.sh custom           спросит N M H J K G интерактивно
#   ./run.sh rate             ЖИВАЯ нагрузка R сообщений/мин в течение DURATION
#                             в каналы/ЛС, БЕЗ создания профилей (на готовых данных)
#   ./run.sh light --purge    сначала удалить старые тестовые данные
#
# Параметры режима rate (через переменные окружения, со значениями по умолчанию):
#   RATE=600 DURATION=10m RATE_TARGET=both BASE_URL=https://127.0.0.1:8000 ./run.sh rate
# Реалистичная нагрузка: онлайн-присутствие + сообщения (+ звонки через TURN):
#   ONLINE=200 RATE=600 DURATION=10m CALLS=10 CALL_DURATION=5m ./run.sh rate
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Подхватываем БД/поиск-окружение, если есть loadtest.env рядом со скриптом.
# ВАЖНО: management-команда seed_load должна работать с ТОЙ ЖЕ БД, что и сервер.
# На сервере loadtest.env задаёт POSTGRES_*/ELASTICSEARCH_URL → команда идёт в
# Postgres (а не в sqlite, иначе она читает каналы/юзеров из другой БД и логин
# на сервер падает 0/N). На dev-машине файла нет → sqlite, как раньше.
if [ -f "$HERE/loadtest.env" ]; then
  set -a; . "$HERE/loadtest.env"; set +a
fi

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
    light|medium|high|custom|rate) PROFILE="$a" ;;
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
if [ "$PROFILE" = "rate" ]; then
  # ЖИВАЯ нагрузка по ставке БЕЗ создания профилей: всё сидирование = 0,
  # шлём R сообщений/мин в течение DURATION в каналы/ЛС на готовых данных.
  RATE="${RATE:-600}"
  DURATION="${DURATION:-10m}"
  RATE_TARGET="${RATE_TARGET:-both}"
  echo "Режим rate: ${RATE} сообщений/мин, длительность ${DURATION}, цель ${RATE_TARGET}"
  ARGS+=(--accounts 0 --servers 0 --channels 0 --posts 0 \
         --server-messages 0 --dm-messages 0 --send-dm 0 \
         --rate "$RATE" --duration "$DURATION" --rate-target "$RATE_TARGET")
  # ONLINE — держать N онлайн-пользователей (presence) параллельно с сообщениями
  [ -n "${ONLINE:-}" ] && ARGS+=(--online "$ONLINE")
  # CALLS — реальные WebRTC-звонки через TURN (нужен aiortc); CALL_DURATION — их длительность
  ARGS+=(--active-calls "${CALLS:-0}")
  [ -n "${CALL_DURATION:-}" ] && ARGS+=(--call-duration "$CALL_DURATION")
  [ -n "${BASE_URL:-}" ] && ARGS+=(--base-url "$BASE_URL")
elif [ "$PROFILE" != "custom" ]; then
  ENV_FILE="$HERE/$PROFILE.env"
  [ -f "$ENV_FILE" ] || { echo "Профиль не найден: $ENV_FILE" >&2; exit 1; }
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  ARGS+=(--accounts "$ACCOUNTS" --servers "$SERVERS" --channels "$CHANNELS" \
         --posts "$POSTS" --server-messages "$SERVER_MESSAGES" --dm-messages "$DM_MESSAGES")
  # T — реальная отправка ЛС через сервер (если задано в профиле)
  ARGS+=(--send-dm "${SEND_DM:-0}")
  # I — реальные WebRTC-звонки через TURN (если задано в профиле)
  ARGS+=(--active-calls "${ACTIVE_CALLS:-0}")
  [ -n "${CALL_DURATION:-}" ] && ARGS+=(--call-duration "$CALL_DURATION")
  # R — живая нагрузка по ставке (если задано в профиле/окружении)
  if [ -n "${RATE:-}" ]; then
    ARGS+=(--rate "$RATE")
    [ -n "${DURATION:-}" ] && ARGS+=(--duration "$DURATION")
    [ -n "${RATE_TARGET:-}" ] && ARGS+=(--rate-target "$RATE_TARGET")
  fi
  [ -n "${BASE_URL:-}" ] && ARGS+=(--base-url "$BASE_URL")
  [ -n "${SIGNALING_URL:-}" ] && ARGS+=(--signaling-url "$SIGNALING_URL")
  [ -n "${TURN_HOST:-}" ] && ARGS+=(--turn-host "$TURN_HOST")
fi

"$PY" "${ARGS[@]}"
