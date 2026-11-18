package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"testing"
)

func TestCipherProfilesReservationRollbackCloneAndRevocation(t *testing.T) {
	events, _, owner := deviceFixture(t)
	s := State{Network: "lab", GenesisPin: string(bytes.Repeat([]byte("a"), 64)), Accounts: map[string]Head{}}
	if err := apply(&s, signed(t, owner, 1, zero)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(events[0])); err != nil {
		t.Fatal(err)
	}
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i + 32)
	}
	device := ed25519.NewKeyFromSeed(seed)
	key := events[0].Body.UserID + ":" + events[0].Body.DeviceID
	s.CipherDevices = map[string]CipherDeviceHead{key: {Certificate: CipherDeviceCertificate{Body: CipherDeviceBody{DevicePublic: events[0].Body.DevicePublic}}}}
	record := func(version int64, previous, profile string) CipherProfileRecord {
		b := CipherProfileBody{Domain: "sfera-mesh-cipher-profile-v1", Network: s.Network, Genesis: s.GenesisPin, Owner: events[0].Body.UserID, Device: events[0].Body.DeviceID, Version: version, Previous: previous, ProfileDigest: profile}
		return CipherProfileRecord{b, hex.EncodeToString(ed25519.Sign(device, canonical(b)))}
	}
	first := record(1, zero, s.GenesisPin)
	if err := apply(&s, canonical(first)); err != nil {
		t.Fatal(err)
	}
	cloned := clone(s)
	old := s.CipherProfiles[key]
	wrong := record(2, old.Digest, string(bytes.Repeat([]byte("b"), 64)))
	if err := apply(&s, canonical(wrong)); err == nil {
		t.Fatal("reservation changed sealed snapshot")
	}
	reserved := record(2, old.Digest, first.Body.ProfileDigest)
	if err := apply(&s, canonical(reserved)); err != nil {
		t.Fatal(err)
	}
	if cloned.CipherProfiles[key] != old {
		t.Fatal("clone mutated")
	}
	idle := record(3, s.CipherProfiles[key].Digest, string(bytes.Repeat([]byte("c"), 64)))
	if err := apply(&s, canonical(idle)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(idle)); err != nil {
		t.Fatal("exact retry", err)
	}
	for _, r := range []CipherProfileRecord{first, reserved, record(5, s.CipherProfiles[key].Digest, s.GenesisPin), record(4, zero, idle.Body.ProfileDigest)} {
		if err := apply(&s, canonical(r)); err == nil {
			t.Fatal("rollback/gap/fork accepted")
		}
	}
	if err := verifyCipherProfiles(s); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(events[1])); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(record(4, s.CipherProfiles[key].Digest, idle.Body.ProfileDigest))); err == nil {
		t.Fatal("revoked device advanced profile")
	}
	if err := verifyCipherProfiles(s); err != nil {
		t.Fatal("revocation destroyed historical checkpoint", err)
	}
}
