package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
)

type GrowthBody struct {
	Domain           string `json:"domain"`
	Network          string `json:"network"`
	Cluster          string `json:"cluster"`
	Epoch            int64  `json:"epoch"`
	PlacementHash    string `json:"placement_hash"`
	Origin           string `json:"origin"`
	Token            string `json:"token"`
	BudgetID         string `json:"budget_id"`
	Amount           int64  `json:"amount"`
	IssuedAt         int64  `json:"issued_at"`
	PrepareExpiresAt int64  `json:"prepare_expires_at"`
}
type GrowthRecord struct {
	Body     GrowthBody `json:"body"`
	Consents []Consent  `json:"consents"`
}
type GrowthHead struct {
	Record     GrowthRecord `json:"record"`
	Digest     string       `json:"digest"`
	AcceptedAt int64        `json:"accepted_at"`
}

func growthID(b GrowthBody) string {
	return hex.EncodeToString(digest(map[string]string{"domain": "sfera-mesh-growth-id-v1", "network": b.Network, "cluster": b.Cluster, "origin": b.Origin, "token": b.Token}))
}
func decodeGrowth(tx []byte, network string, p PlacementHead, at int64) (GrowthRecord, string, error) {
	var r GrowthRecord
	if len(tx) > 4096 || json.Unmarshal(tx, &r) != nil || !bytes.Equal(tx, canonical(r)) {
		return r, "", errors.New("invalid growth record")
	}
	b := r.Body
	if b.Domain != "sfera-mesh-growth-v1" || b.Network != network || b.Cluster != p.Record.Body.Cluster || b.Epoch != p.Record.Body.Epoch || b.PlacementHash != p.Digest || b.Amount < 1 || b.BudgetID != growthID(b) || b.IssuedAt < 1 || b.IssuedAt > at+5 || b.IssuedAt < at-30 || b.PrepareExpiresAt <= at || b.PrepareExpiresAt <= b.IssuedAt || b.PrepareExpiresAt-b.IssuedAt > 60 || len(r.Consents) != 3 {
		return r, "", errors.New("invalid growth context")
	}
	for _, value := range []string{b.Cluster, b.PlacementHash, b.Origin, b.Token, b.BudgetID} {
		if !hex64.MatchString(value) {
			return r, "", errors.New("invalid growth identity")
		}
	}
	members := map[string]bool{}
	for _, member := range p.Record.Body.Members {
		members[member] = true
	}
	if !members[b.Origin] {
		return r, "", errors.New("growth origin must be holder")
	}
	previous := ""
	for _, c := range r.Consents {
		pub, err := hex.DecodeString(c.PublicKey)
		if err != nil || !hex64.MatchString(c.PublicKey) || c.PublicKey <= previous {
			return r, "", errors.New("distinct sorted growth signers required")
		}
		sig, err := hex.DecodeString(c.Signature)
		if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != c.Signature || !members[hex.EncodeToString(hashNode(pub))] || !ed25519.Verify(pub, canonical(b), sig) {
			return r, "", errors.New("three growth reservation signatures required")
		}
		previous = c.PublicKey
	}
	return r, hex.EncodeToString(digest(r)), nil
}

func applyGrowth(s *State, tx []byte) error {
	var context GrowthRecord
	if json.Unmarshal(tx, &context) != nil {
		return errors.New("invalid growth transaction")
	}
	if old, ok := s.GrowthGrants[context.Body.BudgetID]; ok {
		if bytes.Equal(tx, canonical(old.Record)) {
			return nil
		}
		return errors.New("immutable growth budget conflict")
	}
	p, ok := s.Placements[context.Body.Cluster]
	if !ok {
		return errors.New("confirmed growth placement required")
	}
	r, h, err := decodeGrowth(tx, s.Network, p, s.BlockTime)
	if err != nil {
		return err
	}
	if err = verifyPlacementLicenses(p.Record, s.Issuers, s.BlockTime); err != nil {
		return err
	}
	if len(s.GrowthGrants) >= 128 {
		return errors.New("growth grant registry limit")
	}
	if s.GrowthGrants == nil {
		s.GrowthGrants = map[string]GrowthHead{}
	}
	s.GrowthGrants[r.Body.BudgetID] = GrowthHead{r, h, s.BlockTime}
	return nil
}

func verifyGrowthGrants(s State) error {
	if len(s.GrowthGrants) > 128 {
		return errors.New("growth grant registry limit")
	}
	for id, head := range s.GrowthGrants {
		body := head.Record.Body
		history := s.PlacementHistory[body.Cluster]
		if body.Epoch < 1 || body.Epoch > int64(len(history)) || head.AcceptedAt < 1 || head.AcceptedAt > s.BlockTime {
			return errors.New("invalid growth history")
		}
		p := history[body.Epoch-1]
		r, h, err := decodeGrowth(canonical(head.Record), s.Network, p, head.AcceptedAt)
		if err != nil || h != head.Digest || id != r.Body.BudgetID {
			return errors.New("invalid growth snapshot")
		}
		if err = verifyPlacementLicenses(p.Record, s.Issuers, head.AcceptedAt); err != nil {
			return err
		}
	}
	return nil
}
