package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	dbm "github.com/cometbft/cometbft-db"
	"sort"
	"strings"
	"testing"
)

func signedWrite(s State, cluster string, keys []ed25519.PrivateKey, token, value string, size int64) WriteRecord {
	p := s.Placements[cluster]
	b := WriteBody{Domain: "sfera-mesh-write-v1", Network: s.Network, Cluster: cluster, Epoch: p.Record.Body.Epoch, PlacementHash: p.Digest, Origin: hex.EncodeToString(hashNode(keys[0].Public().(ed25519.PublicKey))), BlockToken: token, Digest: value, Size: size}
	b.RequestID = writeID(b)
	return resignWrite(b, keys)
}
func resignWrite(b WriteBody, keys []ed25519.PrivateKey) WriteRecord {
	r := WriteRecord{Body: b, Consents: []Consent{}}
	for _, key := range keys {
		r.Consents = append(r.Consents, Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(b)))})
	}
	sort.Slice(r.Consents, func(i, j int) bool { return r.Consents[i].PublicKey < r.Consents[j].PublicKey })
	return r
}

func TestWriteQueueImmutableRetryAndManifestSize(t *testing.T) {
	s, keys, cluster := manifestState(t)
	r := signedWrite(s, cluster, keys[:3], zero, zero, 4)
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	before := hex.EncodeToString(digest(s))
	if err := apply(&s, canonical(r)); err != nil || before != hex.EncodeToString(digest(s)) {
		t.Fatal("retry mutated queue", err)
	}
	b := r.Body
	b.Size = 5
	if err := apply(&s, canonical(resignWrite(b, keys[:3]))); err == nil {
		t.Fatal("write overwrite accepted")
	}
	if err := apply(&s, canonical(sizedManifestFixture(s, cluster, keys[:2], []string{zero}, []int64{5}))); err == nil {
		t.Fatal("queue size bypassed by manifest")
	}
	if err := apply(&s, canonical(sizedManifestFixture(s, cluster, keys[:2], []string{zero}, []int64{4}))); err != nil {
		t.Fatal(err)
	}
	if len(s.WriteQueue) != 1 {
		t.Fatal("legacy completion lost immutable request")
	}
	if err := verifyWriteQueue(s); err != nil {
		t.Fatal(err)
	}
}

func TestWriteQueueRequiresAllCurrentHoldersAndCanonicalRequest(t *testing.T) {
	s, keys, cluster := manifestState(t)
	valid := signedWrite(s, cluster, keys[:3], zero, zero, 4)
	wrong := valid.Body
	wrong.RequestID = zero
	for _, r := range []WriteRecord{resignWrite(valid.Body, keys[:2]), resignWrite(valid.Body, []ed25519.PrivateKey{keys[0], keys[1], keys[3]}), resignWrite(wrong, keys[:3])} {
		before := hex.EncodeToString(digest(s))
		if err := apply(&s, canonical(r)); err == nil {
			t.Fatal("invalid queue admission")
		}
		if before != hex.EncodeToString(digest(s)) {
			t.Fatal("rejection mutated state")
		}
	}
	if err := apply(&s, append(canonical(valid), ' ')); err == nil {
		t.Fatal("noncanonical queue request")
	}
}

func TestWriteQueueHistoryRestartAndCloneIsolation(t *testing.T) {
	s, keys, cluster := manifestState(t)
	s.Accounts = map[string]Head{}
	r := signedWrite(s, cluster, keys[:3], zero, zero, 4)
	pending := clone(s)
	if err := apply(&pending, canonical(r)); err != nil {
		t.Fatal(err)
	}
	if len(s.WriteQueue) != 0 {
		t.Fatal("pending work leaked")
	}
	s = pending
	old := s.Placements[cluster]
	if err := apply(&s, signedPlacement([]ed25519.PrivateKey{keys[0], keys[1], keys[3]}, 2, old.Digest, cluster)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal("historical exact retry", err)
	}
	b := r.Body
	b.BlockToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	b.RequestID = writeID(b)
	if err := apply(&s, canonical(resignWrite(b, keys[:3]))); err == nil {
		t.Fatal("old holder epoch queued new work")
	}
	db := dbm.NewMemDB()
	defer db.Close()
	if err := db.SetSync([]byte("state"), canonical(s)); err != nil {
		t.Fatal(err)
	}
	a, err := NewApplicationWithIssuers(db, "lab", s.Issuers)
	if err != nil || len(a.state.WriteQueue) != 1 {
		t.Fatal("queue restart", err)
	}
	h := s.WriteQueue[r.Body.RequestID]
	h.Digest = zero
	s.WriteQueue[r.Body.RequestID] = h
	if err := db.SetSync([]byte("state"), canonical(s)); err != nil {
		t.Fatal(err)
	}
	if _, err := NewApplicationWithIssuers(db, "lab", s.Issuers); err == nil {
		t.Fatal("corrupt queue reopened")
	}
}

