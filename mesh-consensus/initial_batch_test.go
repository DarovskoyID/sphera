package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"testing"
)

func TestInitialPlanningBeyondTwelveWithHighMaskBits(t *testing.T) {
	s, keys, assessors, _ := policyFixture(t)
	for _, key := range placementKeys(t, 58) {
		candidate := candidateFixture(t, key, 1, zero, true)
		if err := apply(&s, canonical(candidate)); err != nil {
			t.Fatal(err)
		}
		r := resourceFixture(s, candidate.Body.NodeID, assessors, 2, "a")
		if err := apply(&s, canonical(r)); err != nil {
			t.Fatal(err)
		}
		keys = append(keys, key)
	}
	pool, err := initialPool(s)
	if err != nil || len(pool) != 64 {
		t.Fatal("pool", len(pool), err)
	}
	for i, entry := range pool {
		zone := "a"
		if i >= 62 {
			zone = "c"
		} else if i >= 60 {
			zone = "b"
		}
		if err := apply(&s, canonical(resourceFixture(s, entry.NodeID, assessors, 2, zone))); err != nil {
			t.Fatal(err)
		}
	}
	pool, err = initialPool(s)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := bestInitialPlan(s, pool, 2)
	want := [][]string{{pool[0].NodeID, pool[60].NodeID, pool[62].NodeID}, {pool[1].NodeID, pool[61].NodeID, pool[63].NodeID}}
	if err != nil || !bytes.Equal(canonical(plan), canonical(want)) {
		t.Fatal("high bit plan", plan, err)
	}
	if err := apply(&s, canonical(batchFixture(t, s, keys, plan))); err != nil {
		t.Fatal("64-candidate batch", err)
	}
}

func batchFixture(t *testing.T, s State, keys []ed25519.PrivateKey, groups [][]string) InitialBatch {
	t.Helper()
	lookup := map[string]ed25519.PrivateKey{}
	for _, key := range keys {
		lookup[hex.EncodeToString(hashNode(key.Public().(ed25519.PublicKey)))] = key
	}
	records := []Placement{}
	for _, group := range groups {
		members := []ed25519.PrivateKey{}
		for _, id := range group {
			members = append(members, lookup[id])
		}
		p, _, err := decodePlacement(policyPlacement(t, s, members, 1, zero, ""), s.Network)
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, p)
	}
	pool, err := initialPool(s)
	if err != nil {
		t.Fatal(err)
	}
	return InitialBatch{InitialBatchBody{"sfera-mesh-initial-batch-v1", s.Network, hex.EncodeToString(digest(pool)), hex.EncodeToString(digest(records))}, records}
}

func TestInitialPlanSkipsExistingIDAfterOriginalMembersLeave(t *testing.T) {
	s, _, _, _ := policyFixture(t)
	pool, err := initialPool(s)
	if err != nil {
		t.Fatal(err)
	}
	first, err := bestInitialPlan(s, pool, 1)
	if err != nil || len(first) != 1 {
		t.Fatal("missing first plan", err)
	}
	old := clusterID(s.Network, first[0])
	s.Placements = map[string]PlacementHead{}
	// An evolved cluster retains its ID while all original members are free.
	s.Placements[old] = PlacementHead{Record: Placement{Body: PlacementBody{Members: []string{"retired-a", "retired-b", "retired-c"}, Epoch: 4}}}
	next, err := bestInitialPlan(s, pool, 1)
	if err != nil || len(next) != 1 || clusterID(s.Network, next[0]) == old {
		t.Fatal("historical ID blocked alternative plan", err)
	}
	for a := 0; a < len(pool); a++ {
		for b := a + 1; b < len(pool); b++ {
			for c := b + 1; c < len(pool); c++ {
				id := clusterID(s.Network, []string{pool[a].NodeID, pool[b].NodeID, pool[c].NodeID})
				s.Placements[id] = PlacementHead{}
			}
		}
	}
	none, err := bestInitialPlan(s, pool, 1)
	if err != nil || len(none) != 0 {
		t.Fatal("reused an existing ID", err)
	}
}

