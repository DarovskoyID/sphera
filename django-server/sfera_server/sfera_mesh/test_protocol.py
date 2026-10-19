import unittest
from dataclasses import replace
from .history import History, root, proof, verify
from .topology import Candidate, choose_cluster, choose_replacement, module_available

class ProtocolTests(unittest.TestCase):
    def test_proofs_and_tampering(self):
        for count in range(1, 65):
            data = [str(i).encode() for i in range(count)]
            for i in range(count):
                path = proof(data, i)
                self.assertTrue(verify(data[i], i, count, path, root(data)))
                self.assertFalse(verify(b"tampered", i, count, path, root(data)))
                self.assertFalse(verify(data[i], i, count, path + [bytes(32)], root(data)))

    def test_bidirectional_recent_and_duplicates(self):
        h = History()
        for b in range(4):
            h.append(str(b), [(f"{b}-{i}", f"cipher-{b}-{i}".encode()) for i in range(40)])
        self.assertEqual(h.blocks["0"].next, "1")
        self.assertEqual(h.blocks["3"].previous, "2")
        self.assertIsNone(h.blocks["0"].previous)
        self.assertIsNone(h.blocks["3"].next)
        self.assertEqual(len(h.last()), 100)
        self.assertEqual(h.last()[0][:2], ("1", 20))
        self.assertEqual(h.last(0), [])
        with self.assertRaises(ValueError): h.append("4", [("0-0", b"duplicate")])
        self.assertEqual(len(h.order), 4)

    def nodes(self):
        return [Candidate(str(i), str(i), frozenset({"office"}), grant_verified=True) for i in range(7)]

    def test_seven_nodes_replacement(self):
        n = self.nodes()
        self.assertEqual(len(choose_cluster(n[:3])), 3)
        self.assertEqual(len(choose_cluster(n[3:6])), 3)
        survivors = [replace(x, memberships=frozenset({"a"})) for x in n[:2]]
        temporary = replace(n[3], memberships=frozenset({"b"}))
        self.assertEqual(choose_replacement(survivors, [temporary], "a"), temporary)
        self.assertEqual(choose_replacement(survivors, [temporary, n[6]], "a"), n[6])
        self.assertIsNone(choose_replacement(survivors, [replace(temporary, memberships=frozenset({"b", "c"}))], "a"))
        with self.assertRaises(ValueError): choose_replacement(survivors[:1], [temporary], "a")

    def test_similarity_and_domains(self):
        n = self.nodes()
        expensive = replace(n[0], paid_modules=frozenset({"office", "diary", "legal"}))
        self.assertNotIn(expensive, choose_cluster([expensive, *n[1:4]]))
        self.assertEqual(choose_cluster([replace(x, failure_domain="same") for x in n]), ())
        self.assertEqual(choose_cluster([replace(x, grant_verified=False) for x in n]), ())

    def test_entry_grants(self):
        self.assertTrue(module_available({"office"}, {"office"}, "office", True))
        self.assertFalse(module_available(set(), {"office"}, "office", True))
        self.assertFalse(module_available({"office"}, set(), "office", True))
        self.assertFalse(module_available({"office"}, {"office"}, "office", False))


class DurableStorageTests(unittest.TestCase):
    def test_restart_loss_and_independent_manifest(self):
        from tempfile import TemporaryDirectory
        from pathlib import Path
        from .storage import Storage
        with TemporaryDirectory() as temp:
            payload = str(Path(temp) / "payload.sqlite")
            manifest = str(Path(temp) / "manifest.sqlite")
            store = Storage(payload, manifest)
            for i in range(4):
                store.append("dialog", str(i), "lost" if i in (1, 2) else "healthy", [b"encrypted"] * 40)
            checkpoint = store.checkpoint("dialog")
            inclusion = store.inclusion("dialog", 2)
            self.assertTrue(verify(inclusion["leaf"], 2, inclusion["count"], inclusion["path"], bytes.fromhex(checkpoint["root"])))
            self.assertEqual(store.recent("dialog")[0], ("1", 20))
            self.assertEqual(len(store.affected("lost")), 2)
            store.close()
            store = Storage(payload, manifest)
            self.assertEqual(store.checkpoint("dialog"), checkpoint)
            self.assertEqual(len(store.read("1")), 40)
            with store.payload:
                store.payload.execute("DELETE FROM payloads WHERE block_id IN ('1', '2')")
            # Same Merkle root does NOT imply data availability.
            self.assertEqual(store.checkpoint("dialog"), checkpoint)
            self.assertEqual(len(store.affected("lost")), 2)
            with self.assertRaises(FileNotFoundError): store.read("1")
            self.assertEqual(len(store.read("3")), 40)
            with store.payload:
                store.payload.execute("UPDATE payloads SET data=? WHERE block_id='3'", (b"corrupt",))
            with self.assertRaises(ValueError): store.read("3")
            store.close()


class PersistentMerkleTests(unittest.TestCase):
    def test_incremental_tree_matches_reference(self):
        from .storage import Storage
        store = Storage(":memory:", ":memory:")
        try:
            for count in range(1, 66):
                store.append("d", str(count), "c", [str(count).encode()])
                expected = root(store.leaves("d"))
                self.assertEqual(store.checkpoint("d")["root"], expected.hex())
                for i in {0, count // 2, count - 1}:
                    item = store.inclusion("d", i)
                    self.assertTrue(verify(item["leaf"], i, count, item["path"], expected))
        finally:
            store.close()
