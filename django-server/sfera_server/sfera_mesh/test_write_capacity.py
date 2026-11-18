from hashlib import sha256
import unittest

from .write_capacity import check_write_capacity


class WriteCapacityTests(unittest.TestCase):
    def setUp(self):
        self.cluster = 'a' * 64
        self.values = [sha256(str(index).encode()).hexdigest() for index in range(514)]
        self.state = {'manifests': {self.cluster: {'record': {'body': {
            'digests': self.values[:511], 'sizes': [1] * 511}}}}}

    def queue(self, identity, digest, size=1, cluster=None):
        self.state.setdefault('write_queue', {})[identity] = {'record': {'body': {
            'cluster': cluster or self.cluster, 'digest': digest, 'size': size}}}

    def test_independent_writers_cannot_reserve_same_last_slot_for_different_bytes(self):
        self.queue('first', self.values[511])
        with self.assertRaisesRegex(ValueError, 'capacity_exhausted'):
            check_write_capacity(self.state, self.cluster, {self.values[512]: 1})

    def test_manifest_writer_cannot_bypass_reserved_digest(self):
        self.queue('first', self.values[511])
        proposal = dict(zip([*self.values[:511], self.values[512]], [1] * 512))
        with self.assertRaisesRegex(ValueError, 'capacity_exhausted'):
            check_write_capacity(self.state, self.cluster, proposal)
        check_write_capacity(self.state, self.cluster, dict.fromkeys(self.values[:512], 1))

    def test_same_digest_and_inclusion_do_not_double_count_slots(self):
        self.queue('first', self.values[511]); self.queue('second', self.values[511])
        check_write_capacity(self.state, self.cluster, {self.values[511]: 1})
        body = self.state['manifests'][self.cluster]['record']['body']
        body['digests'].append(self.values[511]); body['sizes'].append(1)
        check_write_capacity(self.state, self.cluster)

    def test_snapshot_overcommit_and_conflicting_sizes_are_rejected(self):
        self.queue('first', self.values[511]); self.queue('second', self.values[512])
        with self.assertRaisesRegex(ValueError, 'capacity_exhausted'): check_write_capacity(self.state, self.cluster)
        self.state['write_queue'].pop('second')
        self.queue('second', self.values[511], 2)
        with self.assertRaisesRegex(ValueError, 'size_conflict'): check_write_capacity(self.state, self.cluster)

    def test_other_clusters_and_unsized_legacy_manifest(self):
        del self.state['manifests'][self.cluster]['record']['body']['sizes']
        self.queue('elsewhere', self.values[511], cluster='b' * 64)
        check_write_capacity(self.state, self.cluster, {self.values[511]: 1})

    def test_invalid_queries_fail_closed(self):
        for cluster, additions in (('bad', {}), (self.cluster, []), (self.cluster, {'f' * 64: True}), (self.cluster, {'bad': 1})):
            with self.assertRaisesRegex(ValueError, 'invalid_write_capacity_query'):
                check_write_capacity(self.state, cluster, additions)