func TestInitialBatchAtomicityConflictsAndPoolBinding(t *testing.T) {
	s, keys, assessors, ids := policyFixture(t)
	pool, _ := initialPool(s)
	groups, err := bestInitialPlan(s, pool, 2)
	if err != nil || len(groups) != 2 {
		t.Fatal("plan unavailable", err)
	}
	batch := batchFixture(t, s, keys, groups)
	before := canonical(s)
	// A validly signed but non-current commercial profile in the second group
	// fails after staging the first. Neither placement may escape rollback.
	bad := batchFixture(t, s, keys, groups)
	p := &bad.Placements[1]
	p.Licenses[0].Claims.IssuedAt++
	p.Licenses[0].Signature = hex.EncodeToString(ed25519.Sign(testIssuer, canonical(p.Licenses[0].Claims)))
	p.Body.LicensesHash = hex.EncodeToString(digest(p.Licenses))
	lookup := map[string]ed25519.PrivateKey{}
	for i, id := range ids {
		lookup[id] = keys[i]
	}
	for i, id := range p.Body.Members {
		key := lookup[id]
		p.Consents[i] = Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(p.Body)))}
	}
	bad.Body.PlacementsHash = hex.EncodeToString(digest(bad.Placements))
	if err := apply(&s, canonical(bad)); err == nil {
		t.Fatal("non-current profile accepted")
	}
	if !bytes.Equal(before, canonical(s)) {
		t.Fatal("partial batch escaped rollback")
	}
	changed := clone(s)
	r := changed.Resources[ids[0]].Record.Body
	if err := apply(&changed, canonical(resourceFixture(changed, ids[0], assessors, 2, r.FailureDomain))); err != nil {
		t.Fatal(err)
	}
	changedBefore := canonical(changed)
	if err := apply(&changed, canonical(batch)); err == nil {
		t.Fatal("stale pool accepted")
	}
	if !bytes.Equal(changedBefore, canonical(changed)) {
		t.Fatal("stale batch mutated state")
	}
	competing := clone(s)
	if err := apply(&competing, canonical(batch.Placements[0])); err != nil {
		t.Fatal(err)
	}
	competingBefore := canonical(competing)
	if err := apply(&competing, canonical(batch)); err == nil {
		t.Fatal("partial conflicting batch accepted")
	}
	if !bytes.Equal(competingBefore, canonical(competing)) {
		t.Fatal("competing batch mutated state")
	}
	if err := apply(&s, canonical(batch)); err != nil {
		t.Fatal("joint plan rejected", err)
	}
	if len(s.Placements) != 2 {
		t.Fatal("batch not applied in full")
	}
	forged := batch
	forged.Body.PoolHash = zero
	if err := apply(&s, canonical(forged)); err == nil {
		t.Fatal("different batch body mistaken for exact retry")
	}
	if len(s.InitialBatches) != 1 {
		t.Fatal("accepted batch receipt missing")
	}
	if err := verifyPlacementHistory(s); err != nil {
		t.Fatal(err)
	}
	s.BlockTime = 5000
	if err := apply(&s, canonical(batch)); err != nil {
		t.Fatal("exact retry rejected", err)
	}
}

func TestInitialBatchRejectsOverlapAndNonoptimalPlan(t *testing.T) {
	s, keys, _, _ := policyFixture(t)
	pool, _ := initialPool(s)
	groups, err := bestInitialPlan(s, pool, 2)
	if err != nil {
		t.Fatal(err)
	}
	bad := batchFixture(t, s, keys, [][]string{groups[0], groups[0]})
	if err := apply(&s, canonical(bad)); err == nil {
		t.Fatal("overlap accepted")
	}
	alternative := [][]string{{pool[0].NodeID, pool[1].NodeID, pool[3].NodeID}, {pool[2].NodeID, pool[4].NodeID, pool[5].NodeID}}
	bad = batchFixture(t, s, keys, alternative)
	if err := apply(&s, canonical(bad)); err == nil {
		t.Fatal("nonoptimal tie accepted")
	}
	if len(s.Placements) != 0 {
		t.Fatal("rejected batch changed placements")
	}
}
