"""Mesh node identities and signed, replay-protected transport envelopes."""
import os
from pathlib import Path
import secrets
import sqlite3
import time
from hashlib import sha256
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from .storage import canonical

DOMAIN = "sfera-mesh-transport-v1"
MAX_BYTES = 1024 * 1024


def node_id(public_key):
    return sha256(b"sfera-mesh-node-v1\x00" + public_key).hexdigest()


def create_identity(path):
    key = Ed25519PrivateKey.generate()
    # Never overwrite an existing node identity during reinstall/restart.
    descriptor = os.open(Path(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as file:
        file.write(key.private_bytes_raw())
        file.flush()
        os.fsync(file.fileno())
    return key


def load_identity(path):
    return Ed25519PrivateKey.from_private_bytes(Path(path).read_bytes())


def envelope(key, network, recipient, operation, payload, *, now=None):
    public = key.public_key().public_bytes_raw()
    record = {"domain": DOMAIN, "network": network, "sender": node_id(public), "recipient": recipient,
              "operation": operation, "timestamp": int(time.time() if now is None else now),
              "nonce": secrets.token_hex(24), "payload": payload}
    return {"record": record, "signature": key.sign(canonical(record)).hex()}


class EnvelopeVerifier:
    """Trusted roster is explicit: self-signed identities alone do not grant access.

    This is transport authentication, not public admission or BFT membership.
    """
    def __init__(self, network, recipient, roster, replay_path):
        self.network, self.recipient = network, recipient
        self.roster = dict(roster)
        if any(node_id(public) != identity for identity, public in self.roster.items()):
            raise ValueError("roster_identity_mismatch")
        self.db = sqlite3.connect(replay_path, check_same_thread=False)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS nonces (sender TEXT, nonce TEXT, expires INTEGER NOT NULL, PRIMARY KEY(sender, nonce))")
        import threading
        self.lock = threading.Lock()

    def close(self):
        self.db.close()

    def verify(self, message, operation, *, now=None):
        if not isinstance(message, dict) or set(message) != {"record", "signature"}:
            raise ValueError("invalid_envelope")
        if len(canonical(message)) > MAX_BYTES:
            raise ValueError("envelope_too_large")
        record = message["record"]
        fields = {"domain", "network", "sender", "recipient", "operation", "timestamp", "nonce", "payload"}
        if not isinstance(record, dict) or set(record) != fields:
            raise ValueError("invalid_record")
        if record["domain"] != DOMAIN or record["network"] != self.network or record["recipient"] != self.recipient or record["operation"] != operation:
            raise ValueError("wrong_context")
        if not isinstance(record["sender"], str) or record["sender"] not in self.roster:
            raise ValueError("unknown_sender")
        timestamp, nonce = record["timestamp"], record["nonce"]
        current = int(time.time() if now is None else now)
        if type(timestamp) is not int or abs(current - timestamp) > 60:
            raise ValueError("expired_envelope")
        if not isinstance(nonce, str) or len(nonce) != 48:
            raise ValueError("invalid_nonce")
        try:
            bytes.fromhex(nonce)
            signature = bytes.fromhex(message["signature"])
            Ed25519PublicKey.from_public_bytes(self.roster[record["sender"]]).verify(signature, canonical(record))
        except (ValueError, TypeError, InvalidSignature) as error:
            raise ValueError("invalid_signature") from error
        with self.lock, self.db:
            self.db.execute("DELETE FROM nonces WHERE expires < ?", (current,))
            try:
                self.db.execute("INSERT INTO nonces VALUES (?, ?, ?)", (record["sender"], nonce, timestamp + 60))
            except sqlite3.IntegrityError as error:
                raise ValueError("replayed_envelope") from error
        return record["sender"], record["payload"]
