@echo off
setlocal

:: ─────────────────────────────────────────────────────────────────────────────
:: setup-coturn.bat — installs and configures coturn (STUN+TURN) in WSL Ubuntu
::
:: Idempotent: safe to re-run, won't duplicate users or break existing setup.
:: After this, start-all.bat will be able to launch coturn from WSL.
:: ─────────────────────────────────────────────────────────────────────────────

set "PUBLIC_IP=89.208.74.21"
set "REALM=bottomweb.ru"
set "TURN_USER=sferauser"
set "TURN_PASS=sferaturn123"
set "MIN_PORT=35000"
set "MAX_PORT=35004"
set "CERT_PATH=/mnt/d/nginx-1.29.8/ssl/fullchain.pem"
set "PKEY_PATH=/mnt/d/nginx-1.29.8/ssl/privkey.pem"

echo.
echo  ==========================================
echo    coturn (STUN/TURN) installer for WSL
echo  ==========================================
echo.
echo   Public IP : %PUBLIC_IP%
echo   Realm     : %REALM%
echo   User      : %TURN_USER%
echo   Pass      : %TURN_PASS%
echo   Ports     : 3478 (STUN/TURN), 5349 (TLS), %MIN_PORT%-%MAX_PORT% (relay)
echo.

:: ─── Check WSL is available ───────────────────────────────────────────────────

wsl -e bash -c "echo wsl_ok" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] WSL not available. Install Ubuntu via 'wsl --install' first.
    pause & exit /b 1
)

:: ─── Install coturn ───────────────────────────────────────────────────────────

echo [1/4] Installing coturn package ...
wsl -e bash -c "which turnserver >/dev/null 2>&1 || sudo apt-get update -qq && sudo apt-get install -y coturn sqlite3"
if errorlevel 1 (
    echo [ERROR] apt-get install failed. Run manually:
    echo         wsl sudo apt update ^&^& sudo apt install -y coturn sqlite3
    pause & exit /b 1
)
wsl -e bash -c "which turnserver" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] turnserver still not found after install.
    pause & exit /b 1
)
echo        Done.

:: ─── Write turnserver.conf ────────────────────────────────────────────────────

echo [2/4] Writing ~/turnserver.conf in WSL ...
wsl -e bash -c "cat > ~/turnserver.conf << 'EOF'
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=%PUBLIC_IP%
min-port=%MIN_PORT%
max-port=%MAX_PORT%
realm=%REALM%
lt-cred-mech
cert=%CERT_PATH%
pkey=%PKEY_PATH%
no-cli
fingerprint
userdb=/home/$(whoami)/turndb
EOF"
echo        Done.

:: ─── Create / verify TURN user in SQLite ──────────────────────────────────────

echo [3/4] Ensuring user '%TURN_USER%' exists in SQLite DB ...
wsl -e bash -c "test -s ~/turndb && sqlite3 ~/turndb 'SELECT 1 FROM turnusers_lt WHERE name=\"%TURN_USER%\" LIMIT 1' 2>/dev/null | grep -q 1 || turnadmin -a -u %TURN_USER% -r %REALM% -p %TURN_PASS% -b ~/turndb >/dev/null 2>&1"
wsl -e bash -c "sqlite3 ~/turndb 'SELECT realm,name FROM turnusers_lt'"
echo        Done.

:: ─── Smoke test ───────────────────────────────────────────────────────────────

echo [4/4] Smoke test: start coturn for 3 seconds ...
wsl -e bash -c "pkill -9 turnserver 2>/dev/null; sleep 1; turnserver -c ~/turnserver.conf > ~/coturn.log 2>&1 & sleep 2; if pgrep turnserver >/dev/null; then echo OK: coturn started; pkill turnserver; else echo FAIL: see ~/coturn.log; fi"

echo.
echo  ==========================================
echo    Installation complete.
echo
echo    Run start-all.bat to launch the full stack.
echo    Coturn will listen on:
echo      - UDP/TCP %PUBLIC_IP%:3478  (STUN+TURN)
echo      - UDP/TCP %PUBLIC_IP%:5349  (TURN over TLS)
echo      - UDP %PUBLIC_IP%:%MIN_PORT%-%MAX_PORT% (relay)
echo
echo    Don't forget to forward these ports in router and Windows Firewall:
echo      UDP 3478, UDP %MIN_PORT%-%MAX_PORT%
echo  ==========================================
echo.
pause

endlocal
