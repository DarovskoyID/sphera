package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	dbm "github.com/cometbft/cometbft-db"
	"sort"
	"testing"
)

func capacityManifest(t *testing.T, s *State, cluster string, keys []ed25519.PrivateKey, values []string) {
	t.Helper()
	values = append([]string{}, values...)
	sort.Strings(values)
	sizes := make([]int64, len(values))
	for i := range sizes {
		sizes[i] = 1
	}
	if err := apply(s, canonical(sizedManifestFixture(*s, cluster, keys[:2], values, sizes))); err != nil {
		t.Fatal(err)
	}
}

func TestConsensusSlotReservationCannotBeStolenByAnotherWriter(t *testing.T) {
	s, keys, cluster := manifestState(t)
	values := []string{}
	for i := 1; i <= 511; i++ {
		values = append(values, fmt.Sprintf("%064x", i))
	}
	capacityManifest(t, &s, cluster, keys, values)
	base := clone(s)
	a, b := fmt.Sprintf("%064x", 600), fmt.Sprintf("%064x", 601)
	first := signedWrite(s, cluster, keys[:3], a, a, 1)
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal(err)
	}
	s.Accounts = map[string]Head{}
	db := dbm.NewMemDB()
	defer db.Close()
	if err := db.SetSync([]byte("state"), canonical(s)); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewApplicationWithIssuers(db, "lab", s.Issuers)
	if err != nil {
		t.Fatal("reserved slot did not survive restart", err)
	}
	if err := checkWriteCapacity(restarted.state, cluster, map[string]int64{b: 1}); err == nil {
		t.Fatal("restart forgot reserved slot")
	}
	secondKeys := []ed25519.PrivateKey{keys[1], keys[0], keys[2]}
	second := signedWrite(s, cluster, secondKeys, b, b, 1)
	before := hex.EncodeToString(digest(s))
	if err := apply(&s, canonical(second)); err == nil {
		t.Fatal("competing writer stole the last reserved slot")
	}
	wrong := append(append([]string{}, values...), b)
	sizes := make([]int64, len(wrong))
	for i := range sizes {
		sizes[i] = 1
	}
	if err := apply(&s, canonical(sizedManifestFixture(s, cluster, keys[:2], wrong, sizes))); err == nil {
		t.Fatal("direct manifest bypassed pending reservation")
	}
	if before != hex.EncodeToString(digest(s)) {
		t.Fatal("rejection changed state")
	}
	capacityManifest(t, &s, cluster, keys, append(values, a))
	if err := verifyWriteQueue(s); err != nil {
		t.Fatal("inclusion double-counted slot", err)
	}
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal("exact retry failed", err)
	}
	// Reversing consensus order gives the manifest the slot; the later write
	// must fail, regardless of holders having previously signed its request.
	capacityManifest(t, &base, cluster, keys, wrong)
	if err := apply(&base, canonical(first)); err == nil {
		t.Fatal("write bypassed prior manifest inclusion")
	}
}

func TestConsensusCapacityDeduplicatesDigestsAndRejectsInvalidSnapshot(t *testing.T) {
	s, keys, cluster := manifestState(t)
	values := []string{}
	for i := 1; i <= 511; i++ {
		values = append(values, fmt.Sprintf("%064x", i))
	}
	capacityManifest(t, &s, cluster, keys, values)
	a, b := fmt.Sprintf("%064x", 600), fmt.Sprintf("%064x", 601)
	first := signedWrite(s, cluster, keys[:3], a, a, 1)
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal(err)
	}
	other := signedWrite(s, cluster, []ed25519.PrivateKey{keys[1], keys[0], keys[2]}, b, a, 1)
	if err := apply(&s, canonical(other)); err != nil {
		t.Fatal("same ciphertext counted twice", err)
	}
	if err := verifyWriteQueue(s); err != nil {
		t.Fatal(err)
	}
	bad := clone(s)
	sizes := make([]int64, 512)
	for i := range sizes {
		sizes[i] = 1
	}
	// The signatures/history remain valid; only the global union is invalid.
	r := sizedManifestFixture(bad, cluster, keys[:2], append(values, b), sizes)
	bad.Manifests[cluster] = ManifestHead{r, hex.EncodeToString(digest(r))}
	if err := verifyWriteQueue(bad); err == nil {
		t.Fatal("overcommitted snapshot accepted")
	}
}
