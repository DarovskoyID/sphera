"""Signed checkpoint certificates, NOT a consensus or Sybil admission protocol.

The committee must come from an independently trusted configuration. A quorum
certificate cannot be used to bootstrap trust in its own signer set.
"""
from dataclasses import dataclass
from hashlib import sha256
import sqlite3
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .storage import canonical


@dataclass(frozen=True)
class Committee:
    network: str
    epoch: int
    members: tuple[tuple[str, bytes], ...]

    def __post_init__(self):
        if not self.network or self.epoch < 0 or len(self.members) < 4:
            raise ValueError("invalid_committee")
        ids = [node for node, _ in self.members]
        keys = [key for _, key in self.members]
        if len(set(ids)) != len(ids) or len(set(keys)) != len(keys) or any(len(k) != 32 for k in keys):
            raise ValueError("duplicate_or_invalid_validator")

    @property
    def quorum(self):
        return (2 * len(self.members)) // 3 + 1

    @property
    def identifier(self):
        return sha256(canonical({"network": self.network, "epoch": self.epoch, "members": sorted((node, key.hex()) for node, key in self.members)})).hexdigest()


def statement(committee, height, previous, checkpoint):
    if height < 1 or len(previous) != 64:
        raise ValueError("invalid_checkpoint_position")
    bytes.fromhex(previous)
    return canonical({"domain": "sfera-mesh-checkpoint-v1", "network": committee.network, "committee": committee.identifier, "epoch": committee.epoch, "height": height, "previous": previous, "checkpoint": checkpoint})


class VoteJournal:
    """Persistent refusal to sign conflicting checkpoints at the same height.

This is an anti-equivocation primitive; it does not replace BFT locking rounds.
"""
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS votes (committee TEXT, height INTEGER, digest BLOB NOT NULL, PRIMARY KEY(committee, height))")

    def close(self):
        self.db.close()

    def sign(self, key, committee, height, previous, checkpoint):
        public = key.public_key().public_bytes_raw()
        if public not in dict(committee.members).values():
            raise ValueError("not_a_validator")
        data = statement(committee, height, previous, checkpoint)
        digest = sha256(data).digest()
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO votes VALUES (?, ?, ?)", (committee.identifier, height, digest))
            recorded = self.db.execute("SELECT digest FROM votes WHERE committee=? AND height=?", (committee.identifier, height)).fetchone()[0]
            if recorded != digest:
                raise ValueError("conflicting_vote")
        return key.sign(data)


def verify_certificate(committee, height, previous, checkpoint, votes):
    data = statement(committee, height, previous, checkpoint)
    members = dict(committee.members)
    seen = set()
    for node_id, signature in votes:
        if node_id in seen or node_id not in members:
            return False
        try:
            Ed25519PublicKey.from_public_bytes(members[node_id]).verify(signature, data)
        except (InvalidSignature, ValueError, TypeError):
            return False
        seen.add(node_id)
    return len(seen) >= committee.quorum
