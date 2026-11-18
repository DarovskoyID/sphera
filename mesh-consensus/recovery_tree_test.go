package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
)

// Proof builder used only in tests. Consensus retains no per-message map.
type testRecoveryTree struct {
	nodes map[string][]byte
	empty [129][]byte
}

func newTestRecoveryTree() *testRecoveryTree {
	return &testRecoveryTree{map[string][]byte{}, treeEmpty()}
}
func treeBits(id string) string {
	key, _ := treeUUID(id)
	bits := ""
	for _, b := range key {
		for n := 7; n >= 0; n-- {
			if b&(1<<uint(n)) != 0 {
				bits += "1"
			} else {
				bits += "0"
			}
		}
	}
	return bits
}
func (tree *testRecoveryTree) proof(id string) []string {
	bits := treeBits(id)
	path := []string{}
	for level := 0; level < 128; level++ {
		prefix := bits[:len(bits)-1]
		sibling := prefix + "0"
		if bits[len(bits)-1] == '0' {
			sibling = prefix + "1"
		}
		value, ok := tree.nodes[sibling]
		if !ok {
			value = tree.empty[level]
		}
		path = append(path, hex.EncodeToString(value))
		bits = prefix
	}
	return path
}
func (tree *testRecoveryTree) put(id string, status int) {
	bits := treeBits(id)
	value, _ := treeLeaf(id, status)
	tree.nodes[bits] = value
	for level := 0; level < 128; level++ {
		prefix := bits[:len(bits)-1]
		last := bits[len(bits)-1]
		sibling := prefix + "0"
		if last == '0' {
			sibling = prefix + "1"
		}
		other, ok := tree.nodes[sibling]
		if !ok {
			other = tree.empty[level]
		}
		if last == '1' {
			value = treeParent(other, value)
		} else {
			value = treeParent(value, other)
		}
		bits = prefix
		tree.nodes[bits] = value
	}
}
func treeMessage(i int) string { return fmt.Sprintf("%08x-2222-2222-2222-222222222222", i) }
func treeFixture(t *testing.T) (State, ed25519.PrivateKey, RecoveryTreeBody) {
	s, keys, legacy := recoveryFixture(t)
	empty := treeEmpty()
	body := RecoveryTreeBody{Domain: "sfera-mesh-recovery-tree-head-v2", Network: s.Network, Genesis: s.GenesisPin,
		Publisher: legacy.Body.Publisher, PublicKey: legacy.Body.PublicKey, Source: "dm", Scope: legacy.Body.Scope,
		Version: 1, Previous: zero, Cluster: legacy.Body.Cluster, Digest: zero, Size: 4, Root: hex.EncodeToString(empty[128]), Count: 0, DeletedCount: 0}
	return s, keys[0], body
}
func treeTx(body RecoveryTreeBody, key ed25519.PrivateKey, updates []RecoveryTreeUpdate) RecoveryTreeTransaction {
	body.UpdatesHash = hex.EncodeToString(digest(updates))
	return RecoveryTreeTransaction{body, hex.EncodeToString(ed25519.Sign(key, canonical(body))), updates}
}
func TestRecoveryTree600MessagesBoundedStateAndPythonGolden(t *testing.T) {
	s, key, body := treeFixture(t)
	tree := newTestRecoveryTree()
	var lastTx RecoveryTreeTransaction
	if body.Root != "4fa4e3d457961345b93c7eb3676d922600f4f789d4eb9bc3c0fc17f0c65e0ee0" {
		t.Fatal("empty root differs from Python")
	}
	for start := 0; start < 600; start += 4 {
		updates := []RecoveryTreeUpdate{}
		for i := start; i < start+4; i++ {
			status := 1
			if i%7 == 0 {
				status = 2
			}
			id := treeMessage(i)
			updates = append(updates, RecoveryTreeUpdate{id, 0, status, tree.proof(id)})
			tree.put(id, status)
			body.Count++
			if status == 2 {
				body.DeletedCount++
			}
		}
		body.Root = hex.EncodeToString(tree.nodes[""])
		tx := treeTx(body, key, updates)
		lastTx = tx
		if len(canonical(tx)) > 65536 {
			t.Fatal("proof batch exceeds transaction limit")
		}
		if err := apply(&s, canonical(tx)); err != nil {
			t.Fatalf("batch %d: %v", start, err)
		}
		head := s.RecoveryTrees[recoveryTreeKey(body)]
		if len(canonical(head)) > 1600 {
			t.Fatal("consensus retained message list or proof path")
		}
		body.Previous = head.Digest
		body.Version++
	}
	head := s.RecoveryTrees[recoveryTreeKey(body)]
	if head.Record.Body.Root != "4970480cb69efefb37d1e84b8ca25f8c59af47be67e7bf4245d40a5945fded74" || head.Record.Body.Count != 600 || head.Record.Body.DeletedCount != 86 {
		t.Fatal("Python/Go roots or counters disagree")
	}
	if err := verifyRecoveryTrees(s); err != nil {
		t.Fatal(err)
	}
	s.StateCommitment = stateMerkleScheme
	s.Height = 1
	proof, err := makeStateProof(s, "recovery-tree/"+recoveryTreeKey(body)+"/head")
	if err != nil || len(proof.Leaf.Value) > 1600 {
		t.Fatal("unbounded root proof", err)
	}
	copy := clone(s)
	delete(copy.RecoveryTrees, recoveryTreeKey(body))
	if len(s.RecoveryTrees) != 1 {
		t.Fatal("clone aliases registry")
	}
	// A deleted leaf cannot return to live status, and rejection is atomic.
	before := canonical(s)
	update := RecoveryTreeUpdate{treeMessage(0), 2, 1, tree.proof(treeMessage(0))}
	if apply(&s, canonical(treeTx(body, key, []RecoveryTreeUpdate{update}))) == nil || !bytes.Equal(before, canonical(s)) {
		t.Fatal("resurrection accepted or rejection mutated state")
	}
	// Lost reply / exact replay is idempotent after license expiration.
	s.BlockTime += 1000000
	if err := apply(&s, canonical(lastTx)); err != nil {
		t.Fatal("exact replay should remain confirmed", err)
	}
}
func TestRecoveryTreeMigrationRetainsEveryLegacyDeletionAndFreezesV1(t *testing.T) {
	s, keys, legacy := recoveryFixture(t)
	ids := []string{}
	deleted := []string{}
	for i := 0; i < 256; i++ {
		ids = append(ids, treeMessage(i))
		if i%3 == 0 {
			deleted = append(deleted, treeMessage(i))
		}
	}
	legacy.Body.Messages = ids
	legacy.Body.Deleted = deleted
	if err := apply(&s, canonical(signRecovery(legacy, keys[0]))); err != nil {
		t.Fatal(err)
	}
	root, err := treeLegacy(ids, deleted)
	if err != nil || root != "d5bd5adaffdcadb1a9f3bb758ca67507c4b2ee8268456e778949bf756c81ab2a" {
		t.Fatal("legacy migration differs from Python", err)
	}
	_, _, body := treeFixture(t)
	body.Cluster = legacy.Body.Cluster
	body.Publisher = legacy.Body.Publisher
	body.PublicKey = legacy.Body.PublicKey
	body.Version = 2
	body.Previous = s.RecoveryRoots[recoveryRootKey(legacy.Body)].Digest
	body.Root = root
	body.Count = 256
	body.DeletedCount = int64(len(deleted))
	before := canonical(s)
	wrong := body
	wrong.DeletedCount--
	if apply(&s, canonical(treeTx(wrong, keys[0], []RecoveryTreeUpdate{}))) == nil || !bytes.Equal(before, canonical(s)) {
		t.Fatal("migration dropped a deletion")
	}
	if err := apply(&s, canonical(treeTx(body, keys[0], []RecoveryTreeUpdate{}))); err != nil {
		t.Fatal(err)
	}
	legacy.Body.Version = 2
	legacy.Body.Previous = body.Previous
	if apply(&s, canonical(signRecovery(legacy, keys[0]))) == nil {
		t.Fatal("legacy writer can fork migrated namespace")
	}
}
func TestRecoveryTreeRejectsTamperedProofAndWrongCounter(t *testing.T) {
	s, key, body := treeFixture(t)
	tree := newTestRecoveryTree()
	id := treeMessage(1)
	update := RecoveryTreeUpdate{id, 0, 1, tree.proof(id)}
	tree.put(id, 1)
	body.Root = hex.EncodeToString(tree.nodes[""])
	body.Count = 1
	wrong := body
	wrong.Count = 2
	before := canonical(s)
	if apply(&s, canonical(treeTx(wrong, key, []RecoveryTreeUpdate{update}))) == nil {
		t.Fatal("wrong counter accepted")
	}
	update.Path[0] = strings.Repeat("f", 64)
	if apply(&s, canonical(treeTx(body, key, []RecoveryTreeUpdate{update}))) == nil || !bytes.Equal(before, canonical(s)) {
		t.Fatal("tampered path accepted or mutated state")
	}
}
