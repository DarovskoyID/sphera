import copy
from hashlib import sha256
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .consensus_directory import ConsensusDirectory
from .discovery import endpoint_record, validate_endpoints, validate_endpoint, discovered_peers
from .identity import node_id
from .replication import ReplicaJournal
from .storage import canonical


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.now=int(time.time())
        self.keys=[Ed25519PrivateKey.generate() for _ in range(4)]
        self.directory=Mock(spec=ConsensusDirectory)
        self.directory.network='lab';self.directory.pin='a'*64
        self.directory.lock=threading.RLock()
        self.directory.anchor.return_value={'expires_at':self.now+30}
        self.state={'block_time':self.now,'endpoints':{},'candidates':{}}
        self.directory.current={'state':self.state}
        for index in range(3):self.add(index,12340+index)

    def add(self,index,port,version=1):
        key=self.keys[index];identity=node_id(key.public_key().public_bytes_raw())
        old=self.state['endpoints'].get(identity)
        previous=old['digest'] if old else '0'*64
        record=endpoint_record(key,'lab',f'http://127.0.0.1:{port}',version=version,previous=previous,now=self.now)
        self.state['candidates'][identity]={'record':{'body':{'public_key':record['body']['public_key']}}}
        self.state['endpoints'][identity]={'record':record,'digest':sha256(canonical(record)).hexdigest(),'accepted_at':self.now}
        return identity

    def test_owner_signature_expiry_and_registered_key(self):
        validate_endpoints(self.state,'lab')
        self.assertEqual(len(discovered_peers(self.directory)['peers']),3)
        self.assertEqual(discovered_peers(self.directory,now=self.now+3600)['peers'],{})
        identity=next(iter(self.state['endpoints']))
        record=copy.deepcopy(self.state['endpoints'][identity]['record'])
        record['body']['endpoint']='http://127.0.0.1:1'
        with self.assertRaises(ValueError):validate_endpoint(record,'lab',self.now)
        self.state['candidates'].pop(identity)
        with self.assertRaises(ValueError):validate_endpoints(self.state,'lab')

    def test_single_bootstrap_resolves_updates_and_restart_uses_genesis_pin(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'journal.sqlite3'
            def create():return ReplicaJournal.from_discovery(path,self.keys[0],self.directory,['http://127.0.0.1:26657'],':memory:')
            journal=create()
            try:
                self.assertEqual(len(journal.endpoints),3)
                identity=self.add(1,23456,version=2)
                journal.refresh_discovery()
                self.assertEqual(journal.endpoints[identity],'http://127.0.0.1:23456')
                self.add(3,23457)
            finally:journal.close()
            journal=create()
            try:
                self.assertEqual(len(journal.endpoints),4)
                self.assertEqual(self.directory.refresh.call_count,2)
                with patch('sfera_mesh.replication.time.time',return_value=self.now+31),patch('sfera_mesh.replication.exchange') as exchange:
                    self.assertIsNone(journal._request(identity,'probe',{}))
                    exchange.assert_not_called()
            finally:journal.close()
            self.directory.pin='b'*64
            with self.assertRaisesRegex(ValueError,'context_changed'):create()

    def use_https(self):
        self.state['endpoint_policy']='https-v1'
        for index in range(3):
            identity=node_id(self.keys[index].public_key().public_bytes_raw())
            record=endpoint_record(self.keys[index],'lab',f'https://peer-{index}.example:8443',now=self.now,endpoint_policy='https-v1')
            self.state['endpoints'][identity]={'record':record,'digest':sha256(canonical(record)).hexdigest(),'accepted_at':self.now}

    def test_https_policy_no_downgrade_and_canonical_addresses(self):
        self.use_https();validate_endpoints(self.state,'lab')
        record=next(iter(self.state['endpoints'].values()))['record']
        with self.assertRaises(ValueError):validate_endpoint(record,'lab',self.now)
        for address in ('http://127.0.0.1:80','https://point.example','https://UPPER.example:443','https://point.example:0443','https://point.example:443/','https://user@point.example:443','https://point..example:443','https://-point.example:443','https://[::1]:443','https://point.example:443?x=1','https://point.example:443#x'):
            with self.assertRaises(ValueError):endpoint_record(self.keys[0],'lab',address,now=self.now,endpoint_policy='https-v1')

    def test_https_discovery_refresh_expiry_and_explicit_mode(self):
        with self.assertRaises(ValueError):discovered_peers(self.directory,https_only=True)
        self.use_https()
        with tempfile.TemporaryDirectory() as temp:
            journal=ReplicaJournal.from_discovery(Path(temp)/'replica.sqlite',self.keys[0],self.directory,['http://127.0.0.1:26657'],Path(temp)/'replays.sqlite',https_only=True)
            try:
                identity=node_id(self.keys[1].public_key().public_bytes_raw());old=self.state['endpoints'][identity]
                record=endpoint_record(self.keys[1],'lab','https://moved.example:9443',now=self.now,version=2,previous=old['digest'],endpoint_policy='https-v1')
                self.state['endpoints'][identity]={'record':record,'digest':sha256(canonical(record)).hexdigest(),'accepted_at':self.now}
                journal.refresh_discovery();self.assertEqual(journal.verifier.secure_transport.peers[identity],'https://moved.example:9443')
                with self.assertRaises(ValueError):journal.verifier.secure_transport.route('https://peer-1.example:8443',identity,'probe')
                with patch('sfera_mesh.replication.time.time',return_value=self.now+31),patch('sfera_mesh.replication.exchange') as exchange:
                    self.assertIsNone(journal._request(identity,'probe',{}));exchange.assert_not_called()
            finally:journal.close()
