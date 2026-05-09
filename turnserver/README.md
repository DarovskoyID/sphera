# Свой TURN/STUN сервер (coturn)

## Запуск

```cmd
cd D:\ionik-all\turnserver
docker compose up -d
docker compose logs -f
```

## Открой порты в Windows Firewall

```powershell
# PowerShell от администратора:
New-NetFirewallRule -DisplayName "coturn UDP 3478" -Direction Inbound -Protocol UDP -LocalPort 3478 -Action Allow
New-NetFirewallRule -DisplayName "coturn TCP 3478" -Direction Inbound -Protocol TCP -LocalPort 3478 -Action Allow
New-NetFirewallRule -DisplayName "coturn UDP 5349" -Direction Inbound -Protocol UDP -LocalPort 5349 -Action Allow
New-NetFirewallRule -DisplayName "coturn TCP 5349" -Direction Inbound -Protocol TCP -LocalPort 5349 -Action Allow
New-NetFirewallRule -DisplayName "coturn UDP relay" -Direction Inbound -Protocol UDP -LocalPort 49160-49200 -Action Allow
```

И на роутере (если сервер за NAT) проброс этих же портов на ip Windows-машины.

## Проверка работы

```cmd
# Простая STUN-проверка
curl --stun-uri stun:bottomweb.ru:3478 -v https://bottomweb.ru
```

Или открой в браузере **trickle-ice tester**: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

Введи:
- URI: `turn:bottomweb.ru:3478`
- Username: `ionikuser`
- Password: `ionikturn123`

Жми "Add Server" → "Gather candidates". В таблице должны появиться кандидаты типа `relay`. Если есть — TURN работает.

## Изменить пароль / добавить пользователей

Открой `turnserver.conf`, измени строку `user=...` или добавь несколько:
```
user=alice:secret1
user=bob:secret2
```
Затем `docker compose restart coturn`.

## Безопасность

- Пароль `ionikturn123` тестовый — поменяй на свой.
- Лимит relay-портов 49160-49200 (40 портов = ~20 одновременных пар). Расширь при необходимости.
- TURN over TLS на 5349 (использует тот же cert/pkey что HTTPS).
