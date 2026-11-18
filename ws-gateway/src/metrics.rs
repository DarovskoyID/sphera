//! Лёгкие Prometheus-метрики ws-gateway (без внешних крейтов — на атомиках).
//! Раздаются на GET /metrics в текстовом формате 0.0.4.
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

pub static WS_CONNECTIONS_TOTAL: AtomicU64 = AtomicU64::new(0); // всего принято соединений
pub static WS_ACTIVE: AtomicI64 = AtomicI64::new(0);            // открыто сейчас
pub static CHAT_MESSAGES_IN: AtomicU64 = AtomicU64::new(0);     // входящие чат-сообщения от клиентов
pub static GUILD_MESSAGES_IN: AtomicU64 = AtomicU64::new(0);    // входящие сообщения каналов
pub static MESSAGES_OUT: AtomicU64 = AtomicU64::new(0);         // разослано клиентам (sink)
pub static REDIS_RECEIVED: AtomicU64 = AtomicU64::new(0);       // получено из Redis pub/sub

#[inline]
pub fn inc(c: &AtomicU64) {
    c.fetch_add(1, Ordering::Relaxed);
}

#[inline]
pub fn conn_open() {
    WS_CONNECTIONS_TOTAL.fetch_add(1, Ordering::Relaxed);
    WS_ACTIVE.fetch_add(1, Ordering::Relaxed);
}

#[inline]
pub fn conn_close() {
    WS_ACTIVE.fetch_sub(1, Ordering::Relaxed);
}

pub fn render() -> String {
    format!(
        concat!(
            "# HELP wsgw_ws_connections_total Total WS connections accepted\n",
            "# TYPE wsgw_ws_connections_total counter\n",
            "wsgw_ws_connections_total {}\n",
            "# HELP wsgw_ws_active Currently open WS connections\n",
            "# TYPE wsgw_ws_active gauge\n",
            "wsgw_ws_active {}\n",
            "# HELP wsgw_chat_messages_in_total Chat messages received from clients\n",
            "# TYPE wsgw_chat_messages_in_total counter\n",
            "wsgw_chat_messages_in_total {}\n",
            "# HELP wsgw_guild_messages_in_total Guild channel messages received from clients\n",
            "# TYPE wsgw_guild_messages_in_total counter\n",
            "wsgw_guild_messages_in_total {}\n",
            "# HELP wsgw_messages_out_total Messages forwarded to clients\n",
            "# TYPE wsgw_messages_out_total counter\n",
            "wsgw_messages_out_total {}\n",
            "# HELP wsgw_redis_received_total Messages received from Redis pub/sub\n",
            "# TYPE wsgw_redis_received_total counter\n",
            "wsgw_redis_received_total {}\n",
        ),
        WS_CONNECTIONS_TOTAL.load(Ordering::Relaxed),
        WS_ACTIVE.load(Ordering::Relaxed),
        CHAT_MESSAGES_IN.load(Ordering::Relaxed),
        GUILD_MESSAGES_IN.load(Ordering::Relaxed),
        MESSAGES_OUT.load(Ordering::Relaxed),
        REDIS_RECEIVED.load(Ordering::Relaxed),
    )
}
