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

usage() {
  cat <<'USAGE'
Генератор тестовой нагрузки sfera.

ИСПОЛЬЗОВАНИЕ:
  ./run.sh <профиль> [--purge]
  ./run.sh rate [параметры через переменные окружения]
  ./run.sh --help

ПРОФИЛИ СИДИРОВАНИЯ (наполняют БД аккаунтами/серверами/каналами/сообщениями):
  light      лёгкий   — быстрый прогон для проверки
  medium     средний  — реалистичный объём
  high       высокий  — стресс БД
  custom     спросит числа (N серверов/каналов/сообщений и т.д.) интерактивно
  rate       ЖИВАЯ нагрузка по ставке (см. ниже), БЕЗ создания профилей
  ramp       СТРЕСС: постепенно разгоняет ставку ДО ОТКАЗА сервера и пишет в
             отчёт, на каких параметрах сервер упал (см. RAMP_* ниже)
  botapi     НАГРУЗКА НА BOT API: создаёт временного бота (тариф premium/standard)
             и бьёт по нему BOT_API запросов, замеряя rps/задержки/429
             (env: BOT_API=10000 BOT_API_TIER=premium BOT_API_ENDPOINT=me
              CONCURRENCY=64 BASE_URL=https://127.0.0.1:8000)

ФЛАГИ:
  --purge    сначала удалить старые тестовые данные (loadtest_*), затем сеять
  -h, --help показать эту справку

РЕЖИМ rate — живая нагрузка на готовых данных (нужен запущенный сервер).
Параметры задаются переменными окружения (значения по умолчанию в скобках):
  RATE          сообщений в минуту                         (600)
  DURATION      длительность: 30s / 5m / 1h / 1h30m         (10m)
  RATE_TARGET   куда слать: guild | dm | both              (both)
  ONLINE        держать N онлайн-юзеров (presence)          (0)
  CALLS         реальных WebRTC-звонков через TURN          (0)
  CALL_DURATION длительность звонков                        (—)
  RATE_BOTS     потоков трафика на bot API (0 = выключить)  (4)
  BASE_URL      адрес сервера для логина/WS                 (https://127.0.0.1:8000)

РЕЖИМ ramp — разгон до отказа (env, дефолты в скобках):
  RAMP_START      стартовая ставка, сообщений/мин            (600)
  RAMP_STEP       прибавка ставки за стадию                  (600)
  RAMP_STAGE      длительность одной стадии                  (20s)
  RAMP_MAX        потолок ставки (стоп, если выдержал)       (30000)
  RAMP_TARGET     guild | dm | both                          (guild)
  RAMP_FAIL_ERRORS доля ошибок отправки, считающаяся отказом (0.25)
  RAMP_MAXCONN    число WS-соединений на стадию              (100)
  RAMP_ALL        1 = грузить ВСЁ (target=both, online=200,  (0)
                  bots=8, calls=10) — двигает все панели Grafana
  RAMP_ONLINE     держать N онлайн (presence)                (0)
  RAMP_BOTS       потоков трафика на bot API (0 = выключить) (4)
  RAMP_CALLS      реальных WebRTC-звонков (нужен aiortc)     (0)
  RAMP_CALL_DURATION длительность звонков                    (= RAMP_STAGE)
  RAMP_REPORT     файл отчёта                                (load-tests/ramp-result.txt)

ПРИМЕРЫ:
  ./run.sh light                 # засеять лёгкий набор данных
  ./run.sh medium --purge        # очистить и засеять средний
  RATE=600 DURATION=2m RATE_TARGET=both ./run.sh rate
  ONLINE=50 RATE=600 DURATION=2m CALLS=5 CALL_DURATION=2m ./run.sh rate
  RAMP_START=600 RAMP_STEP=600 RAMP_STAGE=20s ./run.sh ramp   # стресс до отказа

ЗАМЕТКИ:
  • На сервере рядом со скриптом должен быть loadtest.env (PG/ES) — тогда нагрузка
    идёт в ту же БД, что и сервер. Создаётся автоматически при start-common.sh.
  • На проде (SFERA_DEBUG=0) settings требует SFERA_SECRET_KEY, а seed_load ещё и
    SFERA_MESSAGE_ENCRYPTION_KEY. Скрипт сам подхватывает их из /etc/sfera/secrets.env
    (root или sudo). Другой путь — SFERA_SECRETS=/путь/secrets.env, либо просто
    экспортни SFERA_SECRET_KEY перед запуском.
  • Звонкам нужны пакеты из requirements-loadtest.txt (aiortc/websockets).
USAGE
}

for _a in "$@"; do
  case "$_a" in -h|--help|help) usage; exit 0 ;; esac
done

# Подхватываем секреты СЕРВЕРА (SFERA_SECRET_KEY, SFERA_MESSAGE_ENCRYPTION_KEY и
# т.д.), если запускаемся на проде. В проде DEBUG=0 → settings.py требует
# SFERA_SECRET_KEY, а seed_load ещё и шифрует сообщения ключом
# SFERA_MESSAGE_ENCRYPTION_KEY. Единственный источник правды — тот же файл,
# который systemd подаёт сервису (EnvironmentFile=/etc/sfera/secrets.env), поэтому
# читаем его напрямую (root или sudo). Так секрет не дублируется в репозиторий и
# всегда совпадает с работающим сервером.
SFERA_SECRETS="${SFERA_SECRETS:-/etc/sfera/secrets.env}"
if [ -r "$SFERA_SECRETS" ]; then
  set -a; . "$SFERA_SECRETS"; set +a
elif [ -f "$SFERA_SECRETS" ] && command -v sudo >/dev/null 2>&1; then
  # Файл есть, но не читается напрямую (root-only) — берём через sudo.
  set -a; . <(sudo cat "$SFERA_SECRETS" 2>/dev/null) || true; set +a
fi

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
    "$HERE/../django-server/sfera_server/manage.py" \
    "$HERE/../sfera_server/manage.py" \
    "$HERE/sfera_server/manage.py" \
    "$HERE/django-server/sfera_server/manage.py"; do
    [ -f "$c" ] && { echo "$c"; return 0; }
  done
  # запасной вариант — поиск вверх по дереву
  local found
  found="$(find "$HERE/.." "$HERE/../.." -maxdepth 4 -name manage.py -path '*sfera_server*' 2>/dev/null | head -n1)"
  [ -n "$found" ] && { echo "$found"; return 0; }
  return 1
}

