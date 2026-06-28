@echo off
:: Запускает Daphne в цикле с автоперезапуском (аналог systemd Restart=always
:: на Linux). Если процесс упал или завис и был закрыт — поднимается заново.
:: Args: %1 = DJANGO_DIR, %2 = PYTHON exe
setlocal
set "DJANGO_DIR=%~1"
set "PYTHON=%~2"

cd /d "%DJANGO_DIR%"
:: Локальная разработка: DEBUG включён (разрешает любые CORS-origin,
:: отключает HTTPS-редирект). На проде DEBUG выключен по умолчанию.
set IONIK_DEBUG=1
"%PYTHON%" manage.py migrate --noinput

:loop
echo [ionik-django] Starting Daphne on 0.0.0.0:8000 ...
set KAFKA_ENABLED=true
"%PYTHON%" -m daphne -b 0.0.0.0 -p 8000 ionik_server.asgi:application
echo [ionik-django] Daphne exited (code %errorlevel%). Restarting in 3s... (close window to stop)
timeout /t 3 /nobreak >nul
goto loop
