package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// Odd revisions seal an idle SDK snapshot. Even revisions reserve its next
// mutation. A process lost during a reservation cannot silently reuse a backup.
type CipherProfileBody struct {
	Domain        string `json:"domain"`
	Network       string `json:"network"`
	Genesis       string `json:"genesis"`
	Owner         string `json:"owner"`
	Device        string `json:"device"`
	Version       int64  `json:"version"`
	Previous      string `json:"previous"`
	ProfileDigest string `json:"profile_digest"`
}
type CipherProfileRecord struct {
	Body      CipherProfileBody `json:"body"`
	Signature string            `json:"signature"`
}
type CipherProfileHead struct {
	Record CipherProfileRecord `json:"record"`
	Digest string              `json:"digest"`
}

func decodeCipherProfile(s State, tx []byte) (CipherProfileRecord, string, error) {
	var r CipherProfileRecord
	if len(tx) > 4096 || json.Unmarshal(tx, &r) != nil || !bytes.Equal(tx, canonical(r)) {
		return r, "", errors.New("invalid cipher profile encoding")
	}
	b := r.Body
	pin, ok := s.CipherDevices[b.Owner+":"+b.Device]
	if !ok || b.Domain != "sfera-mesh-cipher-profile-v1" || b.Network != s.Network || b.Genesis != s.GenesisPin || b.Version < 1 || b.Version > 9007199254740991 || !hex64.MatchString(b.Previous) || !hex64.MatchString(b.ProfileDigest) || b.ProfileDigest == zero || b.Version == 1 && b.Previous != zero {
		return r, "", errors.New("invalid cipher profile context")
	}
	public, _ := hex.DecodeString(pin.Certificate.Body.DevicePublic)
	sig, err := hex.DecodeString(r.Signature)
	if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != r.Signature || !ed25519.Verify(public, canonical(b), sig) {
		return r, "", errors.New("invalid cipher profile signature")
	}
	return r, hex.EncodeToString(digest(r)), nil
}
func applyCipherProfile(s *State, tx []byte) error {
	r, h, err := decodeCipherProfile(*s, tx)
	if err != nil {
		return err
	}
	b := r.Body
	key := b.Owner + ":" + b.Device
	old, exists := s.CipherProfiles[key]
	if exists && old.Digest == h {
		return nil
	}
	active := false
	for _, head := range s.Devices[b.Owner] {
		if head.Event.Body.DeviceID == b.Device {
			active = head.Event.Body.Operation == "enroll"
		}
	}
	if !active {
		return errors.New("cipher profile device revoked")
	}
	if !exists {
		if b.Version != 1 || b.Previous != zero {
			return errors.New("cipher profile initial checkpoint required")
		}
	} else {
		if b.Version != old.Record.Body.Version+1 || b.Previous != old.Digest || b.Version%2 == 0 && b.ProfileDigest != old.Record.Body.ProfileDigest {
			return errors.New("cipher profile rollback or fork")
		}
	}
	if s.CipherProfiles == nil {
		s.CipherProfiles = map[string]CipherProfileHead{}
	}
	s.CipherProfiles[key] = CipherProfileHead{r, h}
	return nil
}
func verifyCipherProfiles(s State) error {
	if len(s.CipherProfiles) > 512 {
		return errors.New("cipher profile capacity")
	}
	for key, head := range s.CipherProfiles {
		r, h, err := decodeCipherProfile(s, canonical(head.Record))
		if err != nil {
			return err
		}
		if key != r.Body.Owner+":"+r.Body.Device || h != head.Digest {
			return errors.New("invalid cipher profile head")
		}
	}
	return nil
}
