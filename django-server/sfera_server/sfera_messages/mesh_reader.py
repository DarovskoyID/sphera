"""Independent read runtime: verified checkpoints and replay state, no write queue."""
from contextlib import contextmanager, ExitStack
from dataclasses import dataclass
import os
from pathlib import Path
import time
from urllib.error import HTTPError

from django.conf import settings

from sfera_mesh.consensus_directory import ConsensusDirectory, validate_address
from sfera_mesh.discovery import discovered_peers
from sfera_mesh.identity import load_identity, node_id, EnvelopeVerifier
from sfera_mesh.manifest_reads import validate_size_queries, verified_manifests, check_sizes
from sfera_mesh.refresh_lock import RefreshLock
from sfera_mesh.storage import canonical
from sfera_mesh.transport import exchange


def _configuration(config):
    required = {'identity', 'replays', 'verified_state', 'verifier', 'genesis', 'rpc'}
    full = required | {'replicas', 'payloads', 'index', 'publication', 'write_queue'}
    if not isinstance(config, dict) or (set(config) != required and set(config) - {'growth_budgets'} != full):
        raise ValueError('invalid_message_mesh_reader_configuration')
    paths = []
    for key in required - {'rpc'}:
        if not isinstance(config[key], str) or not Path(config[key]).is_absolute():
            raise ValueError('absolute_message_mesh_paths_required')
        paths.append(os.path.normcase(str(Path(config[key]).resolve())))
    if len(set(paths)) != len(paths):
        raise ValueError('separate_message_mesh_files_required')
    app_databases = {os.path.normcase(str(Path(db['NAME']).resolve())) for db in settings.DATABASES.values()
                     if db.get('ENGINE', '').endswith('sqlite3') and db.get('NAME') and db['NAME'] != ':memory:'}
    if set(paths).intersection(app_databases):
        raise ValueError('message_mesh_files_must_not_be_application_database')
    validate_address(config['rpc'])
    return {key: config[key] for key in required}


class _ReadTransport:
    def __init__(self, directory, key, replay_path):
        self.directory, self.key = directory, key
        self.recipient = node_id(key.public_key().public_bytes_raw())
        snapshot = discovered_peers(directory)
        if self.recipient not in snapshot['peers']:
            raise ValueError('message_mesh_reader_advertised_identity_required')
        self.verifier = EnvelopeVerifier(directory.network, self.recipient,
            {node: bytes.fromhex(peer['public_key']) for node, peer in snapshot['peers'].items()}, replay_path)
        try:
            self.refresh_discovery()
        except BaseException:
            self.verifier.close()
            raise

    def close(self):
        self.verifier.close()

    def refresh_discovery(self):
        peers = discovered_peers(self.directory)['peers']
        if self.recipient not in peers:
            raise ValueError('message_mesh_reader_advertised_identity_required')
        self.endpoints = {node: peer['endpoint'] for node, peer in peers.items()}
        self.peer_expiry = {node: peer['expires_at'] for node, peer in peers.items()}
        self.verifier.roster.update({node: bytes.fromhex(peer['public_key']) for node, peer in peers.items()})

    def _request(self, node, operation, payload):
        if operation != 'get':
            raise ValueError('message_mesh_reader_get_only')
        try:
            self.directory.anchor()
            if time.time() >= min(self.peer_expiry.get(node, 0), self.peer_expiry.get(self.recipient, 0)):
                return None
            return exchange(self.endpoints[node], self.key, self.verifier, node, operation, payload)
        except HTTPError as exc:
            exc.close()
            return None
        except (OSError, ValueError, KeyError, TypeError):
            return None


@dataclass
class _ReadContext:
    directory: ConsensusDirectory
    address: str
    journal: _ReadTransport | None = None


class MessageMeshReader:
    def __init__(self, directory, address):
        self.publication = _ReadContext(directory, address)

    def refresh(self):
        directory = self.publication.directory
        lock = RefreshLock(directory.refresh_lock_path)
        if not lock.acquire():
            # A concurrent reader/updater owns network refresh. Only an already
            # verified, still-fresh persisted checkpoint may serve this read.
            result = directory.restore()
        else:
            try:
                result = directory.refresh(self.publication.address)
            finally:
                lock.release()
        if self.publication.journal is not None:
            self.publication.journal.refresh_discovery()
        return result

    def confirm_sizes(self, cluster, sizes):
        return self.confirm_clusters({cluster: sizes})[cluster]

    def confirm_clusters(self, queries):
        validate_size_queries(queries)
        self.refresh()
        anchor, known = verified_manifests(self.publication.directory)
        return check_sizes(anchor, known, queries)


@contextmanager
def open_reader(config, *, clusters=None):
    config = _configuration(config)
    with ExitStack() as stack:
        directory = ConsensusDirectory(config['verified_state'], config['verifier'], config['genesis'])
        stack.callback(directory.close)
        key = load_identity(config['identity'])
        identity = node_id(key.public_key().public_bytes_raw())
        with directory.db:
            directory.db.execute('CREATE TABLE IF NOT EXISTS message_reader_context(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL)')
            directory.db.execute('BEGIN IMMEDIATE')
            context = canonical({'genesis': directory.pin, 'node': identity})
            old = directory.db.execute('SELECT context FROM message_reader_context').fetchone()
            if old and old[0] != context:
                raise ValueError('message_mesh_reader_context_changed')
            directory.db.execute('INSERT OR IGNORE INTO message_reader_context VALUES(1,?)', (context,))
        reader = MessageMeshReader(directory, config['rpc'])
        reader.refresh()
        if clusters is not None:
            for cluster in clusters:
                directory.placement(cluster)
        transport = _ReadTransport(directory, key, config['replays'])
        stack.callback(transport.close)
        reader.publication.journal = transport
        yield reader
