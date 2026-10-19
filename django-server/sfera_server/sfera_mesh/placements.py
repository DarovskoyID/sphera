"""Node consent records, separate from commercial policy and validator votes."""
from hashlib import sha256
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import digest64, ZERO
from .identity import node_id
from .storage import canonical


def cluster_id(network, members):
    return sha256(canonical({'domain': 'sfera-mesh-cluster-v1', 'network': network, 'members': members})).hexdigest()


def validate_body(body, network):
    if not isinstance(body, dict) or set(body) != {'domain', 'network', 'cluster', 'epoch', 'previous', 'members'} or body['domain'] != 'sfera-mesh-placement-v1' or body['network'] != network:
        raise ValueError('invalid_placement_context')
    members = body['members']
    if not digest64(body['cluster']) or not digest64(body['previous']) or type(body['epoch']) is not int or not 1 <= body['epoch'] <= 2**63-1 or not isinstance(members, list) or len(members) != 3 or any(not digest64(node) for node in members) or sorted(set(members)) != members:
        raise ValueError('invalid_placement_body')
    if body['epoch'] == 1 and (body['previous'] != ZERO or body['cluster'] != cluster_id(network, members)):
        raise ValueError('invalid_initial_cluster')
    return body


def validate_placement(record, network):
    if not isinstance(record, dict) or set(record) != {'body', 'consents'} or len(canonical(record)) > 4096:
        raise ValueError('invalid_placement_record')
    body = validate_body(record['body'], network)
    consents = record['consents']
    if not isinstance(consents, list) or len(consents) != 3:
        raise ValueError('three_member_consents_required')
    for member, consent in zip(body['members'], consents):
        if not isinstance(consent, dict) or set(consent) != {'public_key', 'signature'} or not digest64(consent['public_key']):
            raise ValueError('invalid_placement_consent')
        try:
            public = bytes.fromhex(consent['public_key'])
            signature = bytes.fromhex(consent['signature'])
            if node_id(public) != member or len(signature) != 64 or signature.hex() != consent['signature']:
                raise ValueError('consent_member_mismatch')
            Ed25519PublicKey.from_public_bytes(public).verify(signature, canonical(body))
        except (InvalidSignature, TypeError, ValueError) as exc:
            raise ValueError('invalid_placement_signature') from exc
    return body, sha256(canonical(record)).hexdigest()


def consent_placement(body, key):
    """Sign only after the caller checked policy; not automatic admission."""
    validate_body(body, body['network'])
    public = key.public_key().public_bytes_raw()
    if node_id(public) not in body['members']:
        raise ValueError('not_a_placement_member')
    return {'public_key': public.hex(), 'signature': key.sign(canonical(body)).hex()}


def validate_history(state, network):
    placements, histories = state.get('placements', {}), state.get('placement_history', {})
    if set(placements) != set(histories):
        raise ValueError('placement_history_required')
    for cluster, head in placements.items():
        previous, members = ZERO, None
        if not isinstance(histories[cluster], list) or not histories[cluster]:
            raise ValueError('placement_history_required')
        for epoch, item in enumerate(histories[cluster], 1):
            body, digest = validate_placement(item['record'], network)
            if body['cluster'] != cluster or body['epoch'] != epoch or body['previous'] != previous or digest != item['digest']:
                raise ValueError('placement_history_conflict')
            if members is not None and len(set(members) & set(body['members'])) != 2:
                raise ValueError('invalid_historical_replacement')
            previous, members = digest, body['members']
        if previous != head['digest']:
            raise ValueError('placement_history_head_mismatch')
