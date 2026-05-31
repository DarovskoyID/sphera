@echo off
setlocal

set "ROOT=%~dp0..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "NGINX_DIR=D:\nginx-1.29.8"
set "DOCKER_DIR=%ROOT%\django-server"

echo.
echo  Stopping all ionik services...
echo.

:: ─── Django / Daphne ──────────────────────────────────────────────────────────
echo [1/6] Stopping Django ...
taskkill /f /fi "windowtitle eq ionik-django*" >nul 2>&1
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
echo        Done.

:: ─── Kafka worker ─────────────────────────────────────────────────────────────
echo [2/6] Stopping Kafka worker ...
taskkill /f /fi "windowtitle eq ionik-kafka-worker*" >nul 2>&1
echo        Done.

:: ─── nginx ────────────────────────────────────────────────────────────────────
echo [3/6] Stopping nginx ...
if exist "%NGINX_DIR%\nginx.exe" (
    "%NGINX_DIR%\nginx.exe" -s stop >nul 2>&1
    timeout /t 1 >nul
)
taskkill /f /im nginx.exe >nul 2>&1
echo        Done.

:: ─── coturn (WSL) ─────────────────────────────────────────────────────────────
echo [4/6] Stopping coturn ...
taskkill /f /fi "windowtitle eq ionik-coturn*" >nul 2>&1
taskkill /f /fi "windowtitle eq ionik-turn*"   >nul 2>&1
wsl -e bash -c "pkill -9 turnserver 2>/dev/null; exit 0" >nul 2>&1
taskkill /f /im turn-server.exe >nul 2>&1
echo        Done.

:: ─── Docker services (Redis, Kafka, Zookeeper) ───────────────────────────────
echo [5/6] Stopping Docker services ...
where docker >nul 2>&1
if errorlevel 1 (
    echo        Docker not found, skipping.
) else (
    cd /d "%DOCKER_DIR%"
    docker compose stop >nul 2>&1
    echo        Done.
)

:: ─── WS gateway (if running as Docker) ───────────────────────────────────────
echo [6/6] Stopping WS gateway ...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8001 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
echo        Done.

echo.
echo  All services stopped.
echo.
timeout /t 2 >nul

endlocal
