package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"sort"
	"testing"
)

func transferFixture(s State, cluster string, keys []ed25519.PrivateKey) TransferRecord {
	old, exists := s.Transfers[cluster]
	version, previous := int64(1), zero
	if exists {
		version, previous = old.Record.Body.Version+1, old.Digest
	}
	p := s.Placements[cluster]
	b := TransferBody{"sfera-mesh-transfer-v1", s.Network, cluster, p.Record.Body.Epoch, p.Digest, s.Manifests[cluster].Digest, version, previous, s.BlockTime, s.BlockTime + 30}
	return signTransfer(b, keys)
}
func signTransfer(b TransferBody, keys []ed25519.PrivateKey) TransferRecord {
	r := TransferRecord{Body: b, Consents: []Consent{}}
	for _, key := range keys {
		r.Consents = append(r.Consents, Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(b)))})
	}
	sort.Slice(r.Consents, func(i, j int) bool { return r.Consents[i].PublicKey < r.Consents[j].PublicKey })
	return r
}
func TestTransferConsensusRequiresThreeFreshCurrentHolders(t *testing.T) {
	s, keys, cluster := manifestState(t)
	if err := apply(&s, canonical(sizedManifestFixture(s, cluster, keys[:2], []string{zero}, []int64{4}))); err != nil {
		t.Fatal(err)
	}
	valid := transferFixture(s, cluster, keys[:3])
	bad := valid.Body
	bad.ManifestHash = zero
	expired := valid.Body
	expired.IssuedAt = 970
	expired.ExpiresAt = 1000
	for _, record := range []TransferRecord{signTransfer(valid.Body, keys[:2]), signTransfer(valid.Body, []ed25519.PrivateKey{keys[0], keys[1], keys[3]}), signTransfer(bad, keys[:3]), signTransfer(expired, keys[:3])} {
		before := hex.EncodeToString(digest(s))
		if err := apply(&s, canonical(record)); err == nil {
			t.Fatal("invalid transfer accepted")
		}
		if before != hex.EncodeToString(digest(s)) {
			t.Fatal("rejection mutated state")
		}
	}
	pending := clone(s)
	if err := apply(&pending, canonical(valid)); err != nil {
		t.Fatal(err)
	}
	if len(s.Transfers) != 0 {
		t.Fatal("pending transfer leaked")
	}
	s = pending
	s.BlockTime = 1100
	if err := verifyTransfers(s); err != nil {
		t.Fatal("historical transfer expiry invalidated snapshot", err)
	}
	if err := apply(&s, canonical(valid)); err != nil {
		t.Fatal("historical retry", err)
	}
	next := transferFixture(s, cluster, keys[:3])
	if err := apply(&s, canonical(next)); err != nil {
		t.Fatal("renewal", err)
	}
	if s.Transfers[cluster].Record.Body.Version != 2 {
		t.Fatal("missing monotonic renewal")
	}
	old := s.Placements[cluster]
	stale := transferFixture(s, cluster, keys[:3])
	if err := apply(&s, signedPlacement([]ed25519.PrivateKey{keys[0], keys[1], keys[3]}, 2, old.Digest, cluster)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(stale)); err == nil {
		t.Fatal("stale placement acknowledged transfer")
	}
	if err := verifyTransfers(s); err != nil {
		t.Fatal("historical placement transfer lost", err)
	}
}
