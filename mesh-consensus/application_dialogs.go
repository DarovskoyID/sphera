package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// A direct conversation has one stable identity regardless of which entry
// created it. Its immutable membership is not owned by an application server.
type ApplicationDialogBody struct {
	Domain         string   `json:"domain"`
	Network        string   `json:"network"`
	Genesis        string   `json:"genesis"`
	Creator        string   `json:"creator"`
	ControlEpoch   int64    `json:"control_epoch"`
	CreatorDevice  string   `json:"creator_device,omitempty"`
	DevicesVersion int64    `json:"devices_version,omitempty"`
	Members        []string `json:"members"`
}
type ApplicationDialogRecord struct {
	Body      ApplicationDialogBody `json:"body"`
	Signature string                `json:"signature"`
}
type ApplicationDialogHead struct {
	Record ApplicationDialogRecord `json:"record"`
	Digest string                  `json:"digest"`
}

func applicationDialogID(network string, members []string) string {
	hash := sha256.Sum256([]byte("sfera-mesh-application-dialog-v1\x00" + network + "\x00" + members[0] + "\x00" + members[1]))
	return hex.EncodeToString(hash[:])
}
func decodeApplicationDialog(s State, raw []byte) (ApplicationDialogRecord, string, string, error) {
	var r ApplicationDialogRecord
	if len(raw) > 2048 || json.Unmarshal(raw, &r) != nil || !bytes.Equal(raw, canonical(r)) {
		return r, "", "", errors.New("application dialog encoding")
	}
	b := r.Body
	if (b.Domain != "sfera-mesh-application-dialog-v1" && b.Domain != "sfera-mesh-application-dialog-device-v1") || b.Network != s.Network || b.Genesis != s.GenesisPin || !hex64.MatchString(b.Genesis) || len(b.Members) != 2 || b.Members[0] >= b.Members[1] || b.Creator != b.Members[0] && b.Creator != b.Members[1] || b.ControlEpoch < 0 || b.ControlEpoch > int64(len(s.AccountControls[b.Creator])) {
		return r, "", "", errors.New("application dialog context")
	}
	for _, owner := range b.Members {
		if !hex64.MatchString(owner) || len(s.ApplicationProfiles[owner]) == 0 {
			return r, "", "", errors.New("application dialog public profile required")
		}
	}
	public := s.Accounts[b.Creator].Record.Body.PublicKey
	if b.ControlEpoch > 0 {
		public = s.AccountControls[b.Creator][b.ControlEpoch-1].Record.Body.NewPublic
	}
	if b.Domain == "sfera-mesh-application-dialog-device-v1" {
		history := s.Devices[b.Creator]
		if !hex64.MatchString(b.CreatorDevice) || b.DevicesVersion < 1 || b.DevicesVersion > int64(len(history)) {
			return r, "", "", errors.New("application dialog device history")
		}
		public = ""
		for _, head := range history[:b.DevicesVersion] {
			e := head.Event.Body
			if e.DeviceID == b.CreatorDevice {
				if e.Operation == "enroll" {
					public = e.DevicePublic
				} else {
					public = ""
				}
			}
		}
		if public == "" {
			return r, "", "", errors.New("application dialog inactive device")
		}
	} else if b.CreatorDevice != "" || b.DevicesVersion != 0 {
		return r, "", "", errors.New("application dialog unexpected device")
	}
	pub, _ := hex.DecodeString(public)
	sig, err := hex.DecodeString(r.Signature)
	if err != nil || len(pub) != 32 || len(sig) != 64 || hex.EncodeToString(sig) != r.Signature || !ed25519.Verify(pub, canonical(b), sig) {
		return r, "", "", errors.New("application dialog signature")
	}
	return r, applicationDialogID(s.Network, b.Members), hex.EncodeToString(digest(r)), nil
}
func applyApplicationDialog(s *State, raw []byte) error {
	r, id, hash, err := decodeApplicationDialog(*s, raw)
	if err != nil {
		return err
	}
	if _, exists := s.ApplicationDialogs[id]; exists {
		return nil
	}
	if r.Body.ControlEpoch != int64(len(s.AccountControls[r.Body.Creator])) {
		return errors.New("application dialog retired owner key")
	}
	if r.Body.Domain == "sfera-mesh-application-dialog-device-v1" && r.Body.DevicesVersion != int64(len(s.Devices[r.Body.Creator])) {
		return errors.New("application dialog stale device history")
	}
	if len(s.ApplicationDialogs) >= 1024 {
		return errors.New("application dialog capacity")
	}
	count := 0
	for _, head := range s.ApplicationDialogs {
		if head.Record.Body.Creator == r.Body.Creator {
			count++
		}
	}
	if count >= 128 {
		return errors.New("application dialog creator capacity")
	}
	if s.ApplicationDialogs == nil {
		s.ApplicationDialogs = map[string]ApplicationDialogHead{}
	}
	r.Body.Members = append([]string(nil), r.Body.Members...)
	s.ApplicationDialogs[id] = ApplicationDialogHead{r, hash}
	return nil
}
func verifyApplicationDialogs(s State) error {
	if len(s.ApplicationDialogs) > 1024 {
		return errors.New("application dialog capacity")
	}
	counts := map[string]int{}
	for id, head := range s.ApplicationDialogs {
		r, key, hash, err := decodeApplicationDialog(s, canonical(head.Record))
		if err != nil {
			return err
		}
		if id != key || hash != head.Digest {
			return errors.New("application dialog head")
		}
		counts[r.Body.Creator]++
		if counts[r.Body.Creator] > 128 {
			return errors.New("application dialog creator capacity")
		}
	}
	return nil
}
