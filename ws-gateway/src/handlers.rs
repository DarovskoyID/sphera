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
    let idx = protocols.iter().position(|p| *p == "ionik.jwt")?;
    protocols.get(idx + 1).map(|token| token.to_string())
}

async fn authorize_ws(state: &AppState, token: &str, payload: Value) -> bool {
    match state.http_client
        .post(&state.django_authz_url)
        .bearer_auth(token)
        .header("X-Ionik-Client", "1")
        .timeout(std::time::Duration::from_secs(5))
        .json(&payload)
        .send()
        .await
    {
        Ok(response) => response.status().is_success() && response.json::<Value>().await.ok()
            .is_some_and(|body| body.get("ok").and_then(Value::as_bool) == Some(true)),
        Err(err) => {
            tracing::warn!("Django WS authorization failed: {}", err);
            false
        }
    }
}

async fn chat_mode(state: &AppState, token: &str, conversation_id: &str) -> Option<Value> {
    room_mode(state, token, json!({"type": "chat", "conversation_id": conversation_id})).await
}

async fn room_mode(state: &AppState, token: &str, payload: Value) -> Option<Value> {
    let response = state.http_client.post(&state.django_authz_url)
        .bearer_auth(token).header("X-Ionik-Client", "1")
        .timeout(std::time::Duration::from_secs(5))
        .json(&payload)
        .send().await.ok()?;
    if !response.status().is_success() { return None; }
    let mode = response.json::<Value>().await.ok()?;
    if mode.get("ok").and_then(Value::as_bool) != Some(true) { return None; }
    Some(mode)
}

async fn verified_guild_event(state: &AppState, token: &str, guild_id: &str, channel_id: &str, event: &Value) -> Option<Value> {
    let mode = room_mode(state, token, json!({"type": "guild_channel", "guild_id": guild_id, "channel_id": channel_id})).await?;
    if mode.get("mesh_history").and_then(Value::as_bool) != Some(true) { return Some(event.clone()); }
    if matches!(event.get("type").and_then(Value::as_str), Some("todo_update" | "poll_update" | "location_update")) { return None; }
    let edited = event.get("type").and_then(Value::as_str) == Some("message_edited");
    let message = if edited { event.get("message")? } else if event.get("author").is_some() && event.get("id").is_some() { event }
        else { return Some(event.clone()); };
    let identity = Uuid::parse_str(message.get("id")?.as_str()?).ok()?.to_string();
    let write_id = message.get("mesh_write_id")?.as_str()?;
    if write_id.len() != 64 || !write_id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) { return None; }
    let guild = Uuid::parse_str(guild_id).ok()?.to_string();
    let mut endpoint = reqwest::Url::parse(&state.django_authz_url).ok()?;
    endpoint.set_path(&format!("/api/guilds/{guild}/messages/{identity}/mesh-content/"));
    endpoint.set_query(None); endpoint.set_fragment(None);
    let response = state.http_client.get(endpoint).bearer_auth(token).header("X-Ionik-Client", "1")
        .timeout(std::time::Duration::from_secs(20)).send().await.ok()?;
    if response.status() != StatusCode::OK { return None; }
    let mut body = response.json::<Value>().await.ok()?;
    if body.get("id").and_then(Value::as_str) != Some(identity.as_str())
        || body.get("guild_id").and_then(Value::as_str) != Some(guild_id)
        || body.get("channel_id").and_then(Value::as_str) != Some(channel_id)
        || body.get("mesh_write_id").and_then(Value::as_str) != Some(write_id)
        || body.get("consensus_committed").and_then(Value::as_bool) != Some(true)
        || !body.get("author").is_some_and(Value::is_object) || !body.get("content").is_some_and(Value::is_string) { return None; }
    for field in ["nonce", "mesh_event_id", "mesh_revision"] {
        if let Some(value) = message.get(field).and_then(Value::as_str).filter(|value| value.len() <= 256) { body[field] = json!(value); }
    }
    Some(if edited { json!({"type": "message_edited", "message": body}) } else { body })
}

