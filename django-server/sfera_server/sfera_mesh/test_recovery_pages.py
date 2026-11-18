import copy
from hashlib import sha256
import json
import random
import time
import unittest
import uuid
from cryptography.fernet import Fernet

from .recovery_tree import RecoveryTree
from .recovery_pages import build_index, PagedIndexReader, validate_index, validate_page
from .storage import canonical


def message(index): return f'{index:08x}-2222-2222-2222-222222222222'


class RecoveryPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cipher = Fernet(Fernet.generate_key())
        cls.members = [message(1000)]
        cls.entries = [{'message_id': message(i), 'author_id': message(1000), 'created_at': None if i % 7 == 0 else '2026-10-25T10:00:00+00:00',
            'cluster': 'b' * 64, 'digest': sha256(str(i).encode()).hexdigest(), 'size': 10, 'snapshot_hash': 'd' * 64, 'deleted': i % 7 == 0} for i in range(600)]
        cls.tree = RecoveryTree([item['message_id'] for item in cls.entries], [item['message_id'] for item in cls.entries if item['deleted']])
        cls.body = {'genesis': 'a' * 64, 'publisher': 'c' * 64, 'source': 'dm', 'scope': message(999),
            'version': 1, 'root': cls.tree.root, 'count': 600, 'deleted_count': 86}
        cls.plan = build_index(cls.body, cls.entries, cls.members, lambda raw: ('b' * 64, cls.cipher.encrypt(raw)))
        cls.body.update(cls.plan['reference'])

    def reader(self, **kwargs):
        self.calls = []
        def fetch(cluster, digest, size):
            self.calls.append((cluster, digest, size))
            return self.plan['blocks'][(cluster, digest)]
        return PagedIndexReader.from_block(self.body, self.members[0], fetch, self.cipher.decrypt, **kwargs)

    def test_600_messages_use_bounded_encrypted_pages_and_keyed_lookup(self):
        self.assertGreater(len(self.plan['blocks']), 70)
        self.assertLess(max(len(raw) for raw in self.plan['blocks'].values()), 262145)
        self.assertLess(self.body['size'], 6000)
        reader = self.reader()
        self.assertEqual(reader.lookup(message(599))['message_id'], message(599))
        self.assertEqual(reader.lookup(message(0))['deleted'], True)
        self.assertIsNone(reader.lookup(message(700)))
        self.assertLess(len(self.calls), 10, 'lookup downloaded whole index')

    def test_cursor_enumeration_does_not_drop_or_duplicate_entries(self):
        result, before = [], None
        while True:
            page = self.reader().enumerate(before=before)
            if not page: break
            result.extend(item['message_id'] for item in page)
            before = page[-1]['message_id']
        self.assertEqual(result, [message(i) for i in reversed(range(600))])

    def test_deletion_cursor_skips_live_subtrees_and_never_returns_live_ids(self):
        expected = [item['message_id'] for item in reversed(self.entries) if item['deleted']]
        result, before = [], None
        while True:
            page = self.reader().deletions(before=before, limit=23)
            if not page: break
            result.extend(page); before = page[-1]
        self.assertEqual(result, expected)
        for limit in (0, 258, True):
            with self.assertRaises(ValueError): self.reader().deletions(limit=limit)

    def test_access_denial_happens_before_any_page_fetch(self):
        calls = []
        with self.assertRaises(PermissionError):
            PagedIndexReader(self.plan['index'], self.body, message(1001), lambda *args: calls.append(args), self.cipher.decrypt)
        self.assertEqual(calls, [])

    def test_changed_generation_root_acl_and_counters_reject(self):
        for field, value in (('version', 2), ('root', 'e' * 64), ('count', 599), ('deleted_count', 85)):
            body = {**self.body, field: value}
            with self.assertRaises(ValueError): validate_index(self.plan['index'], body)
        bad = copy.deepcopy(self.plan['index']); bad['members'].append(bad['members'][0])
        with self.assertRaises(ValueError): validate_index(bad, self.body)
        for version in (True, 1.0):
            bad = copy.deepcopy(self.plan['index']); bad['context']['version'] = version
            with self.assertRaises(ValueError): validate_index(bad, self.body)
        for member in (None, {}, 1):
            bad = copy.deepcopy(self.plan['index']); bad['members'] = [member]
            with self.assertRaises(ValueError): validate_index(bad, self.body)

    def test_tampered_blocks_bad_path_and_overlapping_ranges_reject(self):
        ref = self.plan['index']['page']
        raw = self.plan['blocks'][(ref['cluster'], ref['digest'])]
        with self.assertRaises(ValueError): PagedIndexReader.unpack(raw + b' ', ref, self.cipher.decrypt)
        node = PagedIndexReader.unpack(raw, ref, self.cipher.decrypt)
        bad = copy.deepcopy(node); bad['children'][1]['first'] = bad['children'][0]['last']
        with self.assertRaises(ValueError): validate_page(bad, ref, self.plan['index']['context'])
        reader = self.reader(); leaf = ref
        while leaf['level']:
            leaf = reader.page(leaf)['children'][0]
        doc = copy.deepcopy(reader.page(leaf)); doc['entries'][0]['deleted'] = False
        with self.assertRaises(ValueError): validate_page(doc, leaf, self.plan['index']['context'])
        doc = copy.deepcopy(reader.page(leaf)); doc['entries'][1]['deleted'] = True
        forged_ref = {**leaf, 'deleted_count': leaf['deleted_count'] + 1}
        with self.assertRaisesRegex(ValueError, 'registry_root_mismatch'): validate_page(doc, forged_ref, self.plan['index']['context'])
        bad = copy.deepcopy(node); bad['children'][0]['registry_root'] = 'e' * 64
        with self.assertRaisesRegex(ValueError, 'registry_root_mismatch'): validate_page(bad, ref, self.plan['index']['context'])
        bad = copy.deepcopy(leaf); bad['size'] += 1
        with self.assertRaises(ValueError): reader.page(bad)
        # A prior validation cannot authorize a different reference to the
        # same cached ciphertext or bypass a subsequent deadline.
        bad = {**leaf, 'registry_root': 'e' * 64}
        with self.assertRaisesRegex(ValueError, 'registry_root_mismatch'): reader.page(bad)
        reader.deadline = time.monotonic() - 1
        with self.assertRaisesRegex(ValueError, 'deadline'): reader.page(leaf)

    def test_limits_and_deadline_never_return_partial_page(self):
        with self.assertRaises(ValueError): self.reader(byte_limit=3000).enumerate()
        with self.assertRaises(ValueError): self.reader(deadline=time.monotonic() - 1)
        for deadline in (float('nan'), float('inf'), True):
            with self.assertRaises(ValueError): self.reader(deadline=deadline)
        for limit in (0, 33, True):
            with self.assertRaises(ValueError): self.reader().enumerate(limit=limit)

    def test_empty_scope_has_no_pages_and_keeps_acl(self):
        body = {**self.body, 'root': RecoveryTree().root, 'count': 0, 'deleted_count': 0}
        plan = build_index(body, [], self.members, lambda raw: ('b' * 64, self.cipher.encrypt(raw)))
        self.assertIsNone(plan['index']['page'])
        self.assertEqual(len(plan['blocks']), 1)
        validate_index(plan['index'], body)

    def test_sparse_prefix_tree_handles_uuid_gaps_and_random_branches(self):
        rng = random.Random(1234)
        values = [{**entry, 'message_id': str(uuid.UUID(int=rng.getrandbits(128)))} for entry in self.entries[:200]]
        tree = RecoveryTree([entry['message_id'] for entry in values], [entry['message_id'] for entry in values if entry['deleted']])
        body = {**self.body, 'root': tree.root, 'count': len(values), 'deleted_count': sum(entry['deleted'] for entry in values)}
        plan = build_index(body, values, self.members, lambda raw: ('b' * 64, self.cipher.encrypt(raw)))
        body.update(plan['reference'])
        def reader():
            return PagedIndexReader.from_block(body, self.members[0], lambda cluster, digest, size: plan['blocks'][(cluster, digest)], self.cipher.decrypt)
        for item in values[::17]: self.assertEqual(reader().lookup(item['message_id'])['deleted'], item['deleted'])
        result, before = [], None
        while True:
            page = reader().enumerate(before=before)
            if not page: break
            result.extend(entry['message_id'] for entry in page); before = page[-1]['message_id']
        self.assertEqual(result, sorted((entry['message_id'] for entry in values), reverse=True))


if __name__ == '__main__': unittest.main()
