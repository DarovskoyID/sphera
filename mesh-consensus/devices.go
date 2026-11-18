package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

type DeviceBody struct {
	Domain       string `json:"domain"`
	Network      string `json:"network"`
	UserID       string `json:"user_id"`
	Version      int64  `json:"version"`
	Previous     string `json:"previous"`
	Operation    string `json:"operation"`
	DeviceID     string `json:"device_id"`
	DevicePublic string `json:"device_public"`
}
type DeviceEvent struct {
	Body            DeviceBody `json:"body"`
	OwnerSignature  string     `json:"owner_signature"`
	DeviceSignature string     `json:"device_signature"`
}
type DeviceHead struct {
	Event  DeviceEvent `json:"event"`
	Digest string      `json:"digest"`
}
type DeviceBatch struct {
	Body struct {
		Domain  string `json:"domain"`
		Network string `json:"network"`
	} `json:"body"`
	Events []DeviceEvent `json:"events"`
}

func decodeDevice(tx []byte, s State) (DeviceEvent, string, error) {
	var e DeviceEvent
	if len(tx) > 2048 || json.Unmarshal(tx, &e) != nil || !bytes.Equal(tx, canonical(e)) {
		return e, "", errors.New("invalid canonical device event")
	}
	b := e.Body
	owner, ok := s.Accounts[b.UserID]
	if !ok || b.Domain != "sfera-mesh-device-event-lab-v1" || b.Network != s.Network || b.Version < 1 || b.Version > 256 || (b.Operation != "enroll" && b.Operation != "revoke") {
		return e, "", errors.New("device event context or account missing")
	}
	for _, v := range []string{b.UserID, b.Previous, b.DeviceID, b.DevicePublic} {
		if !hex64.MatchString(v) {
			return e, "", errors.New("invalid device digest")
		}
	}
	public, _ := hex.DecodeString(b.DevicePublic)
	id := sha256.Sum256(append([]byte("sfera-mesh-device-v1\x00"), public...))
	if b.DeviceID != hex.EncodeToString(id[:]) || b.DevicePublic == owner.Record.Body.PublicKey {
		return e, "", errors.New("device must use a distinct matching key")
	}
	signer := historicalControlPublic(s, b.UserID, b.Version, true)
	if !hex64.MatchString(signer) {
		return e, "", errors.New("invalid historical controller key")
	}
	if b.DevicePublic == controlPublic(s, b.UserID) {
		return e, "", errors.New("device must not reuse controller key")
	}
	for _, heads := range s.AccountControls {
		for _, head := range heads {
			if head.Record.Body.NewPublic == b.DevicePublic {
				return e, "", errors.New("device must not reuse historical controller key")
			}
		}
	}
	ownerPublic, _ := hex.DecodeString(signer)
	sig, err := hex.DecodeString(e.OwnerSignature)
	if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != e.OwnerSignature || !ed25519.Verify(ownerPublic, canonical(b), sig) {
		return e, "", errors.New("device owner signature")
	}
	if b.Operation == "enroll" {
		sig, err = hex.DecodeString(e.DeviceSignature)
		if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != e.DeviceSignature || !ed25519.Verify(public, canonical(b), sig) {
			return e, "", errors.New("device possession signature")
		}
	} else if e.DeviceSignature != "" {
		return e, "", errors.New("unexpected device signature")
	}
	return e, hex.EncodeToString(digest(e)), nil
}

func applyDevice(s *State, tx []byte) error {
	e, h, err := decodeDevice(tx, *s)
	if err != nil {
		return err
	}
	b := e.Body
	history := s.Devices[b.UserID]
	if b.Version <= int64(len(history)) {
		if history[b.Version-1].Digest == h {
			return nil
		}
		return errors.New("device version conflict")
	}
	previous := zero
	if len(history) > 0 {
		previous = history[len(history)-1].Digest
	}
	if b.Version != int64(len(history)+1) || b.Previous != previous {
		return errors.New("device chain gap or fork")
	}
	devices := map[string]bool{}
	for _, head := range history {
		devices[head.Event.Body.DeviceID] = head.Event.Body.Operation == "enroll"
	}
	if b.Operation == "enroll" {
		if _, seen := devices[b.DeviceID]; seen || len(devices) >= 64 {
			return errors.New("device already seen or limit")
		}
	} else if !devices[b.DeviceID] {
		return errors.New("device not active")
	}
	total, active := 0, 0
	for _, heads := range s.Devices {
		total += len(heads)
		states := map[string]bool{}
		for _, head := range heads {
			states[head.Event.Body.DeviceID] = head.Event.Body.Operation == "enroll"
		}
		for _, enabled := range states {
			if enabled {
				active++
			}
		}
	}
	// Reserve one future terminal revoke for each active device.
	if total >= 512 || (b.Operation == "enroll" && total+active+2 > 512) {
		return errors.New("device registry capacity")
	}
	if s.Devices == nil {
		s.Devices = map[string][]DeviceHead{}
	}
	s.Devices[b.UserID] = append(append([]DeviceHead(nil), history...), DeviceHead{e, h})
	return nil
}

func applyDeviceBatch(s *State, tx []byte) error {
	var batch DeviceBatch
	if len(tx) > 8192 || json.Unmarshal(tx, &batch) != nil || !bytes.Equal(tx, canonical(batch)) || batch.Body.Domain != "sfera-mesh-device-update-lab-v1" || batch.Body.Network != s.Network || len(batch.Events) < 1 || len(batch.Events) > 2 {
		return errors.New("invalid device batch")
	}
	staged := clone(*s)
	for _, event := range batch.Events {
		if event.Body.UserID != batch.Events[0].Body.UserID {
			return errors.New("device batch owner mismatch")
		}
		if err := applyDevice(&staged, canonical(event)); err != nil {
			return err
		}
	}
	s.Devices = staged.Devices
	return nil
}

func verifyDevices(s State) error {
	replay := s
	replay.Devices = nil
	total := 0
	for user, history := range s.Devices {
		if len(history) < 1 || len(history) > 256 {
			return errors.New("invalid device history length")
		}
		for index, head := range history {
			total++
			if total > 512 || head.Event.Body.Version != int64(index+1) || head.Event.Body.UserID != user || head.Digest != hex.EncodeToString(digest(head.Event)) {
				return errors.New("invalid device history head")
			}
			if err := applyDevice(&replay, canonical(head.Event)); err != nil {
				return err
			}
		}
	}
	return nil
}
