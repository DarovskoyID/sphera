"""Compact inclusion proofs for previously committed manifest versions.

The current lineage root must come from a fresh verified BFT snapshot.
An inclusion proof supplied by a requester does not supply its own trust root.
"""
from hashlib import sha256
from .directory import digest64
from .history import root, proof
from .storage import canonical

MAX_HISTORY = 4096


def leaf(network, cluster, version, digest):
    return canonical({'domain': 'sfera-mesh-manifest-ancestor-v1', 'network': network,
                      'cluster': cluster, 'version': version, 'digest': digest})


def lineage_root(network, cluster, first, hashes):
    tree = root([leaf(network, cluster, first + offset, digest) for offset, digest in enumerate(hashes)])
    # Count is part of the commitment; odd-node duplication cannot change cardinality.
    return sha256(b'sfera-mesh-manifest-lineage-v1\0' + len(hashes).to_bytes(8, 'big') + tree).hexdigest()


def validate_lineages(state, network):
    lineages = state.get('manifest_lineage', {})
    if not isinstance(lineages, dict):
        raise ValueError('invalid_manifest_lineage')
    total = 0
    for cluster, lineage in lineages.items():
        if cluster not in state.get('manifests', {}) or not isinstance(lineage, dict) or set(lineage) != {'first', 'hashes', 'root'}:
            raise ValueError('invalid_manifest_lineage_head')
        first, hashes = lineage['first'], lineage['hashes']
        if type(first) is not int or first < 1 or not isinstance(hashes, list) or not 1 <= len(hashes) <= MAX_HISTORY or any(not digest64(value) for value in hashes):
            raise ValueError('invalid_manifest_lineage_entries')
        head = state['manifests'][cluster]
        body = head['record']['body']
        if first + len(hashes) - 1 != body['version'] or hashes[-1] != head['digest'] or (len(hashes) > 1 and hashes[-2] != body['previous']) or lineage['root'] != lineage_root(network, cluster, first, hashes):
            raise ValueError('invalid_manifest_lineage_commitment')
        total += len(hashes)
        if total > MAX_HISTORY:
            raise ValueError('manifest_lineage_capacity')


def ancestor_proof(state, network, cluster, ancestor):
    validate_lineages(state, network)
    lineage = state.get('manifest_lineage', {}).get(cluster)
    if lineage is None or ancestor not in lineage['hashes'][:-1]:
        raise ValueError('manifest_ancestor_unavailable')
    hashes, first = lineage['hashes'], lineage['first']
    index = hashes.index(ancestor)
    payloads = [leaf(network, cluster, first + offset, digest) for offset, digest in enumerate(hashes)]
    return {'domain': 'sfera-mesh-manifest-ancestor-proof-v1', 'index': index,
            'count': len(hashes), 'first': first,
            'path': [value.hex() for value in proof(payloads, index)]}


def verify_ancestor(state, network, cluster, ancestor, evidence):
    if not isinstance(evidence, dict) or set(evidence) != {'domain', 'index', 'count', 'first', 'path'}:
        raise ValueError('invalid_manifest_ancestor_proof')
    lineage = state.get('manifest_lineage', {}).get(cluster)
    if lineage is None:
        raise ValueError('manifest_ancestor_unavailable')
    index, count, first, path = (evidence[name] for name in ('index', 'count', 'first', 'path'))
    if (evidence['domain'] != 'sfera-mesh-manifest-ancestor-proof-v1' or
            any(type(value) is not int for value in (index, count, first)) or
            not 0 <= index < count - 1 or count != len(lineage['hashes']) or first != lineage['first'] or
            not 2 <= count <= MAX_HISTORY or not digest64(ancestor) or
            not isinstance(path, list) or len(path) > 12 or any(not digest64(value) for value in path)):
        raise ValueError('invalid_manifest_ancestor_context')
    value = leaf(network, cluster, first + index, ancestor)
    # Reconstruct the raw root while enforcing exact path length and odd duplicates.
    tree = sha256(b'\0' + value).digest()
    position, width = index, count
    for encoded in path:
        if width <= 1:
            raise ValueError('invalid_manifest_ancestor_path')
        sibling = bytes.fromhex(encoded)
        if position == width - 1 and width % 2 and sibling != tree:
            raise ValueError('invalid_manifest_ancestor_path')
        tree = sha256(b'\1' + (sibling + tree if position % 2 else tree + sibling)).digest()
        position //= 2
        width = (width + 1) // 2
    expected = sha256(b'sfera-mesh-manifest-lineage-v1\0' + count.to_bytes(8, 'big') + tree).hexdigest()
    if width != 1 or expected != lineage['root']:
        raise ValueError('invalid_manifest_ancestor_path')
    return True
