package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
)

// Candidate records are short-lived offers, not admission as a validator or
// evidence of physical capacity/operator independence. A license grants neither.
type CandidateBody struct {
	Domain    string          `json:"domain"`
	Network   string          `json:"network"`
	NodeID    string          `json:"node_id"`
	PublicKey string          `json:"public_key"`
	Version   int64           `json:"version"`
	Previous  string          `json:"previous"`
	Available bool            `json:"available"`
	License   LicenseDocument `json:"license"`
}
type CandidateRecord struct {
	Body      CandidateBody `json:"body"`
	Signature string        `json:"signature"`
}
type CandidateHead struct {
	Record     CandidateRecord `json:"record"`
	Digest     string          `json:"digest"`
	AcceptedAt int64           `json:"accepted_at"`
}

func decodeCandidate(tx []byte, network string) (CandidateRecord, string, error) {
	var r CandidateRecord
	if len(tx) > 16384 {
		return r, "", errors.New("candidate too large")
	}
	d := json.NewDecoder(bytes.NewReader(tx))
	d.DisallowUnknownFields()
	if err := d.Decode(&r); err != nil {
		return r, "", err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return r, "", errors.New("trailing candidate")
	}
	b := r.Body
	if !bytes.Equal(tx, canonical(r)) || b.Domain != "sfera-mesh-candidate-v1" || b.Network != network || b.Version < 1 || !hex64.MatchString(b.Previous) || !hex64.MatchString(b.NodeID) || !hex64.MatchString(b.PublicKey) {
		return r, "", errors.New("invalid candidate context")
	}
	public, _ := hex.DecodeString(b.PublicKey)
	sig, err := hex.DecodeString(r.Signature)
	if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != r.Signature || hex.EncodeToString(hashNode(public)) != b.NodeID || !ed25519.Verify(public, canonical(b), sig) {
		return r, "", errors.New("candidate owner signature")
	}
	return r, hex.EncodeToString(digest(r)), nil
}

func applyCandidate(s *State, tx []byte) error {
	r, hash, err := decodeCandidate(tx, s.Network)
	if err != nil {
		return err
	}
	old, exists := s.Candidates[r.Body.NodeID]
	if exists && old.Digest == hash {
		return nil
	}
	if (!exists && (r.Body.Version != 1 || r.Body.Previous != zero)) || (exists && (old.Record.Body.Version == int64(^uint64(0)>>1) || r.Body.Version != old.Record.Body.Version+1 || r.Body.Previous != old.Digest)) {
		return errors.New("candidate version conflict")
	}
	if err := verifyLicense(r.Body.License, s.Issuers, r.Body.NodeID, s.Network, s.BlockTime); err != nil {
		return err
	}
	// Bounded laboratory state; expired heads stay to prevent version replay.
	if !exists && len(s.Candidates) >= 128 {
		return errors.New("candidate laboratory limit")
	}
	if r.Body.Available {
		for id, head := range s.Candidates {
			if id != r.Body.NodeID && head.Record.Body.Available && head.Record.Body.License.Claims.ExpiresAt > s.BlockTime && head.Record.Body.License.Claims.InstanceID == r.Body.License.Claims.InstanceID {
				return errors.New("duplicate candidate license instance")
			}
		}
	}
	if s.Candidates == nil {
		s.Candidates = map[string]CandidateHead{}
	}
	s.Candidates[r.Body.NodeID] = CandidateHead{r, hash, s.BlockTime}
	return nil
}

// registeredReplacement chooses by commercial criteria only. The caller must
// supply the admissible IDs after independent resource/failure-domain checks.
// Memberships come from consensus, never from the proposing node.
func registeredReplacement(s State, survivors []string, cluster string, admissible map[string]bool) (string, error) {
	head, ok := s.Placements[cluster]
	if !ok || len(survivors) != 2 || survivors[0] == survivors[1] {
		return "", errors.New("two current survivors required")
	}
	members := map[string]bool{}
	for _, id := range head.Record.Body.Members {
		members[id] = true
	}
	documents := []LicenseDocument{}
	for _, id := range survivors {
		entry, exists := s.Candidates[id]
		if !members[id] || !exists || verifyLicense(entry.Record.Body.License, s.Issuers, id, s.Network, s.BlockTime) != nil {
			return "", errors.New("fresh survivor profile required")
		}
		documents = append(documents, entry.Record.Body.License)
	}
	best, bestSpread, bestMismatch, bestMemberships := "", 0, 0, 0
	for id, entry := range s.Candidates {
		if !admissible[id] || members[id] || !entry.Record.Body.Available || verifyLicense(entry.Record.Body.License, s.Issuers, id, s.Network, s.BlockTime) != nil {
			continue
		}
		memberships := 0
		for _, placement := range s.Placements {
			for _, member := range placement.Record.Body.Members {
				if member == id {
					memberships++
				}
			}
		}
		if memberships >= 2 {
			continue
		}
		group := []LicenseDocument{documents[0], documents[1], entry.Record.Body.License}
		spread, mismatch, err := placementModuleScore(group)
		if err != nil {
			return "", err
		}
		if best == "" || spread < bestSpread || (spread == bestSpread && (mismatch < bestMismatch || (mismatch == bestMismatch && (memberships < bestMemberships || (memberships == bestMemberships && id < best))))) {
			best, bestSpread, bestMismatch, bestMemberships = id, spread, mismatch, memberships
		}
	}
	return best, nil
}

func verifyCandidateRegistry(s State) error {
	if len(s.Candidates) > 128 {
		return errors.New("candidate laboratory limit")
	}
	instances := map[string]string{}
	for id, head := range s.Candidates {
		r, hash, err := decodeCandidate(canonical(head.Record), s.Network)
		if err != nil || r.Body.NodeID != id || hash != head.Digest || head.AcceptedAt <= 0 || head.AcceptedAt > s.BlockTime || (r.Body.Version == 1 && r.Body.Previous != zero) {
			return errors.New("invalid candidate snapshot")
		}
		if err := verifyLicense(r.Body.License, s.Issuers, id, s.Network, head.AcceptedAt); err != nil {
			return err
		}
		// Only simultaneous active offers must use distinct license instances.
		if r.Body.Available && r.Body.License.Claims.ExpiresAt > s.BlockTime {
			instance := r.Body.License.Claims.InstanceID
			if prior, ok := instances[instance]; ok && prior != id {
				return errors.New("duplicate candidate license instance")
			}
			instances[instance] = id
		}
	}
	return nil
}
