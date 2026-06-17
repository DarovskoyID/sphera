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
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manage = Join-Path $here '..\ionik_server\manage.py'

# Выбираем python из виртуального окружения, если он есть
$venvPy = Join-Path $here '..\myenv\Scripts\python.exe'
$py = if (Test-Path $venvPy) { $venvPy } else { 'python' }

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

$args = @($manage, 'seed_load')
if ($cfg.ContainsKey('ACCOUNTS'))        { $args += '--accounts';        $args += $cfg['ACCOUNTS'] }
if ($cfg.ContainsKey('SERVERS'))         { $args += '--servers';         $args += $cfg['SERVERS'] }
if ($cfg.ContainsKey('CHANNELS'))        { $args += '--channels';        $args += $cfg['CHANNELS'] }
if ($cfg.ContainsKey('POSTS'))           { $args += '--posts';           $args += $cfg['POSTS'] }
if ($cfg.ContainsKey('SERVER_MESSAGES')) { $args += '--server-messages'; $args += $cfg['SERVER_MESSAGES'] }
if ($cfg.ContainsKey('DM_MESSAGES'))     { $args += '--dm-messages';     $args += $cfg['DM_MESSAGES'] }

Write-Host "Профиль: $Profile" -ForegroundColor Cyan
& $py @args
