@echo off
setlocal EnableDelayedExpansion

set "ROOT=%~dp0..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "DJANGO_DIR=%ROOT%\django-server"
set "PYTHON=%DJANGO_DIR%\myenv\Scripts\python.exe"
set "PIP=%DJANGO_DIR%\myenv\Scripts\pip.exe"
set "REQ_UTF8=%TEMP%\sfera-requirements-%RANDOM%.txt"
set "DOCKER_ENV=%DJANGO_DIR%\.env"
set "INSTALL_COTURN=1"
set "INSTALL_SYSTEM=1"

if /i "%~1"=="--skip-coturn" set "INSTALL_COTURN=0"
if /i "%~1"=="--skip-system" set "INSTALL_SYSTEM=0"
if /i "%~1"=="--help" goto :help
if /i "%~1"=="-h" goto :help
if not "%~1"=="" if /i not "%~1"=="--skip-coturn" if /i not "%~1"=="--skip-system" (
    echo Unknown option: %~1
    echo Run with --help for usage.
    exit /b 1
)

echo.
echo  ==========================================
echo    Installing sfera dependencies
echo  ==========================================
echo.
echo  Project root: %ROOT%
echo.

if "%INSTALL_SYSTEM%"=="1" (
    call :install_system_tools
    if errorlevel 1 exit /b 1
) else (
    echo [INFO] Skipping system tools.
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found after system install.
    exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] python not found after system install.
    exit /b 1
)

echo [1/4] Installing root Node dependencies ...
cd /d "%ROOT%"
call npm install
if errorlevel 1 exit /b 1
echo        Done.

echo [2/4] Installing Django Python dependencies ...
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

echo [3/4] Starting Docker services (Redis, Kafka, ws-gateway, load balancer) ...
where docker >nul 2>&1
if errorlevel 1 (
    echo [WARN] Docker not found. Install Docker Desktop to run Redis and Kafka.
    echo        Without Docker, the app will use InMemoryChannelLayer (unreliable).
) else (
    cd /d "%DJANGO_DIR%"
    call :ensure_docker_env
    docker compose up -d --build redis kafka zookeeper kafka-init prometheus grafana ws-gateway loadbalancer
    echo        Done.
)

echo [4/4] Installing coturn ...
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
echo Usage: scripts\windows\install-deps.bat [--skip-coturn] [--skip-system]
echo.
echo Installs Node.js/npm, Python/pip, project npm packages,
echo Django Python packages, Docker services, and coturn via WSL.
exit /b 0

:ensure_docker_env
if not exist "%DOCKER_ENV%" (
    >"%DOCKER_ENV%" echo # Generated automatically. Do not commit.
)
call :ensure_env_key GRAFANA_PASSWORD random
call :ensure_env_key POSTGRES_PASSWORD random
call :ensure_env_key JWT_SECRET fixed
exit /b 0

:ensure_env_key
findstr /b /c:"%~1=" "%DOCKER_ENV%" >nul 2>&1
if not errorlevel 1 exit /b 0
if /i "%~2"=="fixed" (
    >>"%DOCKER_ENV%" echo %~1=sfera-local-development-secret-key-not-for-production
    exit /b 0
)
for /f "usebackq delims=" %%S in (`powershell -NoProfile -Command "[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).Replace('/','').Replace('+','').Replace('=','')"`) do set "ENV_VALUE=%%S"
>>"%DOCKER_ENV%" echo %~1=!ENV_VALUE!
exit /b 0

:install_system_tools
echo [0/5] Installing system tools ...

where winget >nul 2>&1
if errorlevel 1 (
    echo [ERROR] winget not found. Install App Installer from Microsoft Store,
    echo         or install Node.js, Python and WSL manually.
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if errorlevel 1 exit /b 1
)
set "PATH=%PATH%;%ProgramFiles%\nodejs"

where python >nul 2>&1
if errorlevel 1 (
    winget install --id Python.Python.3.11 --exact --accept-package-agreements --accept-source-agreements
    if errorlevel 1 exit /b 1
)
set "PATH=%PATH%;%LocalAppData%\Programs\Python\Python311;%LocalAppData%\Programs\Python\Python311\Scripts"

where wsl >nul 2>&1
if errorlevel 1 (
    echo [WARN] WSL is not installed. coturn installer requires WSL Ubuntu.
    echo        Run: wsl --install
)

where docker >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installing Docker Desktop ...
    winget install --id Docker.DockerDesktop --exact --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo [WARN] Docker install failed. Install manually from https://docker.com
    ) else (
        echo        Docker installed. Open Docker Desktop to finish setup.
    )
)

echo        Done.
exit /b 0
