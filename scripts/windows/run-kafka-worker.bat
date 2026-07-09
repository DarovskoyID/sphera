@echo off
:: Запускает Kafka worker в цикле с автоперезапуском.
:: Args: %1 = DJANGO_DIR, %2 = PYTHON exe
setlocal
set "DJANGO_DIR=%~1"
set "PYTHON=%~2"

cd /d "%DJANGO_DIR%"
:: Локальная разработка: DEBUG включён (как в run-daphne.bat).
set SFERA_DEBUG=1

:loop
echo [sfera-kafka-worker] Starting kafka_worker ...
set KAFKA_ENABLED=true
"%PYTHON%" manage.py kafka_worker
echo [sfera-kafka-worker] Worker exited (code %errorlevel%). Restarting in 5s... (close window to stop)
timeout /t 5 /nobreak >nul
goto loop
