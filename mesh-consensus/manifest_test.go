package main

import (
	"crypto/ed25519"
	"encoding/hex"
	dbm "github.com/cometbft/cometbft-db"
	"sort"
	"testing"
)

func manifestFixture(s State, cluster string, keys []ed25519.PrivateKey, values []string) ManifestRecord {
	head := s.Placements[cluster]
	version, previous := int64(1), zero
	if prior, ok := s.Manifests[cluster]; ok {
		version, previous = prior.Record.Body.Version+1, prior.Digest
	}
	values = append([]string{}, values...)
	sort.Strings(values)
	b := ManifestBody{"sfera-mesh-manifest-v1", s.Network, cluster, head.Record.Body.Epoch, head.Digest, version, previous, values, nil}
	r := ManifestRecord{Body: b, Consents: []Consent{}}
	for _, key := range keys {
		r.Consents = append(r.Consents, Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(b)))})
	}
	sort.Slice(r.Consents, func(i, j int) bool { return r.Consents[i].PublicKey < r.Consents[j].PublicKey })
	return r
}

func manifestState(t *testing.T) (State, []ed25519.PrivateKey, string) {
	t.Helper()
	keys := placementKeys(t, 4)
	s := State{Network: "lab", Issuers: testIssuers(), BlockTime: 1000}
	tx := signedPlacement(keys[:3], 1, zero, "")
	p, _, err := decodePlacement(tx, s.Network)
	if err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, tx); err != nil {
		t.Fatal(err)
	}
	return s, keys, p.Body.Cluster
}

func sizedManifestFixture(s State, cluster string, keys []ed25519.PrivateKey, values []string, sizes []int64) ManifestRecord {
	r := manifestFixture(s, cluster, keys, values)
	r.Body.Domain = "sfera-mesh-manifest-v2"
	r.Body.Sizes = &sizes
	for i, key := range keys {
		r.Consents[i] = Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(r.Body)))}
	}
	sort.Slice(r.Consents, func(i, j int) bool { return r.Consents[i].PublicKey < r.Consents[j].PublicKey })
	return r
}

func TestSizedManifestUpgradeRejectsResizeAndDowngrade(t *testing.T) {
	s, keys, cluster := manifestState(t)
	values := []string{zero}
	if err := apply(&s, canonical(manifestFixture(s, cluster, keys[:2], values))); err != nil {
		t.Fatal(err)
	}
	upgrade := sizedManifestFixture(s, cluster, keys[:2], values, []int64{4})
	if err := apply(&s, canonical(upgrade)); err != nil {
		t.Fatal(err)
	}
	before := hex.EncodeToString(digest(s))
	bad := []ManifestRecord{manifestFixture(s, cluster, keys[:2], values), sizedManifestFixture(s, cluster, keys[:2], values, []int64{5}), sizedManifestFixture(s, cluster, keys[:2], values, []int64{0}), sizedManifestFixture(s, cluster, keys[:2], values, []int64{262145}), sizedManifestFixture(s, cluster, keys[:2], values, []int64{})}
	for _, r := range bad {
		if err := apply(&s, canonical(r)); err == nil {
			t.Fatal("bad size transition accepted")
		}
		if hex.EncodeToString(digest(s)) != before {
			t.Fatal("rejection mutated state")
		}
	}
	next := sizedManifestFixture(s, cluster, keys[:2], []string{zero, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, []int64{4, 8})
	if err := apply(&s, canonical(next)); err != nil {
		t.Fatal(err)
	}
	if err := verifyManifestRegistry(s); err != nil {
		t.Fatal(err)
	}
}

func TestManifestRequiresStorageMajorityAndAppendOnlyVersions(t *testing.T) {
	s, keys, cluster := manifestState(t)
	value := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	first := manifestFixture(s, cluster, keys[:2], []string{value})
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal("retry failed", err)
	}
	before := hex.EncodeToString(digest(s))
	for _, bad := range []ManifestRecord{
		manifestFixture(s, cluster, keys[:1], []string{value}),
		manifestFixture(s, cluster, keys[2:], []string{value}),
		manifestFixture(s, cluster, []ed25519.PrivateKey{keys[0], keys[0]}, []string{value}),
		manifestFixture(s, cluster, keys[:2], []string{}),
		manifestFixture(s, cluster, keys[:2], []string{value, value}),
	} {
		if err := apply(&s, canonical(bad)); err == nil {
			t.Fatal("invalid manifest accepted")
		}
		if hex.EncodeToString(digest(s)) != before {
			t.Fatal("rejection mutated state")
		}
	}
	second := manifestFixture(s, cluster, keys[:2], []string{value, zero})
	copyState := clone(s)
	if err := apply(&copyState, canonical(second)); err != nil {
		t.Fatal(err)
	}
	if s.Manifests[cluster].Record.Body.Version != 1 {
		t.Fatal("pending manifest leaked")
	}
	if err := verifyManifestRegistry(copyState); err != nil {
		t.Fatal(err)
	}
}

func TestManifestWriterIsFencedByPlacementButHistoryRemainsVerifiable(t *testing.T) {
	s, keys, cluster := manifestState(t)
	first := manifestFixture(s, cluster, keys[:2], []string{zero})
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal(err)
	}
	stale := manifestFixture(s, cluster, keys[:2], []string{zero})
	old := s.Placements[cluster]
	if err := apply(&s, signedPlacement([]ed25519.PrivateKey{keys[0], keys[1], keys[3]}, 2, old.Digest, cluster)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(stale)); err == nil {
		t.Fatal("old epoch writer accepted")
	}
	if err := verifyManifestRegistry(s); err != nil {
		t.Fatal("old certified index lost", err)
	}
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal("historical retry rejected", err)
	}
	current := manifestFixture(s, cluster, keys[:2], []string{zero})
	if err := apply(&s, canonical(current)); err != nil {
		t.Fatal(err)
	}
	if err := verifyManifestRegistry(s); err != nil {
		t.Fatal(err)
	}
}

func TestManifestSurvivesRestartAndCorruptHeadIsRejected(t *testing.T) {
	s, keys, cluster := manifestState(t)
	s.Accounts = map[string]Head{}
	if err := apply(&s, canonical(manifestFixture(s, cluster, keys[:2], []string{zero}))); err != nil {
		t.Fatal(err)
	}
	db := dbm.NewMemDB()
	defer db.Close()
	if err := db.SetSync([]byte("state"), canonical(s)); err != nil {
		t.Fatal(err)
	}
	a, err := NewApplicationWithIssuers(db, "lab", s.Issuers)
	if err != nil || a.state.Manifests[cluster].Digest != s.Manifests[cluster].Digest {
		t.Fatal("manifest lost on restart", err)
	}
	head := s.Manifests[cluster]
	head.Digest = zero
	s.Manifests[cluster] = head
	if err := db.SetSync([]byte("state"), canonical(s)); err != nil {
		t.Fatal(err)
	}
	if _, err := NewApplicationWithIssuers(db, "lab", s.Issuers); err == nil {
		t.Fatal("corrupt manifest accepted on restart")
	}
}
