# Горизонтальное масштабирование (добавление нод)

Главный сервер держит всё состояние (Postgres, Redis, Kafka, Elasticsearch),
балансировщик и мониторинг. **Доп-нода запускает только `ws-gateway`** — это и
есть то, что балансирует LB и что упирается в потолок по WebSocket-соединениям.
Ноды синхронизируются между собой через Redis pub/sub главного сервера; LB на
ноде НЕ нужен.

Связь между серверами — приватный **WireGuard VPN** (Redis/Kafka наружу не
торчат, ходят только внутри VPN).

```
                 Интернет (WSS :8001, API :8000)
                          │
                 [ГЛАВНЫЙ СЕРВЕР]
                 nginx → loadbalancer (servers.conf)
                 ├── ws-gateway (нода-0)
                 ├── Daphne API, Postgres, Redis, Kafka, ES, мониторинг
                 │        ▲ Redis :6379 / Kafka :9094  (только по WG 10.77.0.1)
                 │        │  WireGuard
                 └────────┼───────────────► [НОДА-2] ws-gateway (10.77.0.2)
                          └ LB → 10.77.0.2:8001 (по WG)
```

## Одноразово на ГЛАВНОМ сервере

```bash
cd /root/ionik
# 1. Поднять WireGuard-хаб
sudo bash scripts/linux/wg-hub.sh install      # запомни вывод: HUB public key + endpoint

# 2. Открыть Redis/Kafka в VPN (пересоздаёт redis+kafka, ~10с даунтайма)
cd django-server
IONIK_WG_HUB_IP=10.77.0.1 docker compose \
  -f docker-compose.yml -f docker-compose.cluster.yml up -d redis kafka

# 3. Узнать JWT-секрет (понадобится на ноде)
sudo sed -n 's/^IONIK_SECRET_KEY=//p' /etc/ionik/secrets.env
```
Открой UDP-порт **51820** на главном у хостера (если есть внешний фаервол).

## На каждой ДОП-НОДЕ

```bash
git clone <repo> /root/ionik && cd /root/ionik
sudo bash scripts/install-deps.sh --skip-coturn   # нужен только docker (+ сборка ws-gateway)

# 1. Подключить в VPN (значения — из вывода wg-hub.sh info на главном)
sudo IONIK_WG_HUB_PUBKEY='<HUB pubkey>' \
     IONIK_WG_HUB_ENDPOINT='<публ. IP главного>:51820' \
     IONIK_WG_NODE_IP=10.77.0.2 \
     bash scripts/linux/wg-node.sh                 # выведет NODE public key

# 2. На ГЛАВНОМ зарегистрировать пира (один раз):
#    sudo bash scripts/linux/wg-hub.sh add-peer <NODE pubkey> 10.77.0.2
#    проверь: ping 10.77.0.1 с ноды

# 3. Конфиг ноды
sudo mkdir -p /etc/ionik
sudo cp scripts/linux/node.env.example /etc/ionik/node.env
sudo nano /etc/ionik/node.env       # впиши JWT_SECRET (= IONIK_SECRET_KEY главного), IP'шники
sudo chmod 600 /etc/ionik/node.env

# 4. Поднять ws-gateway
bash scripts/linux/node-up.sh
```

## Зарегистрировать ноду в балансировщике (на ГЛАВНОМ)

```bash
cd /root/ionik
echo 'server 10.77.0.2:8001 max_fails=3 fail_timeout=10s;' >> loadbalancer/servers.conf
cd django-server && docker compose exec loadbalancer nginx -s reload
```

Готово — трафик WebSocket пойдёт на обе ноды, сообщения между ними летят через
Redis pub/sub. Для следующей ноды повторяй блок «На ДОП-НОДЕ» с IP `10.77.0.3` и т.д.

## Проверка
- С ноды: `ping 10.77.0.1`, `redis-cli -h 10.77.0.1 ping` (PONG).
- С главного: `curl -s http://10.77.0.2:8001/metrics | head` (метрики ноды).
- LB: `docker compose exec loadbalancer curl -s localhost:8001/lb-health`.

## Важно
- **`JWT_SECRET` ноды = `IONIK_SECRET_KEY` главного.** Иначе ws-gateway отвергнет все токены (403/закрытие WS). При ротации секрета на главном — обнови `/etc/ionik/node.env` и перезапусти `node-up.sh`.
- Redis/Kafka слушают только на `10.77.0.1` (WG) и `127.0.0.1` — в интернет не выставлены.
- `kafka_worker`/Daphne на ноду не выносим (упор в WS-соединения снимает именно ws-gateway). Если упрётесь в запись в БД — отдельно масштабируется `kafka_worker` (нужен доступ к Postgres по WG).
