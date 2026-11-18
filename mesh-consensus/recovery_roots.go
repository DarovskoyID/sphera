package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
)

// The namespace includes the publisher: a first claim cannot capture another
// application's chat UUID. This commits a current pointer, not plaintext ACLs.
type RecoveryRootBody struct {
	Domain    string   `json:"domain"`
	Network   string   `json:"network"`
	Genesis   string   `json:"genesis"`
	Publisher string   `json:"publisher"`
	PublicKey string   `json:"public_key"`
	Source    string   `json:"source"`
	Scope     string   `json:"scope"`
	Version   int64    `json:"version"`
	Previous  string   `json:"previous"`
	Cluster   string   `json:"cluster"`
	Digest    string   `json:"digest"`
	Size      int64    `json:"size"`
	Messages  []string `json:"messages"`
	Deleted   []string `json:"deleted"`
}
type RecoveryRootRecord struct {
	Body      RecoveryRootBody `json:"body"`
	Signature string           `json:"signature"`
}
type RecoveryRootHead struct {
	Record RecoveryRootRecord `json:"record"`
	Digest string             `json:"digest"`
}

var recoveryScope = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func recoveryRootKey(b RecoveryRootBody) string {
	return hex.EncodeToString(digest(map[string]string{"domain": "sfera-mesh-recovery-namespace-v1", "publisher": b.Publisher, "source": b.Source, "scope": b.Scope}))
}
func decodeRecoveryRoot(tx []byte, s State) (RecoveryRootRecord, string, error) {
	var r RecoveryRootRecord
	if len(tx) > 32768 || json.Unmarshal(tx, &r) != nil || !bytes.Equal(tx, canonical(r)) {
		return r, "", errors.New("invalid recovery root record")
	}
	b := r.Body
	if b.Domain != "sfera-mesh-recovery-root-v1" || b.Network != s.Network || b.Genesis != s.GenesisPin || !hex64.MatchString(b.Genesis) ||
		(b.Source != "dm" && b.Source != "guild") || !recoveryScope.MatchString(b.Scope) || b.Version < 1 ||
		(b.Version == 1 && b.Previous != zero) || b.Size < 1 || b.Size > 262144 {
		return r, "", errors.New("invalid recovery root context")
	}
	for _, value := range []string{b.Publisher, b.PublicKey, b.Previous, b.Cluster, b.Digest} {
		if !hex64.MatchString(value) {
			return r, "", errors.New("invalid recovery root digest")
		}
	}
	if b.Messages == nil || b.Deleted == nil || len(b.Messages) > 256 || len(b.Deleted) > len(b.Messages) {
		return r, "", errors.New("invalid recovery root message set")
	}
	for i, id := range b.Messages {
		if !recoveryScope.MatchString(id) || (i > 0 && b.Messages[i-1] >= id) {
			return r, "", errors.New("invalid recovery root message order")
		}
	}
	for i, id := range b.Deleted {
		j := sort.SearchStrings(b.Messages, id)
		if (i > 0 && b.Deleted[i-1] >= id) || j == len(b.Messages) || b.Messages[j] != id {
			return r, "", errors.New("invalid recovery root deletion set")
		}
	}
	public, _ := hex.DecodeString(b.PublicKey)
	signature, err := hex.DecodeString(r.Signature)
	if err != nil || len(signature) != 64 || hex.EncodeToString(signature) != r.Signature || hex.EncodeToString(hashNode(public)) != b.Publisher || !ed25519.Verify(public, canonical(b), signature) {
		return r, "", errors.New("invalid recovery root signature")
	}
	candidate, ok := s.Candidates[b.Publisher]
	if !ok || candidate.Record.Body.PublicKey != b.PublicKey {
		return r, "", errors.New("registered recovery publisher required")
	}
	manifest, ok := s.Manifests[b.Cluster]
	if !ok || manifest.Record.Body.Sizes == nil {
		return r, "", errors.New("sized recovery manifest required")
	}
	values := manifest.Record.Body.Digests
	sizes := *manifest.Record.Body.Sizes
	i := sort.SearchStrings(values, b.Digest)
	if len(values) != len(sizes) || i == len(values) || values[i] != b.Digest || sizes[i] != b.Size {
		return r, "", errors.New("uncommitted recovery root block")
	}
	return r, hex.EncodeToString(digest(r)), nil
}
func applyRecoveryRoot(s *State, tx []byte) error {
	r, h, err := decodeRecoveryRoot(tx, *s)
	if err != nil {
		return err
	}
	key := recoveryRootKey(r.Body)
	if _, upgraded := s.RecoveryTrees[key]; upgraded {
		return errors.New("recovery namespace already migrated to tree v2")
	}
	old, exists := s.RecoveryRoots[key]
	if !exists {
		names := map[string]bool{}
		for identity := range s.RecoveryRoots {
			names[identity] = true
		}
		for identity := range s.RecoveryTrees {
			names[identity] = true
		}
		if !names[key] && len(names) >= 128 {
			return errors.New("recovery namespace capacity")
		}
	}
	if exists && old.Digest == h {
		return nil
	}
	if err := verifyLicense(s.Candidates[r.Body.Publisher].Record.Body.License, s.Issuers, r.Body.Publisher, s.Network, s.BlockTime); err != nil {
		return err
	}
	if (!exists && (r.Body.Version != 1 || len(s.RecoveryRoots) >= 128)) ||
		(exists && (old.Record.Body.Version == int64(^uint64(0)>>1) || r.Body.Version != old.Record.Body.Version+1 || r.Body.Previous != old.Digest)) {
		return errors.New("recovery root version conflict")
	}
	if exists {
		for _, pair := range [][2][]string{{old.Record.Body.Messages, r.Body.Messages}, {old.Record.Body.Deleted, r.Body.Deleted}} {
			for _, id := range pair[0] {
				i := sort.SearchStrings(pair[1], id)
				if i == len(pair[1]) || pair[1][i] != id {
					return errors.New("recovery root omission or resurrection")
				}
			}
		}
	}
	total := len(r.Body.Messages)
	for identity, head := range s.RecoveryRoots {
		if identity != key {
			total += len(head.Record.Body.Messages)
		}
	}
	if total > 512 {
		return errors.New("recovery root message registry limit")
	}
	// No mutation occurs until all validation succeeds: FinalizeBlock does not
	// roll back a handler's partial writes when that handler rejects a tx.
	if s.RecoveryRoots == nil {
		s.RecoveryRoots = map[string]RecoveryRootHead{}
	}
	s.RecoveryRoots[key] = RecoveryRootHead{r, h}
	return nil
}
func verifyRecoveryRoots(s State) error {
	if len(s.RecoveryRoots) > 128 {
		return errors.New("recovery root registry limit")
	}
	total := 0
	for key, head := range s.RecoveryRoots {
		r, h, err := decodeRecoveryRoot(canonical(head.Record), s)
		if err != nil || key != recoveryRootKey(r.Body) || h != head.Digest {
			return errors.New("invalid recovery root snapshot")
		}
		total += len(r.Body.Messages)
	}
	if total > 512 {
		return errors.New("recovery root message registry limit")
	}
	return nil
}
