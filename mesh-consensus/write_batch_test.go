package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"sort"
	"testing"

	dbm "github.com/cometbft/cometbft-db"
)

func writeBatchFixture(s State, cluster string, keys []ed25519.PrivateKey, count int) WriteBatch {
	records := []WriteRecord{}
	for i := 0; i < count; i++ {
		value := fmt.Sprintf("%064x", 10000+i)
		b := signedWrite(s, cluster, keys[:3], value, value, 1).Body
		b.Domain = "sfera-mesh-write-v2"
		b.RequestID = writeID(b)
		records = append(records, resignWrite(b, keys[:3]))
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Body.RequestID < records[j].Body.RequestID })
	return WriteBatch{WriteBatchBody{"sfera-mesh-write-batch-v2", s.Network, records}}
}

func TestWriteBatch128AtomicRestartAndReplay(t *testing.T) {
	s, keys, cluster := manifestState(t)
	batch := writeBatchFixture(s, cluster, keys, 128)
	if len(canonical(batch)) <= 65536 {
		t.Fatal("large transaction boundary not exercised")
	}
	if err := apply(&s, canonical(batch)); err != nil {
		t.Fatal(err)
	}
	if len(s.WriteQueue) != 128 {
		t.Fatal("batch incomplete")
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
	if err := apply(&s, canonical(batch)); err != nil || before != hex.EncodeToString(digest(s)) {
		t.Fatal("batch replay changed state", err)
	}
	values := []string{}
	for _, r := range batch.Body.Writes {
		values = append(values, r.Body.Digest)
	}
	capacityManifest(t, &s, cluster, keys, values)
	if len(s.WriteQueue) != 0 {
		t.Fatal("completed batch retained")
	}
	before = hex.EncodeToString(digest(s))
	if err := apply(&s, canonical(batch)); err != nil || before != hex.EncodeToString(digest(s)) {
		t.Fatal("completed replay changed state", err)
	}
}

func TestWriteBatchLateFailureNeverReservesPrefix(t *testing.T) {
	for _, scenario := range []string{"signature", "slots", "queue", "duplicate", "legacy"} {
		t.Run(scenario, func(t *testing.T) {
			s, keys, cluster := manifestState(t)
			batch := writeBatchFixture(s, cluster, keys, 2)
			switch scenario {
			case "signature":
				batch.Body.Writes[1].Consents[2].Signature = zero + zero
			case "slots":
				values := []string{}
				for i := 1; i <= 511; i++ {
					values = append(values, fmt.Sprintf("%064x", i))
				}
				capacityManifest(t, &s, cluster, keys, values)
			case "queue":
				full := writeBatchFixture(s, cluster, keys, 128)
				full.Body.Writes = full.Body.Writes[:127]
				if err := apply(&s, canonical(full)); err != nil {
					t.Fatal(err)
				}
				// Distinct IDs that do not already exist in the 127-entry queue.
				for i := range batch.Body.Writes {
					b := batch.Body.Writes[i].Body
					b.BlockToken = fmt.Sprintf("%064x", 20000+i)
					b.RequestID = writeID(b)
					batch.Body.Writes[i] = resignWrite(b, keys[:3])
				}
				sort.Slice(batch.Body.Writes, func(i, j int) bool { return batch.Body.Writes[i].Body.RequestID < batch.Body.Writes[j].Body.RequestID })
			case "duplicate":
				batch.Body.Writes[1] = batch.Body.Writes[0]
			case "legacy":
				b := batch.Body.Writes[1].Body
				b.Domain = "sfera-mesh-write-v1"
				b.RequestID = writeID(b)
				batch.Body.Writes[1] = resignWrite(b, keys[:3])
			}
			before := hex.EncodeToString(digest(s))
			if err := apply(&s, canonical(batch)); err == nil {
				t.Fatal("invalid batch accepted")
			}
			if before != hex.EncodeToString(digest(s)) {
				t.Fatal("failed batch reserved prefix")
			}
		})
	}
}

func TestWriteBatchClusterConflictIsAtomic(t *testing.T) {
	s, keys, cluster := manifestState(t)
	otherKeys := []ed25519.PrivateKey{keys[0], keys[1], keys[3]}
	tx := signedPlacement(otherKeys, 1, zero, "")
	p, _, err := decodePlacement(tx, s.Network)
	if err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, tx); err != nil {
		t.Fatal(err)
	}
	other := p.Body.Cluster
	values := []string{}
	for i := 1; i <= 512; i++ {
		values = append(values, fmt.Sprintf("%064x", i))
	}
	capacityManifest(t, &s, other, otherKeys, values)
	batch := writeBatchFixture(s, cluster, keys, 1)
	second := writeBatchFixture(s, other, otherKeys, 1)
	batch.Body.Writes = append(batch.Body.Writes, second.Body.Writes...)
	sort.Slice(batch.Body.Writes, func(i, j int) bool { return batch.Body.Writes[i].Body.RequestID < batch.Body.Writes[j].Body.RequestID })
	before := hex.EncodeToString(digest(s))
	if err := apply(&s, canonical(batch)); err == nil {
		t.Fatal("cross-cluster overflow accepted")
	}
	if before != hex.EncodeToString(digest(s)) {
		t.Fatal("cross-cluster partial reservation")
	}
}
