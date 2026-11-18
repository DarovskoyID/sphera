package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestAtomicRootSuccessionPreservesIdentityAndRejectsOldAuthority(t *testing.T) {
	events, _, owner := deviceFixture(t)
	s := State{Network: "lab", GenesisPin: string(bytes.Repeat([]byte("a"), 64)), Accounts: map[string]Head{}}
	first := signed(t, owner, 1, zero)
	if err := apply(&s, first); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(events[0])); err != nil {
		t.Fatal(err)
	}
	id := events[0].Body.UserID
	makeUpdate := func(s State, old, next ed25519.PrivateKey) AccountControlUpdate {
		head := s.Accounts[id]
		history := s.AccountControls[id]
		devices := s.Devices[id]
		u := AccountControlUpdate{}
		u.Body.Domain = "sfera-mesh-account-control-update-v1"
		u.Body.Network = s.Network
		u.Body.Genesis = s.GenesisPin
		u.Account = head.Record
		u.Account.Body.Version++
		u.Account.Body.Previous = head.Digest
		u.Account.Body.VaultDigest = hex.EncodeToString(digest(next.Public().(ed25519.PublicKey)))
		u.Account.Signature = hex.EncodeToString(ed25519.Sign(next, canonical(u.Account.Body)))
		previous := zero
		if len(history) > 0 {
			previous = history[len(history)-1].Digest
		}
		deviceDigest := zero
		if len(devices) > 0 {
			deviceDigest = devices[len(devices)-1].Digest
		}
		u.Control.Body = AccountControlBody{Domain: "sfera-mesh-account-control-v1", Network: s.Network, Genesis: s.GenesisPin, Owner: id, Epoch: int64(len(history) + 1), Previous: previous, OldPublic: hex.EncodeToString(old.Public().(ed25519.PublicKey)), NewPublic: hex.EncodeToString(next.Public().(ed25519.PublicKey)), AccountVersion: head.Record.Body.Version, AccountDigest: head.Digest, DevicesVersion: int64(len(devices)), DevicesDigest: deviceDigest, ReplacementDigest: hex.EncodeToString(digest(u.Account))}
		u.Control.OldSignature = hex.EncodeToString(ed25519.Sign(old, canonical(u.Control.Body)))
		u.Control.NewSignature = hex.EncodeToString(ed25519.Sign(next, canonical(u.Control.Body)))
		return u
	}
	seed := sha256.Sum256([]byte("new controller 1"))
	next := ed25519.NewKeyFromSeed(seed[:])
	update := makeUpdate(s, owner, next)
	before := canonical(s)
	bad := update
	bad.Account.Signature = zero
	if err := apply(&s, canonical(bad)); err == nil {
		t.Fatal("partial atomic update accepted")
	}
	if !bytes.Equal(before, canonical(s)) {
		t.Fatal("failed update mutated state")
	}
	if err := apply(&s, canonical(update.Control)); err == nil {
		t.Fatal("unbundled root transition accepted")
	}
	if err := apply(&s, canonical(update)); err != nil {
		t.Fatal(err)
	}
	if s.Accounts[id].Record.Body.PublicKey != hex.EncodeToString(owner.Public().(ed25519.PublicKey)) || len(s.Devices[id]) != 1 {
		t.Fatal("identity or devices lost")
	}
	oldRevoke := events[1]
	if err := apply(&s, canonical(oldRevoke)); err == nil {
		t.Fatal("old owner retained device authority")
	}
	newRevoke := oldRevoke
	newRevoke.OwnerSignature = hex.EncodeToString(ed25519.Sign(next, canonical(newRevoke.Body)))
	if err := apply(&s, canonical(newRevoke)); err != nil {
		t.Fatal(err)
	}
	if err := verifyDevices(s); err != nil {
		t.Fatal("historical signature replay", err)
	}
	if err := verifyAccountControls(s); err != nil {
		t.Fatal(err)
	}
	oldRecord := s.Accounts[id].Record
	oldRecord.Body.Version++
	oldRecord.Body.Previous = s.Accounts[id].Digest
	oldRecord.Signature = hex.EncodeToString(ed25519.Sign(owner, canonical(oldRecord.Body)))
	if err := apply(&s, canonical(oldRecord)); err == nil {
		t.Fatal("old owner updated account")
	}
	oldRecord.Signature = hex.EncodeToString(ed25519.Sign(next, canonical(oldRecord.Body)))
	if err := apply(&s, canonical(oldRecord)); err != nil {
		t.Fatal(err)
	}
	seed2 := sha256.Sum256([]byte("new controller 2"))
	next2 := ed25519.NewKeyFromSeed(seed2[:])
	second := makeUpdate(s, next, next2)
	if err := apply(&s, canonical(second)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(update)); err != nil {
		t.Fatal("exact historical atomic retry", err)
	}
	if err := verifyAccountControls(s); err != nil {
		t.Fatal(err)
	}
	if err := verifyDevices(s); err != nil {
		t.Fatal(err)
	}
	corrupt := clone(s)
	head := corrupt.AccountControls[id][0]
	head.Digest = zero
	corrupt.AccountControls[id][0] = head
	if err := verifyAccountControls(corrupt); err == nil {
		t.Fatal("corrupt root chain accepted")
	}
}
