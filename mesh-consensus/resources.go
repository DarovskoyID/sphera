package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"

	"github.com/cometbft/cometbft/types"
)

// Laboratory assessments describe operator-measured capacity, not a storage
// proof or Sybil policy. Three pinned validators must attest the same body.
type ResourceBody struct {
	Domain        string `json:"domain"`
	Network       string `json:"network"`
	NodeID        string `json:"node_id"`
	CandidateHash string `json:"candidate_hash"`
	Version       int64  `json:"version"`
	Previous      string `json:"previous"`
	FailureDomain string `json:"failure_domain"`
	CapacitySlots int    `json:"capacity_slots"`
	IssuedAt      int64  `json:"issued_at"`
	ExpiresAt     int64  `json:"expires_at"`
}
type ResourceRecord struct {
	Body     ResourceBody `json:"body"`
	Consents []Consent    `json:"consents"`
}
type ResourceHead struct {
	Record     ResourceRecord `json:"record"`
	Digest     string         `json:"digest"`
	AcceptedAt int64          `json:"accepted_at"`
}

func validatePolicyKeys(keys map[string]string) error {
	if len(keys) == 0 {
		return nil
	}
	if len(keys) != 4 {
		return errors.New("four pinned placement assessors required")
	}
	return validateIssuers(keys)
}
func genesisPolicyKeys(genesis *types.GenesisDoc) (map[string]string, error) {
	if _, err := genesisIssuers(genesis.AppState); err != nil {
		return nil, err
	}
	var config GenesisApplication
	if len(genesis.AppState) > 0 {
		if err := json.Unmarshal(genesis.AppState, &config); err != nil {
			return nil, err
		}
	}
	if !config.PlacementPolicy {
		return nil, nil
	}
	if len(config.Issuers) == 0 {
		return nil, errors.New("placement policy requires issuers")
	}
	keys := map[string]string{}
	for _, v := range genesis.Validators {
		if v.PubKey == nil || v.PubKey.Type() != "ed25519" || v.Power != 1 {
			return nil, errors.New("unsupported placement assessor")
		}
		public := v.PubKey.Bytes()
		hash := sha256.Sum256(public)
		keys[hex.EncodeToString(hash[:])] = hex.EncodeToString(public)
	}
	return keys, validatePolicyKeys(keys)
}

