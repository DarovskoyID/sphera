package main

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"testing"
	"time"

	dbm "github.com/cometbft/cometbft-db"
	abci "github.com/cometbft/cometbft/abci/types"
)

func candidateFixture(t *testing.T, key ed25519.PrivateKey, version int64, previous string, available bool) CandidateRecord {
	t.Helper()
	p, _, err := decodePlacement(signedPlacement([]ed25519.PrivateKey{key, placementKeys(t, 1)[0], placementKeys(t, 1)[0]}, 1, zero, ""), "lab")
	if err != nil {
		t.Fatal(err)
	}
	id := hex.EncodeToString(hashNode(key.Public().(ed25519.PublicKey)))
	var license LicenseDocument
	for _, document := range p.Licenses {
		if document.Claims.NodeID == id {
			license = document
		}
	}
	// Stable per-node instance, regardless of fixture sorting.
	license.Claims.InstanceID = id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:32]
	license.Signature = hex.EncodeToString(ed25519.Sign(testIssuer, canonical(license.Claims)))
	b := CandidateBody{"sfera-mesh-candidate-v1", "lab", id, hex.EncodeToString(key.Public().(ed25519.PublicKey)), version, previous, available, license}
	return CandidateRecord{b, hex.EncodeToString(ed25519.Sign(key, canonical(b)))}
}
func signCandidate(r *CandidateRecord, key ed25519.PrivateKey) {
	r.Signature = hex.EncodeToString(ed25519.Sign(key, canonical(r.Body)))
}

func TestCandidateVersionsExpiryAndClone(t *testing.T) {
	key := placementKeys(t, 1)[0]
	s := State{Network: "lab", Issuers: testIssuers(), BlockTime: 1000}
	r := candidateFixture(t, key, 1, zero, true)
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	id := r.Body.NodeID
	copyState := clone(s)
	next := r
	next.Body.Version, next.Body.Previous, next.Body.Available = 2, s.Candidates[id].Digest, false
	signCandidate(&next, key)
	if err := apply(&copyState, canonical(next)); err != nil {
		t.Fatal(err)
	}
	if !s.Candidates[id].Record.Body.Available {
		t.Fatal("pending candidate leaked")
	}
	if err := apply(&copyState, canonical(r)); err == nil {
		t.Fatal("replayed version accepted")
	}
	if err := apply(&copyState, canonical(next)); err != nil {
		t.Fatal("retry failed", err)
	}
	s.BlockTime = 5000
	if err := verifyCandidateRegistry(s); err != nil {
		t.Fatal("expired history lost", err)
	}
	next.Body.Previous = s.Candidates[id].Digest
	signCandidate(&next, key)
	if err := apply(&s, canonical(next)); err == nil {
		t.Fatal("expired renewal accepted")
	}
}

func TestCandidateTamperingAndDuplicateLicense(t *testing.T) {
	keys := placementKeys(t, 2)
	s := State{Network: "lab", Issuers: testIssuers(), BlockTime: 1000}
	r := candidateFixture(t, keys[0], 1, zero, true)
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	other := candidateFixture(t, keys[1], 1, zero, true)
	other.Body.License.Claims.InstanceID = r.Body.License.Claims.InstanceID
	other.Body.License.Signature = hex.EncodeToString(ed25519.Sign(testIssuer, canonical(other.Body.License.Claims)))
	signCandidate(&other, keys[1])
	if err := apply(&s, canonical(other)); err == nil || len(s.Candidates) != 1 {
		t.Fatal("duplicate instance accepted")
	}
	other.Body.Network = "elsewhere"
	signCandidate(&other, keys[1])
	if err := apply(&s, canonical(other)); err == nil {
		t.Fatal("wrong network accepted")
	}
	r.Body.Available = false
	if err := apply(&s, canonical(r)); err == nil {
		t.Fatal("tampered offer accepted")
	}
}

func TestCandidateFinalizationAndRestart(t *testing.T) {
	db := dbm.NewMemDB()
	defer db.Close()
	a, err := NewApplicationWithIssuers(db, "lab", testIssuers())
	if err != nil {
		t.Fatal(err)
	}
	a.state.BlockTime = 1000
	r := candidateFixture(t, placementKeys(t, 1)[0], 1, zero, true)
	ctx := context.Background()
	check, _ := a.CheckTx(ctx, &abci.RequestCheckTx{Tx: canonical(r)})
	if check.Code != 0 {
		t.Fatal(check.Log)
	}
	result, err := a.FinalizeBlock(ctx, &abci.RequestFinalizeBlock{Height: 1, Time: time.Unix(1300, 0), Txs: [][]byte{canonical(r)}})
	if err != nil || result.TxResults[0].Code == 0 {
		t.Fatal("expired candidate finalized", err)
	}
	// Commit a valid offer in a separate application at its valid block time.
	a.pending = nil
	result, err = a.FinalizeBlock(ctx, &abci.RequestFinalizeBlock{Height: 1, Time: time.Unix(1001, 0), Txs: [][]byte{canonical(r)}})
	if err != nil || result.TxResults[0].Code != 0 {
		t.Fatal("valid candidate rejected", err)
	}
	if _, err := a.Commit(ctx, &abci.RequestCommit{}); err != nil {
		t.Fatal(err)
	}
	b, err := NewApplicationWithIssuers(db, "lab", testIssuers())
	if err != nil || len(b.state.Candidates) != 1 {
		t.Fatal("candidate lost after restart", err)
	}
}

func TestRegisteredReplacementUsesCurrentOffersAndMemberships(t *testing.T) {
	keys := placementKeys(t, 6)
	s := State{Network: "lab", Issuers: testIssuers(), BlockTime: 1000}
	tx := signedPlacement(keys[:3], 1, zero, "")
	p, _, err := decodePlacement(tx, "lab")
	if err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, tx); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, key := range keys {
		r := candidateFixture(t, key, 1, zero, true)
		if err := apply(&s, canonical(r)); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, r.Body.NodeID)
	}
	admissible := map[string]bool{ids[3]: true, ids[4]: true, ids[5]: true}
	// Same commercial score and membership count: stable node ID tie-break.
	expected := ids[3]
	for _, id := range ids[4:] {
		if id < expected {
			expected = id
		}
	}
	best, err := registeredReplacement(s, ids[:2], p.Body.Cluster, admissible)
	if err != nil || best != expected {
		t.Fatal("unstable ranking", best, expected, err)
	}
	// An existing membership loses to a free candidate at equal score.
	s.Placements["neighbor"] = PlacementHead{Record: Placement{Body: PlacementBody{Members: []string{expected}}}}
	best, err = registeredReplacement(s, ids[:2], p.Body.Cluster, admissible)
	if err != nil || best == expected || best == "" {
		t.Fatal("membership tie-break ignored", err)
	}
	// A node with two memberships must never be proposed for a third.
	s.Placements["other"] = s.Placements["neighbor"]
	best, err = registeredReplacement(s, ids[:2], p.Body.Cluster, map[string]bool{expected: true})
	if err != nil || best != "" {
		t.Fatal("third membership proposed", err)
	}
	best, err = registeredReplacement(s, ids[:2], p.Body.Cluster, nil)
	if err != nil || best != "" {
		t.Fatal("unassessed resources admitted", err)
	}
	s.BlockTime = 1300
	if _, err := registeredReplacement(s, ids[:2], p.Body.Cluster, admissible); err == nil {
		t.Fatal("expired survivor profile ranked")
	}
}
