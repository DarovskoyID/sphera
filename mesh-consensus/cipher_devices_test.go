package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

func TestGlobalCipherPinsAdmissionImmutabilityRevocationAndClone(t *testing.T) {
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
	c := CipherDeviceCertificate{Body: CipherDeviceBody{Domain: "sfera-mesh-cipher-device-v1", Network: "lab", Genesis: s.GenesisPin, Owner: events[0].Body.UserID, Device: events[0].Body.DeviceID, DevicePublic: events[0].Body.DevicePublic, Ed25519: base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)), Curve25519: base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))}}
	sign := func(c CipherDeviceCertificate) CipherDeviceCertificate {
		c.Signature = hex.EncodeToString(ed25519.Sign(device, canonical(c.Body)))
		return c
	}
	c = sign(c)
	unpinned := clone(s)
	if err := apply(&s, canonical(c)); err != nil {
		t.Fatal(err)
	}
	if len(unpinned.CipherDevices) != 0 {
		t.Fatal("speculative clone leaked pins")
	}
	if err := apply(&s, canonical(c)); err != nil {
		t.Fatal(err)
	}
	changed := c
	changed.Body.Ed25519 = base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
	changed = sign(changed)
	before := canonical(s)
	if err := apply(&s, canonical(changed)); err == nil {
		t.Fatal("SDK replacement accepted")
	}
	if !bytes.Equal(before, canonical(s)) {
		t.Fatal("rejected mutation changed state")
	}
	wrong := c
	wrong.Body.Genesis = zero
	wrong = sign(wrong)
	if err := apply(&unpinned, canonical(wrong)); err == nil {
		t.Fatal("wrong genesis accepted")
	}
	if err := apply(&s, canonical(events[1])); err != nil {
		t.Fatal(err)
	}
	if err := verifyCipherDevices(s); err != nil {
		t.Fatal("revocation erased historical pin", err)
	}
	if err := apply(&s, canonical(c)); err != nil {
		t.Fatal("exact historical retry", err)
	}
	if err := apply(&unpinned, canonical(events[1])); err != nil {
		t.Fatal(err)
	}
	if err := apply(&unpinned, canonical(c)); err == nil {
		t.Fatal("revoked unpinned device registered")
	}
	corrupt := clone(s)
	key := c.Body.Owner + ":" + c.Body.Device
	head := corrupt.CipherDevices[key]
	head.Digest = zero
	corrupt.CipherDevices[key] = head
	if err := verifyCipherDevices(corrupt); err == nil {
		t.Fatal("corrupt snapshot accepted")
	}
}
