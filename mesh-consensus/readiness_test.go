package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"testing"
)

func readyPlacementFixture(t *testing.T, s State, tx []byte, target ed25519.PrivateKey, keys []ed25519.PrivateKey) []byte {
	t.Helper()
	p, _, err := decodePlacement(tx, s.Network)
	if err != nil {
		t.Fatal(err)
	}
	p.Body.Domain = "sfera-mesh-placement-v3"
	p.Body.ManifestHash = s.Manifests[p.Body.Cluster].Digest
	b := ReadinessBody{"sfera-mesh-readiness-v1", s.Network, p.Body.Cluster, readinessProposalHash(p.Body), p.Body.ManifestHash, hex.EncodeToString(hashNode(target.Public().(ed25519.PublicKey))), 1000, 1030}
	p.Readiness = &ReadinessProof{b, hex.EncodeToString(target.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(target, canonical(b)))}
	p.Body.ReadinessHash = hex.EncodeToString(digest(p.Readiness))
	lookup := map[string]ed25519.PrivateKey{}
	for _, key := range keys {
		lookup[hex.EncodeToString(hashNode(key.Public().(ed25519.PublicKey)))] = key
	}
	for i, id := range p.Body.Members {
		key := lookup[id]
		p.Consents[i] = Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(p.Body)))}
	}
	return canonical(p)
}

func TestReadinessBindsReplacementToCurrentIndexAndAcceptanceTime(t *testing.T) {
	s, keys, _, ids := policyFixture(t)
	first := policyPlacement(t, s, keys[:3], 1, zero, "")
	p, _, _ := decodePlacement(first, s.Network)
	if err := apply(&s, first); err != nil {
		t.Fatal(err)
	}
	cluster := p.Body.Cluster
	if err := apply(&s, canonical(manifestFixture(s, cluster, keys[:2], []string{}))); err != nil {
		t.Fatal(err)
	}
	best := 3
	for i := 4; i < 6; i++ {
		if ids[i] < ids[best] {
			best = i
		}
	}
	selected := []ed25519.PrivateKey{keys[0], keys[1], keys[best]}
	legacy := policyPlacement(t, s, selected, 2, s.Placements[cluster].Digest, cluster)
	if err := apply(&s, legacy); err == nil {
		t.Fatal("index-bound policy bypassed with v2")
	}
	ready := readyPlacementFixture(t, s, legacy, keys[best], selected)
	changed := clone(s)
	if err := apply(&changed, canonical(manifestFixture(changed, cluster, keys[:2], []string{zero}))); err != nil {
		t.Fatal(err)
	}
	if err := apply(&changed, ready); err == nil {
		t.Fatal("changed index accepted with old readiness")
	}
	expired := clone(s)
	expired.BlockTime = 1030
	if err := apply(&expired, ready); err == nil {
		t.Fatal("expired readiness accepted at finalization")
	}
	wrong := readyPlacementFixture(t, s, legacy, keys[0], selected)
	if err := apply(&s, wrong); err == nil {
		t.Fatal("survivor impersonated new target")
	}
	if err := apply(&s, ready); err != nil {
		t.Fatal("valid readiness rejected", err)
	}
	s.BlockTime = 5000
	if err := verifyPlacementHistory(s); err != nil {
		t.Fatal("accepted readiness expired retroactively", err)
	}
}
