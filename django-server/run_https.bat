@echo off
REM ─── Run Daphne (Django ASGI) with TLS ───────────────────────────────────────
REM Сертификаты лежат в D:\nginx-1.29.8\ssl\
REM   fullchain.pem  — публичный сертификат (chain)
REM   privkey.pem    — приватный ключ
REM
REM Запуск:  D:\sfera-all\django-server\run_https.bat
REM Сервер слушает 0.0.0.0:8000 по HTTPS/WSS.
REM Подключение:  https://bottomweb.ru:8000   /   wss://bottomweb.ru:8000/ws/...

setlocal

set BASE=%~dp0
set CERT=D:\nginx-1.29.8\ssl\fullchain.pem
set KEY=D:\nginx-1.29.8\ssl\privkey.pem
set PYTHON=%BASE%myenv\Scripts\python.exe

REM Twisted endpoint description treats backslash as a generic escape char,
REM so EVERY backslash in the path must be doubled, and the drive-letter
REM colon is escaped as \:
set CERT_ESC=D\:\\nginx-1.29.8\\ssl\\fullchain.pem
set KEY_ESC=D\:\\nginx-1.29.8\\ssl\\privkey.pem

if not exist "%CERT%" (
    echo [ERROR] Не найден сертификат: %CERT%
    exit /b 1
)
if not exist "%KEY%" (
    echo [ERROR] Не найден приватный ключ: %KEY%
    exit /b 1
)
if not exist "%PYTHON%" (
    echo [ERROR] Виртуальное окружение не найдено: %PYTHON%
    exit /b 1
)

cd /d "%BASE%sfera_server"

REM Применяем миграции на всякий случай
"%PYTHON%" manage.py migrate --noinput

REM Запускаем Daphne с TLS endpoint (двоеточия в путях экранированы)
"%PYTHON%" -m daphne ^
  -e "ssl:8000:privateKey=%KEY_ESC%:certKey=%CERT_ESC%" ^
  sfera_server.asgi:application

endlocal
