package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"testing"

	dbm "github.com/cometbft/cometbft-db"
)

func resourceFixture(s State, id string, assessors []ed25519.PrivateKey, slots int, zone string) ResourceRecord {
	old, exists := s.Resources[id]
	version, previous := int64(1), zero
	if exists {
		version, previous = old.Record.Body.Version+1, old.Digest
	}
	b := ResourceBody{"sfera-mesh-resource-v1", s.Network, id, s.Candidates[id].Digest, version, previous, zone, slots, 990, 1290}
	r := ResourceRecord{Body: b, Consents: []Consent{}}
	for _, key := range assessors[:3] {
		r.Consents = append(r.Consents, Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(b)))})
	}
	sort.Slice(r.Consents, func(i, j int) bool { return r.Consents[i].PublicKey < r.Consents[j].PublicKey })
	return r
}

func policyFixture(t *testing.T) (State, []ed25519.PrivateKey, []ed25519.PrivateKey, []string) {
	t.Helper()
	assessors := placementKeys(t, 4)
	s := State{Network: "lab", Issuers: testIssuers(), BlockTime: 1000, PolicyKeys: map[string]string{}}
	for _, key := range assessors {
		public := key.Public().(ed25519.PublicKey)
		hash := sha256.Sum256(public)
		s.PolicyKeys[hex.EncodeToString(hash[:])] = hex.EncodeToString(public)
	}
	keys := placementKeys(t, 6)
	ids := []string{}
	for i, key := range keys {
		candidate := candidateFixture(t, key, 1, zero, true)
		if err := apply(&s, canonical(candidate)); err != nil {
			t.Fatal(err)
		}
		id := candidate.Body.NodeID
		ids = append(ids, id)
		r := resourceFixture(s, id, assessors, 2, string(rune('a'+i)))
		if err := apply(&s, canonical(r)); err != nil {
			t.Fatal(err)
		}
	}
	return s, keys, assessors, ids
}

func policyPlacement(t *testing.T, s State, keys []ed25519.PrivateKey, epoch int64, previous, cluster string) []byte {
	t.Helper()
	p, _, err := decodePlacement(signedPlacement(keys, epoch, previous, cluster), s.Network)
	if err != nil {
		t.Fatal(err)
	}
	lookup := map[string]ed25519.PrivateKey{}
	for _, key := range keys {
		lookup[hex.EncodeToString(hashNode(key.Public().(ed25519.PublicKey)))] = key
	}
	for i, id := range p.Body.Members {
		p.Licenses[i] = s.Candidates[id].Record.Body.License
	}
	p.Body.LicensesHash = hex.EncodeToString(digest(p.Licenses))
	for i, id := range p.Body.Members {
		key := lookup[id]
		p.Consents[i] = Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(p.Body)))}
	}
	return canonical(p)
}

func TestQuorumResourcesAndVersionedBinding(t *testing.T) {
	s, keys, assessors, ids := policyFixture(t)
	r := resourceFixture(s, ids[0], assessors, 1, "zone")
	bad := r
	bad.Consents = append([]Consent(nil), r.Consents[:2]...)
	if err := apply(&s, canonical(bad)); err == nil {
		t.Fatal("two assessors accepted")
	}
	bad = r
	bad.Consents = append([]Consent(nil), r.Consents...)
	bad.Consents[1] = bad.Consents[0]
	if err := apply(&s, canonical(bad)); err == nil {
		t.Fatal("duplicate assessor accepted")
	}
	bad = resourceFixture(s, ids[0], placementKeys(t, 4), 1, "zone")
	if err := apply(&s, canonical(bad)); err == nil {
		t.Fatal("untrusted assessors accepted")
	}
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal("retry failed", err)
	}
	if err := apply(&s, canonical(resourceFixture(State{Network: "lab", Candidates: s.Candidates}, ids[0], assessors, 2, "a"))); err == nil {
		t.Fatal("resource version replay accepted")
	}
	candidate := s.Candidates[ids[0]].Record
	candidate.Body.Version = 2
	candidate.Body.Previous = s.Candidates[ids[0]].Digest
	signCandidate(&candidate, keys[0])
	if err := apply(&s, canonical(candidate)); err != nil {
		t.Fatal(err)
	}
	if _, ok := assessedResource(s, ids[0]); ok {
		t.Fatal("assessment survived candidate replacement")
	}
	s.BlockTime = 5000
	if err := verifyResourceRegistry(s); err != nil {
		t.Fatal("historical assessment expired retroactively", err)
	}
	if _, ok := assessedResource(s, ids[1]); ok {
		t.Fatal("expired assessment selected")
	}
}