var failureDomainName = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`)

func decodeResource(tx []byte, network string, keys map[string]string) (ResourceRecord, string, error) {
	var r ResourceRecord
	if len(tx) > 16384 || len(keys) != 4 {
		return r, "", errors.New("resource policy unavailable or record too large")
	}
	d := json.NewDecoder(bytes.NewReader(tx))
	d.DisallowUnknownFields()
	if err := d.Decode(&r); err != nil {
		return r, "", err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return r, "", errors.New("trailing resource record")
	}
	b := r.Body
	if !bytes.Equal(tx, canonical(r)) || b.Domain != "sfera-mesh-resource-v1" || b.Network != network || !hex64.MatchString(b.NodeID) || !hex64.MatchString(b.CandidateHash) || !hex64.MatchString(b.Previous) || b.Version < 1 || (b.Version == 1 && b.Previous != zero) || !failureDomainName.MatchString(b.FailureDomain) || b.CapacitySlots < 0 || b.CapacitySlots > 2 || b.IssuedAt < 0 || b.IssuedAt > int64(^uint64(0)>>1)-300 || b.ExpiresAt <= b.IssuedAt || b.ExpiresAt > b.IssuedAt+300 || len(r.Consents) != 3 {
		return r, "", errors.New("invalid resource context")
	}
	prior := ""
	for _, consent := range r.Consents {
		public, err := hex.DecodeString(consent.PublicKey)
		if err != nil || !hex64.MatchString(consent.PublicKey) || consent.PublicKey <= prior {
			return r, "", errors.New("distinct sorted resource assessors required")
		}
		hash := sha256.Sum256(public)
		sig, err := hex.DecodeString(consent.Signature)
		if keys[hex.EncodeToString(hash[:])] != consent.PublicKey || err != nil || len(sig) != 64 || hex.EncodeToString(sig) != consent.Signature || !ed25519.Verify(public, canonical(b), sig) {
			return r, "", errors.New("resource assessor signature")
		}
		prior = consent.PublicKey
	}
	return r, hex.EncodeToString(digest(r)), nil
}

func applyResource(s *State, tx []byte) error {
	r, hash, err := decodeResource(tx, s.Network, s.PolicyKeys)
	if err != nil {
		return err
	}
	b := r.Body
	old, exists := s.Resources[b.NodeID]
	if exists && old.Digest == hash {
		return nil
	}
	if (!exists && b.Version != 1) || (exists && (old.Record.Body.Version == int64(^uint64(0)>>1) || b.Version != old.Record.Body.Version+1 || b.Previous != old.Digest)) {
		return errors.New("resource version conflict")
	}
	candidate, ok := s.Candidates[b.NodeID]
	if !ok || candidate.Digest != b.CandidateHash || verifyLicense(candidate.Record.Body.License, s.Issuers, b.NodeID, s.Network, s.BlockTime) != nil {
		return errors.New("fresh bound candidate required")
	}
	if s.BlockTime <= 0 || b.IssuedAt > s.BlockTime+30 || b.ExpiresAt <= s.BlockTime || b.ExpiresAt > candidate.Record.Body.License.Claims.ExpiresAt {
		return errors.New("resource assessment expired or invalid time")
	}
	if s.Resources == nil {
		s.Resources = map[string]ResourceHead{}
	}
	s.Resources[b.NodeID] = ResourceHead{r, hash, s.BlockTime}
	return nil
}

func verifyResourceRegistry(s State) error {
	if err := validatePolicyKeys(s.PolicyKeys); err != nil {
		return err
	}
	if len(s.Resources) > 128 {
		return errors.New("resource laboratory limit")
	}
	for id, head := range s.Resources {
		r, hash, err := decodeResource(canonical(head.Record), s.Network, s.PolicyKeys)
		if err != nil || r.Body.NodeID != id || hash != head.Digest || head.AcceptedAt <= 0 || head.AcceptedAt > s.BlockTime || r.Body.IssuedAt > head.AcceptedAt+30 || r.Body.ExpiresAt <= head.AcceptedAt {
			return errors.New("invalid resource snapshot")
		}
	}
	return nil
}

func assessedResource(s State, id string) (ResourceBody, bool) {
	resource, ok := s.Resources[id]
	candidate, exists := s.Candidates[id]
	b := resource.Record.Body
	return b, ok && exists && b.CandidateHash == candidate.Digest && b.ExpiresAt > s.BlockTime && candidate.Record.Body.Available && verifyLicense(candidate.Record.Body.License, s.Issuers, id, s.Network, s.BlockTime) == nil
}
func membershipCount(s State, id string) int {
	count := 0
	for _, head := range s.Placements {
		for _, member := range head.Record.Body.Members {
			if member == id {
				count++
			}
		}
	}
	return count
}

func enforcePlacementPolicy(s State, p Placement, exists bool) error {
	if len(s.PolicyKeys) == 0 {
		return nil
	}
	domains := map[string]bool{}
	priorMembers := map[string]bool{}
	if exists {
		for _, id := range s.Placements[p.Body.Cluster].Record.Body.Members {
			priorMembers[id] = true
		}
	}
	survivors := []string{}
	replacement := ""
	for i, id := range p.Body.Members {
		resource, ok := assessedResource(s, id)
		needed := membershipCount(s, id)
		if !priorMembers[id] {
			needed++
		}
		if !ok || resource.CapacitySlots < needed || domains[resource.FailureDomain] || !bytes.Equal(canonical(p.Licenses[i]), canonical(s.Candidates[id].Record.Body.License)) {
			return errors.New("assessed independent capacity and current profiles required")
		}
		domains[resource.FailureDomain] = true
		if priorMembers[id] {
			survivors = append(survivors, id)
		} else {
			replacement = id
		}
	}
	if !exists {
		return nil
	} // Initial triples require admissibility; global matching is a separate problem.
	admissible := map[string]bool{}
	plannedReturn := false
	for id := range priorMembers {
		kept := false
		for _, member := range survivors {
			if id == member {
				kept = true
			}
		}
		if kept {
			continue
		}
		resource, ok := assessedResource(s, id)
		if !ok {
			return errors.New("fresh departure assessment required")
		}
		if ok && membershipCount(s, id) == 2 && resource.CapacitySlots >= 2 {
			if !borrowedFromHistory(s, id, p.Body.Cluster) || p.Body.Domain != "sfera-mesh-placement-v3" {
				return errors.New("history-proven manifest-bound return required")
			}
			if _, exists := s.Manifests[p.Body.Cluster]; !exists {
				return errors.New("return manifest required")
			}
			plannedReturn = true
		}
	}
	survivorDomains := map[string]bool{}
	for _, id := range survivors {
		resource, _ := assessedResource(s, id)
		survivorDomains[resource.FailureDomain] = true
	}
	for id := range s.Candidates {
		resource, ok := assessedResource(s, id)
		if ok && !survivorDomains[resource.FailureDomain] && resource.CapacitySlots > membershipCount(s, id) && (!plannedReturn || membershipCount(s, id) == 0) {
			admissible[id] = true
		}
	}
	best, err := registeredReplacement(s, survivors, p.Body.Cluster, admissible)
	if err != nil {
		return err
	}
	if best == "" || best != replacement {
		return errors.New("best assessed replacement required")
	}
	return nil
}