func TestContentBoundQueueReleasesCompletedSlots(t *testing.T) {
	s, keys, cluster := manifestState(t)
	values := []string{}
	sizes := []int64{}
	var first WriteRecord
	for i := 0; i < 160; i++ {
		value := fmt.Sprintf("%064x", i+1)
		b := signedWrite(s, cluster, keys[:3], value, value, 4).Body
		b.Domain = "sfera-mesh-write-v2"
		b.RequestID = writeID(b)
		r := resignWrite(b, keys[:3])
		if i == 0 {
			first = r
		}
		if err := apply(&s, canonical(r)); err != nil {
			t.Fatal(i, err)
		}
		values = append(values, value)
		sizes = append(sizes, 4)
		if err := apply(&s, canonical(sizedManifestFixture(s, cluster, keys[:2], values, sizes))); err != nil {
			t.Fatal(i, err)
		}
		if len(s.WriteQueue) != 0 {
			t.Fatal("completed v2 request retained")
		}
	}
	s.Accounts = map[string]Head{}
	db := dbm.NewMemDB()
	defer db.Close()
	if err := db.SetSync([]byte("state"), canonical(s)); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewApplicationWithIssuers(db, "lab", s.Issuers)
	if err != nil {
		t.Fatal(err)
	}
	s = reopened.state
	before := hex.EncodeToString(digest(s))
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal(err)
	}
	if before != hex.EncodeToString(digest(s)) {
		t.Fatal("completed retry mutated state")
	}
	b := first.Body
	b.Size = 5
	if err := apply(&s, canonical(resignWrite(b, keys[:3]))); err == nil {
		t.Fatal("content identity not enforced")
	}
	old := s.Placements[cluster]
	if err := apply(&s, signedPlacement([]ed25519.PrivateKey{keys[0], keys[1], keys[3]}, 2, old.Digest, cluster)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal("historical completed retry", err)
	}
	b = first.Body
	b.Digest = fmt.Sprintf("%064x", 999)
	b.RequestID = writeID(b)
	if err := apply(&s, canonical(resignWrite(b, keys[:3]))); err == nil {
		t.Fatal("historical holders admitted fresh work")
	}
	if err := verifyWriteQueue(s); err != nil {
		t.Fatal(err)
	}
}

func TestContentBoundWriteIDGolden(t *testing.T) {
	b := WriteBody{Domain: "sfera-mesh-write-v2", Network: "lab", Cluster: strings.Repeat("a", 64), Origin: strings.Repeat("b", 64), BlockToken: strings.Repeat("c", 64), Digest: strings.Repeat("d", 64), Size: 4}
	if writeID(b) != "8e4098f57e36f4455bf43e5125b768d9f737010f89ead88b917ef1229797b05d" {
		t.Fatal("Python/Go write identity mismatch")
	}
}

func TestContentBoundPendingQueueStillBounded(t *testing.T) {
	s, keys, cluster := manifestState(t)
	for i := 0; i < 129; i++ {
		value := fmt.Sprintf("%064x", i+1)
		b := signedWrite(s, cluster, keys[:3], value, value, 4).Body
		b.Domain = "sfera-mesh-write-v2"
		b.RequestID = writeID(b)
		before := hex.EncodeToString(digest(s))
		err := apply(&s, canonical(resignWrite(b, keys[:3])))
		if i < 128 && err != nil {
			t.Fatal(i, err)
		}
		if i == 128 && (err == nil || before != hex.EncodeToString(digest(s))) {
			t.Fatal("pending queue overflow mutated state")
		}
	}
	if err := verifyWriteQueue(s); err != nil {
		t.Fatal(err)
	}
}
