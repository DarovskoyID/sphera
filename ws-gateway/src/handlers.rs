use std::sync::Arc;
use axum::{
    extract::{Path, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::HeaderMap,
    response::IntoResponse,
    http::StatusCode,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

use crate::AppState;
use crate::auth;
use crate::redis_pubsub;
use crate::metrics;

fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("sec-websocket-protocol")?.to_str().ok()?;
    let protocols: Vec<&str> = raw.split(',').map(str::trim).collect();
    let idx = protocols.iter().position(|p| *p == "sfera.jwt")?;
    protocols.get(idx + 1).map(|token| token.to_string())
}

async fn authorize_ws(state: &AppState, token: &str, payload: Value) -> bool {
    match state.http_client
        .post(&state.django_authz_url)
        .bearer_auth(token)
        .header("X-Sfera-Client", "1")
        .json(&payload)
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(err) => {
            tracing::warn!("Django WS authorization failed: {}", err);
            false
        }
    }
}

// ── Chat WebSocket ──────────────────────────────────────────────────────────

pub async fn chat_ws(
    ws: WebSocketUpgrade,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let token = token_from_headers(&headers);
    let Some(token) = token else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let claims = match auth::validate_token(&token, &state.jwt_secret) {
        Some(c) => c,
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };
    if !authorize_ws(
        &state,
        &token,
        json!({"type": "chat", "conversation_id": conversation_id.clone()}),
    ).await {
        return StatusCode::FORBIDDEN.into_response();
    }

    ws.protocols(["sfera.jwt"])
        .on_upgrade(move |socket| handle_chat(socket, state, conversation_id, claims.user_id))
}

async fn handle_chat(socket: WebSocket, state: Arc<AppState>, conversation_id: String, user_id: String) {
    metrics::conn_open();
    let room = format!("chat_{}", conversation_id);
    let mut rx = state.hub.join(&room, &user_id);

    let (mut sink, mut stream) = socket.split();

    // Task: forward Hub broadcasts → WS client
    let room_clone = room.clone();
    let sink_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    if sink.send(Message::Text(msg.to_string().into())).await.is_err() {
                        break;
                    }
                    metrics::inc(&metrics::MESSAGES_OUT);
                }
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!("Client lagged {} messages in {}", n, room_clone);
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    // Task: WS client messages → Kafka + Redis broadcast
    let state2 = state.clone();
    let room2 = room.clone();
    let user_id2 = user_id.clone();
    let conv_id2 = conversation_id.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => {
                    handle_chat_message(&state2, &room2, &conv_id2, &user_id2, &text).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Wait for either task to finish
    tokio::select! {
        _ = sink_task => {}
        _ = recv_task => {}
    }

    state.hub.leave(&room, &user_id);
    metrics::conn_close();
    tracing::debug!("Chat WS closed: user={} room={}", user_id, room);
}

async fn handle_chat_message(
    state: &Arc<AppState>,
    room: &str,
    conversation_id: &str,
    user_id: &str,
    text: &str,
) {
    let data: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    // Handle mark_read — pass through to Django via Redis
    if data.get("type").and_then(|v| v.as_str()) == Some("mark_read") {
        let _ = redis_pubsub::publish(
            &state.redis_url,
            &format!("chat_cmd_{}", conversation_id),
            text,
        ).await;
        return;
    }

    let content = data.get("message").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let nonce = data.get("nonce").and_then(|v| v.as_str()).map(|s| s.to_string());
    let attachment_ids: Vec<Value> = data.get("attachment_ids")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let reply_to_id = data.get("reply_to_id").cloned();

    if content.is_empty() && attachment_ids.is_empty() {
        return;
    }

    let msg_id = Uuid::new_v4().to_string();
    let now = chrono_now();

    // Build WS broadcast payload
    let mut msg_payload = json!({
        "id": msg_id,
        "author": {
            "id": user_id,
        },
        "content": content,
        "created_at": now,
        "attachments": [],
        "reply_to": null,
        "is_pinned": false,
    });

    if let Some(ref n) = nonce {
        msg_payload["nonce"] = json!(n);
    }

    // Forward reply_to_id so receivers can resolve the reply preview locally
    // (the full reply_to object is only filled in by the REST reload).
    if let Some(ref r) = reply_to_id {
        if !r.is_null() {
            msg_payload["reply_to_id"] = r.clone();
        }
    }

    let payload_str = msg_payload.to_string();

    metrics::inc(&metrics::CHAT_MESSAGES_IN);

    // 1) Broadcast to all local clients via Hub
    state.hub.broadcast(room, &payload_str);

    // 2) Publish to Redis for other gateway instances
    let _ = redis_pubsub::publish(&state.redis_url, room, &payload_str).await;

    // 3) Publish to Kafka for DB persistence
    let kafka_payload = json!({
        "msg_id": msg_id,
        "conversation_id": conversation_id,
        "author_id": user_id,
        "content": content,
        "attachment_ids": attachment_ids,
        "reply_to_id": reply_to_id,
    });

    state.kafka_producer.publish(
        "chat.messages",
        conversation_id,
        &kafka_payload.to_string(),
    ).await;
}

