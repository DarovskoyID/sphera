"""Verified succession of account authority; the initial identity stays stable."""
from hashlib import sha256
import re
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from .directory import digest64, ZERO
from .storage import canonical


def controller_public(state, owner, version=None, *, devices=False):
    public = state['accounts'][owner]['record']['body']['public_key']
    for head in state.get('account_controls', {}).get(owner, []):
        cut = head['record']['body']['devices_version' if devices else 'account_version']
        if version is not None and version <= cut:
            break
        public = head['record']['body']['new_public']
    return public


def validate_controls(state, network, genesis):
    histories = state.get('account_controls', {})
    if not isinstance(histories, dict) or len(histories) > 256:
        raise ValueError('invalid_account_controls')
    used = {head['record']['body']['public_key'] for head in state['accounts'].values()}
    used.update(head['event']['body']['device_public'] for history in state.get('devices', {}).values() for head in history)
    total = 0
    for owner, history in histories.items():
        if owner not in state['accounts'] or not isinstance(history, list) or not 1 <= len(history) <= 16:
            raise ValueError('invalid_account_control_history')
        public, previous, account_version, account_digest, devices_version = controller_public({'accounts': state['accounts']}, owner), ZERO, 0, '', 0
        account, devices = state['accounts'][owner], state.get('devices', {}).get(owner, [])
        for epoch, head in enumerate(history, 1):
            total += 1
            if total > 256 or not isinstance(head, dict) or set(head) != {'record', 'digest'}:
                raise ValueError('invalid_account_control_head')
            record = head['record']
            if not isinstance(record, dict) or set(record) != {'body', 'old_signature', 'new_signature'} or len(canonical(record)) > 4096:
                raise ValueError('invalid_account_control_record')
            b = record['body']
            if (not isinstance(b, dict) or set(b) != {'domain','network','genesis','owner','epoch','previous','old_public','new_public','account_version','account_digest','devices_version','devices_digest','replacement_digest'}
                    or b['domain'] != 'sfera-mesh-account-control-v1' or b['network'] != network or b['genesis'] != genesis
                    or b['owner'] != owner or type(b['epoch']) is not int or b['epoch'] != epoch
                    or b['previous'] != previous or b['old_public'] != public
                    or not all(digest64(b[name]) for name in ('genesis','owner','previous','old_public','new_public','account_digest','devices_digest','replacement_digest'))
                    or b['new_public'] in used or b['new_public'] == b['old_public']
                    or type(b['account_version']) is not int or not account_version < b['account_version'] < account['record']['body']['version']
                    or type(b['devices_version']) is not int or not devices_version <= b['devices_version'] <= len(devices)):
                raise ValueError('account_control_gap_or_fork')
            if (b['account_version'] == account_version and b['account_digest'] != account_digest or
                    b['account_version'] == account['record']['body']['version'] and b['account_digest'] != account['digest'] or
                    b['account_version'] + 1 == account['record']['body']['version'] and b['replacement_digest'] != account['digest'] or
                    b['devices_digest'] != (devices[b['devices_version']-1]['digest'] if b['devices_version'] else ZERO)):
                raise ValueError('account_control_checkpoint_conflict')
            for key, name in [(b['old_public'], 'old_signature'), (b['new_public'], 'new_signature')]:
                signature = record[name]
                if not isinstance(signature, str) or re.fullmatch('[0-9a-f]{128}', signature) is None:
                    raise ValueError('invalid_account_control_signature')
                try:
                    Ed25519PublicKey.from_public_bytes(bytes.fromhex(key)).verify(bytes.fromhex(signature), canonical(b))
                except InvalidSignature as exc:
                    raise ValueError('invalid_account_control_signature') from exc
            digest = sha256(canonical(record)).hexdigest()
            if head['digest'] != digest:
                raise ValueError('invalid_account_control_digest')
            public, previous, account_version, account_digest, devices_version = b['new_public'], digest, b['account_version'], b['account_digest'], b['devices_version']
            used.add(public)
    return histories


def check_progress(previous, current):
    for owner, history in previous.get('account_controls', {}).items():
        new = current.get('account_controls', {}).get(owner, [])
        if len(new) < len(history) or new[:len(history)] != history:
            raise ValueError('account_control_rollback_or_fork')


def history_signer(history, version):
    """Input is the checked directory's device history, never a caller's claim."""
    public = history['owner_public']
    for head in history.get('control_history', []):
        if version <= head['record']['body']['devices_version']:
            break
        public = head['record']['body']['new_public']
    return public


def account_signer(head):
    public = head['record']['body']['public_key']
    version = head['record']['body']['version']
    for control in head.get('control_history', []):
        if version <= control['record']['body']['account_version']:
            break
        public = control['record']['body']['new_public']
    return public