func TestPolicyEnforcesBestSafeReplacement(t *testing.T) {
	s, keys, assessors, ids := policyFixture(t)
	first := policyPlacement(t, s, keys[:3], 1, zero, "")
	p, hash, err := decodePlacement(first, s.Network)
	if err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, first); err != nil {
		t.Fatal(err)
	}
	bestIndex := 3
	for i := 4; i < 6; i++ {
		if ids[i] < ids[bestIndex] {
			bestIndex = i
		}
	}
	other := 3
	if other == bestIndex {
		other = 4
	}
	bad := policyPlacement(t, s, []ed25519.PrivateKey{keys[0], keys[1], keys[other]}, 2, hash, p.Body.Cluster)
	if err := apply(&s, bad); err == nil {
		t.Fatal("nonoptimal replacement accepted")
	}
	good := policyPlacement(t, s, []ed25519.PrivateKey{keys[0], keys[1], keys[bestIndex]}, 2, hash, p.Body.Cluster)
	copyState := clone(s)
	if err := apply(&copyState, good); err != nil {
		t.Fatal("best replacement rejected", err)
	}
	// Quorum assigns the best commercial candidate a survivor's failure zone.
	r := resourceFixture(s, ids[bestIndex], assessors, 2, "a")
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, good); err == nil {
		t.Fatal("same failure zone accepted")
	}
	admissible := map[string]bool{}
	for i := 3; i < 6; i++ {
		if i != bestIndex {
			admissible[ids[i]] = true
		}
	}
	next, err := registeredReplacement(s, ids[:2], p.Body.Cluster, admissible)
	if err != nil {
		t.Fatal(err)
	}
	nextIndex := 0
	for i, id := range ids {
		if id == next {
			nextIndex = i
		}
	}
	if err := apply(&s, policyPlacement(t, s, []ed25519.PrivateKey{keys[0], keys[1], keys[nextIndex]}, 2, hash, p.Body.Cluster)); err != nil {
		t.Fatal("safe fallback rejected", err)
	}
}

func TestPolicyIsPinnedAcrossRestart(t *testing.T) {
	s, _, _, _ := policyFixture(t)
	s.Accounts = map[string]Head{}
	db := dbm.NewMemDB()
	defer db.Close()
	if err := db.SetSync([]byte("state"), canonical(s)); err != nil {
		t.Fatal(err)
	}
	if _, err := NewApplicationWithPolicy(db, "lab", s.Issuers, s.PolicyKeys); err != nil {
		t.Fatal(err)
	}
	if _, err := NewApplicationWithIssuers(db, "lab", s.Issuers); err == nil {
		t.Fatal("policy silently disabled")
	}
}

func TestPolicyRejectsMissingCapacityExpiredAssessmentsAndUnregisteredProfiles(t *testing.T) {
	s, keys, assessors, ids := policyFixture(t)
	first := policyPlacement(t, s, keys[:3], 1, zero, "")
	missing := clone(s)
	delete(missing.Resources, ids[0])
	if err := apply(&missing, first); err == nil {
		t.Fatal("missing assessment accepted")
	}
	zeroCapacity := clone(s)
	if err := apply(&zeroCapacity, canonical(resourceFixture(zeroCapacity, ids[0], assessors, 0, "a"))); err != nil {
		t.Fatal(err)
	}
	if err := apply(&zeroCapacity, first); err == nil {
		t.Fatal("zero capacity accepted")
	}
	// Profiles may be genuine company grants and consented by all members,
	// but only the current registered versions may drive placement decisions.
	if err := apply(&s, signedPlacement(keys[:3], 1, zero, "")); err == nil {
		t.Fatal("unregistered profile substituted")
	}
	r := resourceFixture(s, ids[0], assessors, 2, "a")
	r.Body.ExpiresAt = 1001
	r.Consents = nil
	for _, key := range assessors[:3] {
		r.Consents = append(r.Consents, Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(r.Body)))})
	}
	sort.Slice(r.Consents, func(i, j int) bool { return r.Consents[i].PublicKey < r.Consents[j].PublicKey })
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, first); err != nil {
		t.Fatal("valid assessment rejected", err)
	}
	// Reuse a pre-placement state to avoid the idempotent transaction path.
	s.Placements = nil
	s.PlacementHistory = nil
	s.BlockTime = 1001
	if err := apply(&s, first); err == nil {
		t.Fatal("expired resource assessment accepted with valid profiles")
	}
}