MANAGE="$(find_manage)" || { echo "Не найден manage.py (sfera_server). Запусти скрипт рядом с проектом." >&2; exit 1; }
DJANGO_ROOT="$(cd "$(dirname "$MANAGE")/.." && pwd)"   # .../django-server

# ── Python: venv проекта, иначе системный ──
PY="python3"
for c in "$DJANGO_ROOT/.venv/bin/python" "$DJANGO_ROOT/myenv/bin/python" \
         "$DJANGO_ROOT/../.venv/bin/python"; do
  [ -x "$c" ] && { PY="$c"; break; }
done

# ── Профиль ramp: разгон ставки до отказа сервера ────────────────────────────
# Постепенно повышает сообщения/мин стадиями. После каждой стадии проверяет
# здоровье сервера (HTTP-проба) и долю ошибок отправки. Когда сервер «падает»
# (не отвечает или ошибки выше порога) — пишет в отчёт, на каких параметрах упал.
# Параметры через env: RAMP_START, RAMP_STEP, RAMP_STAGE, RAMP_MAX, RAMP_TARGET,
# RAMP_FAIL_ERRORS, RAMP_MAXCONN, RAMP_REPORT, BASE_URL.
# ВНИМАНИЕ: цель режима — довести сервер до отказа. Запускай осознанно.
run_ramp() {
  local start="${RAMP_START:-600}" step="${RAMP_STEP:-600}" stage="${RAMP_STAGE:-20s}"
  local max="${RAMP_MAX:-30000}" thr="${RAMP_FAIL_ERRORS:-0.25}"
  local maxconn="${RAMP_MAXCONN:-100}" base="${BASE_URL:-https://127.0.0.1:8000}"
  local report="${RAMP_REPORT:-$HERE/ramp-result.txt}"
  # Токен для status/metrics: на проде задан SFERA_STATUS_TOKEN (его требует
  # сервер В ПУТИ status-<token>/ и как ?token= у /metrics). Если не задан —
  # legacy-токен = сегодняшняя дата. Без этого проба ловит 404 и ложно решает,
  # что сервер «упал».
  local stok="${SFERA_STATUS_TOKEN:-$(date +%Y-%m-%d)}"
  local probe="$base/status-$stok/"
  local metrics_url="$base/metrics/?token=$stok"
  local rate="$start" prev_ok=0 fell=0 reason=""

  # RAMP_ALL=1 — грузить ВСЁ, что видно в Grafana: каналы+ЛС, онлайн-присутствие,
  # боты и WebRTC-звонки (звонкам нужен aiortc и ≥2×RAMP_CALLS тестовых аккаунтов).
  # Отдельные RAMP_* переопределяют пресет.
  if [ "${RAMP_ALL:-0}" = "1" ]; then
    : "${RAMP_TARGET:=both}"; : "${RAMP_ONLINE:=200}"; : "${RAMP_BOTS:=8}"; : "${RAMP_CALLS:=10}"
  fi
  local target="${RAMP_TARGET:-guild}" online="${RAMP_ONLINE:-0}"
  local bots="${RAMP_BOTS:-}" calls="${RAMP_CALLS:-0}" calldur="${RAMP_CALL_DURATION:-$stage}"

  # ВАЖНО: внутри ramp отключаем errexit/pipefail — здесь grep/curl легитимно
  # возвращают не-ноль (нет совпадения, недоступный сервер), а решения мы
  # принимаем сами по захваченным значениям. Иначе скрипт молча умирал бы после
  # первой стадии (grep по 'отправлено' без совпадений → pipefail → set -e).
  set +e
  set +o pipefail

  echo "=== RAMP: разгон до отказа сервера ==="
  echo "  старт=$start/мин шаг=+$step стадия=$stage потолок=$max цель=$target"
  echo "  порог ошибок=$thr  соединений=$maxconn  онлайн=$online  боты=${bots:-4}  звонки=$calls"
  echo "  отчёт=$report"
  echo "  ВНИМАНИЕ: режим намеренно валит сервер. Нужны уже засеянные данные (./run.sh light)."

  while [ "$rate" -le "$max" ]; do
    echo ""
    echo ">>> стадия: $rate сообщений/мин ($stage)"
    local out sent errors code total cpu mem
    local stage_args=(--accounts 0 --servers 0 --channels 0 --posts 0 \
        --server-messages 0 --dm-messages 0 --send-dm 0 \
        --rate "$rate" --duration "$stage" --rate-target "$target" \
        --rate-max-conns "$maxconn" --base-url "$base" \
        --online "$online" --active-calls "$calls")
    [ -n "$bots" ] && stage_args+=(--rate-bots "$bots")
    [ "$calls" != "0" ] && stage_args+=(--call-duration "$calldur")
    out="$("$PY" "$MANAGE" seed_load "${stage_args[@]}" 2>&1)"
    # Нет каналов/диалогов в БД — это не «отказ сервера», а отсутствие данных.
    if printf '%s' "$out" | grep -q 'Нет целей'; then
      echo "    Нет целей для нагрузки — каналов/диалогов нет в БД."
      echo ""
      echo "Сначала засей данные:  ./run.sh light   (или medium/high), затем ./run.sh ramp"
      return 1
    fi
    sent="$(printf '%s' "$out"  | grep -oE 'отправлено [0-9]+' | grep -oE '[0-9]+' | tail -1)"; sent="${sent:-0}"
    errors="$(printf '%s' "$out" | grep -oE 'ошибок [0-9]+'    | grep -oE '[0-9]+' | tail -1)"; errors="${errors:-0}"
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 "$probe" 2>/dev/null || echo 000)"
    cpu="$(curl -sk --max-time 5 "$metrics_url" 2>/dev/null | grep -oE '^sfera_cpu_percent [0-9.]+'    | awk '{print $2}')"
    mem="$(curl -sk --max-time 5 "$metrics_url" 2>/dev/null | grep -oE '^sfera_memory_percent [0-9.]+' | awk '{print $2}')"
    echo "    отправлено=$sent ошибок=$errors health=$code CPU=${cpu:-?}% MEM=${mem:-?}%"

    total=$((sent + errors))
    if [ "$code" = "000" ]; then
      fell=1; reason="сервер не отвечает на $probe (health=000)"
    elif [ "$total" -eq 0 ]; then
      fell=1; reason="ноль отправок (логин/коннект не прошёл — сервер недоступен?)"
    elif awk "BEGIN{exit !($errors/$total > $thr)}"; then
      fell=1; reason="доля ошибок $errors/$total превысила порог $thr"
    fi

    if [ "$fell" = "1" ]; then
      echo ""
      # Если отправок было ноль — это почти всегда логин/коннект, а не «отказ».
      # Показываем реальный вывод стадии, чтобы было видно ПОЧЕМУ (иначе он
      # проглатывался и приходилось гадать).
      if [ "$total" -eq 0 ]; then
        echo "--- вывод последней стадии (seed_load), тут причина 0 отправок: ---"
        printf '%s\n' "$out" | sed 's/^/    /'
        echo "-----------------------------------------------------------------"
      fi
      echo "!!! СЕРВЕР УПАЛ на $rate сообщений/мин — $reason"
      {
        echo "=== sfera ramp result — $(date) ==="
        echo "Упал на ставке:           $rate сообщений/мин"
        echo "Последняя успешная ставка: $prev_ok сообщений/мин"
        echo "Причина:                  $reason"
        echo "Последняя стадия:         отправлено=$sent ошибок=$errors health=$code"
        echo "Метрики сервера:          CPU=${cpu:-?}% MEM=${mem:-?}%"
        echo "Параметры разгона:        старт=$start шаг=$step стадия=$stage цель=$target соединений=$maxconn онлайн=$online боты=${bots:-4} звонки=$calls"
      } | tee "$report"
      return 0
    fi
    prev_ok="$rate"
    rate=$((rate + step))
  done

  echo ""
  echo "Достигнут потолок $max сообщений/мин — сервер ВЫДЕРЖАЛ. Подними RAMP_MAX для продолжения."
  {
    echo "=== sfera ramp result — $(date) ==="
    echo "Сервер выдержал до потолка $max сообщений/мин (последняя успешная ставка $prev_ok)."
    echo "Параметры: старт=$start шаг=$step стадия=$stage цель=$target соединений=$maxconn"
  } | tee "$report"
  return 0
}

