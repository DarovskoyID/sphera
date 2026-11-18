"""Explicit loopback worker assembly; no worker threads start during web imports."""
from contextlib import contextmanager, ExitStack
import os
from pathlib import Path
from django.conf import settings

from sfera_mesh.consensus_directory import ConsensusDirectory
from sfera_mesh.identity import load_identity
from sfera_mesh.publication import ReplicaPublication
from sfera_mesh.replication import ReplicaJournal
from sfera_mesh.refresh_lock import RefreshLock
from sfera_mesh.storage import Storage
from sfera_mesh.storage_publication import StoragePublication
from sfera_mesh.write_queue import ConsensusWriteQueue


@contextmanager
def open_writer(config, *, clusters=None):
    required = {'identity', 'replicas', 'replays', 'verified_state', 'verifier', 'genesis',
                'rpc', 'payloads', 'index', 'publication', 'write_queue'}
    if not isinstance(config, dict) or set(config) - {'growth_budgets'} != required:
        raise ValueError('invalid_message_mesh_worker_configuration')
    files = required - {'rpc', 'publication'}
    if any(not isinstance(config[key], str) or not Path(config[key]).is_absolute() for key in files):
        raise ValueError('absolute_message_mesh_paths_required')
    paths = [os.path.normcase(str(Path(config[key]).resolve())) for key in files]
    if len(set(paths)) != len(paths):
        raise ValueError('separate_message_mesh_files_required')
    app_databases = {os.path.normcase(str(Path(db['NAME']).resolve())) for db in settings.DATABASES.values()
                     if db.get('ENGINE', '').endswith('sqlite3') and db.get('NAME') and db['NAME'] != ':memory:'}
    if set(paths).intersection(app_databases):
        raise ValueError('message_mesh_files_must_not_be_application_database')
    if not isinstance(config['publication'], str) or not Path(config['publication']).is_absolute():
        raise ValueError('absolute_message_mesh_paths_required')
    if os.path.normcase(str(Path(config['publication']).resolve())) in paths:
        raise ValueError('separate_message_mesh_files_required')
    budgets = config.get('growth_budgets', {})
    if not isinstance(budgets, dict) or len(budgets) > 64:
        raise ValueError('invalid_message_growth_budgets')
    with ExitStack() as stack:
        lock = RefreshLock(str(Path(config['index']).resolve()) + '.django-message-worker.lock')
        if not lock.acquire():
            raise ValueError('message_mesh_worker_already_running')
        stack.callback(lock.release)
        directory = ConsensusDirectory(config['verified_state'], config['verifier'], config['genesis'])
        stack.callback(directory.close)
        key = load_identity(config['identity'])
        journal = ReplicaJournal.from_discovery(config['replicas'], key, directory, [config['rpc']], config['replays'])
        stack.callback(journal.close)
        if clusters is None:
            clusters = {row['record']['body']['cluster'] for row in directory.current['state'].get('placements', {}).values()
                        if journal.verifier.recipient in row['record']['body']['members']}
        for cluster in sorted(clusters):
            if journal.verifier.recipient not in directory.placement(cluster)['record']['body']['members']:
                raise ValueError('message_mesh_current_holder_required')
            profiles = [profile for profile in directory.placement_candidates(cluster=cluster) if profile.node_id in journal.endpoints]
            journal.apply_confirmed_placement(directory, cluster, profiles)
        for cluster, budget in budgets.items():
            journal.use_growth_budget(directory, cluster, budget)
        publication = ReplicaPublication(config['publication'], directory, config['rpc'], journal)
        queue = ConsensusWriteQueue(config['write_queue'], publication,
            content_bound=getattr(settings, 'SFERA_MESH_WRITE_QUEUE_V2', False))
        stack.callback(queue.close)
        storage = Storage(config['payloads'], config['index'])
        stack.callback(storage.close)
        yield StoragePublication(storage, publication, queue)
