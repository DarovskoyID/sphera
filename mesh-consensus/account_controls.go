package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// The first account public key stays the immutable identity anchor. Only this
// separately committed chain changes who may authorize subsequent operations.
type AccountControlBody struct {
	ReplacementDigest string `json:"replacement_digest"`
	Domain            string `json:"domain"`
	Network           string `json:"network"`
	Genesis           string `json:"genesis"`
	Owner             string `json:"owner"`
	Epoch             int64  `json:"epoch"`
	Previous          string `json:"previous"`
	OldPublic         string `json:"old_public"`
	NewPublic         string `json:"new_public"`
	AccountVersion    int64  `json:"account_version"`
	AccountDigest     string `json:"account_digest"`
	DevicesVersion    int64  `json:"devices_version"`
	DevicesDigest     string `json:"devices_digest"`
}
type AccountControl struct {
	Body         AccountControlBody `json:"body"`
	OldSignature string             `json:"old_signature"`
	NewSignature string             `json:"new_signature"`
}
type AccountControlHead struct {
	Record AccountControl `json:"record"`
	Digest string         `json:"digest"`
}

func controlPublic(s State, owner string) string {
	if history := s.AccountControls[owner]; len(history) > 0 {
		return history[len(history)-1].Record.Body.NewPublic
	}
	return s.Accounts[owner].Record.Body.PublicKey
}
func historicalControlPublic(s State, owner string, version int64, devices bool) string {
	public := s.Accounts[owner].Record.Body.PublicKey
	for _, head := range s.AccountControls[owner] {
		cut := head.Record.Body.AccountVersion
		if devices {
			cut = head.Record.Body.DevicesVersion
		}
		if version > cut {
			public = head.Record.Body.NewPublic
		} else {
			break
		}
	}
	return public
}
func decodeAccountControl(tx []byte, s State) (AccountControl, string, error) {
	var r AccountControl
	if len(tx) > 4096 || json.Unmarshal(tx, &r) != nil || !bytes.Equal(tx, canonical(r)) {
		return r, "", errors.New("invalid root transition encoding")
	}
	b := r.Body
	if b.Domain != "sfera-mesh-account-control-v1" || b.Network != s.Network || b.Genesis != s.GenesisPin || b.Epoch < 1 || b.Epoch > 16 || b.AccountVersion < 1 || b.DevicesVersion < 0 || b.DevicesVersion > 256 {
		return r, "", errors.New("invalid root transition context")
	}
	for _, v := range []string{b.Genesis, b.Owner, b.Previous, b.OldPublic, b.NewPublic, b.AccountDigest, b.DevicesDigest, b.ReplacementDigest} {
		if !hex64.MatchString(v) {
			return r, "", errors.New("invalid root transition field")
		}
	}
	if _, ok := s.Accounts[b.Owner]; !ok || b.OldPublic == b.NewPublic {
		return r, "", errors.New("root transition owner missing or unchanged")
	}
	for _, item := range []struct{ public, sig string }{{b.OldPublic, r.OldSignature}, {b.NewPublic, r.NewSignature}} {
		public, _ := hex.DecodeString(item.public)
		sig, err := hex.DecodeString(item.sig)
		if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != item.sig || !ed25519.Verify(public, canonical(b), sig) {
			return r, "", errors.New("root transition dual signature")
		}
	}
	return r, hex.EncodeToString(digest(r)), nil
}
func applyAccountControl(s *State, tx []byte) error {
	r, h, err := decodeAccountControl(tx, *s)
	if err != nil {
		return err
	}
	b := r.Body
	history := s.AccountControls[b.Owner]
	if b.Epoch <= int64(len(history)) {
		if history[b.Epoch-1].Digest == h {
			return nil
		}
		return errors.New("root transition epoch conflict")
	}
	previous := zero
	if len(history) > 0 {
		previous = history[len(history)-1].Digest
	}
	account := s.Accounts[b.Owner]
	devices := s.Devices[b.Owner]
	deviceDigest := zero
	if len(devices) > 0 {
		deviceDigest = devices[len(devices)-1].Digest
	}
	if b.Epoch != int64(len(history)+1) || b.Previous != previous || b.OldPublic != controlPublic(*s, b.Owner) || b.AccountVersion != account.Record.Body.Version || b.AccountDigest != account.Digest || b.DevicesVersion != int64(len(devices)) || b.DevicesDigest != deviceDigest {
		return errors.New("root transition checkpoint conflict")
	}
	total := 0
	for _, heads := range s.AccountControls {
		total += len(heads)
		for _, head := range heads {
			if head.Record.Body.NewPublic == b.NewPublic {
				return errors.New("root key reuse")
			}
		}
	}
	if total >= 256 {
		return errors.New("root transition capacity")
	}
	for _, head := range s.Accounts {
		if head.Record.Body.PublicKey == b.NewPublic {
			return errors.New("root identity key reuse")
		}
	}
	for _, heads := range s.Devices {
		for _, head := range heads {
			if head.Event.Body.DevicePublic == b.NewPublic {
				return errors.New("root must not reuse device key")
			}
		}
	}
	if s.AccountControls == nil {
		s.AccountControls = map[string][]AccountControlHead{}
	}
	s.AccountControls[b.Owner] = append(append([]AccountControlHead(nil), history...), AccountControlHead{r, h})
	return nil
}
func verifyAccountControls(s State) error {
	seen := map[string]bool{}
	total := 0
	for owner, heads := range s.AccountControls {
		account, ok := s.Accounts[owner]
		if !ok || len(heads) < 1 || len(heads) > 16 {
			return errors.New("invalid root history")
		}
		public, previous := account.Record.Body.PublicKey, zero
		var accountVersion, devicesVersion int64
		accountDigest := ""
		for index, head := range heads {
			total++
			if total > 256 {
				return errors.New("root history capacity")
			}
			r, h, err := decodeAccountControl(canonical(head.Record), s)
			if err != nil {
				return err
			}
			b := r.Body
			if b.Owner != owner || b.Epoch != int64(index+1) || b.Previous != previous || b.OldPublic != public || head.Digest != h || seen[b.NewPublic] || b.NewPublic == account.Record.Body.PublicKey || b.AccountVersion <= accountVersion || b.DevicesVersion < devicesVersion || b.AccountVersion >= account.Record.Body.Version || b.DevicesVersion > int64(len(s.Devices[owner])) {
				return errors.New("root history gap or fork")
			}
			if b.AccountVersion == accountVersion && b.AccountDigest != accountDigest {
				return errors.New("root history account checkpoint fork")
			}
			if b.AccountVersion == account.Record.Body.Version && b.AccountDigest != account.Digest {
				return errors.New("root account checkpoint mismatch")
			}
			if b.AccountVersion+1 == account.Record.Body.Version && b.ReplacementDigest != account.Digest {
				return errors.New("root replacement account mismatch")
			}
			deviceDigest := zero
			if b.DevicesVersion > 0 {
				deviceDigest = s.Devices[owner][b.DevicesVersion-1].Digest
			}
			if b.DevicesDigest != deviceDigest {
				return errors.New("root device checkpoint mismatch")
			}
			for _, a := range s.Accounts {
				if a.Record.Body.PublicKey == b.NewPublic {
					return errors.New("root identity key reuse")
				}
			}
			for _, devices := range s.Devices {
				for _, d := range devices {
					if d.Event.Body.DevicePublic == b.NewPublic {
						return errors.New("root device key reuse")
					}
				}
			}
			seen[b.NewPublic] = true
			public = b.NewPublic
			previous = h
			accountVersion = b.AccountVersion
			accountDigest = b.AccountDigest
			devicesVersion = b.DevicesVersion
		}
	}
	return nil
}

