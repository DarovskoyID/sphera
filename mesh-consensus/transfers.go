package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
)

type TransferBody struct {
	Domain        string `json:"domain"`
	Network       string `json:"network"`
	Cluster       string `json:"cluster"`
	Epoch         int64  `json:"epoch"`
	PlacementHash string `json:"placement_hash"`
	ManifestHash  string `json:"manifest_hash"`
	Version       int64  `json:"version"`
	Previous      string `json:"previous"`
	IssuedAt      int64  `json:"issued_at"`
	ExpiresAt     int64  `json:"expires_at"`
}
type TransferRecord struct {
	Body     TransferBody `json:"body"`
	Consents []Consent    `json:"consents"`
}
type TransferHead struct {
	Record     TransferRecord `json:"record"`
	Digest     string         `json:"digest"`
	AcceptedAt int64          `json:"accepted_at"`
}

func decodeTransfer(tx []byte, network string, placement PlacementHead, at int64) (TransferRecord, string, error) {
	var r TransferRecord
	if len(tx) > 4096 {
		return r, "", errors.New("transfer record too large")
	}
	d := json.NewDecoder(bytes.NewReader(tx))
	d.DisallowUnknownFields()
	if err := d.Decode(&r); err != nil {
		return r, "", err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return r, "", errors.New("trailing transfer record")
	}
	b := r.Body
	if !bytes.Equal(tx, canonical(r)) || b.Domain != "sfera-mesh-transfer-v1" || b.Network != network || b.Cluster != placement.Record.Body.Cluster || b.Epoch != placement.Record.Body.Epoch || b.PlacementHash != placement.Digest || b.Version < 1 || !hex64.MatchString(b.ManifestHash) || !hex64.MatchString(b.Previous) || b.Version == 1 && b.Previous != zero || b.IssuedAt < 1 || b.IssuedAt > at+5 || b.ExpiresAt <= at || b.ExpiresAt <= b.IssuedAt || b.ExpiresAt-b.IssuedAt > 30 || len(r.Consents) != 3 {
		return r, "", errors.New("invalid transfer context or freshness")
	}
	members := map[string]bool{}
	for _, id := range placement.Record.Body.Members {
		members[id] = true
	}
	previous := ""
	for _, consent := range r.Consents {
		public, err := hex.DecodeString(consent.PublicKey)
		if err != nil || !hex64.MatchString(consent.PublicKey) || consent.PublicKey <= previous {
			return r, "", errors.New("distinct sorted transfer signers required")
		}
		signature, err := hex.DecodeString(consent.Signature)
		if err != nil || len(signature) != 64 || hex.EncodeToString(signature) != consent.Signature || !members[hex.EncodeToString(hashNode(public))] || !ed25519.Verify(public, canonical(b), signature) {
			return r, "", errors.New("three transfer signatures required")
		}
		previous = consent.PublicKey
	}
	return r, hex.EncodeToString(digest(r)), nil
}

func applyTransfer(s *State, tx []byte) error {
	var context TransferRecord
	if err := json.Unmarshal(tx, &context); err != nil {
		return err
	}
	old, exists := s.Transfers[context.Body.Cluster]
	if exists && bytes.Equal(tx, canonical(old.Record)) {
		return nil
	}
	placement, ok := s.Placements[context.Body.Cluster]
	if !ok {
		return errors.New("transfer placement required")
	}
	manifest, ok := s.Manifests[context.Body.Cluster]
	if !ok || manifest.Record.Body.Sizes == nil {
		return errors.New("sized transfer manifest required")
	}
	r, h, err := decodeTransfer(tx, s.Network, placement, s.BlockTime)
	if err != nil {
		return err
	}
	if r.Body.ManifestHash != manifest.Digest {
		return errors.New("transfer manifest changed")
	}
	if !exists && (r.Body.Version != 1 || len(s.Transfers) >= 128) || exists && (old.Record.Body.Version == int64(^uint64(0)>>1) || r.Body.Version != old.Record.Body.Version+1 || r.Body.Previous != old.Digest) {
		return errors.New("transfer version conflict")
	}
	if s.Transfers == nil {
		s.Transfers = map[string]TransferHead{}
	}
	s.Transfers[r.Body.Cluster] = TransferHead{r, h, s.BlockTime}
	return nil
}

func verifyTransfers(s State) error {
	if len(s.Transfers) > 128 {
		return errors.New("transfer registry limit")
	}
	for cluster, head := range s.Transfers {
		b := head.Record.Body
		history := s.PlacementHistory[cluster]
		if b.Cluster != cluster || b.Epoch < 1 || b.Epoch > int64(len(history)) || head.AcceptedAt < 1 || head.AcceptedAt > s.BlockTime {
			return errors.New("transfer placement history required")
		}
		_, h, err := decodeTransfer(canonical(head.Record), s.Network, history[b.Epoch-1], head.AcceptedAt)
		if err != nil || h != head.Digest {
			return errors.New("invalid transfer snapshot")
		}
	}
	return nil
}
