package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
)

type ReadinessBody struct {
	Domain       string `json:"domain"`
	Network      string `json:"network"`
	Cluster      string `json:"cluster"`
	ProposalHash string `json:"proposal_hash"`
	ManifestHash string `json:"manifest_hash"`
	Target       string `json:"target"`
	CheckedAt    int64  `json:"checked_at"`
	ExpiresAt    int64  `json:"expires_at"`
}
type ReadinessProof struct {
	Body      ReadinessBody `json:"body"`
	PublicKey string        `json:"public_key"`
	Signature string        `json:"signature"`
}

func readinessProposalHash(b PlacementBody) string {
	// The readiness signature cannot include its own hash.
	b.ReadinessHash = ""
	return hex.EncodeToString(digest(b))
}
func verifyReadiness(p Placement, at int64) error {
	if p.Readiness == nil || !hex64.MatchString(p.Body.ManifestHash) || !hex64.MatchString(p.Body.ReadinessHash) || p.Body.ReadinessHash != hex.EncodeToString(digest(p.Readiness)) {
		return errors.New("readiness commitment required")
	}
	r := p.Readiness
	b := r.Body
	if b.Domain != "sfera-mesh-readiness-v1" || b.Network != p.Body.Network || b.Cluster != p.Body.Cluster || b.ProposalHash != readinessProposalHash(p.Body) || b.ManifestHash != p.Body.ManifestHash || b.CheckedAt < 1 || b.CheckedAt > int64(^uint64(0)>>1)-30 || b.ExpiresAt <= b.CheckedAt || b.ExpiresAt > b.CheckedAt+30 {
		return errors.New("invalid readiness context")
	}
	found := false
	for _, id := range p.Body.Members {
		if id == b.Target {
			found = true
		}
	}
	public, err := hex.DecodeString(r.PublicKey)
	if err != nil || !hex64.MatchString(r.PublicKey) || !found || hex.EncodeToString(hashNode(public)) != b.Target {
		return errors.New("readiness target key mismatch")
	}
	sig, err := hex.DecodeString(r.Signature)
	if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != r.Signature || !ed25519.Verify(public, canonical(b), sig) {
		return errors.New("readiness target signature required")
	}
	if at > 0 && (b.CheckedAt > at+5 || b.ExpiresAt <= at) {
		return errors.New("readiness expired or future")
	}
	return nil
}
