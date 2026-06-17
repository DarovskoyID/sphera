use std::sync::Arc;
use redis::AsyncCommands;
use crate::AppState;

/// Subscribes to Redis pub/sub channels and fans out to local WS clients via Hub.
/// Redis channels mirror the Django Channels group names:
///   chat_{conversation_id}, guild_channel_{channel_id}, user_{user_id}
pub async fn subscribe_loop(state: Arc<AppState>) {
    loop {
        if let Err(e) = run_subscriber(&state).await {
            tracing::error!("Redis subscriber error: {}, reconnecting in 2s...", e);
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }
}

async fn run_subscriber(state: &Arc<AppState>) -> redis::RedisResult<()> {
    let client = redis::Client::open(state.redis_url.as_str())?;
    let mut pubsub = client.get_async_pubsub().await?;

    // Subscribe to pattern to catch all chat/guild/user channels
    pubsub.psubscribe("chat_*").await?;
    pubsub.psubscribe("guild_channel_*").await?;
    pubsub.psubscribe("user_*").await?;

    tracing::info!("Redis subscriber connected");

    let mut stream = pubsub.into_on_message();

    use futures_util::StreamExt;
    while let Some(msg) = stream.next().await {
        let channel: String = msg.get_channel_name().to_string();
        let payload: String = match msg.get_payload() {
            Ok(p) => p,
            Err(_) => continue,
        };

        state.hub.broadcast(&channel, &payload);
    }

    Ok(())
}

/// Publish a message to a Redis channel (for broadcasting to other gateway instances)
pub async fn publish(redis_url: &str, channel: &str, message: &str) -> redis::RedisResult<()> {
    let client = redis::Client::open(redis_url)?;
    let mut conn = client.get_multiplexed_async_connection().await?;
    conn.publish::<_, _, ()>(channel, message).await?;
    Ok(())
}
