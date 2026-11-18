from datetime import datetime, timedelta, timezone
import copy
from hashlib import sha256
import random
import unittest

from cryptography.fernet import Fernet
from .recovery_pages import build_index, PagedIndexReader
from .recovery_timeline import time_key, validate_page, validate_complete
from .recovery_tree import RecoveryTree
from .storage import canonical


class TimelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cipher = Fernet(Fernet.generate_key()); cls.member = 'ffffffff-2222-2222-2222-222222222222'
        rng = random.Random(111); times = list(range(600)); rng.shuffle(times)
        cls.entries = [{'message_id': f'{index:08x}-2222-2222-2222-222222222222', 'author_id': cls.member,
            'created_at': None if index % 7 == 0 else (datetime(2026, 10, 25, tzinfo=timezone.utc) + timedelta(microseconds=times[index])).isoformat(),
            'snapshot_hash': 'd'*64, 'cluster': 'b'*64, 'digest': sha256(str(index).encode()).hexdigest(), 'size': 10,
            'deleted': index % 7 == 0} for index in range(600)]
        tree = RecoveryTree([item['message_id'] for item in cls.entries], [item['message_id'] for item in cls.entries if item['deleted']])
        cls.body = {'genesis': 'a'*64, 'publisher': 'c'*64, 'source': 'dm', 'scope': cls.member, 'version': 1,
            'root': tree.root, 'count': 600, 'deleted_count': sum(item['deleted'] for item in cls.entries)}
        cls.plan = build_index(cls.body, cls.entries, [cls.member], lambda raw: ('b'*64, cls.cipher.encrypt(raw)))
        cls.body.update(cls.plan['reference'])

    def reader(self, plan=None, body=None, **kwargs):
        plan, body = plan or self.plan, body or self.body
        self.calls = []
        def fetch(cluster, digest, size):
            self.calls.append(digest); return plan['blocks'][(cluster, digest)]
        return PagedIndexReader.from_block(body, self.member, fetch, self.cipher.decrypt, **kwargs)

    def test_600_entries_page_in_time_order_not_uuid_order(self):
        expected = sorted((item for item in self.entries if not item['deleted']),
            key=lambda item: time_key(item['created_at'], item['message_id']), reverse=True)
        found, before = [], None
        while True:
            page, before = self.reader().chronological(before=before)
            found.extend(item['message_id'] for item in page)
            self.assertTrue(all(not item['deleted'] for item in page))
            if before is None: break
        self.assertEqual(found, [item['message_id'] for item in expected])
        self.assertNotEqual(found, sorted(found, reverse=True))
        self.assertEqual(len(set(found)), 514)

    def test_first_item_does_not_download_full_index(self):
        page, cursor = self.reader().chronological(limit=1)
        self.assertEqual(len(page), 1); self.assertIsNotNone(cursor)
        self.assertLess(len(self.calls), 16)

    def test_equal_times_offsets_and_microseconds_have_exact_stable_keys(self):
        identity = self.entries[1]['message_id']
        self.assertEqual(time_key('2026-10-25T10:00:00.123456+03:00', identity), time_key('2026-10-25T07:00:00.123456Z', identity))
        self.assertLess(time_key('2026-10-25T07:00:00.123455Z', identity), time_key('2026-10-25T07:00:00.123456Z', identity))
        self.assertLess(time_key('2026-10-25T07:00:00Z', self.entries[1]['message_id']), time_key('2026-10-25T07:00:00Z', self.entries[2]['message_id']))
        for value in (None, '2026-10-25T07:00:00', 'invalid'):
            with self.assertRaises(ValueError): time_key(value, identity)

    def test_legacy_uuid_only_generation_uses_complete_bounded_fallback(self):
        plan = build_index(self.body, self.entries, [self.member], lambda raw: ('b'*64, self.cipher.encrypt(raw)), include_timeline=False)
        body = {**self.body, **plan['reference']}
        page, cursor = self.reader(plan, body).chronological()
        expected, next_cursor = self.reader().chronological()
        self.assertEqual(page, expected); self.assertEqual(cursor, next_cursor)
        with self.assertRaisesRegex(ValueError, 'read_limit'):
            self.reader(plan, body, byte_limit=10000).chronological()

    def test_corrupt_timeline_branch_and_missing_uuid_mapping_reject(self):
        reader = self.reader(); ref = reader.document['timeline']
        doc = copy.deepcopy(reader.block(ref)); doc['children'][0]['count'] += 1
        with self.assertRaises(ValueError): validate_page(doc, ref, reader.document['context'])
        original = reader.lookup
        reader.lookup = lambda identity: None
        with self.assertRaisesRegex(ValueError, 'uuid_mismatch'): reader.chronological()
        reader.lookup = original
        def load(ref): return reader.block(ref)
        wrong = copy.deepcopy(self.entries); wrong[1]['created_at'] = '2026-01-01T00:00:00Z'
        with self.assertRaisesRegex(ValueError, 'omission_or_mismatch'): validate_complete(reader.document, wrong, load)

    def test_deleted_or_unknown_cursor_and_budget_are_rejected(self):
        for cursor in (self.entries[0]['message_id'], 'eeeeeeee-2222-2222-2222-222222222222'):
            with self.assertRaisesRegex(ValueError, 'cursor_unknown'): self.reader().chronological(before=cursor)
        with self.assertRaises(ValueError): self.reader(byte_limit=5000).chronological()
        for limit in (0, 33, True):
            with self.assertRaises(ValueError): self.reader().chronological(limit=limit)


if __name__ == '__main__': unittest.main()
