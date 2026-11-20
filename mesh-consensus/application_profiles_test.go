package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	dbm "github.com/cometbft/cometbft-db"
	abci "github.com/cometbft/cometbft/abci/types"
	"os"
	"strings"
	"testing"
)

func TestApplicationProfilePythonBrowserFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/application-profile-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		PublicKey string                   `json:"public_key"`
		Record    ApplicationProfileRecord `json:"record"`
		Digest    string                   `json:"digest"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	b := fixture.Record.Body
	s := State{Network: b.Network, GenesisPin: b.Genesis, Accounts: map[string]Head{b.Owner: {Record: Record{Body: Body{PublicKey: fixture.PublicKey}}}}}
	_, hash, err := decodeApplicationProfile(s, canonical(fixture.Record))
	if err != nil || hash != fixture.Digest {
		t.Fatal("cross-language profile rejected", hash, err)
	}
}

func profileFixture(t *testing.T) (State, ed25519.PrivateKey, string) {
	t.Helper()
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	s := State{Network: "lab", GenesisPin: strings.Repeat("a", 64), Accounts: map[string]Head{}}
	tx := signed(t, key, 1, zero)
	if err := apply(&s, tx); err != nil {
		t.Fatal(err)
	}
	r, _, _ := decodeRecord(tx, "lab")
	return s, key, r.Body.UserID
}

func TestApplicationProfileCheckTxIsolationAndRestart(t *testing.T) {
	s, key, owner := profileFixture(t)
	db := dbm.NewMemDB()
	defer db.Close()
	if err := db.SetSync([]byte("state"), canonical(s)); err != nil {
		t.Fatal(err)
	}
	// Construct directly: the fixture supplies a fixed nonempty pin, whereas
	// NewApplication also requires its matching locally pinned genesis bytes.
	a := &Application{db: db, state: s}
	ctx := context.Background()
	first := profileTx(s, key, owner, "alice", 1, zero)
	checked, _ := a.CheckTx(ctx, &abci.RequestCheckTx{Tx: first})
	if checked.Code != 0 || len(a.state.ApplicationProfiles) != 0 {
		t.Fatal("CheckTx mutated committed profiles", checked)
	}
	result, err := a.FinalizeBlock(ctx, &abci.RequestFinalizeBlock{Height: 1, Txs: [][]byte{first}})
	if err != nil || result.TxResults[0].Code != 0 || len(a.state.ApplicationProfiles) != 0 {
		t.Fatal("uncommitted profile exposed", err)
	}
	if _, err := a.Commit(ctx, &abci.RequestCommit{}); err != nil {
		t.Fatal(err)
	}
	saved, err := db.Get([]byte("state"))
	if err != nil {
		t.Fatal(err)
	}
	var restored State
	if err := json.Unmarshal(saved, &restored); err != nil {
		t.Fatal(err)
	}
	if err := verifyApplicationProfiles(restored); err != nil {
		t.Fatal(err)
	}
	before := string(canonical(a.state))
	second := profileTx(a.state, key, owner, "alice_new", 2, a.state.ApplicationProfiles[owner][0].Digest)
	checked, _ = a.CheckTx(ctx, &abci.RequestCheckTx{Tx: second})
	if checked.Code != 0 || string(canonical(a.state)) != before {
		t.Fatal("CheckTx changed existing profile history", checked)
	}
	copied := clone(a.state)
	copied.ApplicationProfiles[owner][0].Digest = zero
	if a.state.ApplicationProfiles[owner][0].Digest == zero {
		t.Fatal("history aliases clone")
	}
}
func profileTx(s State, key ed25519.PrivateKey, owner, handle string, version int64, previous string) []byte {
	b := ApplicationProfileBody{"sfera-mesh-application-profile-v1", s.Network, s.GenesisPin, owner, int64(len(s.AccountControls[owner])), version, previous, handle, hex.EncodeToString([]byte("Алиса"))}
	return canonical(ApplicationProfileRecord{b, hex.EncodeToString(ed25519.Sign(key, canonical(b)))})
}
func TestApplicationProfileOwnershipAndNames(t *testing.T) {
	s, key, owner := profileFixture(t)
	tx := profileTx(s, key, owner, "alice", 1, zero)
	if err := apply(&s, tx); err != nil {
		t.Fatal(err)
	}
	before := string(canonical(s))
	if err := apply(&s, tx); err != nil || string(canonical(s)) != before {
		t.Fatal("retry changed state", err)
	}
	_, attacker, _ := ed25519.GenerateKey(rand.Reader)
	if err := apply(&s, profileTx(s, attacker, owner, "stolen", 2, s.ApplicationProfiles[owner][0].Digest)); err == nil {
		t.Fatal("forged owner accepted")
	}
	otherTx := signed(t, attacker, 1, zero)
	if err := apply(&s, otherTx); err != nil {
		t.Fatal(err)
	}
	other, _, _ := decodeRecord(otherTx, "lab")
	if err := apply(&s, profileTx(s, attacker, other.Body.UserID, "alice", 1, zero)); err == nil {
		t.Fatal("duplicate handle accepted")
	}
	head := s.ApplicationProfiles[owner][0]
	if err := apply(&s, profileTx(s, key, owner, "alice_new", 2, head.Digest)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, profileTx(s, attacker, other.Body.UserID, "alice", 1, zero)); err == nil {
		t.Fatal("old handle impersonation accepted")
	}
	if err := verifyApplicationProfiles(s); err != nil {
		t.Fatal(err)
	}
}
func TestApplicationProfileCanonicalAndHistory(t *testing.T) {
	s, key, owner := profileFixture(t)
	tx := profileTx(s, key, owner, "alice", 1, zero)
	if err := apply(&s, append(tx, ' ')); err == nil {
		t.Fatal("noncanonical accepted")
	}
	for _, handle := range []string{"Alice", "a", "a b", "аlice"} {
		if err := apply(&s, profileTx(s, key, owner, handle, 1, zero)); err == nil {
			t.Fatal("invalid handle", handle)
		}
	}
	if err := apply(&s, tx); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, profileTx(s, key, owner, "alice", 3, s.ApplicationProfiles[owner][0].Digest)); err == nil {
		t.Fatal("skipped revision")
	}
	if err := apply(&s, profileTx(s, key, owner, "alice", 2, zero)); err == nil {
		t.Fatal("fork accepted")
	}
	raw := canonical(s)
	var recovered State
	if err := json.Unmarshal(raw, &recovered); err != nil {
		t.Fatal(err)
	}
	if err := verifyApplicationProfiles(recovered); err != nil {
		t.Fatal("durable history rejected", err)
	}
	recovered.ApplicationProfiles[owner][0].Digest = zero
	if err := verifyApplicationProfiles(recovered); err == nil {
		t.Fatal("corrupt snapshot accepted")
	}
}