async fn verified_chat_event(state: &AppState, token: &str, conversation_id: &str, event: &Value) -> Option<Value> {
    let mode = chat_mode(state, token, conversation_id).await?;
    if mode.get("mesh_history").and_then(Value::as_bool) != Some(true) {
        return Some(event.clone());
    }
    if matches!(event.get("type").and_then(Value::as_str), Some("todo_update" | "poll_update" | "location_update")) { return None; }
    let edited = event.get("type").and_then(Value::as_str) == Some("message_edited");
    let message = if edited { event.get("message")? } else if event.get("author").is_some() && event.get("id").is_some() {
        event
    } else {
        return Some(event.clone());
    };
    let identity = Uuid::parse_str(message.get("id")?.as_str()?).ok()?.to_string();
    let write_id = message.get("mesh_write_id")?.as_str()?;
    if write_id.len() != 64 || !write_id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return None;
    }
    let mut endpoint = reqwest::Url::parse(&state.django_authz_url).ok()?;
    endpoint.set_path(&format!("/api/messages/{}/mesh-content/", identity));
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    let response = state.http_client.get(endpoint).bearer_auth(token)
        .header("X-Ionik-Client", "1").timeout(std::time::Duration::from_secs(20))
        .send().await.ok()?;
    if response.status() != StatusCode::OK { return None; }
    let mut body = response.json::<Value>().await.ok()?;
    if body.get("id").and_then(Value::as_str) != Some(identity.as_str())
        || body.get("conversation_id").and_then(Value::as_str) != Some(conversation_id)
        || body.get("mesh_write_id").and_then(Value::as_str) != Some(write_id)
        || body.get("consensus_committed").and_then(Value::as_bool) != Some(true)
        || !body.get("author").is_some_and(Value::is_object)
        || !body.get("content").is_some_and(Value::is_string) {
        return None;
    }
    // Correlation is separate from content: it cannot supply message bytes or
    // make an unconfirmed/currently unauthorized revision eligible for delivery.
    for field in ["nonce", "mesh_event_id", "mesh_revision"] {
        if let Some(value) = message.get(field).and_then(Value::as_str).filter(|value| value.len() <= 256) {
            body[field] = json!(value);
        }
    }
    Some(if edited { json!({"type": "message_edited", "message": body}) } else { body })
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

    ws.protocols(["ionik.jwt"])
        .on_upgrade(move |socket| handle_chat(socket, state, conversation_id, claims.user_id, token))
}

