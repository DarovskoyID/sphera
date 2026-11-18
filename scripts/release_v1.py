"""Production release documents; laboratory v1 packets are never accepted here.

Root keys authorize short-lived release/head signing keys. Client trust is built
into its binary, independently of the selected application/mesh server.
"""
import base64
import hashlib
import json
import re
import time
from pathlib import Path
from urllib.parse import urlsplit
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.exceptions import InvalidSignature

PRODUCT = 'sphere'
PLATFORMS = {'windows-x64': 'windows-installer', 'android-universal': 'android-apk',
    'ios-arm64': 'apple-store', 'macos-arm64': 'macos-pkg', 'macos-x64': 'macos-pkg',
    'linux-server-source': 'server-source'}
MAX_FILE = 512 * 1024 * 1024
HEX = re.compile(r'[0-9a-f]{64}\Z')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('duplicate_release_field')
        result[key] = value
    return result


def parse(raw, limit=32768):
    if len(raw) > limit: raise ValueError('release_document_limit')
    return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid_release_number')))


def fields(value, names):
    if not isinstance(value, dict) or set(value) != set(names.split()): raise ValueError('release_schema')


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high: raise ValueError('release_integer')


def public_text(key):
    return base64.b64encode(key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).decode()


def public_key(value):
    if not isinstance(value, str) or len(value) > 1024: raise ValueError('release_public_key')
    key = serialization.load_der_public_key(base64.b64decode(value, validate=True))
    if not isinstance(key, rsa.RSAPublicKey) or key.key_size not in (3072, 4096) or key.public_numbers().e != 65537 or public_text(key) != value:
        raise ValueError('release_public_key')
    return key


def key_id(value):
    public_key(value)
    return hashlib.sha256(base64.b64decode(value, validate=True)).hexdigest()


def trust_document(value, require_source=True):
    fields(value,'domain product channel root_public_key root_key_id base_url minimum_sequence')
    if value['domain']!='sphere-release-trust-v1' or value['product']!=PRODUCT or not isinstance(value['channel'],str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}',value['channel']):
        raise ValueError('release_trust_context')
    if value['root_key_id']!=key_id(value['root_public_key']): raise ValueError('release_root_id')
    integer(value['minimum_sequence'],1,2**53-1)
    if value['base_url'] is None and not require_source:return value
    url=value['base_url']
    if not isinstance(url,str) or len(url)>2048 or any(ord(char)<33 for char in url): raise ValueError('release_source_not_provisioned')
    parsed=urlsplit(url)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or not url.endswith('/') or '%' in parsed.path or '\\' in url or any(part in ('.','..') for part in parsed.path.split('/')):
        raise ValueError('release_https_source_required')
    if parsed.port is not None and not 1<=parsed.port<=65535: raise ValueError('release_source_port')
    return value


def sign(body, private):
    raw = canonical(body)
    return {'payload': base64.b64encode(raw).decode(), 'signature': base64.b64encode(private.sign(raw,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())).decode()}


def verify(packet, public):
    fields(packet, 'payload signature')
    if not all(isinstance(packet[name], str) for name in packet): raise ValueError('release_signature')
    raw = base64.b64decode(packet['payload'], validate=True)
    if len(raw) > 16384 or base64.b64encode(raw).decode() != packet['payload']: raise ValueError('release_payload')
    signature = base64.b64decode(packet['signature'], validate=True)
    try:public_key(public).verify(signature, raw, padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())
    except InvalidSignature:raise ValueError('release_signature_invalid') from None
    body = parse(raw, 16384)
    if canonical(body) != raw: raise ValueError('release_noncanonical')
    return body


def certificate(packet, root, channel, role, now=None):
    now = int(time.time()) if now is None else now
    body = verify(packet, root)
    fields(body, 'domain product channel key_id public_key roles not_before expires_at')
    if body['domain'] != 'sphere-release-delegation-v1' or body['product'] != PRODUCT or body['channel'] != channel:
        raise ValueError('release_delegation_context')
    if body['key_id'] != key_id(body['public_key']) or not isinstance(body['roles'], list) or not body['roles'] or len(set(body['roles'])) != len(body['roles']) or not set(body['roles']) <= {'release', 'head'} or role not in body['roles']:
        raise ValueError('release_delegation_role')
    integer(body['not_before'], 1, 2**53-1); integer(body['expires_at'], 1, 2**53-1)
    if not body['not_before'] <= now < body['expires_at'] or body['expires_at'] - body['not_before'] > 31*86400:
        raise ValueError('release_delegation_expired')
    return body


