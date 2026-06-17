<#
  Запуск генератора тестовой нагрузки по профилю.

  Использование:
    .\run.ps1 light            # лёгкий профиль
    .\run.ps1 medium           # средний
    .\run.ps1 high             # высокий
    .\run.ps1 custom           # спросит N M H J K G интерактивно
    .\run.ps1 light -Purge     # сначала удалить старые тестовые данные

  Числа из профиля можно переопределить флагами:
    .\run.ps1 medium -Accounts 500 -DmMessages 20000
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('light', 'medium', 'high', 'custom')]
    [string]$Profile = 'light',

    [int]$Accounts, [int]$Servers, [int]$Channels,
    [int]$Posts, [int]$ServerMessages, [int]$DmMessages,
    [int]$SendDm, [string]$BaseUrl,
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Ищем manage.py — расположение load-tests может отличаться на разных машинах
$manage = $null
foreach ($c in @(
        '..\django-server\ionik_server\manage.py',
        '..\ionik_server\manage.py',
        'ionik_server\manage.py',
        'django-server\ionik_server\manage.py')) {
    $p = Join-Path $here $c
    if (Test-Path $p) { $manage = (Resolve-Path $p).Path; break }
}
if (-not $manage) {
    $manage = Get-ChildItem -Path $here\.. -Recurse -Depth 4 -Filter manage.py -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'ionik_server' } | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $manage) { throw 'Не найден manage.py (ionik_server). Запусти скрипт рядом с проектом.' }
$djangoRoot = Split-Path -Parent (Split-Path -Parent $manage)   # ...\django-server

# Выбираем python из виртуального окружения, если он есть
$py = 'python'
foreach ($c in @(
        (Join-Path $djangoRoot '.venv\Scripts\python.exe'),
        (Join-Path $djangoRoot 'myenv\Scripts\python.exe'))) {
    if (Test-Path $c) { $py = $c; break }
}

Write-Host "manage.py: $manage" -ForegroundColor DarkGray
Write-Host "python:    $py" -ForegroundColor DarkGray

if ($Purge) {
    & $py $manage seed_load --purge
}

$cfg = @{}
if ($Profile -ne 'custom') {
    $envFile = Join-Path $here "$Profile.env"
    if (-not (Test-Path $envFile)) { throw "Профиль не найден: $envFile" }
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_]+)\s*=\s*(\d+)') { $cfg[$matches[1]] = [int]$matches[2] }
    }
}

# Флаги командной строки переопределяют значения из профиля
if ($PSBoundParameters.ContainsKey('Accounts'))       { $cfg['ACCOUNTS'] = $Accounts }
if ($PSBoundParameters.ContainsKey('Servers'))        { $cfg['SERVERS'] = $Servers }
if ($PSBoundParameters.ContainsKey('Channels'))       { $cfg['CHANNELS'] = $Channels }
if ($PSBoundParameters.ContainsKey('Posts'))          { $cfg['POSTS'] = $Posts }
if ($PSBoundParameters.ContainsKey('ServerMessages')) { $cfg['SERVER_MESSAGES'] = $ServerMessages }
if ($PSBoundParameters.ContainsKey('DmMessages'))     { $cfg['DM_MESSAGES'] = $DmMessages }
if ($PSBoundParameters.ContainsKey('SendDm'))         { $cfg['SEND_DM'] = $SendDm }

$args = @($manage, 'seed_load')
if ($cfg.ContainsKey('ACCOUNTS'))        { $args += '--accounts';        $args += $cfg['ACCOUNTS'] }
if ($cfg.ContainsKey('SERVERS'))         { $args += '--servers';         $args += $cfg['SERVERS'] }
if ($cfg.ContainsKey('CHANNELS'))        { $args += '--channels';        $args += $cfg['CHANNELS'] }
if ($cfg.ContainsKey('POSTS'))           { $args += '--posts';           $args += $cfg['POSTS'] }
if ($cfg.ContainsKey('SERVER_MESSAGES')) { $args += '--server-messages'; $args += $cfg['SERVER_MESSAGES'] }
if ($cfg.ContainsKey('DM_MESSAGES'))     { $args += '--dm-messages';     $args += $cfg['DM_MESSAGES'] }
if ($cfg.ContainsKey('SEND_DM'))         { $args += '--send-dm';         $args += $cfg['SEND_DM'] }
if ($BaseUrl)                            { $args += '--base-url';        $args += $BaseUrl }

Write-Host "Профиль: $Profile" -ForegroundColor Cyan
& $py @args
