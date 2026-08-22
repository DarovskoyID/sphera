<#
  Запуск генератора тестовой нагрузки по профилю.

  Использование:
    .\run.ps1 light            # лёгкий профиль
    .\run.ps1 medium           # средний
    .\run.ps1 high             # высокий
    .\run.ps1 custom           # спросит N M H J K G интерактивно
    .\run.ps1 rate             # ЖИВАЯ нагрузка R сообщений/мин в течение -Duration
    .\run.ps1 light -Purge     # сначала удалить старые тестовые данные

  Числа из профиля можно переопределить флагами:
    .\run.ps1 medium -Accounts 500 -DmMessages 20000

  Живая нагрузка БЕЗ создания профилей (на готовых данных, нужен запущенный сервер):
    .\run.ps1 rate -Rate 600 -Duration 10m -RateTarget both -BaseUrl https://127.0.0.1:8000
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('light', 'medium', 'high', 'custom', 'rate')]
    [string]$Profile = 'light',

    [int]$Accounts, [int]$Servers, [int]$Channels,
    [int]$Posts, [int]$ServerMessages, [int]$DmMessages,
    [int]$SendDm, [string]$BaseUrl,
    [int]$BotApi, [ValidateSet('me', 'chats')][string]$BotApiEndpoint,
    [ValidateSet('standard', 'premium')][string]$BotApiTier, [int]$Concurrency,
    [int]$ActiveCalls, [string]$CallDuration, [string]$SignalingUrl, [string]$TurnHost,
    [switch]$WithVideo,
    [int]$Rate, [string]$Duration, [ValidateSet('guild', 'dm', 'both')][string]$RateTarget,
    [int]$Online, [int]$Calls,
    [int]$RateBots, [string]$StatusToken,
    [switch]$Purge,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
    @'
Генератор тестовой нагрузки sfera.

ИСПОЛЬЗОВАНИЕ:
  .\run.ps1 <профиль> [-Purge]
  .\run.ps1 rate [-Rate N -Duration 2m -RateTarget both -Online N -Calls N -CallDuration 2m]
  .\run.ps1 -Help

ПРОФИЛИ: light | medium | high | custom | rate
  light/medium/high  сидируют БД (аккаунты/серверы/каналы/сообщения)
  custom             интерактивный ввод чисел
  rate               живая нагрузка по ставке на готовых данных

ПАРАМЕТРЫ rate:
  -Rate N            сообщений/мин (600)
  -Duration 2m       длительность (30s/5m/1h)
  -RateTarget both   guild | dm | both
  -Online N          держать N онлайн-юзеров (presence)
  -Calls N           реальных WebRTC-звонков через TURN
  -CallDuration 2m   длительность звонков
  -BaseUrl URL       адрес сервера (https://127.0.0.1:8000)
  -Purge             сначала удалить старые тестовые данные

ПРИМЕРЫ:
  .\run.ps1 light
  .\run.ps1 medium -Purge
  .\run.ps1 rate -Rate 600 -Duration 2m -RateTarget both
  .\run.ps1 rate -Online 50 -Rate 600 -Duration 2m -Calls 5 -CallDuration 2m
'@ | Write-Host
    exit 0
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Ищем manage.py — расположение load-tests может отличаться на разных машинах
$manage = $null
foreach ($c in @(
        '..\django-server\sfera_server\manage.py',
        '..\sfera_server\manage.py',
        'sfera_server\manage.py',
        'django-server\sfera_server\manage.py')) {
    $p = Join-Path $here $c
    if (Test-Path $p) { $manage = (Resolve-Path $p).Path; break }
}
if (-not $manage) {
    $manage = Get-ChildItem -Path $here\.. -Recurse -Depth 4 -Filter manage.py -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'sfera_server' } | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $manage) { throw 'Не найден manage.py (sfera_server). Запусти скрипт рядом с проектом.' }
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
$callDur = $null
if ($Profile -eq 'rate') {
    # ЖИВАЯ нагрузка по ставке БЕЗ создания профилей: сидирование = 0.
    $cfg['ACCOUNTS'] = 0; $cfg['SERVERS'] = 0; $cfg['CHANNELS'] = 0
    $cfg['POSTS'] = 0; $cfg['SERVER_MESSAGES'] = 0; $cfg['DM_MESSAGES'] = 0
    $cfg['SEND_DM'] = 0
    $cfg['ACTIVE_CALLS'] = if ($PSBoundParameters.ContainsKey('Calls')) { $Calls } else { 0 }
    if (-not $PSBoundParameters.ContainsKey('Rate'))   { $Rate = 600 }
    if (-not $Duration)                                { $Duration = '10m' }
    if (-not $RateTarget)                              { $RateTarget = 'both' }
}
elseif ($Profile -ne 'custom') {
    $envFile = Join-Path $here "$Profile.env"
    if (-not (Test-Path $envFile)) { throw "Профиль не найден: $envFile" }
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_]+)\s*=\s*(\d+)\s*$') { $cfg[$matches[1]] = [int]$matches[2] }
        elseif ($_ -match '^\s*CALL_DURATION\s*=\s*(\S+)') { $callDur = $matches[1] }
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
if ($PSBoundParameters.ContainsKey('ActiveCalls'))    { $cfg['ACTIVE_CALLS'] = $ActiveCalls }
if ($CallDuration)                                    { $callDur = $CallDuration }

