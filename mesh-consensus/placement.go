package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sort"
)

type PlacementBody struct {
	Domain       string   `json:"domain"`
	Network      string   `json:"network"`
	Cluster      string   `json:"cluster"`
	Epoch        int64    `json:"epoch"`
	Previous     string   `json:"previous"`
	Members      []string `json:"members"`
	LicensesHash string   `json:"licenses_hash,omitempty"`
}
type Consent struct {
	PublicKey string `json:"public_key"`
	Signature string `json:"signature"`
}
type Placement struct {
	Body     PlacementBody     `json:"body"`
	Consents []Consent         `json:"consents"`
	Licenses []LicenseDocument `json:"licenses,omitempty"`
}
type PlacementHead struct {
	Record     Placement `json:"record"`
	Digest     string    `json:"digest"`
	AcceptedAt int64     `json:"accepted_at,omitempty"`
}

func clusterID(network string, members []string) string {
	return hex.EncodeToString(digest(map[string]any{"domain": "sfera-mesh-cluster-v1", "network": network, "members": members}))
}
func decodePlacement(tx []byte, network string) (Placement, string, error) {
	var p Placement
	if len(tx) > 16384 {
		return p, "", errors.New("placement too large")
	}
	d := json.NewDecoder(bytes.NewReader(tx))
	d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil {
		return p, "", err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return p, "", errors.New("trailing placement")
	}
	b := p.Body
	if !bytes.Equal(tx, canonical(p)) || (b.Domain != "sfera-mesh-placement-v1" && b.Domain != "sfera-mesh-placement-v2") || b.Network != network || !hex64.MatchString(b.Cluster) || b.Epoch < 1 || !hex64.MatchString(b.Previous) || len(b.Members) != 3 || len(p.Consents) != 3 || !sort.StringsAreSorted(b.Members) {
		return p, "", errors.New("placement context")
	}
	if b.Domain == "sfera-mesh-placement-v1" {
		if b.LicensesHash != "" || len(p.Licenses) != 0 {
			return p, "", errors.New("legacy placement fields")
		}
	} else if len(p.Licenses) != 3 || b.LicensesHash != hex.EncodeToString(digest(p.Licenses)) {
		return p, "", errors.New("consented licenses hash mismatch")
	}
	if b.Epoch == 1 && (b.Previous != zero || b.Cluster != clusterID(network, b.Members)) {
		return p, "", errors.New("initial cluster identity")
	}
	for i, node := range b.Members {
		if !hex64.MatchString(node) || (i > 0 && b.Members[i-1] == node) {
			return p, "", errors.New("duplicate member")
		}
		consent := p.Consents[i]
		public, err := hex.DecodeString(consent.PublicKey)
		if err != nil || !hex64.MatchString(consent.PublicKey) {
			return p, "", errors.New("invalid consent key")
		}
		id := hex.EncodeToString(hashNode(public))
		sig, err := hex.DecodeString(consent.Signature)
		if id != node || err != nil || len(sig) != 64 || hex.EncodeToString(sig) != consent.Signature || !ed25519.Verify(public, canonical(b), sig) {
			return p, "", errors.New("member consent required")
		}
	}
	return p, hex.EncodeToString(digest(p)), nil
}
func applyPlacement(s *State, tx []byte) error {
	p, h, err := decodePlacement(tx, s.Network)
	if err != nil {
		return err
	}
	old, exists := s.Placements[p.Body.Cluster]
	if exists && old.Digest == h {
		return nil
	}
	if err := verifyPlacementLicenses(p, s.Issuers, s.BlockTime); err != nil {
		return err
	}
	if !exists && p.Body.Epoch != 1 {
		return errors.New("initial epoch required")
	}
	if exists {
		if old.Record.Body.Epoch == int64(^uint64(0)>>1) || p.Body.Epoch != old.Record.Body.Epoch+1 || p.Body.Previous != old.Digest {
			return errors.New("placement epoch conflict")
		}
		overlap := 0
		for _, node := range p.Body.Members {
			for _, prior := range old.Record.Body.Members {
				if node == prior {
					overlap++
				}
			}
		}
		if overlap != 2 {
			return errors.New("exactly one replacement required")
		}
	}
	for _, node := range p.Body.Members {
		memberships := 0
		for cluster, head := range s.Placements {
			if cluster == p.Body.Cluster {
				continue
			}
			for _, member := range head.Record.Body.Members {
				if member == node {
					memberships++
				}
			}
		}
		if memberships >= 2 {
			return errors.New("storage membership limit")
		}
	}
	if s.Placements == nil {
		s.Placements = map[string]PlacementHead{}
	}
	s.Placements[p.Body.Cluster] = PlacementHead{p, h, s.BlockTime}
	if s.PlacementHistory == nil {
		s.PlacementHistory = map[string][]PlacementHead{}
	}
	s.PlacementHistory[p.Body.Cluster] = append(s.PlacementHistory[p.Body.Cluster], PlacementHead{p, h, s.BlockTime})
	return nil
}

func verifyPlacementHistory(state State) error {
	if len(state.Placements) != len(state.PlacementHistory) {
		return errors.New("missing placement history")
	}
	for cluster, head := range state.Placements {
		history := state.PlacementHistory[cluster]
		if len(history) == 0 {
			return errors.New("missing placement chain")
		}
		previous := zero
		var prior *PlacementBody
		for i, item := range history {
			p, h, err := decodePlacement(canonical(item.Record), state.Network)
			if err != nil || h != item.Digest || p.Body.Cluster != cluster || p.Body.Epoch != int64(i+1) || p.Body.Previous != previous {
				return errors.New("invalid placement chain")
			}
			if p.Body.Domain == "sfera-mesh-placement-v2" {
				if item.AcceptedAt > state.BlockTime {
					return errors.New("future license acceptance")
				}
				if err := verifyPlacementLicenses(p, state.Issuers, item.AcceptedAt); err != nil {
					return err
				}
			} else if len(state.Issuers) > 0 {
				return errors.New("legacy placement in issuer-pinned network")
			}
			if prior != nil {
				overlap := 0
				for _, node := range p.Body.Members {
					for _, old := range prior.Members {
						if node == old {
							overlap++
						}
					}
				}
				if overlap != 2 {
					return errors.New("invalid historical replacement")
				}
			}
			b := p.Body
			prior = &b
			previous = h
		}
		if previous != head.Digest || !bytes.Equal(canonical(head), canonical(history[len(history)-1])) {
			return errors.New("placement head mismatch")
		}
	}
	return nil
}
