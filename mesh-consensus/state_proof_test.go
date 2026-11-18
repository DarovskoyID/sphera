package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestCompactStateCommitmentBindsLeafPositionSizeAndCount(t *testing.T) {
	s, keys, cluster := manifestState(t)
	s.StateCommitment = stateMerkleScheme
	s.Height = 7
	if err := apply(&s, canonical(sizedManifestFixture(s, cluster, keys[:2], []string{zero}, []int64{4}))); err != nil {
		t.Fatal(err)
	}
	key := "manifest/" + cluster + "/entry/" + zero
	p, err := makeStateProof(s, key)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := proofAppHash(p)
	if err != nil || !bytes.Equal(hash, digest(s)) {
		t.Fatal("proof root", err)
	}
	if len(canonical(p)) >= len(canonical(s)) {
		t.Fatal("proof not compact")
	}
	for _, field := range []string{"value", "count", "index", "path"} {
		var bad StateProof
		_ = json.Unmarshal(canonical(p), &bad)
		switch field {
		case "value":
			bad.Leaf.Value = canonical(map[string]any{"size": 5})
		case "count":
			bad.Count++
		case "index":
			bad.Index = (bad.Index + 1) % bad.Count
		case "path":
			bad.Path = append(bad.Path, zero)
		}
		altered, err := proofAppHash(bad)
		if err == nil && bytes.Equal(altered, digest(s)) {
			t.Fatal("tampered proof accepted", field)
		}
	}
	leaves := stateLeaves(s)
	for _, leaf := range leaves {
		proof, err := makeStateProof(s, leaf.Key)
		if err != nil {
			t.Fatal(err)
		}
		got, err := proofAppHash(proof)
		if err != nil || !bytes.Equal(got, digest(s)) {
			t.Fatal("leaf proof", leaf.Key, err)
		}
	}
	s.StateCommitment = ""
	if _, err := makeStateProof(s, key); err == nil {
		t.Fatal("legacy state enabled compact proofs")
	}
}
