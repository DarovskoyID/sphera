"""Live consensus + seven HTTP storage nodes. Imported by the integration test."""
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
import threading
import time
import uuid
import copy

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.directory import ZERO
from sfera_mesh.identity import node_id, EnvelopeVerifier
from sfera_mesh.health import HealthJournal
from sfera_mesh.placements import cluster_id, consent_placement, consent_licensed_placement, validate_placement
from sfera_mesh.licenses import placement_candidate
from sfera_mesh.replication import ReplicaJournal
from sfera_mesh.storage import canonical
from sfera_mesh.topology import Candidate, choose_cluster, choose_replacement
from sfera_mesh.transport import BlobStore, LabServer


def verify_placements(network, temp, directory, address, submit, wait_for, license_issuer):
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
    issuer_public = license_issuer.public_key().public_bytes_raw()
    issuer_id = sha256(issuer_public).hexdigest()
    trusted_issuers = {issuer_id:issuer_public}
    issued = int(time.time())
    documents = {}
    for node in ids:
        claims = {'schema':'sfera-mesh-license-v1','issuer':issuer_id,'instance_id':str(uuid.uuid4()),'node_id':node,'network':network,'issued_at':issued,'expires_at':issued+240,'modules':[{'id':'office','expires_at':issued+3600}]}
        documents[node] = {'claims':claims,'signature':license_issuer.sign(canonical(claims)).hex()}
    profiles = [placement_candidate(documents[node], trusted_issuers, node, network, f'failure-domain-{i}') for i,node in enumerate(ids)]
    members = sorted(node.node_id for node in choose_cluster(profiles))
    cluster = cluster_id(network, members)
    def record(members, epoch=1, previous=ZERO):
        licenses = [documents[node] for node in sorted(members)]
        body = {'domain': 'sfera-mesh-placement-v2', 'network': network, 'cluster': cluster, 'epoch': epoch, 'previous': previous, 'members': sorted(members),'licenses_hash':sha256(canonical(licenses)).hexdigest()}
        item = {'body': body, 'consents': [consent_licensed_placement(body, licenses, lookup[node], trusted_issuers) for node in body['members']], 'licenses':licenses}
        validate_placement(item, network)
        return item
    def refresh_epoch(epoch):
        directory.refresh(address)
        return directory.placement(cluster)['record']['body']['epoch'] == epoch
    try:
        first = record(members)
        # Re-sign node consents deliberately: these must fail because of the
        # company proof, not because a node forgot to sign the modified body.
        for attack in ('tampered','expired','future','ttl','unknown_module','wrong_node','wrong_network','duplicate_instance','unknown_issuer'):
            bad = copy.deepcopy(first)
            claims = bad['licenses'][0]['claims']
            signing_key = license_issuer
            if attack == 'tampered': claims['modules'] = []
            elif attack == 'expired': claims.update(issued_at=issued-400,expires_at=issued-100)
            elif attack == 'future': claims.update(issued_at=issued+120,expires_at=issued+240)
            elif attack == 'ttl': claims['expires_at'] = issued+301
            elif attack == 'unknown_module': claims['modules'][0]['id'] = 'not-a-module'
            elif attack == 'wrong_node': claims['node_id'] = next(node for node in ids if node not in members)
            elif attack == 'wrong_network': claims['network'] = 'another-network'
            elif attack == 'duplicate_instance': claims['instance_id'] = bad['licenses'][1]['claims']['instance_id']
            else:
                signing_key = Ed25519PrivateKey.generate()
                claims['issuer'] = sha256(signing_key.public_key().public_bytes_raw()).hexdigest()
            if attack != 'tampered': bad['licenses'][0]['signature'] = signing_key.sign(canonical(claims)).hex()
            bad['body']['licenses_hash'] = sha256(canonical(bad['licenses'])).hexdigest()
            bad['consents'] = [consent_placement(bad['body'],lookup[node]) for node in members]
            assert submit(bad)['code'] != 0, attack
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