$args = @($manage, 'seed_load')
if ($cfg.ContainsKey('ACCOUNTS'))        { $args += '--accounts';        $args += $cfg['ACCOUNTS'] }
if ($cfg.ContainsKey('SERVERS'))         { $args += '--servers';         $args += $cfg['SERVERS'] }
if ($cfg.ContainsKey('CHANNELS'))        { $args += '--channels';        $args += $cfg['CHANNELS'] }
if ($cfg.ContainsKey('POSTS'))           { $args += '--posts';           $args += $cfg['POSTS'] }
if ($cfg.ContainsKey('SERVER_MESSAGES')) { $args += '--server-messages'; $args += $cfg['SERVER_MESSAGES'] }
if ($cfg.ContainsKey('DM_MESSAGES'))     { $args += '--dm-messages';     $args += $cfg['DM_MESSAGES'] }
if ($cfg.ContainsKey('SEND_DM'))         { $args += '--send-dm';         $args += $cfg['SEND_DM'] }
if ($cfg.ContainsKey('ACTIVE_CALLS'))    { $args += '--active-calls';    $args += $cfg['ACTIVE_CALLS'] }
if ($callDur)                            { $args += '--call-duration';   $args += $callDur }
# R — живая нагрузка по ставке (сообщений/мин в течение -Duration)
if ($Rate)                               { $args += '--rate';            $args += $Rate }
if ($Duration)                           { $args += '--duration';        $args += $Duration }
if ($RateTarget)                         { $args += '--rate-target';     $args += $RateTarget }
if ($Online)                             { $args += '--online';          $args += $Online }
# Трафик на bot API во время rate (по умолчанию 4 потока в самой команде; 0 = выключить)
if ($PSBoundParameters.ContainsKey('RateBots')) { $args += '--rate-bots'; $args += $RateBots }
if ($StatusToken)                        { $args += '--status-token';    $args += $StatusToken }
if ($BaseUrl)                            { $args += '--base-url';        $args += $BaseUrl }
if ($SignalingUrl)                       { $args += '--signaling-url';   $args += $SignalingUrl }
if ($TurnHost)                           { $args += '--turn-host';       $args += $TurnHost }
if ($WithVideo)                          { $args += '--with-video' }
# B — нагрузка на bot API (создаёт временного бота и обстреливает его)
if ($BotApi)                             { $args += '--bot-api';          $args += $BotApi }
if ($BotApiEndpoint)                     { $args += '--bot-api-endpoint'; $args += $BotApiEndpoint }
if ($BotApiTier)                         { $args += '--bot-api-tier';     $args += $BotApiTier }
if ($Concurrency)                        { $args += '--concurrency';      $args += $Concurrency }

Write-Host "Профиль: $Profile" -ForegroundColor Cyan
& $py @args
