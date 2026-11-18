"""Global immutable SDK certificates carried by the checked consensus state."""
from .cipher_authority import verify_certificate
from .storage import canonical
from hashlib import sha256


def validate_cipher_devices(state, network, genesis):
    pins = state.get('cipher_devices', {})
    if not isinstance(pins, dict) or len(pins) > 512:
        raise ValueError('invalid_global_cipher_devices')
    ed, curve = set(), set()
    for key, head in pins.items():
        if not isinstance(head, dict) or set(head) != {'certificate', 'digest'}:
            raise ValueError('invalid_global_cipher_head')
        body = verify_certificate(head['certificate'], network, genesis)
        if key != body['owner'] + ':' + body['device'] or head['digest'] != sha256(canonical(head['certificate'])).hexdigest():
            raise ValueError('invalid_global_cipher_head')
        events = state.get('devices', {}).get(body['owner'], [])
        if not any(head['event']['body']['operation'] == 'enroll' and head['event']['body']['device_id'] == body['device'] and head['event']['body']['device_public'] == body['device_public'] for head in events):
            raise ValueError('global_cipher_device_not_admitted')
        if body['ed25519'] in ed or body['curve25519'] in curve:
            raise ValueError('duplicate_global_sdk_key')
        ed.add(body['ed25519']); curve.add(body['curve25519'])
    return pins


def check_progress(previous, current):
    for key, head in previous.get('cipher_devices', {}).items():
        if current.get('cipher_devices', {}).get(key) != head:
            raise ValueError('global_cipher_pin_rollback_or_fork')
