package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"sort"
	"strings"
	"testing"

	dbm "github.com/cometbft/cometbft-db"
	abci "github.com/cometbft/cometbft/abci/types"
)

func committeeFixture(t *testing.T) (State, CommitteeRecord, []ed25519.PrivateKey) {
	s, _, authorities, _ := policyFixture(t)
	s.GenesisPin = strings.Repeat("a", 64)
	s.StateCommitment = stateMerkleScheme
	s.Accounts = map[string]Head{}
	joining := placementKeys(t, 1)[0]
	request, approval := admissionFixture(s, joining, authorities[:3], 1, zero)
	tx := AdmissionTransaction{Body: AdmissionTxBody{"sfera-mesh-admission-update-lab-v1", s.Network, "approve"}, Application: &request, Approval: &approval}
	if err := apply(&s, canonical(tx)); err != nil {
		t.Fatal(err)
	}
	public := hex.EncodeToString(joining.Public().(ed25519.PublicKey))
	members := append(initialCommittee(s.PolicyKeys), public)
	sort.Strings(members)
	b := CommitteeBody{Domain: "sfera-mesh-committee-lab-v1", Network: s.Network, Genesis: s.GenesisPin, Version: 1, Previous: zero, ActivateAt: 8, Members: members,
		Admissions: map[string]string{public: s.Admissions[request.Body.NodeID][0].Digest}}
	record := CommitteeRecord{Body: b, Votes: []Consent{}, Joins: []Consent{{public, hex.EncodeToString(ed25519.Sign(joining, canonical(b)))}}}
	for _, key := range authorities[:3] {
		record.Votes = append(record.Votes, Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(b)))})
	}
	sort.Slice(record.Votes, func(i, j int) bool { return record.Votes[i].PublicKey < record.Votes[j].PublicKey })
	return s, record, authorities
}
func TestCommitteeScheduledUpdatesAreDurableAndProofIsRetained(t *testing.T) {
	s, record, _ := committeeFixture(t)
	db := dbm.NewMemDB()
	defer db.Close()
	a := &Application{db: db, state: s}
	result, err := a.FinalizeBlock(context.Background(), &abci.RequestFinalizeBlock{Height: 1, Txs: [][]byte{canonical(record)}})
	if err != nil || result.TxResults[0].Code != 0 || len(result.ValidatorUpdates) != 0 {
		t.Fatal(result, err)
	}
	if len(a.state.Committees) != 0 {
		t.Fatal("uncommitted change escaped")
	}
	if _, err = a.Commit(context.Background(), &abci.RequestCommit{}); err != nil {
		t.Fatal(err)
	}
	if err = verifyCommitteeHistory(a.state); err != nil {
		t.Fatal(err)
	}
	proofResult, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/committee-history"})
	if err != nil || !bytes.Contains(proofResult.Value, []byte(committeeKey(1))) {
		t.Fatal("missing durable proof", err)
	}
	for height := int64(2); height <= 9; height++ {
		result, err = a.FinalizeBlock(context.Background(), &abci.RequestFinalizeBlock{Height: height})
		if err != nil {
			t.Fatal(err)
		}
		want := 0
		if height == 6 {
			want = 1
		}
		if len(result.ValidatorUpdates) != want {
			t.Fatalf("updates at height %d: %v", height, result.ValidatorUpdates)
		}
		if _, err = a.Commit(context.Background(), &abci.RequestCommit{}); err != nil {
			t.Fatal(err)
		}
	}
	if err = apply(&a.state, canonical(record)); err != nil || len(a.state.Committees) != 1 {
		t.Fatal("idempotent retry", err)
	}
	raw, err := db.Get([]byte("state"))
	if err != nil || !bytes.Equal(raw, canonical(a.state)) {
		t.Fatal("state persistence", err)
	}
}
func TestCommitteeRejectsMissingQuorumPossessionAdmissionAndPendingChange(t *testing.T) {
	s, record, _ := committeeFixture(t)
	for _, kind := range []string{"quorum", "join", "admission", "genesis", "early", "order"} {
		bad := record
		switch kind {
		case "quorum":
			bad.Votes = record.Votes[:2]
		case "join":
			bad.Joins = []Consent{}
		case "admission":
			bad.Body.Admissions = map[string]string{}
		case "genesis":
			bad.Body.Genesis = zero
		case "early":
			bad.Body.ActivateAt = 4
		case "order":
			bad.Body.Members = append([]string(nil), record.Body.Members...)
			bad.Body.Members[0], bad.Body.Members[1] = bad.Body.Members[1], bad.Body.Members[0]
		}
		trial := clone(s)
		before := canonical(trial)
		if err := apply(&trial, canonical(bad)); err == nil || !bytes.Equal(before, canonical(trial)) {
			t.Fatal("accepted or mutated invalid change", kind)
		}
	}
	if err := apply(&s, canonical(record)); err != nil {
		t.Fatal(err)
	}
	s.Height = 1
	bad := record
	bad.Body.Version = 2
	bad.Body.Previous = s.Committees[0].Digest
	bad.Body.ActivateAt = 9
	if err := apply(&s, canonical(bad)); err == nil {
		t.Fatal("overlapping committee change")
	}
}
