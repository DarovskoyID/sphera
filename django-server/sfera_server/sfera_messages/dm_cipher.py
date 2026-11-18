"""Opaque personal-message envelopes. Parsing never decrypts client ciphertext."""
import json
import re
import uuid
from hashlib import sha256

from sfera_mesh.cipher_relay import exact, public, sdk_user
from sfera_mesh.storage import canonical

KIND = 'cipher'
IMMUTABLE = ('conversation_id', 'author_id', 'encrypted_content', 'encrypted_payload',
    'message_type', 'reply_to_id', 'live_until', 'edited', 'created_at')


def parse(value, scope, *, identity=None, author=None, source='dm', guild=None):
    if len(canonical(value)) > 131072:
        raise ValueError('cipher_message_too_large')
    value = json.loads(canonical(value))
    exact(value, ('domain', 'scope', 'id', 'sender', 'envelope') + (('guild',) if source == 'guild' else ()))
    if source not in ('dm', 'guild') or value['domain'] != f'sfera-{source}-cipher-message-v1' or value['scope'] != str(scope):
        raise ValueError('cipher_message_context_mismatch')
    if source == 'guild' and (guild is None or value['guild'] != str(guild)):
        raise ValueError('cipher_message_guild_mismatch')
    if not isinstance(value['id'], str) or str(uuid.UUID(value['id'])) != value['id']:
        raise ValueError('invalid_cipher_message_id')
    if identity is not None and value['id'] != str(identity):
        raise ValueError('cipher_message_id_mismatch')
    sender = value['sender']
    exact(sender, ('user', 'owner', 'device'))
    if (not isinstance(sender['user'], str) or str(uuid.UUID(sender['user'])) != sender['user'] or
            any(not isinstance(sender[key], str) or not re.fullmatch('[0-9a-f]{64}', sender[key]) for key in ('owner', 'device')) or
            (author is not None and sender['user'] != str(author))):
        raise ValueError('cipher_message_author_mismatch')
    envelope = value['envelope']
    exact(envelope, ('room', 'epoch', 'message_id', 'sender_device', 'content'))
    if (envelope['message_id'] != value['id'] or envelope['sender_device'] != sender['device'] or
            type(envelope['epoch']) is not int or not 1 <= envelope['epoch'] <= 2147483647 or
            not isinstance(envelope['room'], str) or not re.fullmatch(r'![0-9a-f]{64}:[0-9a-f]{64}\.sphere', envelope['room'])):
        raise ValueError('cipher_message_envelope_mismatch')
    content = envelope['content']
    exact(content, ('algorithm', 'ciphertext', 'sender_key', 'session_id', 'device_id'))
    if (content['algorithm'] != 'm.megolm.v1.aes-sha2' or content['device_id'] != sender['device'] or
            not isinstance(content['ciphertext'], str) or not re.fullmatch('[A-Za-z0-9+/]{1,131000}', content['ciphertext'])):
        raise ValueError('invalid_cipher_message_content')
    public(content['sender_key']); public(content['session_id'])
    return value


def room_for(proof):
    peers = [item['body'] for item in proof['certificates']]
    digest = sha256(canonical(['sfera-mesh-cipher-scope-id-v1', proof['network'], proof['genesis'],
        proof['entry'], proof['source'], proof['scope']])).hexdigest()
    scope = '-'.join((digest[:8], digest[8:12], digest[12:16], digest[16:20], digest[20:32]))
    pins = [[sdk_user(peer), peer['device'], peer['ed25519'], peer['curve25519']] for peer in peers]
    pins.sort(key=lambda item: ':'.join(item))
    return '!' + sha256(canonical(['sfera-mesh-group-context-v1', proof['network'], proof['genesis'],
        scope, proof['epoch'], pins])).hexdigest() + ':' + proof['genesis'] + '.sphere'


def authorize(value, proof, claim):
    sender, envelope = value['sender'], value['envelope']
    if (sender['owner'], sender['device']) != (claim['owner'], claim['device']):
        raise ValueError('cipher_message_session_mismatch')
    peers = [item['body'] for item in proof['certificates']]
    own = next((peer for peer in peers if (peer['owner'], peer['device']) == (sender['owner'], sender['device'])), None)
    room = room_for(proof)
    if own is None or envelope['epoch'] != proof['epoch'] or envelope['room'] != room or envelope['content']['sender_key'] != own['curve25519']:
        raise ValueError('cipher_message_roster_mismatch')


def validate_save(message, using, update_fields=None):
    # Called by every Message.save, independently of mesh publication flags.
    previous = type(message).objects.using(using).filter(pk=message.pk).values(*IMMUTABLE).first()
    old_cipher = previous is not None and previous['message_type'] == KIND
    if old_cipher and (update_fields is None or set(update_fields).intersection(IMMUTABLE)):
        if any(getattr(message, field) != previous[field] for field in IMMUTABLE):
            raise ValueError('cipher_message_is_immutable')
    if message.message_type != KIND:
        if old_cipher:
            raise ValueError('cipher_message_kind_is_immutable')
        return
    if previous is not None and not old_cipher:
        raise ValueError('cipher_message_kind_is_immutable')
    if message.content != '' or message.reply_to_id or message.live_until or message.edited:
        raise ValueError('cipher_message_plaintext_metadata_forbidden')
    parse(message.payload, message.conversation_id, identity=message.pk, author=message.author_id)
