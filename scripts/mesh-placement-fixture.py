"""Live consensus + seven HTTP storage nodes. Imported by the integration test."""
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
import threading
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.directory import ZERO
from sfera_mesh.identity import node_id, EnvelopeVerifier
from sfera_mesh.health import HealthJournal
from sfera_mesh.placements import cluster_id, consent_placement, validate_placement
from sfera_mesh.replication import ReplicaJournal
from sfera_mesh.storage import canonical
from sfera_mesh.topology import Candidate, choose_cluster, choose_replacement
from sfera_mesh.transport import BlobStore, LabServer


def verify_placements(network, temp, directory, address, submit, wait_for):
    keys = [Ed25519PrivateKey.generate() for _ in range(7)]
    ids = [node_id(key.public_key().public_bytes_raw()) for key in keys]
    lookup = dict(zip(ids, keys))
    roster = {node: key.public_key().public_bytes_raw() for node, key in zip(ids, keys)}
    checks = [EnvelopeVerifier(network, node, roster, ':memory:') for node in ids]
    stores = [BlobStore(':memory:') for _ in ids]
    servers = [LabServer(key, check, store) for key, check, store in zip(keys, checks, stores)]
    threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
    for thread in threads:
        thread.start()
    endpoints = {node: server.endpoint for node, server in zip(ids, servers)}
    path = str(Path(temp) / 'confirmed-replication.sqlite')
    journal = ReplicaJournal(path, keys[0], checks[0], endpoints, require_consensus=True)
    lagging = ReplicaJournal(str(Path(temp) / 'lagging-replication.sqlite'), keys[0], checks[0], endpoints, require_consensus=True)
    health = HealthJournal(str(Path(temp) / 'health.sqlite'), keys[0], checks[0], endpoints)
    profiles = [Candidate(node, f'failure-domain-{i}', frozenset({'office'}), grant_verified=True, grant_expires_at=int(time.time()) + 300) for i, node in enumerate(ids)]
    members = sorted(node.node_id for node in choose_cluster(profiles))
    cluster = cluster_id(network, members)
    def record(members, epoch=1, previous=ZERO):
        body = {'domain': 'sfera-mesh-placement-v1', 'network': network, 'cluster': cluster, 'epoch': epoch, 'previous': previous, 'members': sorted(members)}
        item = {'body': body, 'consents': [consent_placement(body, lookup[node]) for node in body['members']]}
        validate_placement(item, network)
        return item
    def refresh_epoch(epoch):
        directory.refresh(address)
        return directory.placement(cluster)['record']['body']['epoch'] == epoch
    try:
        first = record(members)
        invalid = {**first, 'consents': first['consents'][:2]}
        assert submit(invalid)['code'] != 0
        assert submit(first)['code'] == 0
        wait_for(lambda: refresh_epoch(1))
        try:
            journal.apply_confirmed_placement(directory, cluster, [replace(node, grant_verified=False) for node in profiles])
        except ValueError:
            pass
        else:
            raise AssertionError('confirmed proposal bypassed commercial placement checks')
        journal.apply_confirmed_placement(directory, cluster, profiles)
        lagging.apply_confirmed_placement(directory, cluster, profiles)
        digest = journal.stage(cluster, b'encrypted block under confirmed placement')
        lagging.stage(cluster, b'encrypted block under confirmed placement')
        journal.run_batch(cluster)
        assert journal.status(cluster, digest)['replicated']
        for node in members:
            health.probe(node, now=100)
            health.probe(node, now=105)
        failed = members[-1]
        server = servers[ids.index(failed)]
        server.shutdown()
        server.server_close()
        for moment in (110,115,120):
            health.probe(failed, now=moment)
        for node in members:
            if node != failed:
                health.probe(node, now=120)
        advisory = health.advisory(directory, cluster, now=120)
        assert advisory['can_request_consents']
        assert not advisory['replacement_authorised']
        assert directory.placement(cluster)['record']['body']['epoch'] == 1  # Observation alone changes nothing.
        profiles = [replace(node, capacity_ok=False) if node.node_id == failed else node for node in profiles]
        survivors = [node for node in profiles if node.node_id in members and node.node_id != failed]
        chosen = choose_replacement(survivors, [node for node in profiles if node.node_id not in members], cluster)
        replacement_members = sorted([node.node_id for node in survivors] + [chosen.node_id])
        second = record(replacement_members, 2, sha256(canonical(first)).hexdigest())
        assert submit(second)['code'] == 0
        wait_for(lambda: refresh_epoch(2))
        try:
            journal.replace_failed(cluster, failed, profiles, expected_epoch=1)
        except ValueError:
            pass
        else:
            raise AssertionError('operator bypassed consensus placement mode')
        with journal.db:
            journal.db.execute('UPDATE replica_jobs SET payload=NULL')
        journal.apply_confirmed_placement(directory, cluster, profiles)
        assert not journal.status(cluster, digest)['replicated']  # Old receipts have no new-epoch authority.
        journal.run_batch(cluster)
        assert journal.status(cluster, digest)['replicated']
        target = stores[ids.index(chosen.node_id)]
        assert target.execute('get', {'digest': digest})['ciphertext'] == b'encrypted block under confirmed placement'.hex()
        other = next(node for node in ids if node not in replacement_members and node != failed)
        competing = record([node.node_id for node in survivors] + [other], 2, sha256(canonical(first)).hexdigest())
        assert submit(competing)['code'] != 0
        journal.close()
        journal = ReplicaJournal(path, keys[0], checks[0], endpoints)
        assert journal.status(cluster, digest)['epoch'] == 2
        assert not journal.apply_confirmed_placement(directory, cluster, profiles)['changed']
        try:
            journal.register_cluster('unconfirmed', choose_cluster(profiles))
        except ValueError:
            pass
        else:
            raise AssertionError('unconfirmed triple entered a consensus-bound journal')
        retired = replacement_members[0]
        profiles = [replace(node, capacity_ok=False) if node.node_id == retired else node for node in profiles]
        survivors = [node for node in profiles if node.node_id in replacement_members and node.node_id != retired]
        chosen = choose_replacement(survivors, [node for node in profiles if node.node_id not in replacement_members], cluster)
        third = record([node.node_id for node in survivors] + [chosen.node_id], 3, sha256(canonical(second)).hexdigest())
        assert submit(third)['code'] == 0
        wait_for(lambda: refresh_epoch(3))
        with lagging.db:
            lagging.db.execute('UPDATE replica_jobs SET payload=NULL')
        lagging.apply_confirmed_placement(directory, cluster, profiles)  # Jumps 1 -> 3 using verified history.
        assert lagging.status(cluster, digest)['epoch'] == 3
        lagging.run_batch(cluster)
        assert lagging.status(cluster, digest)['replicated']
    finally:
        health.close()
        lagging.close()
        journal.close()
        for server in servers:
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(2)
        for check in checks:
            check.close()
        for store in stores:
            store.close()
