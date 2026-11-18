use super::*;
use axum::{routing::{get, post}, Json, Router};
use std::sync::Mutex;
use tokio::{net::TcpListener, task::JoinHandle, time::{timeout, Duration}};

const CONVERSATION: &str = "00000000-0000-4000-8000-000000000001";
const MESSAGE: &str = "00000000-0000-4000-8000-000000000002";
const USER: &str = "00000000-0000-4000-8000-000000000003";

struct Backend {
    state: Arc<AppState>,
    mode: Arc<Mutex<Value>>,
    body: Arc<Mutex<Value>>,
    requests: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}

impl Drop for Backend {
    fn drop(&mut self) { self.task.abort(); }
}

async fn backend() -> Backend {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mode = Arc::new(Mutex::new(json!({"ok": true, "mesh_delivery": true, "mesh_history": true})));
    let body = Arc::new(Mutex::new(json!({
        "id": MESSAGE, "conversation_id": CONVERSATION, "mesh_write_id": "a".repeat(64),
        "consensus_committed": true, "publication_state": "confirmed", "author": {"id": USER},
        "content": "verified mesh body", "attachments": [], "created_at": "2026-10-21T00:00:00+00:00"
    })));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let router = Router::new()
        .route("/api/ws/authorize/", post({
            let mode = mode.clone();
            move || {
                let value = mode.lock().unwrap().clone();
                async move { Json(value) }
            }
        }))
        .route("/api/conversations/{id}/messages/send/", post({
            let requests = requests.clone();
            move |headers: HeaderMap, Json(payload): Json<Value>| {
                requests.lock().unwrap().push(json!({"kind": "send", "payload": payload,
                    "authorization": headers.get("authorization").unwrap().to_str().unwrap()}));
                async move { (StatusCode::ACCEPTED, Json(json!({"type": "message_pending", "id": MESSAGE,
                    "nonce": "nonce-1", "consensus_committed": false}))) }
            }
        }))
        .route("/api/messages/{id}/mesh-content/", get({
            let requests = requests.clone();
            let body = body.clone();
            move |headers: HeaderMap| {
                requests.lock().unwrap().push(json!({"kind": "read",
                    "authorization": headers.get("authorization").unwrap().to_str().unwrap()}));
                let value = body.lock().unwrap().clone();
                async move { Json(value) }
            }
        }))
        .route("/api/guilds/{guild}/channels/{channel}/messages/send/", post({
            let requests = requests.clone();
            move |headers: HeaderMap, Json(payload): Json<Value>| {
                requests.lock().unwrap().push(json!({"kind": "guild-send", "payload": payload,
                    "authorization": headers.get("authorization").unwrap().to_str().unwrap()}));
                async move { (StatusCode::ACCEPTED, Json(json!({"type": "message_pending", "id": MESSAGE,
                    "nonce": "guild-nonce", "consensus_committed": false}))) }
            }
        }))
        .route("/api/guilds/{guild}/messages/{id}/mesh-content/", get({
            let body = body.clone();
            move || { let value = body.lock().unwrap().clone(); async move { Json(value) } }
        }));
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
    let state = Arc::new(AppState {
        hub: crate::hub::Hub::new(),
        kafka_producer: crate::kafka::KafkaProducer::new("127.0.0.1:1"),
        jwt_secret: "isolated-test-secret".into(), redis_url: "invalid-redis-url".into(),
        django_authz_url: format!("http://{address}/api/ws/authorize/"),
        http_client: reqwest::Client::builder().no_proxy().build().unwrap(),
    });
    Backend { state, mode, body, requests, task }
}

fn relay() -> Value {
    json!({"id": MESSAGE, "author": {"id": USER}, "mesh_write_id": "a".repeat(64),
        "content": "unverified relay body", "nonce": "nonce-1"})
}

#[tokio::test]
async fn mesh_send_returns_pending_without_legacy_broadcast() {
    let backend = backend().await;
    let room = format!("chat_{CONVERSATION}");
    let mut events = backend.state.hub.join(&room, USER);
    let (reply, mut replies) = tokio::sync::mpsc::unbounded_channel();
    timeout(Duration::from_secs(3), handle_chat_message(&backend.state, &room, CONVERSATION, USER,
        "test-token", &reply, &json!({"message": "hello", "nonce": "nonce-1", "attachment_ids": []}).to_string())).await.unwrap();
    let result: Value = serde_json::from_str(&replies.try_recv().unwrap()).unwrap();
    assert_eq!(result["type"], "message_pending");
    assert_eq!(result["consensus_committed"], false);
    assert!(events.try_recv().is_err());
    let requests = backend.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["authorization"], "Bearer test-token");
    assert_eq!(requests[0]["payload"]["content"], "hello");
    assert_eq!(requests[0]["payload"]["nonce"], "nonce-1");
}