async fn handle_chat(socket: WebSocket, state: Arc<AppState>, conversation_id: String, user_id: String, token: String) {
    let mesh_bound = auth::validate_token(&token, &state.jwt_secret)
        .map(|claims| claims.mesh_session.is_some()).unwrap_or(false);
    metrics::conn_open();
    let room = format!("chat_{}", conversation_id);
    let mut rx = state.hub.join(&room, &user_id);
    // Django publishes `ban_<user_id>` when the superuser bans the account.
    let ban_room = format!("ban_{}", user_id);
    let mut ban_rx = state.hub.join(&ban_room, &user_id);
    let banned = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let banned_sink = banned.clone();
    // Replies meant only for this client (e.g. "your message was blocked").
    let (direct_tx, mut direct_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let (mut sink, mut stream) = socket.split();

    // Task: forward Hub broadcasts and direct replies → WS client
    let room_clone = room.clone();
    let session_state = state.clone();
    let session_token = token.clone();
    let session_conversation = conversation_id.clone();
    let mut sink_task = tokio::spawn(async move {
        let mut session_tick = tokio::time::interval(std::time::Duration::from_secs(2));
        loop {
            tokio::select! {
                _ = session_tick.tick(), if mesh_bound => {
                    if !authorize_ws(&session_state, &session_token, json!({"type": "mesh_session"})).await {
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                }
                ban = ban_rx.recv() => {
                    if let Ok(event) = ban {
                        banned_sink.store(true, std::sync::atomic::Ordering::SeqCst);
                        let _ = sink.send(Message::Text(event.to_string().into())).await;
                        let _ = sink.send(Message::Close(None)).await;
                    }
                    break;
                }
                direct = direct_rx.recv() => {
                    let Some(text) = direct else { break };
                    if mesh_bound && !authorize_ws(&session_state, &session_token, json!({"type": "mesh_session"})).await { break; }
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                received = rx.recv() => match received {
                    Ok(msg) => {
                        let Ok(event) = serde_json::from_str::<Value>(msg.as_ref()) else { continue; };
                        let Some(message) = verified_chat_event(&session_state, &session_token, &session_conversation, &event).await else {
                            let _ = sink.send(Message::Close(None)).await;
                            break;
                        };
                        if sink.send(Message::Text(message.to_string().into())).await.is_err() {
                            break;
                        }
                        metrics::inc(&metrics::MESSAGES_OUT);
                    }
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!("Client lagged {} messages in {}", n, room_clone);
                    }
                    Err(RecvError::Closed) => break,
                },
            }
        }
    });

    // Task: WS client messages → Kafka + Redis broadcast
    let state2 = state.clone();
    let room2 = room.clone();
    let user_id2 = user_id.clone();
    let conv_id2 = conversation_id.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            if banned.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            match msg {
                Message::Text(text) => {
                    if mesh_bound && !authorize_ws(&state2, &token, json!({"type": "mesh_session"})).await { break; }
                    handle_chat_message(&state2, &room2, &conv_id2, &user_id2, &token, &direct_tx, &text).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Wait for either task to finish
    tokio::select! {
        _ = &mut sink_task => {}
        _ = &mut recv_task => {}
    }
    sink_task.abort();
    recv_task.abort();

    state.hub.leave(&room, &user_id);
    state.hub.leave(&ban_room, &user_id);
    metrics::conn_close();
    tracing::debug!("Chat WS closed: user={} room={}", user_id, room);
}

async fn handle_chat_message(
    state: &Arc<AppState>,
    room: &str,
    conversation_id: &str,
    user_id: &str,
    token: &str,
    reply: &tokio::sync::mpsc::UnboundedSender<String>,
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

    // Ask the authoritative backend on every send. A gateway configuration or
    // cached socket admission must not bypass a newly enabled durable outbox.
    let mode = chat_mode(state, token, conversation_id).await;
    let Some(mode) = mode else {
        let _ = reply.send(json!({"type": "message_failed", "reason": "storage_unavailable", "nonce": nonce}).to_string());
        return;
    };
    if mode.get("cipher_only").and_then(Value::as_bool) == Some(true) {
        let _ = reply.send(json!({"type": "message_failed", "reason": "cipher_conversation_requires_envelope", "nonce": nonce}).to_string());
        return;
    }
    if mode.get("mesh_delivery").and_then(Value::as_bool) == Some(true)
        || mode.get("cipher_messages").and_then(Value::as_bool) == Some(true) {
        let mut endpoint = match reqwest::Url::parse(&state.django_authz_url) {
            Ok(endpoint) => endpoint,
            Err(_) => return,
        };
        endpoint.set_path(&format!("/api/conversations/{}/messages/send/", conversation_id));
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        let response = state.http_client.post(endpoint).bearer_auth(token)
            .header("X-Ionik-Client", "1").timeout(std::time::Duration::from_secs(10))
            .json(&json!({"content": content, "attachment_ids": attachment_ids, "reply_to_id": reply_to_id, "nonce": nonce}))
            .send().await;
        let result = match response {
            Ok(response) if response.status() == StatusCode::OK || response.status() == StatusCode::CREATED
                || response.status() == StatusCode::ACCEPTED => response.json::<Value>().await.ok(),
            _ => None,
        };
        let result = result.unwrap_or_else(|| json!({"type": "message_failed", "reason": "storage_unavailable", "nonce": nonce}));
        let _ = reply.send(result.to_string());
        return;
    }

    // Anti-scam: a code-like message is relayed only if Django agrees nobody in
    // the chat has just asked for an SMS / verification code (code_guard.py).
    if has_code_like_digits(&content)
        && !authorize_ws(
            state,
            token,
            json!({"type": "chat_send_check", "conversation_id": conversation_id, "content": content}),
        ).await
    {
        let _ = reply.send(json!({
            "type": "message_blocked",
            "reason": "verification_code",
            "nonce": nonce,
        }).to_string());
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

/// Cheap pre-filter: a run of 3–8 digits (single spaces/dashes allowed inside)
/// not glued to letters or other digits. Django makes the real decision.
fn has_code_like_digits(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() || (i > 0 && chars[i - 1].is_alphanumeric()) {
            i += 1;
            continue;
        }
        let mut digits = 0;
        let mut j = i;
        while j < chars.len() {
            if chars[j].is_ascii_digit() {
                digits += 1;
                j += 1;
            } else if (chars[j] == ' ' || chars[j] == '-') && j + 1 < chars.len() && chars[j + 1].is_ascii_digit() {
                j += 1;
            } else {
                break;
            }
        }
        let glued = j < chars.len() && chars[j].is_alphanumeric();
        if (3..=8).contains(&digits) && !glued {
            return true;
        }
        i = j.max(i + 1);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::has_code_like_digits;

    #[test]
    fn code_like() {
        assert!(has_code_like_digits("4821"));
        assert!(has_code_like_digits("код 482 913"));
        assert!(!has_code_like_digits("привет"));
        assert!(!has_code_like_digits("12"));
        assert!(!has_code_like_digits("abc1234"));
        assert!(!has_code_like_digits("+7 999 123 45 67 89"));
    }
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

    ws.protocols(["ionik.jwt"])
        .on_upgrade(move |socket| handle_guild(socket, state, guild_id, channel_id, claims.user_id, token))
}

async fn handle_guild(
    socket: WebSocket,
    state: Arc<AppState>,
    guild_id: String,
    channel_id: String,
    user_id: String,
    token: String,
) {
    let mesh_bound = auth::validate_token(&token, &state.jwt_secret)
        .map(|claims| claims.mesh_session.is_some()).unwrap_or(false);
    metrics::conn_open();
    let room = format!("guild_channel_{}", channel_id);
    let guild_room = format!("guild_{}", guild_id);
    let mut rx = state.hub.join(&room, &user_id);
    let mut guild_rx = state.hub.join(&guild_room, &user_id);
    let ban_room = format!("ban_{}", user_id);
    let mut ban_rx = state.hub.join(&ban_room, &user_id);
    let banned = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let banned_sink = banned.clone();
    let (direct_tx, mut direct_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let (mut sink, mut stream) = socket.split();

    // Forward broadcasts → client (from both channel and guild rooms)
    let session_state = state.clone();
    let session_token = token.clone();
    let session_guild = guild_id.clone();
    let session_channel = channel_id.clone();
    let mut sink_task = tokio::spawn(async move {
        let mut session_tick = tokio::time::interval(std::time::Duration::from_secs(2));
        loop {
            tokio::select! {
                _ = session_tick.tick(), if mesh_bound => {
                    if !authorize_ws(&session_state, &session_token, json!({"type": "mesh_session"})).await {
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                }
                ban = ban_rx.recv() => {
                    if let Ok(event) = ban {
                        banned_sink.store(true, std::sync::atomic::Ordering::SeqCst);
                        let _ = sink.send(Message::Text(event.to_string().into())).await;
                        let _ = sink.send(Message::Close(None)).await;
                    }
                    break;
                }
                direct = direct_rx.recv() => {
                    let Some(text) = direct else { break };
                    if mesh_bound && !authorize_ws(&session_state, &session_token, json!({"type": "mesh_session"})).await { break; }
                    if sink.send(Message::Text(text.into())).await.is_err() { break; }
                }
                result = rx.recv() => {
                    match result {
                        Ok(msg) => {
                            let Ok(event) = serde_json::from_str::<Value>(msg.as_ref()) else { continue; };
                            let Some(payload) = verified_guild_event(&session_state, &session_token, &session_guild, &session_channel, &event).await else { break; };
                            if sink.send(Message::Text(payload.to_string().into())).await.is_err() {
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
                            let Ok(event) = serde_json::from_str::<Value>(msg.as_ref()) else { continue; };
                            let Some(payload) = verified_guild_event(&session_state, &session_token, &session_guild, &session_channel, &event).await else { break; };
                            if sink.send(Message::Text(payload.to_string().into())).await.is_err() {
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
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            if banned.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            match msg {
                Message::Text(text) => {
                    if !authorize_ws(
                        &state2,
                        &token,
                        json!({"type": "guild_channel_send", "guild_id": guild_id.clone(), "channel_id": channel_id2.clone()}),
                    ).await {
                        continue;
                    }
                    handle_guild_message(&state2, &room2, &guild_id, &channel_id2, &user_id2, &token, &direct_tx, &text).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut sink_task => {}
        _ = &mut recv_task => {}
    }
    sink_task.abort();
    recv_task.abort();

    state.hub.leave(&room, &user_id);
    state.hub.leave(&guild_room, &user_id);
    state.hub.leave(&ban_room, &user_id);
    metrics::conn_close();
}

async fn handle_guild_message(
    state: &Arc<AppState>,
    room: &str,
    guild_id: &str,
    channel_id: &str,
    user_id: &str,
    token: &str,
    reply: &tokio::sync::mpsc::UnboundedSender<String>,
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

    let mode = room_mode(state, token, json!({"type": "guild_channel_send", "guild_id": guild_id, "channel_id": channel_id})).await;
    let Some(mode) = mode else {
        let _ = reply.send(json!({"type": "message_failed", "reason": "storage_unavailable", "nonce": nonce}).to_string()); return;
    };
    if mode.get("cipher_only").and_then(Value::as_bool) == Some(true) {
        let _ = reply.send(json!({"type": "message_failed", "reason": "cipher_channel_requires_envelope", "nonce": nonce}).to_string()); return;
    }
    if mode.get("mesh_delivery").and_then(Value::as_bool) == Some(true)
        || mode.get("cipher_messages").and_then(Value::as_bool) == Some(true) {
        let (Ok(guild), Ok(channel)) = (Uuid::parse_str(guild_id), Uuid::parse_str(channel_id)) else { return; };
        let Ok(mut endpoint) = reqwest::Url::parse(&state.django_authz_url) else { return; };
        endpoint.set_path(&format!("/api/guilds/{guild}/channels/{channel}/messages/send/")); endpoint.set_query(None); endpoint.set_fragment(None);
        let response = state.http_client.post(endpoint).bearer_auth(token).header("X-Ionik-Client", "1")
            .timeout(std::time::Duration::from_secs(10))
            .json(&json!({"content": content, "attachment_ids": attachment_ids, "reply_to_id": reply_to_id, "nonce": nonce})).send().await;
        let result = match response { Ok(response) if matches!(response.status(), StatusCode::OK | StatusCode::CREATED | StatusCode::ACCEPTED) => response.json::<Value>().await.ok(), _ => None };
        let result = result.unwrap_or_else(|| json!({"type": "message_failed", "reason": "storage_unavailable", "nonce": nonce}));
        let _ = reply.send(result.to_string()); return;
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

#[cfg(test)]
mod mesh_tests;
