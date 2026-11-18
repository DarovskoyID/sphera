package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func recoveryFixture(t *testing.T) (State, []ed25519.PrivateKey, RecoveryRootRecord) {
	t.Helper()
	s, keys, cluster := manifestState(t)
	s.GenesisPin = strings.Repeat("a", 64)
	for _, key := range keys[:2] {
		if err := apply(&s, canonical(candidateFixture(t, key, 1, zero, true))); err != nil {
			t.Fatal(err)
		}
	}
	if err := apply(&s, canonical(sizedManifestFixture(s, cluster, keys[:2], []string{zero, strings.Repeat("b", 64)}, []int64{4, 8}))); err != nil {
		t.Fatal(err)
	}
	public := keys[0].Public().(ed25519.PublicKey)
	body := RecoveryRootBody{"sfera-mesh-recovery-root-v1", s.Network, s.GenesisPin, hex.EncodeToString(hashNode(public)), hex.EncodeToString(public), "dm", "11111111-1111-1111-1111-111111111111", 1, zero, cluster, zero, 4, []string{}, []string{}}
	r := RecoveryRootRecord{body, hex.EncodeToString(ed25519.Sign(keys[0], canonical(body)))}
	return s, keys, r
}

func TestRecoveryRootBoundedProofsAndMessageRegistry(t *testing.T) {
	s, keys, r := recoveryFixture(t)
	for i := 0; i < 256; i++ {
		r.Body.Messages = append(r.Body.Messages, fmt.Sprintf("%08x-2222-2222-2222-222222222222", i))
	}
	r.Body.Deleted = append([]string{}, r.Body.Messages...)
	if err := apply(&s, canonical(signRecovery(r, keys[0]))); err != nil {
		t.Fatal(err)
	}
	other := r
	other.Body.Source = "guild"
	if err := apply(&s, canonical(signRecovery(other, keys[0]))); err != nil {
		t.Fatal(err)
	}
	before := hex.EncodeToString(digest(s))
	other.Body.Scope = "33333333-3333-3333-3333-333333333333"
	if apply(&s, canonical(signRecovery(other, keys[0]))) == nil {
		t.Fatal("global message bound bypassed")
	}
	if hex.EncodeToString(digest(s)) != before {
		t.Fatal("bound rejection mutated state")
	}
	s.StateCommitment = stateMerkleScheme
	s.Height = 1
	for _, suffix := range []string{"meta", "message/" + r.Body.Messages[255]} {
		p, err := makeStateProof(s, "recovery-root/"+recoveryRootKey(r.Body)+"/"+suffix)
		if err != nil || len(p.Leaf.Value) > 2048 {
			t.Fatalf("bounded proof: %v", err)
		}
		got, err := proofAppHash(p)
		if err != nil || !bytes.Equal(got, digest(s)) {
			t.Fatalf("wrong proof commitment: %v", err)
		}
	}
	// Metadata must preserve the full signed int64 version, without a float64
	// round trip changing the signature preimage at high sequence numbers.
	head := s.RecoveryRoots[recoveryRootKey(r.Body)]
	head.Record.Body.Version = 9007199254740993
	s.RecoveryRoots[recoveryRootKey(r.Body)] = head
	p, err := makeStateProof(s, "recovery-root/"+recoveryRootKey(r.Body)+"/meta")
	if err != nil || !bytes.Contains(p.Leaf.Value, []byte(`"version":9007199254740993`)) {
		t.Fatalf("version precision lost: %v", err)
	}
	var metadata map[string]json.RawMessage
	if json.Unmarshal(p.Leaf.Value, &metadata) != nil {
		t.Fatal("invalid metadata")
	}
}
func signRecovery(r RecoveryRootRecord, key ed25519.PrivateKey) RecoveryRootRecord {
	r.Signature = hex.EncodeToString(ed25519.Sign(key, canonical(r.Body)))
	return r
}
func TestRecoveryRootSequenceAndManifestBinding(t *testing.T) {
	s, keys, r := recoveryFixture(t)
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	first := s.RecoveryRoots[recoveryRootKey(r.Body)]
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	r.Body.Version = 2
	r.Body.Previous = first.Digest
	r.Body.Digest = strings.Repeat("b", 64)
	r.Body.Size = 8
	r = signRecovery(r, keys[0])
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	if err := verifyRecoveryRoots(s); err != nil {
		t.Fatal(err)
	}
	before := hex.EncodeToString(digest(s))
	bad := []RecoveryRootRecord{first.Record, r, r, r, r, r}
	bad[1].Body.Version = 4
	bad[2].Body.Previous = zero
	bad[3].Body.Size = 7
	bad[4].Body.Digest = strings.Repeat("c", 64)
	bad[5].Body.Genesis = zero
	for _, record := range bad {
		record = signRecovery(record, keys[0])
		if err := apply(&s, canonical(record)); err == nil {
			t.Fatal("invalid recovery transition accepted")
		}
		if hex.EncodeToString(digest(s)) != before {
			t.Fatal("rejected recovery transition mutated state")
		}
	}
	// Snapshot verification is historical; retry cannot extend or roll back state.
	s.BlockTime = 999999
	if err := verifyRecoveryRoots(s); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	next := r
	next.Body.Version = 3
	next.Body.Previous = s.RecoveryRoots[recoveryRootKey(r.Body)].Digest
	if err := apply(&s, canonical(signRecovery(next, keys[0]))); err == nil {
		t.Fatal("expired publisher license accepted")
	}
}
func TestRecoveryRootNamespacesCloneAndProof(t *testing.T) {
	s, keys, r := recoveryFixture(t)
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	other := r
	public := keys[1].Public().(ed25519.PublicKey)
	other.Body.Publisher = hex.EncodeToString(hashNode(public))
	other.Body.PublicKey = hex.EncodeToString(public)
	if err := apply(&s, canonical(signRecovery(other, keys[1]))); err != nil {
		t.Fatal(err)
	}
	if len(s.RecoveryRoots) != 2 {
		t.Fatal("publisher namespaces collided")
	}
	guild := r
	guild.Body.Source = "guild"
	if err := apply(&s, canonical(signRecovery(guild, keys[0]))); err != nil {
		t.Fatal(err)
	}
	if len(s.RecoveryRoots) != 3 {
		t.Fatal("source namespaces collided")
	}
	copy := clone(s)
	delete(copy.RecoveryRoots, recoveryRootKey(r.Body))
	if len(s.RecoveryRoots) != 3 {
		t.Fatal("clone aliases recovery roots")
	}
	s.StateCommitment = stateMerkleScheme
	s.Height = 1
	proof, err := makeStateProof(s, "recovery-root/"+recoveryRootKey(r.Body)+"/meta")
	if err != nil || !strings.HasPrefix(proof.Leaf.Key, "recovery-root/") || len(proof.Leaf.Value) > 2048 {
		t.Fatalf("compact root proof failed: %v", err)
	}
	bad := clone(s)
	head := bad.RecoveryRoots[recoveryRootKey(r.Body)]
	head.Digest = zero
	bad.RecoveryRoots[recoveryRootKey(r.Body)] = head
	if verifyRecoveryRoots(bad) == nil {
		t.Fatal("corrupt head accepted")
	}
	bad = clone(s)
	delete(bad.Manifests, r.Body.Cluster)
	if verifyRecoveryRoots(bad) == nil {
		t.Fatal("missing root block accepted")
	}
}

