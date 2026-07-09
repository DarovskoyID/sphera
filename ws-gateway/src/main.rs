mod auth;
mod hub;
mod kafka;
mod redis_pubsub;
mod handlers;
mod metrics;

use std::sync::Arc;
use axum::{Router, routing::get};
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub hub: hub::Hub,
    pub kafka_producer: kafka::KafkaProducer,
    pub jwt_secret: String,
    pub redis_url: String,
    pub django_authz_url: String,
    pub http_client: reqwest::Client,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let jwt_secret = std::env::var("JWT_SECRET")
        .or_else(|_| std::env::var("SFERA_SECRET_KEY"))
        .unwrap_or_else(|_| "sfera-local-development-secret-key-not-for-production".into());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());
    let kafka_brokers = std::env::var("KAFKA_BOOTSTRAP_SERVERS").unwrap_or_else(|_| "localhost:9092".into());
    let bind_addr = std::env::var("WS_BIND").unwrap_or_else(|_| "0.0.0.0:8001".into());
    // In prod this comes from the env (set by start-common.sh -> .env). The default
    // targets the public nginx API because Daphne binds 127.0.0.1 and is unreachable
    // from inside the container via the docker gateway.
    let django_authz_url = std::env::var("DJANGO_WS_AUTHZ_URL")
        .unwrap_or_else(|_| "https://start-ionik.ru:8000/api/ws/authorize/".into());

    let kafka_producer = kafka::KafkaProducer::new(&kafka_brokers);
    let hub = hub::Hub::new();

    let state = Arc::new(AppState {
        hub,
        kafka_producer,
        jwt_secret,
        redis_url: redis_url.clone(),
        django_authz_url,
        http_client: reqwest::Client::new(),
    });

    // Spawn Redis subscriber that fans out messages to connected WS clients
    let sub_state = state.clone();
    tokio::spawn(async move {
        redis_pubsub::subscribe_loop(sub_state).await;
    });

    let app = Router::new()
        .route("/ws/chat/{conversation_id}/", get(handlers::chat_ws))
        .route("/ws/guild/{guild_id}/channel/{channel_id}/", get(handlers::guild_ws))
        .route("/health", get(|| async { "ok" }))
        .route("/metrics", get(|| async { metrics::render() }))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await.unwrap();
    tracing::info!("WS gateway listening on {}", bind_addr);
    axum::serve(listener, app).await.unwrap();
}
