package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"testing"
)

func TestManifest512PagedProofsAndBounds(t *testing.T) {
	s, keys, cluster := manifestState(t)
	values := []string{}
	sizes := []int64{}
	for i := 0; i < 512; i++ {
		hash := sha256.Sum256([]byte(strconv.Itoa(i)))
		values = append(values, hex.EncodeToString(hash[:]))
		sizes = append(sizes, 4)
	}
	record := sizedManifestFixture(s, cluster, keys[:2], values, sizes)
	if len(canonical(record)) <= 16384 {
		t.Fatal("large index did not cross former wire bound")
	}
	if err := apply(&s, canonical(record)); err != nil {
		t.Fatal(err)
	}
	s.Height = 1
	s.StateCommitment = stateMerkleScheme
	page, err := makeManifestPage(s, canonical(ManifestPageRequest{cluster, 128, 16}))
	if err != nil || len(page.Entries) != 16 {
		t.Fatal(page, err)
	}
	proofs := append([]StateProof{page.Meta}, page.Entries...)
	for _, proof := range proofs {
		root, err := proofAppHash(proof)
		if err != nil || !bytes.Equal(root, digest(s)) {
			t.Fatal("invalid page inclusion proof", err)
		}
	}
	for index, proof := range page.Entries {
		if proof.Index != page.Meta.Index-512+128+index {
			t.Fatal("page not consecutive")
		}
	}
	if _, err = makeManifestPage(s, canonical(ManifestPageRequest{cluster, 513, 16})); err == nil {
		t.Fatal("out of range page accepted")
	}
	if _, err = makeManifestPage(s, canonical(ManifestPageRequest{cluster, 0, 65})); err == nil {
		t.Fatal("unbounded page accepted")
	}
}