type AccountControlUpdate struct {
	Body struct {
		Domain  string `json:"domain"`
		Network string `json:"network"`
		Genesis string `json:"genesis"`
	} `json:"body"`
	Control AccountControl `json:"control"`
	Account Record         `json:"account"`
}

func applyAccountControlUpdate(s *State, tx []byte) error {
	var update AccountControlUpdate
	if len(tx) > 16384 || json.Unmarshal(tx, &update) != nil || !bytes.Equal(tx, canonical(update)) || update.Body.Domain != "sfera-mesh-account-control-update-v1" || update.Body.Network != s.Network || update.Body.Genesis != s.GenesisPin {
		return errors.New("invalid atomic root update")
	}
	b := update.Control.Body
	account := update.Account.Body
	if account.UserID != b.Owner || account.Version != b.AccountVersion+1 || account.Previous != b.AccountDigest || hex.EncodeToString(digest(update.Account)) != b.ReplacementDigest {
		return errors.New("root replacement binding mismatch")
	}
	if old, ok := s.Accounts[b.Owner]; !ok || account.PublicKey != old.Record.Body.PublicKey || account.DialogsDigest != old.Record.Body.DialogsDigest {
		return errors.New("root update must preserve identity and history")
	}
	staged := clone(*s)
	if err := applyAccountControl(&staged, canonical(update.Control)); err != nil {
		return err
	}
	if heads := s.AccountControls[b.Owner]; b.Epoch <= int64(len(heads)) {
		_, _, err := decodeRecordWithSigner(canonical(update.Account), s.Network, historicalControlPublic(staged, b.Owner, account.Version, false))
		return err
	}
	if err := apply(&staged, canonical(update.Account)); err != nil {
		return err
	}
	s.AccountControls = staged.AccountControls
	s.Accounts = staged.Accounts
	return nil
}