func TestRecoveryRootDeletionIsTerminalAndCloneOwnsMessageSlices(t *testing.T) {
	s, keys, r := recoveryFixture(t)
	id := "22222222-2222-2222-2222-222222222222"
	r.Body.Messages = []string{id}
	r.Body.Deleted = []string{id}
	r = signRecovery(r, keys[0])
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	key := recoveryRootKey(r.Body)
	copy := clone(s)
	head := copy.RecoveryRoots[key]
	head.Record.Body.Messages[0] = r.Body.Scope
	head.Record.Body.Deleted[0] = r.Body.Scope
	if s.RecoveryRoots[key].Record.Body.Messages[0] != id || s.RecoveryRoots[key].Record.Body.Deleted[0] != id {
		t.Fatal("clone aliases recovery message slices")
	}
	before := hex.EncodeToString(digest(s))
	next := r
	next.Body.Version = 2
	next.Body.Previous = s.RecoveryRoots[key].Digest
	next.Body.Deleted = []string{}
	if apply(&s, canonical(signRecovery(next, keys[0]))) == nil {
		t.Fatal("resurrection accepted")
	}
	next.Body.Messages = []string{}
	if apply(&s, canonical(signRecovery(next, keys[0]))) == nil {
		t.Fatal("message omission accepted")
	}
	if hex.EncodeToString(digest(s)) != before {
		t.Fatal("rejected deletion rollback mutated state")
	}
	s.StateCommitment = stateMerkleScheme
	s.Height = 1
	proof, err := makeStateProof(s, "recovery-root/"+key+"/message/"+id)
	if err != nil || !strings.Contains(string(proof.Leaf.Value), `"deleted":true`) {
		t.Fatalf("deletion proof failed: %v", err)
	}
}
