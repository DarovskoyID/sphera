package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"testing"
)

var testIssuer = ed25519.NewKeyFromSeed(make([]byte, 32))

func testIssuers() map[string]string {
	public := testIssuer.Public().(ed25519.PublicKey)
	sum := sha256.Sum256(public)
	return map[string]string{hex.EncodeToString(sum[:]): hex.EncodeToString(public)}
}

func placementKeys(t *testing.T, n int) []ed25519.PrivateKey {
	t.Helper()
	keys := []ed25519.PrivateKey{}
	for i := 0; i < n; i++ {
		_, key, e := ed25519.GenerateKey(rand.Reader)
		if e != nil {
			t.Fatal(e)
		}
		keys = append(keys, key)
	}
	return keys
}
func signedPlacement(keys []ed25519.PrivateKey, epoch int64, previous, cluster string) []byte {
	members := []string{}
	lookup := map[string]ed25519.PrivateKey{}
	for _, key := range keys {
		id := hex.EncodeToString(hashNode(key.Public().(ed25519.PublicKey)))
		members = append(members, id)
		lookup[id] = key
	}
	sort.Strings(members)
	if cluster == "" {
		cluster = clusterID("lab", members)
	}
	licenses := []LicenseDocument{}
	issuerID := ""
	for id := range testIssuers() {
		issuerID = id
	}
	for i, node := range members {
		claims := LicenseClaims{"sfera-mesh-license-v1", issuerID, fmt.Sprintf("00000000-0000-0000-0000-%012d", i+1), node, "lab", 990, 1290, []LicenseModule{{"office", 2000}}}
		licenses = append(licenses, LicenseDocument{claims, hex.EncodeToString(ed25519.Sign(testIssuer, canonical(claims)))})
	}
	b := PlacementBody{"sfera-mesh-placement-v2", "lab", cluster, epoch, previous, members, hex.EncodeToString(digest(licenses))}
	p := Placement{Body: b, Consents: []Consent{}}
	p.Licenses = licenses
	for _, id := range members {
		key := lookup[id]
		p.Consents = append(p.Consents, Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(b)))})
	}
	return canonical(p)
}
func TestPlacementConsentEpochAndFork(t *testing.T) {
	keys := placementKeys(t, 5)
	state := State{Network: "lab", Accounts: map[string]Head{}, Issuers: testIssuers(), BlockTime: 1000}
	first := signedPlacement(keys[:3], 1, zero, "")
	p, h, e := decodePlacement(first, "lab")
	if e != nil {
		t.Fatal(e)
	}
	if e = apply(&state, first); e != nil {
		t.Fatal(e)
	}
	copyState := clone(state)
	second := signedPlacement([]ed25519.PrivateKey{keys[0], keys[1], keys[3]}, 2, h, p.Body.Cluster)
	if e = apply(&copyState, second); e != nil {
		t.Fatal(e)
	}
	if state.Placements[p.Body.Cluster].Record.Body.Epoch != 1 {
		t.Fatal("proposal leaked to committed state")
	}
	fork := signedPlacement([]ed25519.PrivateKey{keys[0], keys[1], keys[4]}, 2, h, p.Body.Cluster)
	if e = apply(&copyState, fork); e == nil {
		t.Fatal("conflicting epoch accepted")
	}
	if e = apply(&copyState, second); e != nil {
		t.Fatal("idempotent placement rejected")
	}
	if e = verifyPlacementHistory(copyState); e != nil {
		t.Fatal(e)
	}
	badHistory := clone(copyState)
	badHistory.PlacementHistory[p.Body.Cluster] = badHistory.PlacementHistory[p.Body.Cluster][1:]
	if e = verifyPlacementHistory(badHistory); e == nil {
		t.Fatal("missing placement predecessor accepted")
	}
	bad := p
	bad.Consents = bad.Consents[:2]
	if e = apply(&state, canonical(bad)); e == nil {
		t.Fatal("missing member consent accepted")
	}
	if _, _, e = decodePlacement(first, "other-network"); e == nil {
		t.Fatal("cross-network placement accepted")
	}
}
func TestPlacementLimitsTwoMemberships(t *testing.T) {
	keys := placementKeys(t, 5)
	state := State{Network: "lab", Accounts: map[string]Head{}, Issuers: testIssuers(), BlockTime: 1000}
	for _, group := range [][]ed25519.PrivateKey{keys[:3], {keys[0], keys[3], keys[4]}} {
		if e := apply(&state, signedPlacement(group, 1, zero, "")); e != nil {
			t.Fatal(e)
		}
	}
	if e := apply(&state, signedPlacement([]ed25519.PrivateKey{keys[0], keys[1], keys[3]}, 1, zero, "")); e == nil {
		t.Fatal("third storage membership accepted")
	}
}