// ── Guild WebSocket ─────────────────────────────────────────────────────────

pub async fn guild_ws(
    ws: WebSocketUpgrade,
    Path((guild_id, channel_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let token = token_from_headers(&headers);
    let Some(token) = token else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let claims = match auth::validate_token(&token, &state.jwt_secret) {
        Some(c) => c,
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };
    if !authorize_ws(
        &state,
        &token,
        json!({
            "type": "guild_channel",
            "guild_id": guild_id.clone(),
            "channel_id": channel_id.clone(),
        }),
    ).await {
        return StatusCode::FORBIDDEN.into_response();
    }

    ws.protocols(["sfera.jwt"])
        .on_upgrade(move |socket| handle_guild(socket, state, guild_id, channel_id, claims.user_id))
}

async fn handle_guild(
    socket: WebSocket,
    state: Arc<AppState>,
    guild_id: String,
    channel_id: String,
    user_id: String,
) {
    metrics::conn_open();
    let room = format!("guild_channel_{}", channel_id);
    let guild_room = format!("guild_{}", guild_id);
    let mut rx = state.hub.join(&room, &user_id);
    let mut guild_rx = state.hub.join(&guild_room, &user_id);

    let (mut sink, mut stream) = socket.split();

    // Forward broadcasts → client (from both channel and guild rooms)
    let sink_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                result = rx.recv() => {
                    match result {
                        Ok(msg) => {
                            if sink.send(Message::Text(msg.to_string().into())).await.is_err() {
                                break;
                            }
                            metrics::inc(&metrics::MESSAGES_OUT);
                        }
                        Err(RecvError::Lagged(n)) => {
                            tracing::warn!("Client lagged {} messages", n);
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
                result = guild_rx.recv() => {
                    match result {
                        Ok(msg) => {
                            if sink.send(Message::Text(msg.to_string().into())).await.is_err() {
                                break;
                            }
                            metrics::inc(&metrics::MESSAGES_OUT);
                        }
                        Err(RecvError::Lagged(_)) => {}
                        Err(RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    let state2 = state.clone();
    let room2 = room.clone();
    let user_id2 = user_id.clone();
    let channel_id2 = channel_id.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => {
                    handle_guild_message(&state2, &room2, &channel_id2, &user_id2, &text).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = sink_task => {}
        _ = recv_task => {}
    }

    state.hub.leave(&room, &user_id);
    state.hub.leave(&guild_room, &user_id);
    metrics::conn_close();
}

async fn handle_guild_message(
    state: &Arc<AppState>,
    room: &str,
    channel_id: &str,
    user_id: &str,
    text: &str,
) {
    let data: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    let content = data.get("message").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let nonce = data.get("nonce").and_then(|v| v.as_str()).map(|s| s.to_string());
    let attachment_ids: Vec<Value> = data.get("attachment_ids")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let reply_to_id = data.get("reply_to_id").cloned();

    if content.is_empty() && attachment_ids.is_empty() {
        return;
    }

    let msg_id = Uuid::new_v4().to_string();
    let now = chrono_now();

    let mut msg_payload = json!({
        "id": msg_id,
        "author": { "id": user_id },
        "content": content,
        "created_at": now,
        "attachments": [],
        "reply_to": null,
        "is_pinned": false,
    });

    if let Some(ref n) = nonce {
        msg_payload["nonce"] = json!(n);
    }

    // Forward reply_to_id so receivers can resolve the reply preview locally
    // (the full reply_to object is only filled in by the REST reload).
    if let Some(ref r) = reply_to_id {
        if !r.is_null() {
            msg_payload["reply_to_id"] = r.clone();
        }
    }

    let payload_str = msg_payload.to_string();

    metrics::inc(&metrics::GUILD_MESSAGES_IN);

    state.hub.broadcast(room, &payload_str);
    let _ = redis_pubsub::publish(&state.redis_url, room, &payload_str).await;

    let kafka_payload = json!({
        "msg_id": msg_id,
        "channel_id": channel_id,
        "author_id": user_id,
        "content": content,
        "attachment_ids": attachment_ids,
        "reply_to_id": reply_to_id,
    });

    state.kafka_producer.publish(
        "guild.messages",
        channel_id,
        &kafka_payload.to_string(),
    ).await;
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    // ISO 8601 UTC — good enough, no chrono dependency needed
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let h = time_secs / 3600;
    let m = (time_secs % 3600) / 60;
    let s = time_secs % 60;

    // Convert days since epoch to Y-M-D
    let (y, mo, d) = days_to_ymd(days as i64);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, mo, d, h, m, s, millis)
}

fn days_to_ymd(days: i64) -> (i64, i64, i64) {
    // Civil from days algorithm (Howard Hinnant)
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
