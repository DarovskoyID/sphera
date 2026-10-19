import unittest
from tempfile import TemporaryDirectory
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .certificates import Committee, VoteJournal, verify_certificate


class CertificateTests(unittest.TestCase):
    def setUp(self):
        self.keys = [Ed25519PrivateKey.generate() for _ in range(4)]
        self.committee = Committee("test-network", 1, tuple((str(i), key.public_key().public_bytes_raw()) for i, key in enumerate(self.keys)))
        self.previous = "0" * 64
        self.checkpoint = {"root": "a" * 64, "cluster": "abc"}

    def test_quorum_tampering_duplicates_and_other_network(self):
        journal = VoteJournal(":memory:")
        try:
            votes = [(str(i), journal.sign(key, self.committee, 1, self.previous, self.checkpoint)) for i, key in enumerate(self.keys[:3])]
            self.assertTrue(verify_certificate(self.committee, 1, self.previous, self.checkpoint, votes))
            self.assertFalse(verify_certificate(self.committee, 1, self.previous, self.checkpoint, votes[:2]))
            self.assertFalse(verify_certificate(self.committee, 1, self.previous, self.checkpoint, votes + [votes[0]]))
            self.assertFalse(verify_certificate(self.committee, 1, self.previous, {"root": "changed"}, votes))
            other = Committee("other", 1, self.committee.members)
            self.assertFalse(verify_certificate(other, 1, self.previous, self.checkpoint, votes))
        finally:
            journal.close()

    def test_persistent_equivocation_rejected(self):
        with TemporaryDirectory() as temp:
            path = str(Path(temp) / "votes.sqlite")
            journal = VoteJournal(path)
            first = journal.sign(self.keys[0], self.committee, 1, self.previous, self.checkpoint)
            journal.close()
            journal = VoteJournal(path)
            try:
                self.assertEqual(first, journal.sign(self.keys[0], self.committee, 1, self.previous, self.checkpoint))
                with self.assertRaises(ValueError): journal.sign(self.keys[0], self.committee, 1, self.previous, {"root": "other"})
            finally:
                journal.close()

    def test_no_three_node_or_duplicate_key_committee(self):
        with self.assertRaises(ValueError): Committee("test", 1, self.committee.members[:3])
        with self.assertRaises(ValueError): Committee("test", 1, self.committee.members[:3] + (self.committee.members[0],))
