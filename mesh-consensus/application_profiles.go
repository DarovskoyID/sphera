package main

// Public application names are owner-authorized consensus data. Passwords,
// email addresses, archive keys and application JWTs never belong here.
import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"unicode/utf8"
)

type ApplicationProfileBody struct {
	Domain       string `json:"domain"`
	Network      string `json:"network"`
	Genesis      string `json:"genesis"`
	Owner        string `json:"owner"`
	ControlEpoch int64  `json:"control_epoch"`
	Version      int64  `json:"version"`
	Previous     string `json:"previous"`
	Handle       string `json:"handle"`
	// Hex keeps the signed canonical schema ASCII across Go/Python/JS.
	NicknameUTF8 string `json:"nickname_utf8"`
}
type ApplicationProfileRecord struct {
	Body      ApplicationProfileBody `json:"body"`
	Signature string                 `json:"signature"`
}
type ApplicationProfileHead struct {
	Record ApplicationProfileRecord `json:"record"`
	Digest string                   `json:"digest"`
}

var applicationHandle = regexp.MustCompile(`^[a-z][a-z0-9_]{2,31}$`)

func decodeApplicationProfile(s State, tx []byte) (ApplicationProfileRecord, string, error) {
	var r ApplicationProfileRecord
	if len(tx) > 2048 || json.Unmarshal(tx, &r) != nil || !bytes.Equal(tx, canonical(r)) {
		return r, "", errors.New("application profile encoding")
	}
	b := r.Body
	account, exists := s.Accounts[b.Owner]
	if !exists || b.Domain != "sfera-mesh-application-profile-v1" || b.Network != s.Network || b.Genesis != s.GenesisPin || !hex64.MatchString(b.Genesis) || b.Version < 1 || b.Version > 64 || !hex64.MatchString(b.Previous) || !applicationHandle.MatchString(b.Handle) || b.ControlEpoch < 0 || b.ControlEpoch > int64(len(s.AccountControls[b.Owner])) {
		return r, "", errors.New("application profile context")
	}
	name, err := hex.DecodeString(b.NicknameUTF8)
	if err != nil || hex.EncodeToString(name) != b.NicknameUTF8 || len(name) < 1 || len(name) > 160 || !utf8.Valid(name) || utf8.RuneCount(name) > 50 {
		return r, "", errors.New("application profile nickname")
	}
	for _, c := range string(name) {
		if c < 32 || c == 127 || c >= 0x80 && c <= 0x9f {
			return r, "", errors.New("application profile control character")
		}
	}
	public := account.Record.Body.PublicKey
	if b.ControlEpoch > 0 {
		public = s.AccountControls[b.Owner][b.ControlEpoch-1].Record.Body.NewPublic
	}
	pub, _ := hex.DecodeString(public)
	sig, err := hex.DecodeString(r.Signature)
	if err != nil || len(pub) != 32 || len(sig) != 64 || hex.EncodeToString(sig) != r.Signature || !ed25519.Verify(pub, canonical(b), sig) {
		return r, "", errors.New("application profile signature")
	}
	return r, hex.EncodeToString(digest(r)), nil
}

func applyApplicationProfile(s *State, tx []byte) error {
	r, h, err := decodeApplicationProfile(*s, tx)
	if err != nil {
		return err
	}
	b := r.Body
	history := s.ApplicationProfiles[b.Owner]
	if len(history) > 0 && history[len(history)-1].Digest == h {
		return nil
	}
	if b.ControlEpoch != int64(len(s.AccountControls[b.Owner])) {
		return errors.New("application profile retired owner key")
	}
	previous := zero
	if len(history) > 0 {
		previous = history[len(history)-1].Digest
	}
	if b.Version != int64(len(history)+1) || b.Previous != previous {
		return errors.New("application profile conflict")
	}
	total := 0
	for owner, heads := range s.ApplicationProfiles {
		total += len(heads)
		for _, head := range heads {
			if owner != b.Owner && head.Record.Body.Handle == b.Handle {
				return errors.New("application handle reserved")
			}
		}
	}
	if total >= 1024 || len(history) == 0 && len(s.ApplicationProfiles) >= 256 {
		return errors.New("application profile capacity")
	}
	if s.ApplicationProfiles == nil {
		s.ApplicationProfiles = map[string][]ApplicationProfileHead{}
	}
	s.ApplicationProfiles[b.Owner] = append(append([]ApplicationProfileHead(nil), history...), ApplicationProfileHead{r, h})
	return nil
}

func verifyApplicationProfiles(s State) error {
	if len(s.ApplicationProfiles) > 256 {
		return errors.New("application profile capacity")
	}
	reserved := map[string]string{}
	total := 0
	for owner, history := range s.ApplicationProfiles {
		if len(history) < 1 || len(history) > 64 {
			return errors.New("application profile history")
		}
		previous := zero
		var epoch int64
		for index, head := range history {
			r, h, err := decodeApplicationProfile(s, canonical(head.Record))
			if err != nil {
				return err
			}
			b := r.Body
			if b.Owner != owner || b.Version != int64(index+1) || b.Previous != previous || h != head.Digest || b.ControlEpoch < epoch {
				return errors.New("application profile history fork")
			}
			if other, ok := reserved[b.Handle]; ok && other != owner {
				return errors.New("application handle collision")
			}
			reserved[b.Handle] = owner
			previous = h
			epoch = b.ControlEpoch
			total++
		}
	}
	if total > 1024 {
		return errors.New("application profile capacity")
	}
	return nil
}
