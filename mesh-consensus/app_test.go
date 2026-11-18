package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	dbm "github.com/cometbft/cometbft-db"
	abci "github.com/cometbft/cometbft/abci/types"
)

func signed(t *testing.T, key ed25519.PrivateKey, version int64, previous string) []byte {
	t.Helper()
	pub := key.Public().(ed25519.PublicKey)
	id := sha256.Sum256(append([]byte("sfera-mesh-user-v1\x00"), pub...))
	b := Body{"sfera-mesh-account-v1", "lab", hex.EncodeToString(id[:]), hex.EncodeToString(pub), version, previous, zero, zero}
	return canonical(Record{b, hex.EncodeToString(ed25519.Sign(key, canonical(b)))})
}
func TestCommitIsolationAndRecovery(t *testing.T) {
	ctx := context.Background()
	db := dbm.NewMemDB()
	defer db.Close()
	a, e := NewApplication(db, "lab")
	if e != nil {
		t.Fatal(e)
	}
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	tx := signed(t, key, 1, zero)
	r, hash, e := decodeRecord(tx, "lab")
	if e != nil {
		t.Fatal(e)
	}
	req := &abci.RequestQuery{Path: "/account", Data: []byte(r.Body.UserID)}
	result, e := a.FinalizeBlock(ctx, &abci.RequestFinalizeBlock{Height: 1, Txs: [][]byte{tx}})
	if e != nil || result.TxResults[0].Code != 0 {
		t.Fatal(result, e)
	}
	before, _ := a.Query(ctx, req)
	if before.Code == 0 {
		t.Fatal("uncommitted data exposed")
	}
	fresh, _ := NewApplication(db, "lab")
	info, _ := fresh.Info(ctx, &abci.RequestInfo{})
	if info.LastBlockHeight != 0 {
		t.Fatal("finalize persisted state")
	}
	if _, e = a.Commit(ctx, &abci.RequestCommit{}); e != nil {
		t.Fatal(e)
	}
	fresh, e = NewApplication(db, "lab")
	if e != nil {
		t.Fatal(e)
	}
	info, _ = fresh.Info(ctx, &abci.RequestInfo{})
	if info.LastBlockHeight != 1 || !bytes.Equal(info.LastBlockAppHash, result.AppHash) {
		t.Fatal("recovery mismatch")
	}
	if _, e = NewApplication(db, "other"); e == nil {
		t.Fatal("network silently changed")
	}
	if c, _ := fresh.CheckTx(ctx, &abci.RequestCheckTx{Tx: tx}); c.Code != 0 {
		t.Fatal("idempotent record rejected")
	}
	if c, _ := fresh.CheckTx(ctx, &abci.RequestCheckTx{Tx: signed(t, key, 3, hash)}); c.Code == 0 {
		t.Fatal("version gap accepted")
	}
	second := signed(t, key, 2, hash)
	result, e = fresh.FinalizeBlock(ctx, &abci.RequestFinalizeBlock{Height: 2, Txs: [][]byte{second, signed(t, key, 2, zero)}})
	if e != nil || result.TxResults[0].Code != 0 || result.TxResults[1].Code == 0 {
		t.Fatal("sequential execution/fork validation", e)
	}
	if _, e = fresh.FinalizeBlock(ctx, &abci.RequestFinalizeBlock{Height: 8}); e == nil {
		t.Fatal("height gap accepted")
	}
}
func TestStrictRecords(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	tx := signed(t, key, 1, zero)
	for _, bad := range [][]byte{append(tx, []byte(" {}")...), bytes.Replace(tx, []byte(`"version":1`), []byte(`"version":1,"version":1`), 1), bytes.Replace(tx, []byte(`"version":1`), []byte(`"version":true`), 1), bytes.Replace(tx, []byte(`"network":"lab"`), []byte(`"network":"else"`), 1), bytes.Replace(tx, []byte(`"vault_digest":"0`), []byte(`"vault_digest":"a`), 1)} {
		if _, _, e := decodeRecord(bad, "lab"); e == nil {
			t.Fatal("malformed/forged record accepted")
		}
	}
}
