@echo off
setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "DJANGO_DIR=%ROOT%\django-server"
set "STUN_DIR=%ROOT%\stun-server"
set "TURN_DIR=%ROOT%\turn-server-go"
set "PYTHON=%DJANGO_DIR%\myenv\Scripts\python.exe"
set "PIP=%DJANGO_DIR%\myenv\Scripts\pip.exe"
set "REQ_UTF8=%TEMP%\ionik-requirements-%RANDOM%.txt"
set "INSTALL_COTURN=1"

if /i "%~1"=="--skip-coturn" set "INSTALL_COTURN=0"
if /i "%~1"=="--help" goto :help
if /i "%~1"=="-h" goto :help
if not "%~1"=="" if /i not "%~1"=="--skip-coturn" (
    echo Unknown option: %~1
    echo Run with --help for usage.
    exit /b 1
)

echo.
echo  ==========================================
echo    Installing ionik dependencies
echo  ==========================================
echo.
echo  Project root: %ROOT%
echo.

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found. Install Node.js from https://nodejs.org
    exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] python not found. Install Python 3.11+ and add it to PATH.
    exit /b 1
)

echo [1/5] Installing root Node dependencies ...
cd /d "%ROOT%"
if exist package-lock.json (
    call npm ci
) else (
    call npm install
)
if errorlevel 1 exit /b 1
echo        Done.

echo [2/5] Installing stun-server Node dependencies ...
cd /d "%STUN_DIR%"
if exist package-lock.json (
    call npm ci
) else (
    call npm install
)
if errorlevel 1 exit /b 1
echo        Done.

echo [3/5] Installing Django Python dependencies ...
cd /d "%DJANGO_DIR%"
if not exist "%PYTHON%" (
    python -m venv myenv
    if errorlevel 1 exit /b 1
)
"%PYTHON%" -m pip install --upgrade pip
if errorlevel 1 exit /b 1
"%PYTHON%" -c "import pathlib, sys; p=pathlib.Path(sys.argv[1]); d=p.read_bytes(); t=d.decode('utf-16') if d.startswith((b'\xff\xfe', b'\xfe\xff')) else d.decode('utf-8-sig'); pathlib.Path(sys.argv[2]).write_text(t, encoding='utf-8', newline='\n')" "%DJANGO_DIR%\requirements.txt" "%REQ_UTF8%"
if errorlevel 1 exit /b 1
"%PIP%" install -r "%REQ_UTF8%"
set "PIP_STATUS=%ERRORLEVEL%"
del /f /q "%REQ_UTF8%" >nul 2>&1
if not "%PIP_STATUS%"=="0" exit /b %PIP_STATUS%
echo        Done.

echo [4/5] Downloading Go modules ...
where go >nul 2>&1
if errorlevel 1 (
    echo        Skipped: Go not found. Install Go 1.21+ if you need turn-server-go.
) else (
    cd /d "%TURN_DIR%"
    go mod download
    if errorlevel 1 exit /b 1
    echo        Done.
)

echo [5/5] Installing coturn ...
if "%INSTALL_COTURN%"=="1" (
    call "%~dp0coturn-install.bat"
    if errorlevel 1 exit /b 1
) else (
    echo        Skipped.
)

echo.
echo  ==========================================
echo    Dependencies installed.
echo    Next: run scripts\windows\start-all.bat
echo  ==========================================
echo.
exit /b 0

:help
echo Usage: scripts\windows\install-deps.bat [--skip-coturn]
echo.
echo Installs dependencies for the root app, stun-server, Django, Go modules,
echo and coturn via scripts\windows\coturn-install.bat.
exit /b 0
