"""New JS process recovers an archive through seven real loopback storage nodes.

No production data, account/login session or consensus is involved. The original
JS process exits before the second device opens the recovered encrypted vault.
"""
import json
from hashlib import sha256
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'django-server' / 'sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.identity import node_id, EnvelopeVerifier
from sfera_mesh.directory import AccountDirectory
from sfera_mesh.directory_client import publish_account, resolve_account
from sfera_mesh.transport import BlobStore, LabServer, exchange


def device(value):
    result = subprocess.run(['node', 'scripts/mesh-account-fixture.cjs'], input=json.dumps(value), text=True, capture_output=True, cwd=ROOT, timeout=60, check=True)
    return json.loads(result.stdout)


created = device({'mode': 'create'})
assert set(created) == {'record', 'vault_hex', 'index_hex', 'archive_hex'}  # No root key crosses processes.
identity = created['record']['body']['user_id']
with TemporaryDirectory() as folder:
    keys = [Ed25519PrivateKey.generate() for _ in range(7)]
    ids = [node_id(key.public_key().public_bytes_raw()) for key in keys]
    roster = {identity: key.public_key().public_bytes_raw() for identity, key in zip(ids, keys)}
    checks, stores, directories, servers, threads = [], [], [], [], []
    stopped = set()
    try:
        for i in range(7):
            checks.append(EnvelopeVerifier('lab', ids[i], roster, str(Path(folder) / f'{i}-nonces.sqlite')))
            stores.append(BlobStore(str(Path(folder) / f'{i}-blobs.sqlite')))
            directories.append(AccountDirectory(str(Path(folder) / f'{i}-directory.sqlite'), 'lab'))
            servers.append(LabServer(keys[i], checks[i], stores[i], directories[i]))
            thread = threading.Thread(target=servers[i].serve_forever, daemon=True)
            thread.start()
            threads.append(thread)
        peers = [(ids[i], servers[i].endpoint) for i in range(3)]
        for field in ('vault_hex', 'index_hex', 'archive_hex'):
            data = bytes.fromhex(created[field])
            payload = {'digest': sha256(data).hexdigest(), 'ciphertext': data.hex()}
            for node, endpoint in peers:
                exchange(endpoint, keys[6], checks[6], node, 'put', payload)
        assert len(publish_account(created['record'], peers, keys[6], checks[6])) == 3
        servers[0].shutdown()
        servers[0].server_close()
        stopped.add(0)
        found = resolve_account(identity, peers, keys[6], checks[6], directories[6])
        assert found['synced'] and not found['account']['confirmed']
        record = found['account']['record']
        recovered = {'mode': 'open', 'record': record, 'expectedUser': identity}
        for field in ('vault_hex', 'index_hex', 'archive_hex'):
            # Archive location is inside the encrypted index; this coordinator
            # knows its fixture digest, the second device verifies it after decryption.
            digest = record['body']['vault_digest'] if field == 'vault_hex' else record['body']['dialogs_digest'] if field == 'index_hex' else sha256(bytes.fromhex(created[field])).hexdigest()
            response = exchange(servers[1].endpoint, keys[6], checks[6], ids[1], 'get', {'digest': digest})
            recovered[field] = response['ciphertext']
        opened = device(recovered)
        assert opened == {'opened': True, 'user_id': identity}
    finally:
        for i, server in enumerate(servers):
            if i not in stopped:
                server.shutdown()
                server.server_close()
        for thread in threads:
            thread.join(timeout=2)
        for directory in directories:
            directory.close()
        for store in stores:
            store.close()
        for check in checks:
            check.close()
print('PASS: new client process opens replicated encrypted vault, index and archive after original storage node stops; root key never leaves either client process.')