def document(bundle, root, channel, role, now=None):
    fields(bundle, 'certificate document')
    cert = certificate(bundle['certificate'], root, channel, role, now)
    return verify(bundle['document'], cert['public_key'])


def manifest(bundle, root, channel, platform, minimum=1, now=None):
    now = int(time.time()) if now is None else now
    body = document(bundle, root, channel, 'release', now)
    fields(body, 'domain product channel platform kind sequence version filename size sha256 publisher issued_at expires_at')
    if body['domain'] != 'sphere-release-v1' or body['product'] != PRODUCT or body['channel'] != channel or body['platform'] != platform or body['kind'] != PLATFORMS.get(platform):
        raise ValueError('release_manifest_context')
    integer(minimum, 1, 2**53-1); integer(body['sequence'], minimum, 2**53-1)
    integer(body['issued_at'], 1, 2**53-1); integer(body['expires_at'], 1, 2**53-1)
    delegated=certificate(bundle['certificate'],root,channel,'release',now)
    if body['issued_at'] > now+5 or body['issued_at'] < now-31*86400 or not now < body['expires_at'] <= min(body['issued_at']+31*86400,delegated['expires_at']):
        raise ValueError('release_manifest_expired')
    if not isinstance(body['version'], str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9.-]+)?', body['version']) or len(body['version']) > 64:
        raise ValueError('release_version')
    name = body['filename']
    reserved = {'con','prn','aux','nul', *('com'+str(i) for i in range(1,10)), *('lpt'+str(i) for i in range(1,10))}
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', name) or name.endswith('.') or name.split('.')[0].lower() in reserved:
        raise ValueError('release_filename')
    integer(body['size'], 0 if body['kind']=='apple-store' else 1, MAX_FILE)
    if not isinstance(body['sha256'], str) or not HEX.fullmatch(body['sha256']): raise ValueError('release_digest')
    publisher = body['publisher']
    if not isinstance(publisher, str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', publisher): raise ValueError('release_publisher')
    if body['kind'] in ('windows-installer', 'android-apk', 'server-source') and not HEX.fullmatch(publisher): raise ValueError('release_publisher')
    if body['kind']=='server-source' and publisher!=key_id(root): raise ValueError('server_publisher_root_mismatch')
    extension = {'windows-installer':('.exe','.msi'),'android-apk':('.apk',),'macos-pkg':('.pkg',),'apple-store':('.store',),'server-source':('.tar.gz',)}[body['kind']]
    if not name.lower().endswith(extension): raise ValueError('release_artifact_kind')
    return body


def head(bundle, root, channel, platform, nonce, now=None):
    now = int(time.time()) if now is None else now
    body = document(bundle, root, channel, 'head', now)
    fields(body, 'domain product channel platform nonce sequence manifest_sha256 issued_at expires_at')
    if body['domain'] != 'sphere-release-head-v1' or body['product'] != PRODUCT or body['channel'] != channel or body['platform'] != platform or not HEX.fullmatch(nonce) or body['nonce'] != nonce:
        raise ValueError('release_head_context')
    integer(body['sequence'], 1, 2**53-1); integer(body['issued_at'], 1, 2**53-1)
    delegated=certificate(bundle['certificate'],root,channel,'head',now)
    if not isinstance(body['manifest_sha256'], str) or not HEX.fullmatch(body['manifest_sha256']) or body['issued_at'] > now+5 or body['issued_at'] < now-30 or body['expires_at'] != body['issued_at']+30 or body['expires_at'] <= now or body['expires_at'] > delegated['expires_at']:
        raise ValueError('release_head_expired')
    return body


def artifact(body, path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.name != body['filename'] or path.stat().st_size != body['size']:
        raise ValueError('release_artifact_size')
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1048576), b''): digest.update(chunk)
    if digest.hexdigest() != body['sha256']: raise ValueError('release_artifact_digest')
    return path