#[tokio::test]
async fn encrypted_chat_rejects_legacy_send_before_http_or_broadcast() {
    let backend = backend().await;
    *backend.mode.lock().unwrap() = json!({"ok": true, "mesh_delivery": false, "cipher_only": true});
    let room = format!("chat_{CONVERSATION}");
    let mut events = backend.state.hub.join(&room, USER);
    let (reply, mut replies) = tokio::sync::mpsc::unbounded_channel();
    handle_chat_message(&backend.state, &room, CONVERSATION, USER, "test-token", &reply,
        &json!({"message": "plaintext", "nonce": "nonce-1"}).to_string()).await;
    let result: Value = serde_json::from_str(&replies.try_recv().unwrap()).unwrap();
    assert_eq!(result["reason"], "cipher_conversation_requires_envelope");
    assert!(events.try_recv().is_err());
    assert!(backend.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cipher_capable_backend_checks_sql_before_legacy_chat_broadcast() {
    let backend = backend().await;
    *backend.mode.lock().unwrap() = json!({"ok": true, "mesh_delivery": false, "cipher_messages": true, "cipher_only": false});
    let room = format!("chat_{CONVERSATION}");
    let mut events = backend.state.hub.join(&room, USER);
    let (reply, mut replies) = tokio::sync::mpsc::unbounded_channel();
    handle_chat_message(&backend.state, &room, CONVERSATION, USER, "test-token", &reply,
        &json!({"message": "hello", "nonce": "nonce-1"}).to_string()).await;
    let result: Value = serde_json::from_str(&replies.try_recv().unwrap()).unwrap();
    assert_eq!(result["type"], "message_pending");
    assert!(events.try_recv().is_err());
    assert_eq!(backend.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn rejected_authorization_never_falls_back_to_legacy_send_or_read() {
    let backend = backend().await;
    *backend.mode.lock().unwrap() = json!({"ok": false});
    let room = format!("chat_{CONVERSATION}");
    let mut events = backend.state.hub.join(&room, USER);
    let (reply, mut replies) = tokio::sync::mpsc::unbounded_channel();
    timeout(Duration::from_secs(3), handle_chat_message(&backend.state, &room, CONVERSATION, USER,
        "test-token", &reply, &json!({"message": "hello", "nonce": "nonce-1"}).to_string())).await.unwrap();
    let result: Value = serde_json::from_str(&replies.try_recv().unwrap()).unwrap();
    assert_eq!(result["type"], "message_failed");
    assert!(events.try_recv().is_err());
    assert!(verified_chat_event(&backend.state, "test-token", CONVERSATION, &relay()).await.is_none());
    assert!(backend.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mesh_receive_replaces_relay_body_and_preserves_nonce() {
    let backend = backend().await;
    let result = verified_chat_event(&backend.state, "test-token", CONVERSATION, &relay()).await.unwrap();
    assert_eq!(result["content"], "verified mesh body");
    assert_eq!(result["nonce"], "nonce-1");
    assert_eq!(backend.requests.lock().unwrap()[0]["authorization"], "Bearer test-token");
    let result = verified_chat_event(&backend.state, "test-token", CONVERSATION,
        &json!({"type": "message_edited", "message": relay()})).await.unwrap();
    assert_eq!(result["type"], "message_edited");
    assert_eq!(result["message"]["content"], "verified mesh body");
}

#[tokio::test]
async fn mesh_receive_rejects_unconfirmed_foreign_or_superseded_content() {
    let backend = backend().await;
    backend.body.lock().unwrap()["consensus_committed"] = json!(false);
    assert!(verified_chat_event(&backend.state, "test-token", CONVERSATION, &relay()).await.is_none());
    backend.body.lock().unwrap()["consensus_committed"] = json!(true);
    backend.body.lock().unwrap()["conversation_id"] = json!(USER);
    assert!(verified_chat_event(&backend.state, "test-token", CONVERSATION, &relay()).await.is_none());
    backend.body.lock().unwrap()["conversation_id"] = json!(CONVERSATION);
    backend.body.lock().unwrap()["mesh_write_id"] = json!("b".repeat(64));
    assert!(verified_chat_event(&backend.state, "test-token", CONVERSATION, &relay()).await.is_none());
}

#[tokio::test]
async fn legacy_receive_preserves_authorized_events_when_mesh_history_is_off() {
    let backend = backend().await;
    backend.mode.lock().unwrap()["mesh_history"] = json!(false);
    assert_eq!(verified_chat_event(&backend.state, "test-token", CONVERSATION, &relay()).await, Some(relay()));
    assert!(backend.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn guild_send_waits_for_backend_and_never_broadcasts_early() {
    let backend = backend().await;
    let room = format!("guild_channel_{CONVERSATION}");
    let mut events = backend.state.hub.join(&room, USER);
    let (reply, mut replies) = tokio::sync::mpsc::unbounded_channel();
    handle_guild_message(&backend.state, &room, USER, CONVERSATION, USER, "guild-token", &reply,
        &json!({"message": "guild content", "nonce": "guild-nonce"}).to_string()).await;
    let pending: Value = serde_json::from_str(&replies.try_recv().unwrap()).unwrap();
    assert_eq!(pending["type"], "message_pending"); assert!(events.try_recv().is_err());
    assert_eq!(backend.requests.lock().unwrap()[0]["authorization"], "Bearer guild-token");
    *backend.mode.lock().unwrap() = json!({"ok": false});
    handle_guild_message(&backend.state, &room, USER, CONVERSATION, USER, "guild-token", &reply,
        &json!({"message": "denied"}).to_string()).await;
    let failure: Value = serde_json::from_str(&replies.try_recv().unwrap()).unwrap();
    assert_eq!(failure["type"], "message_failed"); assert_eq!(backend.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn guild_receive_rehydrates_and_rejects_other_channel_or_revision() {
    let backend = backend().await;
    backend.body.lock().unwrap()["guild_id"] = json!(USER);
    backend.body.lock().unwrap()["channel_id"] = json!(CONVERSATION);
    let result = verified_guild_event(&backend.state, "guild-token", USER, CONVERSATION, &relay()).await.unwrap();
    assert_eq!(result["content"], "verified mesh body");
    backend.body.lock().unwrap()["channel_id"] = json!(MESSAGE);
    assert!(verified_guild_event(&backend.state, "guild-token", USER, CONVERSATION, &relay()).await.is_none());
    backend.body.lock().unwrap()["channel_id"] = json!(CONVERSATION);
    backend.body.lock().unwrap()["mesh_write_id"] = json!("b".repeat(64));
    assert!(verified_guild_event(&backend.state, "guild-token", USER, CONVERSATION, &relay()).await.is_none());
}

#[tokio::test]
async fn encrypted_guild_rejects_legacy_send_before_storage_or_broadcast() {
    let backend = backend().await;
    *backend.mode.lock().unwrap() = json!({"ok": true, "cipher_only": true, "mesh_delivery": false});
    let room = format!("guild_channel_{CONVERSATION}");
    let mut events = backend.state.hub.join(&room, USER);
    let (reply, mut replies) = tokio::sync::mpsc::unbounded_channel();
    handle_guild_message(&backend.state, &room, USER, CONVERSATION, USER, "guild-token", &reply,
        &json!({"message": "must not escape", "nonce": "guild-nonce"}).to_string()).await;
    let result: Value = serde_json::from_str(&replies.try_recv().unwrap()).unwrap();
    assert_eq!(result["reason"], "cipher_channel_requires_envelope");
    assert!(backend.requests.lock().unwrap().is_empty());
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn cipher_capable_guild_waits_for_sql_before_legacy_broadcast() {
    let backend = backend().await;
    *backend.mode.lock().unwrap() = json!({"ok": true, "cipher_only": false, "cipher_messages": true, "mesh_delivery": false});
    let room = format!("guild_channel_{CONVERSATION}");
    let mut events = backend.state.hub.join(&room, USER);
    let (reply, mut replies) = tokio::sync::mpsc::unbounded_channel();
    handle_guild_message(&backend.state, &room, USER, CONVERSATION, USER, "guild-token", &reply,
        &json!({"message": "persist first", "nonce": "guild-nonce"}).to_string()).await;
    let result: Value = serde_json::from_str(&replies.try_recv().unwrap()).unwrap();
    assert_eq!(result["type"], "message_pending");
    assert_eq!(backend.requests.lock().unwrap()[0]["kind"], "guild-send");
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn legacy_rich_update_cannot_bypass_verified_message_revision() {
    let backend = backend().await;
    for kind in ["todo_update", "poll_update", "location_update"] {
        let forged = json!({"type": kind, "message_id": MESSAGE, "todo": {"title": "forged"}});
        assert!(verified_chat_event(&backend.state, "token", CONVERSATION, &forged).await.is_none());
        assert!(verified_guild_event(&backend.state, "token", USER, CONVERSATION, &forged).await.is_none());
    }
}
