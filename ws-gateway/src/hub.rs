use dashmap::DashMap;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::broadcast;

/// Per-room broadcast channel
struct Room {
    tx: broadcast::Sender<Arc<str>>,
}

/// Central hub: maps room names to broadcast channels, tracks user→rooms
pub struct Hub {
    rooms: DashMap<String, Room>,
    /// user_id → set of room names they're subscribed to
    user_rooms: DashMap<String, HashSet<String>>,
}

impl Hub {
    pub fn new() -> Self {
        Self {
            rooms: DashMap::new(),
            user_rooms: DashMap::new(),
        }
    }

    /// Subscribe to a room. Returns a broadcast receiver.
    pub fn join(&self, room: &str, user_id: &str) -> broadcast::Receiver<Arc<str>> {
        let entry = self.rooms.entry(room.to_string()).or_insert_with(|| {
            let (tx, _) = broadcast::channel(4096);
            Room { tx }
        });
        let rx = entry.tx.subscribe();

        self.user_rooms
            .entry(user_id.to_string())
            .or_default()
            .insert(room.to_string());

        rx
    }

    /// Leave a room.
    pub fn leave(&self, room: &str, user_id: &str) {
        if let Some(mut rooms) = self.user_rooms.get_mut(user_id) {
            rooms.remove(room);
        }
        // Clean up empty rooms
        if let Some(r) = self.rooms.get(room) {
            if r.tx.receiver_count() == 0 {
                drop(r);
                self.rooms.remove(room);
            }
        }
    }

    /// Broadcast a message to all subscribers of a room.
    pub fn broadcast(&self, room: &str, message: &str) {
        if let Some(r) = self.rooms.get(room) {
            let _ = r.tx.send(Arc::from(message));
        }
    }

    /// Get subscriber count for a room.
    pub fn room_size(&self, room: &str) -> usize {
        self.rooms
            .get(room)
            .map(|r| r.tx.receiver_count())
            .unwrap_or(0)
    }
}
