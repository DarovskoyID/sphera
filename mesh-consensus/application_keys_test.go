package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func keyJournalFixture(t *testing.T) (State, []ApplicationKeyRecord, []ed25519.PrivateKey, string) {
	t.Helper()
	raw, err := os.ReadFile("testdata/application-dialog-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		State   State  `json:"state"`
		Network string `json:"network"`
		Genesis string `json:"genesis"`
		Dialog  string `json:"dialog_identity"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	s := f.State
	s.Network = f.Network
	s.GenesisPin = f.Genesis
	records := []ApplicationKeyRecord{}
	signers := []ed25519.PrivateKey{}
	for _, owner := range s.ApplicationDialogs[f.Dialog].Record.Body.Members {
		// Existing owner/device control is covered by the public fixture. A second
		// public device record here supplies the other member for journal unit tests.
		if len(s.Devices[owner]) == 0 {
			public, _, _ := ed25519.GenerateKey(rand.Reader)
			hash := sha256.Sum256(append([]byte("sfera-mesh-device-v1\x00"), public...))
			device := hex.EncodeToString(hash[:])
			s.Devices[owner] = []DeviceHead{{Event: DeviceEvent{Body: DeviceBody{Operation: "enroll", DeviceID: device, DevicePublic: hex.EncodeToString(public)}}}}
		}
		event := s.Devices[owner][0].Event.Body
		public, key, _ := ed25519.GenerateKey(rand.Reader)
		curve, _, _ := ed25519.GenerateKey(rand.Reader)
		cert := CipherDeviceCertificate{Body: CipherDeviceBody{Owner: owner, Device: event.DeviceID, DevicePublic: event.DevicePublic,
			Ed25519: base64.RawStdEncoding.EncodeToString(public), Curve25519: base64.RawStdEncoding.EncodeToString(curve)}}
		if s.CipherDevices == nil {
			s.CipherDevices = map[string]CipherDeviceHead{}
		}
		s.CipherDevices[owner+":"+event.DeviceID] = CipherDeviceHead{Certificate: cert}
		records = append(records, ApplicationKeyRecord{Body: ApplicationKeyBody{Domain: "sfera-mesh-application-key-v1", Network: s.Network, Genesis: s.GenesisPin,
			Owner: owner, Device: event.DeviceID, DevicesVersion: 1, Request: "upload-1", Kind: "upload"}})
		signers = append(signers, key)
	}
	return s, records, signers, f.Dialog
}

func signApplicationKey(r ApplicationKeyRecord, key ed25519.PrivateKey) ApplicationKeyRecord {
	r.Signature = base64.RawStdEncoding.EncodeToString(ed25519.Sign(key, canonical(r.Body)))
	return r
}

func uploadApplicationKey(s State, r ApplicationKeyRecord, key ed25519.PrivateKey, id string, public []byte) ApplicationKeyRecord {
	signed := map[string]string{"key": base64.RawStdEncoding.EncodeToString(public)}
	user := "@" + r.Body.Owner + ":" + s.GenesisPin + ".sphere"
	doc := map[string]any{"key": signed["key"], "signatures": map[string]map[string]string{user: {"ed25519:" + r.Body.Device: base64.RawStdEncoding.EncodeToString(ed25519.Sign(key, canonical(signed)))}}}
	r.Body.KeysUTF8 = hex.EncodeToString(canonical(map[string]any{id: doc}))
	return signApplicationKey(r, key)
}

func TestApplicationKeyExactlyOnceRetryAliasAndClone(t *testing.T) {
	s, rs, keys, dialog := keyJournalFixture(t)
	curve, _, _ := ed25519.GenerateKey(rand.Reader)
	upload := uploadApplicationKey(s, rs[1], keys[1], "signed_curve25519:one", curve)
	if err := apply(&s, canonical(upload)); err != nil {
		t.Fatal(err)
	}
	claim := rs[0]
	claim.Body.Kind = "claim"
	claim.Body.Request = "claim-1"
	claim.Body.Dialog = dialog
	claim.Body.TargetOwner = rs[1].Body.Owner
	claim.Body.TargetDevice = rs[1].Body.Device
	claim = signApplicationKey(claim, keys[0])
	copyState := clone(s)
	if err := apply(&s, canonical(claim)); err != nil {
		t.Fatal(err)
	}
	if len(copyState.ApplicationKeys) != 1 {
		t.Fatal("speculative journal mutated committed slice")
	}
	first := s.ApplicationKeys[1]
	if first.KeyID != "signed_curve25519:one" || first.KeyUTF8 == "" {
		t.Fatal("claim did not receive key")
	}
	before := canonical(s)
	if err := apply(&s, canonical(claim)); err != nil || !bytes.Equal(before, canonical(s)) {
		t.Fatal("exact retry changed result", err)
	}
	next := claim
	next.Body.Request = "claim-2"
	next = signApplicationKey(next, keys[0])
	if err := apply(&s, canonical(next)); err != nil {
		t.Fatal(err)
	}
	if s.ApplicationKeys[2].KeyID != "" {
		t.Fatal("one-time key issued twice")
	}
	// Uploading the identical key again does not resurrect it.
	again := upload
	again.Body.Request = "upload-2"
	again = signApplicationKey(again, keys[1])
	if err := apply(&s, canonical(again)); err != nil {
		t.Fatal(err)
	}
	pool, err := replayApplicationKeys(s)
	if err != nil {
		t.Fatal(err)
	}
	if !pool[rs[1].Body.Owner+":"+rs[1].Body.Device][first.KeyID].Consumed {
		t.Fatal("upload resurrected consumed key")
	}
	alias := rs[1]
	alias.Body.Request = "alias"
	alias = uploadApplicationKey(s, alias, keys[1], "signed_curve25519:alias", curve)
	before = canonical(s)
	if err := apply(&s, canonical(alias)); err == nil || !bytes.Equal(before, canonical(s)) {
		t.Fatal("key alias accepted or changed state")
	}
	changed := claim
	changed.Body.TargetDevice = "wrong"
	changed = signApplicationKey(changed, keys[0])
	if err := apply(&s, canonical(changed)); err == nil {
		t.Fatal("request substitution accepted")
	}
	corrupt := clone(s)
	corrupt.ApplicationKeys[1].KeyID = "signed_curve25519:other"
	if _, err := replayApplicationKeys(corrupt); err == nil {
		t.Fatal("forged receipt accepted")
	}
}

func TestApplicationKeyPythonFixture(t *testing.T) {
	testApplicationKeyPythonFixture(t, "testdata/application-keys-v1.json")
}
func TestApplicationFallbackPythonFixture(t *testing.T) {
	testApplicationKeyPythonFixture(t, "testdata/application-fallback-v1.json")
}
func testApplicationKeyPythonFixture(t *testing.T, filename string) {
	raw, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Network  string                 `json:"network"`
		Genesis  string                 `json:"genesis"`
		Initial  State                  `json:"initial_state"`
		State    State                  `json:"state"`
		Commands []ApplicationKeyRecord `json:"commands"`
		Alias    ApplicationKeyRecord   `json:"alias"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	s := f.Initial
	s.Network = f.Network
	s.GenesisPin = f.Genesis
	for _, command := range f.Commands {
		if err := apply(&s, canonical(command)); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(canonical(s.ApplicationKeys), canonical(f.State.ApplicationKeys)) {
		t.Fatal("Python and Go key receipts differ")
	}
	if _, err := replayApplicationKeys(s); err != nil {
		t.Fatal(err)
	}
	before := canonical(s)
	if err := apply(&s, canonical(f.Alias)); err == nil || !bytes.Equal(before, canonical(s)) {
		t.Fatal("cross-language alias accepted")
	}
}

func TestApplicationKeyRevocationAndTargetIsolation(t *testing.T) {
	s, rs, keys, dialog := keyJournalFixture(t)
	curve, _, _ := ed25519.GenerateKey(rand.Reader)
	upload := uploadApplicationKey(s, rs[1], keys[1], "signed_curve25519:one", curve)
	if err := apply(&s, canonical(upload)); err != nil {
		t.Fatal(err)
	}
	claim := rs[0]
	claim.Body.Kind = "claim"
	claim.Body.Request = "claim-1"
	claim.Body.Dialog = dialog
	claim.Body.TargetOwner = rs[1].Body.Owner
	claim.Body.TargetDevice = rs[1].Body.Device
	wrong := claim
	wrong.Body.TargetOwner = zero
	wrong = signApplicationKey(wrong, keys[0])
	before := canonical(s)
	if err := apply(&s, canonical(wrong)); err == nil || !bytes.Equal(before, canonical(s)) {
		t.Fatal("outsider target accepted")
	}
	claim = signApplicationKey(claim, keys[0])
	if err := apply(&s, canonical(claim)); err != nil {
		t.Fatal(err)
	}
	// Historical receipts survive revocation. New requests require the current
	// history checkpoint and an active SDK-owning device.
	owner := rs[0].Body.Owner
	event := s.Devices[owner][0].Event
	event.Body.Operation = "revoke"
	s.Devices[owner] = append(s.Devices[owner], DeviceHead{Event: event})
	if _, err := replayApplicationKeys(s); err != nil {
		t.Fatal("revocation erased historical key receipt", err)
	}
	next := claim
	next.Body.Request = "after-revoke"
	next = signApplicationKey(next, keys[0])
	if err := apply(&s, canonical(next)); err == nil {
		t.Fatal("stale history accepted")
	}
	next.Body.DevicesVersion = 2
	next = signApplicationKey(next, keys[0])
	if err := apply(&s, canonical(next)); err == nil {
		t.Fatal("revoked device accepted")
	}
}
func TestApplicationFallbackRotationAndNormalPriority(t *testing.T) {
	s, rs, keys, dialog := keyJournalFixture(t)
	makeFallback := func(id, request string) ApplicationKeyRecord {
		curve, _, _ := ed25519.GenerateKey(rand.Reader)
		r := rs[1]
		r.Body.Kind = "fallback"
		r.Body.Request = request
		body := map[string]any{"key": base64.RawStdEncoding.EncodeToString(curve), "fallback": true}
		doc := map[string]any{"key": body["key"], "fallback": true, "signatures": map[string]map[string]string{"@" + r.Body.Owner + ":" + s.GenesisPin + ".sphere": {"ed25519:" + r.Body.Device: base64.RawStdEncoding.EncodeToString(ed25519.Sign(keys[1], canonical(body)))}}}
		r.Body.KeysUTF8 = hex.EncodeToString(canonical(map[string]any{id: doc}))
		return signApplicationKey(r, keys[1])
	}
	first := makeFallback("signed_curve25519:aaa", "fallback-1")
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal(err)
	}
	curve, _, _ := ed25519.GenerateKey(rand.Reader)
	normal := uploadApplicationKey(s, rs[1], keys[1], "signed_curve25519:zzz", curve)
	if err := apply(&s, canonical(normal)); err != nil {
		t.Fatal(err)
	}
	claim := rs[0]
	claim.Body.Kind = "claim"
	claim.Body.Dialog = dialog
	claim.Body.TargetOwner = rs[1].Body.Owner
	claim.Body.TargetDevice = rs[1].Body.Device
	for i, want := range []string{"signed_curve25519:zzz", "signed_curve25519:aaa", "signed_curve25519:aaa"} {
		claim.Body.Request = string(rune('a' + i))
		claim = signApplicationKey(claim, keys[0])
		if err := apply(&s, canonical(claim)); err != nil {
			t.Fatal(err)
		}
		if got := s.ApplicationKeys[len(s.ApplicationKeys)-1].KeyID; got != want {
			t.Fatalf("got %s want %s", got, want)
		}
	}
	next := makeFallback("signed_curve25519:bbb", "fallback-2")
	if err := apply(&s, canonical(next)); err != nil {
		t.Fatal(err)
	}
	first.Body.Request = "resurrect"
	first = signApplicationKey(first, keys[1])
	before := canonical(s)
	if err := apply(&s, canonical(first)); err == nil || !bytes.Equal(before, canonical(s)) {
		t.Fatal("retired fallback resurrected")
	}
	claim.Body.Request = "after-rotation"
	claim = signApplicationKey(claim, keys[0])
	if err := apply(&s, canonical(claim)); err != nil {
		t.Fatal(err)
	}
	if s.ApplicationKeys[len(s.ApplicationKeys)-1].KeyID != "signed_curve25519:bbb" {
		t.Fatal("old fallback reused")
	}
	if _, err := replayApplicationKeys(s); err != nil {
		t.Fatal(err)
	}
}
