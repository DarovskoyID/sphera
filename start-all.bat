@echo off
setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
set "NGINX_DIR=D:\nginx-1.29.8"
set "NGINX_HTML=%NGINX_DIR%\html"
set "PYTHON=%ROOT%django-server\myenv\Scripts\python.exe"
set "DJANGO_DIR=%ROOT%django-server\ionik_server"
set "STUN_DIR=%ROOT%stun-server"
set "TURN_DIR=%ROOT%turn-server-go"
set "TURN_EXE=%TURN_DIR%\turn-server.exe"
set "GO_EXE=C:\Program Files\Go\bin\go.exe"

echo.
echo  ==========================================
echo    ionik -- full stack startup
echo  ==========================================
echo.

:: ─── Prerequisites check ──────────────────────────────────────────────────────

if not exist "%PYTHON%" (
    echo [ERROR] Python venv not found:
    echo         %PYTHON%
    echo.
    echo  Fix: cd django-server
    echo       python -m venv myenv
    echo       myenv\Scripts\pip install -r requirements.txt
    echo.
    pause & exit /b 1
)
if not exist "%NGINX_DIR%\nginx.exe" (
    echo [ERROR] nginx.exe not found in %NGINX_DIR%
    pause & exit /b 1
)

:: ─── 1. Build React UI ────────────────────────────────────────────────────────

echo [1/6] Building React UI ...
cd /d "%ROOT%"
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] npm run build failed
    pause & exit /b 1
)
echo        Done.

:: ─── 2. Clear nginx html ──────────────────────────────────────────────────────

echo [2/6] Clearing %NGINX_HTML% ...
if exist "%NGINX_HTML%\" (
    for /d %%D in ("%NGINX_HTML%\*") do rd /s /q "%%D" 2>nul
    del /f /q "%NGINX_HTML%\*" 2>nul
)
echo        Done.

:: ─── 3. Deploy dist → nginx html ─────────────────────────────────────────────

echo [3/6] Deploying dist\ to %NGINX_HTML% ...
xcopy /e /i /y "%ROOT%dist\" "%NGINX_HTML%\" >nul
if errorlevel 1 (
    echo.
    echo [ERROR] xcopy failed
    pause & exit /b 1
)
echo        Done.

:: ─── 4. nginx ─────────────────────────────────────────────────────────────────

echo [4/6] Starting nginx ...
tasklist 2>nul | find /i "nginx.exe" >nul
if not errorlevel 1 (
    echo        Already running -- reloading config ...
    "%NGINX_DIR%\nginx.exe" -s reload
) else (
    start "" /d "%NGINX_DIR%" "%NGINX_DIR%\nginx.exe"
)
echo        Done.

:: ─── 5. Django / Daphne ───────────────────────────────────────────────────────

echo [5/6] Starting Django (Daphne) ...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
start "ionik-django" cmd /k ^"cd /d "%DJANGO_DIR%" ^&^& "%PYTHON%" manage.py migrate --noinput ^&^& "%PYTHON%" -m daphne -b 0.0.0.0 -p 8000 ionik_server.asgi:application^"
echo        Done.

:: ─── 6. STUN / TURN server (pion turn — native Windows) ─────────────────────

echo [6/6] Starting STUN/TURN server (pion turn) ...

:: Build turn-server.exe if missing
if not exist "%TURN_EXE%" (
    echo        turn-server.exe not found -- building from Go sources ...
    if not exist "%GO_EXE%" (
        echo [ERROR] Go not installed at %GO_EXE%
        echo  Fix: winget install GoLang.Go
        pause & exit /b 1
    )
    pushd "%TURN_DIR%"
    "%GO_EXE%" mod tidy
    "%GO_EXE%" build -o turn-server.exe .
    popd
    if not exist "%TURN_EXE%" (
        echo [ERROR] go build failed
        pause & exit /b 1
    )
    echo        Build OK.
)

:: Stop anything currently bound to 3478
powershell -NoProfile -Command "Get-NetUDPEndpoint -LocalPort 3478 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3478 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
wsl -d Ubuntu -u root -- bash -c "systemctl stop coturn 2>/dev/null; killall -9 turnserver 2>/dev/null; exit 0" >nul 2>&1
timeout /t 2 >nul
start "ionik-turn" "%TURN_EXE%" -public-ip 89.208.74.21 -port 3478 -realm ionik.local -users ionikuser=ionikturn123 -relay-min 49160 -relay-max 49200
echo        Done.

:: ─── Summary ──────────────────────────────────────────────────────────────────

echo.
echo  ==========================================
echo    All services running:
echo      UI (nginx)  ^>  http://localhost:8084
echo      API         ^>  http://localhost:8000
echo      STUN/TURN   ^>  localhost:3478
echo  ==========================================
echo.
echo  Press any key to stop all services and exit...
pause >nul

:: ─── Shutdown ─────────────────────────────────────────────────────────────────

echo.
echo Stopping services...
taskkill /f /fi "windowtitle eq ionik-django*" >nul 2>&1
taskkill /f /fi "windowtitle eq ionik-turn*"   >nul 2>&1
"%NGINX_DIR%\nginx.exe" -s stop                >nul 2>&1
echo Done. Bye!
timeout /t 2 >nul

endlocal
