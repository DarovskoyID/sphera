import copy
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
from types import SimpleNamespace
import unittest
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .consensus_directory import ConsensusDirectory, ConsensusUnavailable
from .identity import node_id
from .recovery_roots import namespace, root_record, validate_root, validate_recovery_roots, check_progress, current_root
from .storage import canonical


class RecoveryRootTests(unittest.TestCase):
    def setUp(self):
        self.key = Ed25519PrivateKey.generate()
        self.publisher = node_id(self.key.public_key().public_bytes_raw())
        self.scope = str(uuid.uuid4())
        self.digest = sha256(canonical([b'index'.hex()])).hexdigest()
        self.size = len(canonical([b'index'.hex()]))
        self.record = root_record(self.key, 'lab', 'a'*64, 'dm', self.scope, 'b'*64, self.digest, self.size)
        self.head = {'record': self.record, 'digest': sha256(canonical(self.record)).hexdigest()}
        self.identity = namespace(self.publisher, 'dm', self.scope)
        self.state = {'network': 'lab', 'candidates': {self.publisher: {'record': {'body': {
            'public_key': self.key.public_key().public_bytes_raw().hex()}}}},
            'manifests': {'b'*64: {'record': {'body': {'digests': [self.digest], 'sizes': [self.size]}}}},
            'recovery_roots': {self.identity: self.head}}

    def test_signature_context_and_owned_namespace(self):
        validate_recovery_roots(self.state, 'lab', 'a'*64)
        self.assertEqual(validate_root(self.record, 'lab', 'a'*64)[1], self.head['digest'])
        self.assertNotEqual(self.identity, namespace(self.publisher, 'guild', self.scope))
        other = Ed25519PrivateKey.generate()
        self.assertNotEqual(self.identity, namespace(node_id(other.public_key().public_bytes_raw()), 'dm', self.scope))
        for field, value in (('size', self.size+1), ('genesis', 'b'*64), ('source', 'guild'), ('scope', str(uuid.uuid4())), ('version', 2)):
            changed = copy.deepcopy(self.record); changed['body'][field] = value
            with self.assertRaises(ValueError):
                validate_root(changed, 'lab', 'a'*64)
        changed = copy.deepcopy(self.record); changed['extra'] = True
        with self.assertRaises(ValueError):
            validate_root(changed, 'lab', 'a'*64)

    def test_only_sized_committed_payload_and_registered_key_are_accepted(self):
        for modify in (
            lambda state: state['candidates'].clear(),
            lambda state: state['manifests'].clear(),
            lambda state: state['manifests']['b'*64]['record']['body'].pop('sizes'),
            lambda state: state['manifests']['b'*64]['record']['body'].update(sizes=[self.size+1]),
            lambda state: state['recovery_roots'][self.identity].update(digest='f'*64),
        ):
            state = copy.deepcopy(self.state); modify(state)
            with self.assertRaises(ValueError):
                validate_recovery_roots(state, 'lab', 'a'*64)

    def test_root_high_water_survives_reader_restart(self):
        with TemporaryDirectory() as folder:
            genesis = Path(folder) / 'genesis.json'; genesis.write_text(json.dumps({'chain_id': 'lab'}))
            path = Path(folder) / 'reader.sqlite'
            state = {**copy.deepcopy(self.state), 'height': 1, 'accounts': {}}
            verified = {'state': state, 'header_hash': '1'*64, 'validators_hash': '2'*64, 'header_time': int(time.time())}
            directory = ConsensusDirectory(path, 'unused-test-verifier', genesis)
            try:
                directory._install(verified, {'state': state})
            finally:
                directory.close()
            for change in ('missing', 'fork', 'older', 'wrong_previous'):
                directory = ConsensusDirectory(path, 'unused-test-verifier', genesis)
                try:
                    later = copy.deepcopy(verified); later['state']['height'] = 2; later['header_hash'] = '3'*64
                    head = later['state']['recovery_roots'][self.identity]
                    if change == 'missing': later['state']['recovery_roots'] = {}
                    elif change == 'fork': head['digest'] = '4'*64
                    elif change == 'older': head['record']['body']['version'] = 0
                    else:
                        head['record']['body']['version'] = 2; head['record']['body']['previous'] = 'f'*64
                    with self.assertRaisesRegex(ValueError, 'recovery_root_rollback_or_fork'):
                        directory._install(later, {'state': later['state']})
                    self.assertEqual(directory.db.execute('SELECT height FROM consensus_snapshot').fetchone(), (1,))
                finally:
                    directory.close()

    def test_current_lookup_never_uses_stale_or_foreign_namespace(self):
        def anchor():
            if not directory.available: raise ConsensusUnavailable('offline')
            return {'height': 5}
        directory = SimpleNamespace(lock=threading.RLock(), available=True, anchor=anchor, current={'state': self.state})
        result = current_root(directory, self.publisher, 'dm', self.scope)
        result['record']['body']['version'] = 99
        self.assertEqual(self.record['body']['version'], 1)
        with self.assertRaisesRegex(ValueError, 'not_published'):
            current_root(directory, self.publisher, 'guild', self.scope)
        self.state['recovery_trees'] = {self.identity: {'record': {'body': {'version': 2}}}}
        with self.assertRaisesRegex(ValueError, 'v2_reader_required'):
            current_root(directory, self.publisher, 'dm', self.scope)
        self.state.pop('recovery_trees')
        directory.available = False
        with self.assertRaises(ConsensusUnavailable):
            current_root(directory, self.publisher, 'dm', self.scope)

    def test_registry_limit_and_noninteger_fields(self):
        for field, value in (('version', True), ('size', True), ('version', 2**63), ('size', 262145)):
            changed = copy.deepcopy(self.record); changed['body'][field] = value
            changed['signature'] = self.key.sign(canonical(changed['body'])).hex()
            with self.assertRaises(ValueError):
                validate_root(changed, 'lab', 'a'*64)
        state = {**self.state, 'recovery_roots': {str(index): self.head for index in range(129)}}
        with self.assertRaisesRegex(ValueError, 'limit'):
            validate_recovery_roots(state, 'lab', 'a'*64)

    def test_known_messages_and_deletions_survive_version_jumps(self):
        identity = str(uuid.uuid4())
        first = root_record(self.key, 'lab', 'a'*64, 'dm', self.scope, 'b'*64, self.digest, self.size,
            messages=[identity], deleted=[identity])
        old_head = {'record': first, 'digest': sha256(canonical(first)).hexdigest()}
        old = {'recovery_roots': {self.identity: old_head}}
        for version in (2, 8):
            good = root_record(self.key, 'lab', 'a'*64, 'dm', self.scope, 'b'*64, self.digest, self.size,
                version=version, previous=old_head['digest'], messages=[identity], deleted=[identity])
            current = {'recovery_roots': {self.identity: {'record': good, 'digest': sha256(canonical(good)).hexdigest()}}}
            check_progress(old, current)
            for field in ('messages', 'deleted'):
                changed = copy.deepcopy(current)
                changed['recovery_roots'][self.identity]['record']['body'][field] = []
                with self.assertRaisesRegex(ValueError, 'omission_or_resurrection'):
                    check_progress(old, changed)


if __name__ == '__main__':
    unittest.main()
