package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"sort"
	"testing"
)

func TestApplicationDialogPythonFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/application-dialog-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Network  string `json:"network"`
		Genesis  string `json:"genesis"`
		State    State  `json:"state"`
		Identity string `json:"dialog_identity"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	s := fixture.State
	s.Network = fixture.Network
	s.GenesisPin = fixture.Genesis
	if err := verifyApplicationProfiles(s); err != nil {
		t.Fatal(err)
	}
	if err := verifyDevices(s); err != nil {
		t.Fatal(err)
	}
	if err := verifyApplicationDialogs(s); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.ApplicationDialogs[fixture.Identity]; !ok {
		t.Fatal("cross-language dialog identity differs")
	}
}

func TestApplicationDialogDeviceCreationAndRevocation(t *testing.T) {
	raw, err := os.ReadFile("testdata/application-dialog-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Network      string                  `json:"network"`
		Genesis      string                  `json:"genesis"`
		State        State                   `json:"state"`
		Creator      string                  `json:"creator"`
		Device       string                  `json:"device"`
		Identity     string                  `json:"dialog_identity"`
		DeviceRecord ApplicationDialogRecord `json:"device_dialog"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	s := fixture.State
	s.Network = fixture.Network
	s.GenesisPin = fixture.Genesis
	body := s.ApplicationDialogs[fixture.Identity].Record.Body
	s.ApplicationDialogs = nil
	body.Domain = "sfera-mesh-application-dialog-device-v1"
	body.CreatorDevice = fixture.Device
	body.DevicesVersion = 1
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 9
	}
	device := ed25519.NewKeyFromSeed(seed)
	record := ApplicationDialogRecord{body, hex.EncodeToString(ed25519.Sign(device, canonical(body)))}
	if !bytes.Equal(canonical(record), canonical(fixture.DeviceRecord)) {
		t.Fatal("cross-language device proof differs")
	}
	if err := apply(&s, canonical(record)); err != nil {
		t.Fatal("active device could not create DM", err)
	}
	if len(s.ApplicationDialogs) != 1 {
		t.Fatal("DM missing")
	}
	// Revocation blocks new use, but cannot erase an already committed dialogue.
	seed = make([]byte, 32)
	for i := range seed {
		seed[i] = 1
	}
	owner := ed25519.NewKeyFromSeed(seed)
	old := s.Devices[fixture.Creator][0]
	b := old.Event.Body
	b.Version = 2
	b.Previous = old.Digest
	b.Operation = "revoke"
	revoke := DeviceEvent{Body: b, OwnerSignature: hex.EncodeToString(ed25519.Sign(owner, canonical(b)))}
	if err := apply(&s, canonical(revoke)); err != nil {
		t.Fatal(err)
	}
	if err := verifyApplicationDialogs(s); err != nil {
		t.Fatal("revocation erased historical DM authority", err)
	}
	s.ApplicationDialogs = nil
	if err := apply(&s, canonical(record)); err == nil {
		t.Fatal("stale device history created new DM")
	}
	body.DevicesVersion = 2
	record = ApplicationDialogRecord{body, hex.EncodeToString(ed25519.Sign(device, canonical(body)))}
	if err := apply(&s, canonical(record)); err == nil {
		t.Fatal("revoked device created DM")
	}
}

func dialogFixture(t *testing.T) (State, map[string]ed25519.PrivateKey, []string) {
	t.Helper()
	s, key, owner := profileFixture(t)
	keys := map[string]ed25519.PrivateKey{owner: key}
	if err := apply(&s, profileTx(s, key, owner, "alice", 1, zero)); err != nil {
		t.Fatal(err)
	}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	tx := signed(t, other, 1, zero)
	if err := apply(&s, tx); err != nil {
		t.Fatal(err)
	}
	r, _, _ := decodeRecord(tx, "lab")
	keys[r.Body.UserID] = other
	if err := apply(&s, profileTx(s, other, r.Body.UserID, "bob", 1, zero)); err != nil {
		t.Fatal(err)
	}
	members := []string{owner, r.Body.UserID}
	sort.Strings(members)
	return s, keys, members
}
func dialogTx(s State, key ed25519.PrivateKey, creator string, members []string) []byte {
	b := ApplicationDialogBody{Domain: "sfera-mesh-application-dialog-v1", Network: s.Network, Genesis: s.GenesisPin, Creator: creator, ControlEpoch: int64(len(s.AccountControls[creator])), Members: members}
	return canonical(ApplicationDialogRecord{b, hex.EncodeToString(ed25519.Sign(key, canonical(b)))})
}
func TestApplicationDialogStableIdentityAcrossEntries(t *testing.T) {
	s, keys, members := dialogFixture(t)
	first := dialogTx(s, keys[members[0]], members[0], members)
	if err := apply(&s, first); err != nil {
		t.Fatal(err)
	}
	id := applicationDialogID(s.Network, members)
	head := s.ApplicationDialogs[id]
	// Concurrent creation by the other participant converges on the first
	// committed descriptor rather than creating a second conversation.
	if err := apply(&s, dialogTx(s, keys[members[1]], members[1], members)); err != nil {
		t.Fatal(err)
	}
	if len(s.ApplicationDialogs) != 1 || s.ApplicationDialogs[id].Digest != head.Digest {
		t.Fatal("duplicate dialog or changed authority")
	}
	if err := verifyApplicationDialogs(s); err != nil {
		t.Fatal(err)
	}
	copied := clone(s)
	copied.ApplicationDialogs[id].Record.Body.Members[0] = zero
	if s.ApplicationDialogs[id].Record.Body.Members[0] == zero {
		t.Fatal("dialog clone aliases members")
	}
	if err := verifyApplicationDialogs(copied); err == nil {
		t.Fatal("tampered membership accepted")
	}
}
func TestApplicationDialogRejectsOutsiderAndUnregisteredMembers(t *testing.T) {
	s, keys, members := dialogFixture(t)
	_, attacker, _ := ed25519.GenerateKey(rand.Reader)
	for _, tx := range [][]byte{
		dialogTx(s, attacker, members[0], members),
		dialogTx(s, keys[members[0]], zero, members),
		dialogTx(s, keys[members[0]], members[0], []string{members[0], members[0]}),
		dialogTx(s, keys[members[0]], members[0], []string{members[1], members[0]}),
		dialogTx(s, keys[members[0]], members[0], nil),
	} {
		if err := apply(&s, tx); err == nil {
			t.Fatal("invalid dialog accepted")
		}
	}
	delete(s.ApplicationProfiles, members[1])
	if err := apply(&s, dialogTx(s, keys[members[0]], members[0], members)); err == nil {
		t.Fatal("unregistered application participant accepted")
	}
	if len(s.ApplicationDialogs) != 0 {
		t.Fatal("failed request changed state")
	}
}
