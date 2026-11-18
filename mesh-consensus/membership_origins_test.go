package main

import (
	"crypto/ed25519"
	"testing"
)

func TestPlannedReturnRequiresProvenLoanAndFreeReadyTarget(t *testing.T) {
	s, keys, assessors, ids := policyFixture(t)
	s.BlockTime = 999
	if err := apply(&s, policyPlacement(t, s, keys[2:5], 1, zero, "")); err != nil {
		t.Fatal(err)
	}
	s.BlockTime = 1000
	first := policyPlacement(t, s, []ed25519.PrivateKey{keys[0], keys[1], keys[5]}, 1, zero, "")
	p, _, _ := decodePlacement(first, s.Network)
	cluster := p.Body.Cluster
	if err := apply(&s, first); err != nil {
		t.Fatal(err)
	}
	s.BlockTime = 1001
	if err := apply(&s, canonical(resourceFixture(s, ids[5], assessors, 0, "f"))); err != nil {
		t.Fatal(err)
	}
	borrowed := 2
	for i := 3; i < 5; i++ {
		if ids[i] < ids[borrowed] {
			borrowed = i
		}
	}
	selected := []ed25519.PrivateKey{keys[0], keys[1], keys[borrowed]}
	if err := apply(&s, policyPlacement(t, s, selected, 2, s.Placements[cluster].Digest, cluster)); err != nil {
		t.Fatal(err)
	}
	if !borrowedFromHistory(s, ids[borrowed], cluster) {
		t.Fatal("loan not recognized")
	}
	if err := apply(&s, canonical(resourceFixture(s, ids[5], assessors, 2, "f"))); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(manifestFixture(s, cluster, keys[:2], []string{}))); err != nil {
		t.Fatal(err)
	}
	target := []ed25519.PrivateKey{keys[0], keys[1], keys[5]}
	legacy := policyPlacement(t, s, target, 3, s.Placements[cluster].Digest, cluster)
	ready := readyPlacementFixture(t, s, legacy, keys[5], target)
	ambiguous := clone(s)
	for key, history := range ambiguous.PlacementHistory {
		if key != cluster {
			history[0].AcceptedAt = 1001
			ambiguous.PlacementHistory[key] = history
		}
	}
	if err := apply(&ambiguous, ready); err == nil {
		t.Fatal("ambiguous origin accepted")
	}
	stale := clone(s)
	delete(stale.Resources, ids[borrowed])
	if err := apply(&stale, ready); err == nil {
		t.Fatal("missing departure assessment accepted")
	}
	busy := clone(s)
	busy.Placements["busy"] = PlacementHead{Record: Placement{Body: PlacementBody{Members: []string{ids[5]}}}}
	if err := apply(&busy, ready); err == nil {
		t.Fatal("another borrowed target accepted")
	}
	broken := clone(s)
	if err := apply(&broken, canonical(resourceFixture(broken, ids[0], assessors, 0, "a"))); err != nil {
		t.Fatal(err)
	}
	if err := apply(&broken, ready); err == nil {
		t.Fatal("unhealthy survivor accepted")
	}
	if err := apply(&s, legacy); err == nil {
		t.Fatal("unprepared return accepted")
	}
	if err := apply(&s, ready); err != nil {
		t.Fatal("ready return rejected", err)
	}
	if membershipCount(s, ids[borrowed]) != 1 || borrowedFromHistory(s, ids[borrowed], cluster) {
		t.Fatal("loan not released at finalization")
	}
}
