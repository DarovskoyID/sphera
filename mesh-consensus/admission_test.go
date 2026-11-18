package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	dbm "github.com/cometbft/cometbft-db"
	"sort"
	"strings"
	"testing"
)

func admissionFixture(s State, key ed25519.PrivateKey, authorities []ed25519.PrivateKey, version int64, previous string) (AdmissionApplication, AdmissionApproval) {
	public := key.Public().(ed25519.PublicKey)
	b := AdmissionApplicationBody{"sfera-mesh-admission-application-lab-v1", s.Network, s.GenesisPin, strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("e", 64), hex.EncodeToString(hashNode(public)), hex.EncodeToString(public), "validator", s.BlockTime - 1, s.BlockTime + 250}
	request := AdmissionApplication{b, hex.EncodeToString(ed25519.Sign(key, canonical(b)))}
	body := AdmissionApprovalBody{"sfera-mesh-admission-approval-lab-v1", s.Network, s.GenesisPin, b.Policy, hex.EncodeToString(digest(admissionCommittee(s))), hex.EncodeToString(digest(request)), version, previous, s.BlockTime, s.BlockTime + 250}
	approval := AdmissionApproval{Body: body, Votes: []Consent{}}
	for _, authority := range authorities {
		approval.Votes = append(approval.Votes, Consent{hex.EncodeToString(authority.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(authority, canonical(body)))})
	}
	sort.Slice(approval.Votes, func(i, j int) bool { return approval.Votes[i].PublicKey < approval.Votes[j].PublicKey })
	return request, approval
}
func revocationFixture(s State, old AdmissionHead, authorities []ed25519.PrivateKey, reason string) AdmissionRevocation {
	version, _, _, _ := admissionVersion(old)
	b := AdmissionRevocationBody{"sfera-mesh-admission-revocation-lab-v1", s.Network, s.GenesisPin, s.AdmissionPolicy, hex.EncodeToString(digest(admissionCommittee(s))), old.Application.Body.NodeID, old.Application.Body.Operator, old.Digest, version + 1, old.Digest, reason, s.BlockTime, s.BlockTime + 250}
	record := AdmissionRevocation{Body: b, Votes: []Consent{}}
	for _, key := range authorities {
		record.Votes = append(record.Votes, Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(b)))})
	}
	sort.Slice(record.Votes, func(i, j int) bool { return record.Votes[i].PublicKey < record.Votes[j].PublicKey })
	return record
}
func TestAdmissionConsensusApprovalRevocationAndHistoricalRetry(t *testing.T) {
	s, _, authorities, _ := policyFixture(t)
	s.GenesisPin = strings.Repeat("a", 64)
	s.Accounts = map[string]Head{}
	candidate := placementKeys(t, 1)[0]
	request, approval := admissionFixture(s, candidate, authorities[:3], 1, zero)
	tx := AdmissionTransaction{Body: AdmissionTxBody{"sfera-mesh-admission-update-lab-v1", s.Network, "approve"}, Application: &request, Approval: &approval}
	invalid := approval
	invalid.Votes = approval.Votes[:2]
	bad := tx
	bad.Approval = &invalid
	before := canonical(s)
	if err := apply(&s, canonical(bad)); err == nil || !bytes.Equal(before, canonical(s)) {
		t.Fatal("invalid quorum mutated admission")
	}
	if err := apply(&s, canonical(tx)); err != nil {
		t.Fatal(err)
	}
	node := request.Body.NodeID
	head := s.Admissions[node][0]
	revoked := revocationFixture(s, head, authorities[:3], strings.Repeat("f", 64))
	revokeTx := AdmissionTransaction{Body: AdmissionTxBody{"sfera-mesh-admission-update-lab-v1", s.Network, "revoke"}, Revocation: &revoked}
	if err := apply(&s, canonical(revokeTx)); err != nil {
		t.Fatal(err)
	}
	s.BlockTime += 1000
	if err := apply(&s, canonical(tx)); err != nil {
		t.Fatal("exact expired approval retry", err)
	}
	if err := apply(&s, canonical(revokeTx)); err != nil {
		t.Fatal("exact expired revocation retry", err)
	}
	if len(s.Admissions[node]) != 2 {
		t.Fatal("retry changed history")
	}
	if err := verifyAdmissions(s); err != nil {
		t.Fatal(err)
	}
	request2, approval2 := admissionFixture(s, candidate, authorities[:3], 3, hex.EncodeToString(digest(revoked)))
	tx.Application = &request2
	tx.Approval = &approval2
	if err := apply(&s, canonical(tx)); err == nil {
		t.Fatal("revoked node reapproved")
	}
}
func TestAdmissionRotationAtomicityAndRestart(t *testing.T) {
	s, _, authorities, _ := policyFixture(t)
	s.GenesisPin = strings.Repeat("a", 64)
	s.Accounts = map[string]Head{}
	keys := placementKeys(t, 2)
	request, approval := admissionFixture(s, keys[0], authorities[:3], 1, zero)
	tx := AdmissionTransaction{Body: AdmissionTxBody{"sfera-mesh-admission-update-lab-v1", s.Network, "approve"}, Application: &request, Approval: &approval}
	if err := apply(&s, canonical(tx)); err != nil {
		t.Fatal(err)
	}
	old := s.Admissions[request.Body.NodeID][0]
	target, approved := admissionFixture(s, keys[1], authorities[:3], 1, zero)
	b := AdmissionRotationBody{"sfera-mesh-admission-rotation-lab-v1", old.Digest, hex.EncodeToString(digest(target)), hex.EncodeToString(digest(approved)), s.BlockTime}
	proof := AdmissionRotation{b, hex.EncodeToString(ed25519.Sign(keys[0], canonical(b))), hex.EncodeToString(ed25519.Sign(keys[1], canonical(b)))}
	revoked := revocationFixture(s, old, authorities[:3], hex.EncodeToString(digest(proof)))
	rotateTx := AdmissionTransaction{Body: AdmissionTxBody{"sfera-mesh-admission-update-lab-v1", s.Network, "rotate"}, Application: &target, Approval: &approved, Revocation: &revoked, Rotation: &proof}
	bad := rotateTx
	badApproval := approved
	badApproval.Votes = approved.Votes[:2]
	bad.Approval = &badApproval
	before := canonical(s)
	if err := apply(&s, canonical(bad)); err == nil || !bytes.Equal(before, canonical(s)) {
		t.Fatal("rotation partly accepted")
	}
	if err := apply(&s, canonical(rotateTx)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(rotateTx)); err != nil {
		t.Fatal("rotation exact retry", err)
	}
	if err := verifyAdmissions(s); err != nil {
		t.Fatal(err)
	}
	db := dbm.NewMemDB()
	defer db.Close()
	if err := db.SetSync([]byte("state"), canonical(s)); err != nil {
		t.Fatal(err)
	}
	loaded, err := NewApplicationWithPolicy(db, s.Network, s.Issuers, s.PolicyKeys, s.GenesisPin)
	if err != nil || len(loaded.state.AdmissionRotations) != 1 {
		t.Fatal("admission restart", err)
	}
	if _, err := NewApplicationWithPolicy(db, s.Network, s.Issuers, s.PolicyKeys, strings.Repeat("f", 64)); err == nil {
		t.Fatal("foreign genesis accepted")
	}
}
