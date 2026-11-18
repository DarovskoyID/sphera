"""Immutable ciphertext blocks, bidirectional index and Merkle range proofs.

This index detects content mismatches, not live storage availability.
"""
from dataclasses import dataclass
from hashlib import sha256


def leaf_hash(payload):
    return sha256(b"\x00" + payload).digest()


def parent_hash(left, right):
    return sha256(b"\x01" + left + right).digest()


def levels(payloads):
    row = [leaf_hash(p) for p in payloads]
    result = [row]
    while len(row) > 1:
        row = [parent_hash(row[i], row[i + 1] if i + 1 < len(row) else row[i]) for i in range(0, len(row), 2)]
        result.append(row)
    return result


def root(payloads):
    tree = levels(payloads)
    return tree[-1][0] if tree[0] else sha256(b"").digest()


def proof(payloads, index):
    tree = levels(payloads)
    if not 0 <= index < len(tree[0]):
        raise IndexError(index)
    path = []
    for row in tree[:-1]:
        sibling = index ^ 1
        path.append(row[sibling] if sibling < len(row) else row[index])
        index //= 2
    return path


def verify(payload, index, count, path, expected):
    if count <= 0 or not 0 <= index < count:
        return False
    value = leaf_hash(payload)
    offset = 0
    while count > 1:
        if offset >= len(path) or len(path[offset]) != 32:
            return False
        sibling = path[offset]
        if index == count - 1 and count % 2 and sibling != value:
            return False
        value = parent_hash(sibling, value) if index % 2 else parent_hash(value, sibling)
        index //= 2
        count = (count + 1) // 2
        offset += 1
    return offset == len(path) and value == expected


@dataclass(frozen=True)
class Block:
    block_id: str
    ciphertexts: tuple[bytes, ...]
    previous: str | None
    next: str | None


class History:
    """Local protocol model; mutations must later be committed by cluster consensus."""
    def __init__(self):
        self.blocks = {}
        self.order = []
        self.message_ids = set()

    def append(self, block_id, messages):
        messages = list(messages)
        ids = [mid for mid, _ in messages]
        if not messages or len(set(ids)) != len(ids) or self.message_ids.intersection(ids) or block_id in self.blocks:
            raise ValueError("duplicate_or_empty_block")
        if any(not isinstance(payload, bytes) or not payload for _, payload in messages):
            raise ValueError("ciphertext_required")
        previous = self.order[-1] if self.order else None
        block = Block(block_id, tuple(payload for _, payload in messages), previous, None)
        if previous:
            old = self.blocks[previous]
            self.blocks[previous] = Block(old.block_id, old.ciphertexts, old.previous, block_id)
        self.blocks[block_id] = block
        self.order.append(block_id)
        self.message_ids.update(ids)
        return block

    def last(self, limit=100):
        if limit < 0:
            raise ValueError("invalid_limit")
        selected = []
        for block_id in reversed(self.order):
            block = self.blocks[block_id]
            for offset in range(len(block.ciphertexts) - 1, -1, -1):
                if len(selected) == limit:
                    return list(reversed(selected))
                selected.append((block_id, offset, block.ciphertexts[offset]))
        return list(reversed(selected))
