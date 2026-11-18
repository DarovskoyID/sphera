package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
)

type CipherDeviceBody struct {
	Domain       string `json:"domain"`
	Network      string `json:"network"`
	Genesis      string `json:"genesis"`
	Owner        string `json:"owner"`
	Device       string `json:"device"`
	DevicePublic string `json:"device_public"`
	Ed25519      string `json:"ed25519"`
	Curve25519   string `json:"curve25519"`
}
type CipherDeviceCertificate struct {
	Body      CipherDeviceBody `json:"body"`
	Signature string           `json:"signature"`
}
type CipherDeviceHead struct {
	Certificate CipherDeviceCertificate `json:"certificate"`
	Digest      string                  `json:"digest"`
}

func decodeCipherDevice(tx []byte, s State) (CipherDeviceCertificate, string, error) {
	var c CipherDeviceCertificate
	if len(tx) > 4096 || json.Unmarshal(tx, &c) != nil || !bytes.Equal(tx, canonical(c)) {
		return c, "", errors.New("invalid canonical cipher certificate")
	}
	b := c.Body
	if b.Domain != "sfera-mesh-cipher-device-v1" || b.Network != s.Network || b.Genesis != s.GenesisPin || !hex64.MatchString(b.Genesis) || !hex64.MatchString(b.Owner) || !hex64.MatchString(b.Device) || !hex64.MatchString(b.DevicePublic) {
		return c, "", errors.New("cipher certificate context")
	}
	for _, key := range []string{b.Ed25519, b.Curve25519} {
		raw, err := base64.RawStdEncoding.DecodeString(key)
		if err != nil || len(raw) != 32 || base64.RawStdEncoding.EncodeToString(raw) != key {
			return c, "", errors.New("invalid SDK public key")
		}
	}
	found := false
	for _, head := range s.Devices[b.Owner] {
		if head.Event.Body.DeviceID == b.Device && head.Event.Body.Operation == "enroll" && head.Event.Body.DevicePublic == b.DevicePublic {
			found = true
		}
	}
	if !found {
		return c, "", errors.New("cipher device never admitted")
	}
	public, _ := hex.DecodeString(b.DevicePublic)
	sig, err := hex.DecodeString(c.Signature)
	if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != c.Signature || !ed25519.Verify(public, canonical(b), sig) {
		return c, "", errors.New("cipher device signature")
	}
	return c, hex.EncodeToString(digest(c)), nil
}
func applyCipherDevice(s *State, tx []byte) error {
	c, h, err := decodeCipherDevice(tx, *s)
	if err != nil {
		return err
	}
	b := c.Body
	key := b.Owner + ":" + b.Device
	if old, ok := s.CipherDevices[key]; ok {
		if old.Digest == h {
			return nil
		}
		return errors.New("global SDK pins are immutable")
	}
	active := false
	for _, head := range s.Devices[b.Owner] {
		if head.Event.Body.DeviceID == b.Device {
			active = head.Event.Body.Operation == "enroll"
		}
	}
	if !active {
		return errors.New("cipher device revoked")
	}
	if len(s.CipherDevices) >= 512 {
		return errors.New("cipher device capacity")
	}
	for _, old := range s.CipherDevices {
		if old.Certificate.Body.Ed25519 == b.Ed25519 || old.Certificate.Body.Curve25519 == b.Curve25519 {
			return errors.New("duplicate global SDK key")
		}
	}
	if s.CipherDevices == nil {
		s.CipherDevices = map[string]CipherDeviceHead{}
	}
	s.CipherDevices[key] = CipherDeviceHead{c, h}
	return nil
}
func verifyCipherDevices(s State) error {
	if len(s.CipherDevices) > 512 {
		return errors.New("cipher device capacity")
	}
	ed, curve := map[string]bool{}, map[string]bool{}
	for key, head := range s.CipherDevices {
		c, h, err := decodeCipherDevice(canonical(head.Certificate), s)
		if err != nil {
			return err
		}
		if key != c.Body.Owner+":"+c.Body.Device || h != head.Digest || ed[c.Body.Ed25519] || curve[c.Body.Curve25519] {
			return errors.New("invalid global SDK pin head")
		}
		ed[c.Body.Ed25519] = true
		curve[c.Body.Curve25519] = true
	}
	return nil
}
