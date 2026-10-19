"""Durable local ciphertext storage for the mesh laboratory.

No networking, consensus acknowledgement or plaintext encryption is implied.
The independent manifest database can survive loss of the payload database.
"""
import json
import sqlite3
from hashlib import sha256
from .history import root, leaf_hash, parent_hash


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


class Storage:
    def __init__(self, payload_path, manifest_path):
        self.payload = sqlite3.connect(payload_path)
        self.index = sqlite3.connect(manifest_path)
        for db in (self.payload, self.index):
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
        self.payload.execute("CREATE TABLE IF NOT EXISTS payloads (block_id TEXT PRIMARY KEY, data BLOB NOT NULL)")
        self.index.executescript("""
            CREATE TABLE IF NOT EXISTS blocks (
                dialog TEXT NOT NULL, position INTEGER NOT NULL, block_id TEXT UNIQUE NOT NULL,
                cluster_id TEXT NOT NULL, digest TEXT NOT NULL, count INTEGER NOT NULL,
                previous TEXT, next TEXT, PRIMARY KEY(dialog, position));
            CREATE INDEX IF NOT EXISTS cluster_blocks ON blocks(cluster_id);
            CREATE TABLE IF NOT EXISTS merkle_nodes (
                dialog TEXT NOT NULL, level INTEGER NOT NULL, position INTEGER NOT NULL,
                digest BLOB NOT NULL, PRIMARY KEY(dialog, level, position));
        """)

    def close(self):
        self.payload.close()
        self.index.close()

    def append(self, dialog, block_id, cluster_id, ciphertexts):
        if not all(isinstance(x, str) and x for x in (dialog, block_id, cluster_id)):
            raise ValueError("invalid_identity")
        values = list(ciphertexts)
        if not values or any(not isinstance(x, bytes) or not x for x in values):
            raise ValueError("ciphertext_required")
        data = canonical([x.hex() for x in values])
        digest = sha256(data).hexdigest()
        if self.index.execute("SELECT 1 FROM blocks WHERE block_id=?", (block_id,)).fetchone():
            raise ValueError("duplicate_block")
        # Payload first; a crash may leave an orphan, never an index declaring
        # a successful write before its local bytes were durably persisted.
        with self.payload:
            self.payload.execute("INSERT INTO payloads VALUES (?, ?)", (block_id, data))
        with self.index:
            previous = self.index.execute("SELECT position, block_id FROM blocks WHERE dialog=? ORDER BY position DESC LIMIT 1", (dialog,)).fetchone()
            position = previous[0] + 1 if previous else 0
            self.index.execute("INSERT INTO blocks VALUES (?, ?, ?, ?, ?, ?, ?, NULL)", (dialog, position, block_id, cluster_id, digest, len(values), previous[1] if previous else None))
            if previous:
                self.index.execute("UPDATE blocks SET next=? WHERE block_id=?", (block_id, previous[1]))
            self._update_tree(dialog, position, canonical({"dialog": dialog, "position": position, "block_id": block_id, "digest": digest, "count": len(values)}))
        return block_id

    def _update_tree(self, dialog, position, payload):
        value = leaf_hash(payload)
        width = position + 1
        level = 0
        while True:
            self.index.execute("INSERT OR REPLACE INTO merkle_nodes VALUES (?, ?, ?, ?)", (dialog, level, position, value))
            if width == 1:
                break
            if position % 2:
                left = self.index.execute("SELECT digest FROM merkle_nodes WHERE dialog=? AND level=? AND position=?", (dialog, level, position - 1)).fetchone()[0]
                value = parent_hash(left, value)
            else:
                value = parent_hash(value, value)
            width = (width + 1) // 2
            position //= 2
            level += 1

    def _size(self, dialog):
        last = self.index.execute("SELECT position FROM blocks WHERE dialog=? ORDER BY position DESC LIMIT 1", (dialog,)).fetchone()
        return last[0] + 1 if last else 0

    def leaves(self, dialog):
        return [canonical(dict(zip(("dialog", "position", "block_id", "digest", "count"), row))) for row in self.index.execute("SELECT dialog, position, block_id, digest, count FROM blocks WHERE dialog=? ORDER BY position", (dialog,))]

    def checkpoint(self, dialog):
        count = self._size(dialog)
        level = (count - 1).bit_length() if count else 0
        digest = self.index.execute("SELECT digest FROM merkle_nodes WHERE dialog=? AND level=? AND position=0", (dialog, level)).fetchone()
        head = self.index.execute("SELECT block_id FROM blocks WHERE dialog=? AND position=0", (dialog,)).fetchone()
        tail = self.index.execute("SELECT block_id FROM blocks WHERE dialog=? AND position=?", (dialog, count - 1)).fetchone()
        return {"dialog": dialog, "blocks": count, "root": digest[0].hex() if digest else root([]).hex(), "head": head[0] if head else None, "tail": tail[0] if tail else None}

    def inclusion(self, dialog, position):
        count = self._size(dialog)
        if not 0 <= position < count:
            raise IndexError(position)
        row = self.index.execute("SELECT dialog, position, block_id, digest, count FROM blocks WHERE dialog=? AND position=?", (dialog, position)).fetchone()
        payload = canonical(dict(zip(("dialog", "position", "block_id", "digest", "count"), row)))
        width, offset, level, path = count, position, 0, []
        while width > 1:
            sibling = offset ^ 1
            if sibling >= width:
                sibling = offset
            path.append(self.index.execute("SELECT digest FROM merkle_nodes WHERE dialog=? AND level=? AND position=?", (dialog, level, sibling)).fetchone()[0])
            width = (width + 1) // 2
            offset //= 2
            level += 1
        return {"leaf": payload, "path": path, "position": position, "count": count}

    def affected(self, cluster_id):
        # Indexed lookup, independent of whether ciphertext is still reachable.
        return list(self.index.execute("SELECT dialog, position, block_id, digest FROM blocks WHERE cluster_id=? ORDER BY dialog, position", (cluster_id,)))

    def read(self, block_id):
        expected = self.index.execute("SELECT digest FROM blocks WHERE block_id=?", (block_id,)).fetchone()
        data = self.payload.execute("SELECT data FROM payloads WHERE block_id=?", (block_id,)).fetchone()
        if expected is None:
            raise KeyError(block_id)
        if data is None:
            raise FileNotFoundError(block_id)
        if sha256(data[0]).hexdigest() != expected[0]:
            raise ValueError("ciphertext_corrupt")
        return tuple(bytes.fromhex(x) for x in json.loads(data[0]))

    def recent(self, dialog, limit=100):
        if limit < 0:
            raise ValueError("invalid_limit")
        cursors = []
        for block_id, count in self.index.execute("SELECT block_id, count FROM blocks WHERE dialog=? ORDER BY position DESC", (dialog,)):
            for offset in range(count - 1, -1, -1):
                if len(cursors) >= limit:
                    return list(reversed(cursors))
                cursors.append((block_id, offset))
        return list(reversed(cursors))