# ── Аргументы: профиль + флаг очистки (принимаем --purge и -Purge) ──
PROFILE="light"
PURGE=0
for a in "$@"; do
  case "$a" in
    --purge|-Purge|-purge) PURGE=1 ;;
    light|medium|high|custom|rate|ramp) PROFILE="$a" ;;
    *) echo "Неизвестный аргумент: $a" >&2; exit 1 ;;
  esac
done

echo "manage.py: $MANAGE"
echo "python:    $PY"
echo "Профиль:   $PROFILE"

if [ "$PURGE" = "1" ]; then
  "$PY" "$MANAGE" seed_load --purge
fi

if [ "$PROFILE" = "ramp" ]; then
  run_ramp
  exit $?
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
  # RATE_BOTS — сколько потоков параллельно бьют bot API (по умолчанию 4, 0 = выключить)
  [ -n "${RATE_BOTS:-}" ] && ARGS+=(--rate-bots "$RATE_BOTS")
  [ -n "${STATUS_TOKEN:-}" ] && ARGS+=(--status-token "$STATUS_TOKEN")
  [ -n "${BASE_URL:-}" ] && ARGS+=(--base-url "$BASE_URL")
elif [ "$PROFILE" = "botapi" ]; then
  # Нагрузка на bot API: создаёт временного бота нужного тарифа и бьёт по нему
  # BOT_API запросов, замеряя rps/задержки/429. Нужен запущенный сервер.
  BOT_API="${BOT_API:-10000}"
  echo "Режим botapi: ${BOT_API} запросов, тариф ${BOT_API_TIER:-premium}, эндпоинт ${BOT_API_ENDPOINT:-me}"
  ARGS+=(--accounts 0 --servers 0 --channels 0 --posts 0 \
         --server-messages 0 --dm-messages 0 --send-dm 0 \
         --bot-api "$BOT_API")
  [ -n "${BOT_API_ENDPOINT:-}" ] && ARGS+=(--bot-api-endpoint "$BOT_API_ENDPOINT")
  [ -n "${BOT_API_TIER:-}" ] && ARGS+=(--bot-api-tier "$BOT_API_TIER")
  [ -n "${CONCURRENCY:-}" ] && ARGS+=(--concurrency "$CONCURRENCY")
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
  # B — нагрузка на bot API (если задано в профиле/окружении)
  [ -n "${BOT_API:-}" ] && ARGS+=(--bot-api "$BOT_API")
  [ -n "${BOT_API_ENDPOINT:-}" ] && ARGS+=(--bot-api-endpoint "$BOT_API_ENDPOINT")
  [ -n "${BOT_API_TIER:-}" ] && ARGS+=(--bot-api-tier "$BOT_API_TIER")
  [ -n "${CONCURRENCY:-}" ] && ARGS+=(--concurrency "$CONCURRENCY")
  [ -n "${BASE_URL:-}" ] && ARGS+=(--base-url "$BASE_URL")
  [ -n "${SIGNALING_URL:-}" ] && ARGS+=(--signaling-url "$SIGNALING_URL")
  [ -n "${TURN_HOST:-}" ] && ARGS+=(--turn-host "$TURN_HOST")
fi

"$PY" "${ARGS[@]}"
