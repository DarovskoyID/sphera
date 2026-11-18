package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	dbm "github.com/cometbft/cometbft-db"
	abci "github.com/cometbft/cometbft/abci/types"
	"os"
	"testing"
)

func deviceFixture(t *testing.T) ([]DeviceEvent, string, ed25519.PrivateKey) {
	t.Helper()
	raw, err := os.ReadFile("../scripts/fixtures/mesh-devices.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Events []DeviceEvent `json:"events"`
		Digest string        `json:"digest"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i)
	}
	return fixture.Events, fixture.Digest, ed25519.NewKeyFromSeed(seed)
}
func TestDeviceConsensusCommitRestartAndAtomicBatch(t *testing.T) {
	events, expected, owner := deviceFixture(t)
	db := dbm.NewMemDB()
	defer db.Close()
	a, err := NewApplication(db, "lab")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	txs := [][]byte{signed(t, owner, 1, zero), canonical(events[0])}
	result, err := a.FinalizeBlock(ctx, &abci.RequestFinalizeBlock{Height: 1, Txs: txs})
	if err != nil || result.TxResults[0].Code != 0 || result.TxResults[1].Code != 0 {
		t.Fatal(result, err)
	}
	if len(a.state.Devices) != 0 {
		t.Fatal("uncommitted device exposed")
	}
	if _, err = a.Commit(ctx, &abci.RequestCommit{}); err != nil {
		t.Fatal(err)
	}
	a, err = NewApplication(db, "lab")
	if err != nil {
		t.Fatal(err)
	}
	before := canonical(a.state)
	batch := DeviceBatch{Events: []DeviceEvent{events[1], events[0]}}
	batch.Body.Domain = "sfera-mesh-device-update-lab-v1"
	batch.Body.Network = "lab"
	// Re-enrollment after revocation is forbidden even with fresh owner signatures.
	batch.Events[1].Body.Version = 3
	batch.Events[1].Body.Previous = expected
	batch.Events[1].OwnerSignature = "00"
	if err = apply(&a.state, canonical(batch)); err == nil || !bytes.Equal(before, canonical(a.state)) {
		t.Fatal("partial device batch accepted")
	}
	if _, err = a.FinalizeBlock(ctx, &abci.RequestFinalizeBlock{Height: 2, Txs: [][]byte{canonical(events[1])}}); err != nil {
		t.Fatal(err)
	}
	if _, err = a.Commit(ctx, &abci.RequestCommit{}); err != nil {
		t.Fatal(err)
	}
	a, err = NewApplication(db, "lab")
	if err != nil {
		t.Fatal(err)
	}
	user := events[0].Body.UserID
	if a.state.Devices[user][1].Digest != expected {
		t.Fatal("cross language device hash mismatch")
	}
	if err = apply(&a.state, canonical(events[0])); err != nil || len(a.state.Devices[user]) != 2 {
		t.Fatal("old enrollment retry resurrected device", err)
	}
	corrupted := clone(a.state)
	corrupted.Devices[user] = append(corrupted.Devices[user], corrupted.Devices[user][1])
	if verifyDevices(corrupted) == nil {
		t.Fatal("duplicate historical version accepted")
	}
	if err = verifyDevices(a.state); err != nil {
		t.Fatal(err)
	}
}

func TestDeviceCannotAuthorizeWithoutAccountOrPossession(t *testing.T) {
	events, _, owner := deviceFixture(t)
	s := State{Network: "lab", Accounts: map[string]Head{}}
	if apply(&s, canonical(events[0])) == nil {
		t.Fatal("unknown owner accepted")
	}
	if err := apply(&s, signed(t, owner, 1, zero)); err != nil {
		t.Fatal(err)
	}
	forged := events[0]
	forged.DeviceSignature = ""
	if apply(&s, canonical(forged)) == nil {
		t.Fatal("missing device possession accepted")
	}
	if len(s.Devices) != 0 {
		t.Fatal("invalid event mutated state")
	}
}

func TestDeviceCapacityReservesAllTerminalRevocations(t *testing.T) {
	s := State{Network: "lab", Accounts: map[string]Head{}}
	keys := make([]ed25519.PrivateKey, 4)
	users := make([]string, 4)
	deviceKeys := make([][]ed25519.PrivateKey, 4)
	makeEvent := func(user int, device int, operation string) DeviceEvent {
		key := deviceKeys[user][device]
		public := key.Public().(ed25519.PublicKey)
		id := sha256.Sum256(append([]byte("sfera-mesh-device-v1\x00"), public...))
		history := s.Devices[users[user]]
		previous := zero
		if len(history) > 0 {
			previous = history[len(history)-1].Digest
		}
		body := DeviceBody{"sfera-mesh-device-event-lab-v1", "lab", users[user], int64(len(history) + 1), previous, operation, hex.EncodeToString(id[:]), hex.EncodeToString(public)}
		event := DeviceEvent{Body: body, OwnerSignature: hex.EncodeToString(ed25519.Sign(keys[user], canonical(body)))}
		if operation == "enroll" {
			event.DeviceSignature = hex.EncodeToString(ed25519.Sign(key, canonical(body)))
		}
		return event
	}
	for user := 0; user < 4; user++ {
		seed := sha256.Sum256([]byte{255, byte(user)})
		keys[user] = ed25519.NewKeyFromSeed(seed[:])
		account, _, err := decodeRecord(signed(t, keys[user], 1, zero), "lab")
		if err != nil {
			t.Fatal(err)
		}
		users[user] = account.Body.UserID
		if err = apply(&s, signed(t, keys[user], 1, zero)); err != nil {
			t.Fatal(err)
		}
		for device := 0; device < 64; device++ {
			seed := sha256.Sum256([]byte{byte(user), byte(device)})
			deviceKeys[user] = append(deviceKeys[user], ed25519.NewKeyFromSeed(seed[:]))
			if err = apply(&s, canonical(makeEvent(user, device, "enroll"))); err != nil {
				t.Fatal(err)
			}
		}
	}
	// All 256 active devices retain space to revoke, even with no enroll capacity left.
	for user := 0; user < 4; user++ {
		for device := 0; device < 64; device++ {
			if err := apply(&s, canonical(makeEvent(user, device, "revoke"))); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := verifyDevices(s); err != nil {
		t.Fatal(err)
	}
}
