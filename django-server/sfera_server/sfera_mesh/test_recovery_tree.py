import copy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .recovery_tree import RecoveryTree, EMPTY, transition, path_root, head_record, validate_head, check_progress, validate_state
from .recovery_roots import namespace
from .compact_proof import CompactProofClient
from .consensus_directory import ConsensusDirectory
from .storage import canonical


def message(index):
    return f'{index:08x}-2222-2222-2222-222222222222'


class RecoveryTreeTests(unittest.TestCase):
    def test_more_than_512_messages_and_terminal_deletions_have_bounded_proofs(self):
        tree = RecoveryTree()
        root, count, deleted = tree.root, 0, 0
        for index in range(600):
            update = tree.update(message(index), 2 if index % 7 == 0 else 1)
            root, count, deleted = transition(root, count, deleted, [update])
            self.assertEqual(root, tree.root)
            self.assertLess(len(canonical(update)), 10000)
        self.assertEqual((count, deleted), (600, 86))
        self.assertEqual(tree.root, '4970480cb69efefb37d1e84b8ca25f8c59af47be67e7bf4245d40a5945fded74')
        self.assertEqual(path_root(message(599), 1, tree.proof(message(599))), tree.root)
        self.assertEqual(path_root(message(1000), 0, tree.proof(message(1000))), tree.root)
        self.assertNotEqual(path_root(message(0), 1, tree.proof(message(0))), tree.root)

    def test_old_proof_fork_drop_and_resurrection_are_rejected_without_mutation(self):
        tree = RecoveryTree([message(1), message(2)], [message(1)])
        before = tree.root
        for status in (0, 1):
            with self.assertRaises(ValueError):
                tree.update(message(1), status)
            self.assertEqual(tree.root, before)
        update = tree.update(message(3), 1)
        with self.assertRaisesRegex(ValueError, 'old_root'):
            transition(tree.root, 3, 1, [update])
        for field, value in (('old', True), ('new', False), ('path', []), ('message', message(4))):
            bad = copy.deepcopy(update); bad[field] = value
            with self.assertRaises(ValueError):
                transition(before, 2, 1, [bad])

    def test_sequential_batch_proofs_are_bound_to_intermediate_roots(self):
        tree = RecoveryTree()
        initial = tree.root
        updates = [tree.update(message(index), 1) for index in range(4)]
        self.assertEqual(transition(initial, 0, 0, updates), (tree.root, 4, 0))
        with self.assertRaises(ValueError):
            transition(initial, 0, 0, list(reversed(updates)))
        with self.assertRaises(ValueError):
            transition(initial, 0, 0, updates + [updates[0]])
        with self.assertRaises(ValueError):
            transition(initial, 0, 0, [updates[0], updates[0]])

    def test_legacy_migration_is_order_independent_and_preserves_tombstones(self):
        ids = [message(i) for i in range(256)]
        deleted = ids[::3]
        tree = RecoveryTree(ids, deleted)
        self.assertEqual(tree.root, RecoveryTree(reversed(ids), deleted).root)
        self.assertEqual(tree.root, 'd5bd5adaffdcadb1a9f3bb758ca67507c4b2ee8268456e778949bf756c81ab2a')
        self.assertNotEqual(tree.root, RecoveryTree(ids).root)
        with self.assertRaises(ValueError):
            RecoveryTree(ids, [message(1000)])

    def test_signed_header_is_small_and_commits_update_proofs(self):
        key = Ed25519PrivateKey.generate()
        tree = RecoveryTree([message(1)])
        record = head_record(key, 'lab', 'a' * 64, 'dm', message(99), 'b' * 64, 'c' * 64, 10, tree.root, 1, 0)
        self.assertLess(len(canonical(record)), 1600)
        self.assertEqual(validate_head(record, 'lab', 'a' * 64)[0]['root'], tree.root)
        bad = copy.deepcopy(record); bad['body']['count'] = 2
        with self.assertRaises(ValueError):
            validate_head(bad, 'lab', 'a' * 64)
        bad = copy.deepcopy(record); bad['body']['extra'] = 1
        with self.assertRaises(ValueError):
            validate_head(bad, 'lab', 'a' * 64)

    def test_high_water_survives_scope_removal_rollback_or_fork(self):
        old = {'digest': 'a' * 64, 'record': {'body': {'version': 4, 'count': 600, 'deleted_count': 86}}}
        previous = {'recovery_trees': {'namespace': old}}
        for new in (None, {'digest': 'b' * 64, 'record': {'body': {'version': 3, 'count': 600, 'deleted_count': 86}}},
                {'digest': 'b' * 64, 'record': {'body': {'version': 4, 'count': 600, 'deleted_count': 86}}},
                {'digest': 'b' * 64, 'record': {'body': {'version': 5, 'previous': 'a' * 64, 'count': 599, 'deleted_count': 86}}}):
            with self.assertRaises(ValueError):
                check_progress(previous, {'recovery_trees': {'namespace': new}} if new else {})

    def test_compact_proof_accepts_inclusion_deletion_and_absence_at_one_head(self):
        key = Ed25519PrivateKey.generate(); tree = RecoveryTree([message(1), message(2)], [message(2)])
        record = head_record(key, 'lab', 'a' * 64, 'dm', message(99), 'b' * 64, 'c' * 64, 10, tree.root, 2, 1)
        body, digest = validate_head(record, 'lab', 'a' * 64)
        head = {'record': record, 'digest': digest}
        leaf_key = 'recovery-tree/' + namespace(body['publisher'], 'dm', message(99)) + '/head'
        # Only the native BFT signature boundary is simulated here; sparse leaf
        # proofs and the publisher's header signature are real.
        native = {'leaf': {'key': leaf_key, 'value': head}, 'height': 20, 'header_hash': 'd' * 64, 'expires_at': 30}
        client = SimpleNamespace(network='lab', pin='a' * 64, _native=Mock(return_value=native), _checkpoint=Mock())
        entries = [{'message': message(i), 'status': status, 'path': tree.proof(message(i))} for i, status in ((1, 1), (2, 2), (3, 0))]
        verified = CompactProofClient.verify_recovery_tree(client, {}, body['publisher'], 'dm', message(99), entries=entries)
        self.assertEqual([entry['status'] for entry in verified['entries']], [1, 2, 0])
        client._checkpoint.assert_called_once()
        client._checkpoint.reset_mock()
        bad = copy.deepcopy(entries); bad[1]['status'] = 1
        with self.assertRaises(ValueError):
            CompactProofClient.verify_recovery_tree(client, {}, body['publisher'], 'dm', message(99), entries=bad)
        client._checkpoint.assert_not_called()
        with self.assertRaises(ValueError):
            CompactProofClient.verify_recovery_tree(client, {}, body['publisher'], 'guild', message(99), entries=entries)

    def test_state_binds_tree_to_exact_committed_size_and_candidate(self):
        key = Ed25519PrivateKey.generate(); tree = RecoveryTree([message(1)])
        record = head_record(key, 'lab', 'a' * 64, 'dm', message(99), 'b' * 64, 'c' * 64, 10, tree.root, 1, 0)
        body, digest = validate_head(record, 'lab', 'a' * 64)
        identity_key = namespace(body['publisher'], 'dm', message(99))
        state = {'recovery_trees': {identity_key: {'record': record, 'digest': digest}},
            'candidates': {body['publisher']: {'record': {'body': {'public_key': body['public_key']}}}},
            'manifests': {'b' * 64: {'record': {'body': {'digests': ['c' * 64], 'sizes': [10]}}}}}
        validate_state(state, 'lab', 'a' * 64)
        for mutation in ('size', 'candidate'):
            bad = copy.deepcopy(state)
            if mutation == 'size': bad['manifests']['b' * 64]['record']['body']['sizes'][0] += 1
            else: bad['candidates'].clear()
            with self.assertRaises(ValueError): validate_state(bad, 'lab', 'a' * 64)

    def test_persisted_high_water_is_checked_on_first_import_after_restart(self):
        # As with the legacy pointer test, only the native verified boundary is
        # simulated. The persisted SQLite checkpoint is real and reopened.
        with TemporaryDirectory() as folder:
            genesis = Path(folder) / 'genesis.json'; genesis.write_text(json.dumps({'chain_id': 'lab'}))
            path = Path(folder) / 'reader.sqlite'
            old = {'digest': 'a' * 64, 'record': {'body': {'version': 4, 'count': 600, 'deleted_count': 86}}}
            state = {'network': 'lab', 'height': 1, 'accounts': {}, 'recovery_trees': {'namespace': old}}
            verified = {'state': state, 'header_hash': '1' * 64, 'validators_hash': '2' * 64, 'header_time': int(time.time())}
            directory = ConsensusDirectory(path, 'unused-test-verifier', genesis)
            try: directory._install(verified, {'state': state})
            finally: directory.close()
            for change in ('missing', 'fork', 'older', 'wrong_previous', 'drop_count'):
                directory = ConsensusDirectory(path, 'unused-test-verifier', genesis)
                try:
                    later = copy.deepcopy(verified); later['state']['height'] = 2; later['header_hash'] = '3' * 64
                    head = later['state']['recovery_trees']['namespace']
                    if change == 'missing': later['state']['recovery_trees'] = {}
                    elif change == 'fork': head['digest'] = '4' * 64
                    elif change == 'older': head['record']['body']['version'] = 3
                    else:
                        head['record']['body'].update(version=5, previous='f' * 64 if change == 'wrong_previous' else 'a' * 64)
                        if change == 'drop_count': head['record']['body']['count'] = 599
                    with self.assertRaisesRegex(ValueError, 'recovery_tree_rollback_or_fork'):
                        directory._install(later, {'state': later['state']})
                    self.assertEqual(directory.db.execute('SELECT height FROM consensus_snapshot').fetchone(), (1,))
                finally: directory.close()


if __name__ == '__main__':
    unittest.main()
