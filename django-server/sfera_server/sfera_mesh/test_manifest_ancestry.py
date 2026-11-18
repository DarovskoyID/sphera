import copy
from hashlib import sha256
import unittest
from .manifest_ancestry import ancestor_proof, verify_ancestor, validate_lineages, lineage_root


class AncestryTests(unittest.TestCase):
    def state(self, count=257):
        cluster = 'a' * 64
        hashes = [sha256(str(index).encode()).hexdigest() for index in range(count)]
        state = {'manifests': {cluster: {'digest': hashes[-1], 'record': {'body': {'version': count, 'previous': hashes[-2]}}}},
                 'manifest_lineage': {cluster: {'first': 1, 'hashes': hashes, 'root': lineage_root('lab', cluster, 1, hashes)}}}
        return state, cluster, hashes

    def test_long_gap_has_short_proof_and_tampering_fails(self):
        state, cluster, hashes = self.state()
        validate_lineages(state, 'lab')
        evidence = ancestor_proof(state, 'lab', cluster, hashes[0])
        self.assertEqual(len(evidence['path']), 9)
        self.assertTrue(verify_ancestor(state, 'lab', cluster, hashes[0], evidence))
        for key, value in [('count', 258), ('first', 2), ('index', True), ('index', 1), ('path', evidence['path'][:-1]), ('path', evidence['path'] + ['0' * 64])]:
            changed = copy.deepcopy(evidence)
            changed[key] = value
            with self.assertRaises(ValueError):
                verify_ancestor(state, 'lab', cluster, hashes[0], changed)
        with self.assertRaises(ValueError):
            verify_ancestor(state, 'foreign', cluster, hashes[0], evidence)
        with self.assertRaises(ValueError):
            ancestor_proof(state, 'lab', cluster, hashes[-1])
        corrupted = copy.deepcopy(state)
        corrupted['manifest_lineage'][cluster]['hashes'][0] = '0' * 64
        with self.assertRaises(ValueError):
            validate_lineages(corrupted, 'lab')
