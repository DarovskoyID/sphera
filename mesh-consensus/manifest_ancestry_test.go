package main

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
)

func TestManifestLineagePythonCompatibilityAndIsolation(t *testing.T) {
	hashes := []string{}
	for i := 0; i < 257; i++ {
		sum := sha256.Sum256([]byte(strconv.Itoa(i)))
		hashes = append(hashes, hex.EncodeToString(sum[:]))
	}
	if got := manifestLineageRoot("lab", strings.Repeat("a", 64), 1, hashes); got != "62ba721f24090732f5fc9b3dcf56efc25e434087e942c36efed9ba2420d6ad66" {
		t.Fatal("Python lineage root mismatch", got)
	}
	s, keys, cluster := manifestState(t)
	for i := 0; i < 7; i++ {
		if err := apply(&s, canonical(manifestFixture(s, cluster, keys[:2], []string{zero}))); err != nil {
			t.Fatal(err)
		}
	}
	if len(s.ManifestLineage[cluster].Hashes) != 7 || verifyManifestLineages(s) != nil {
		t.Fatal("lineage not committed")
	}
	copied := clone(s)
	copied.ManifestLineage[cluster].Hashes[0] = strings.Repeat("f", 64)
	if verifyManifestLineages(copied) == nil || verifyManifestLineages(s) != nil {
		t.Fatal("lineage clone shared mutable storage")
	}
	// Existing DBs can start a lineage from their current head; unavailable older
	// ancestry is not manufactured during migration.
	s.ManifestLineage = nil
	if err := apply(&s, canonical(manifestFixture(s, cluster, keys[:2], []string{zero}))); err != nil {
		t.Fatal(err)
	}
	if s.ManifestLineage[cluster].First != 7 || len(s.ManifestLineage[cluster].Hashes) != 2 || verifyManifestLineages(s) != nil {
		t.Fatal("invalid legacy lineage boundary")
	}
}
