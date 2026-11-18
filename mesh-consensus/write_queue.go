package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
)

// Immutable replicated work. Completion is derived from the sized manifest;
// no local worker flag, lease or RPC reply can declare a write complete.
type WriteBody struct {
	Domain        string `json:"domain"`
	Network       string `json:"network"`
	Cluster       string `json:"cluster"`
	Epoch         int64  `json:"epoch"`
	PlacementHash string `json:"placement_hash"`
	Origin        string `json:"origin"`
	BlockToken    string `json:"block_token"`
	RequestID     string `json:"request_id"`
	Digest        string `json:"digest"`
	Size          int64  `json:"size"`
}
type WriteRecord struct {
	Body     WriteBody `json:"body"`
	Consents []Consent `json:"consents"`
}
type WriteHead struct {
	Record     WriteRecord `json:"record"`
	Digest     string      `json:"digest"`
	AcceptedAt int64       `json:"accepted_at"`
}

func writeID(b WriteBody) string {
	if b.Domain == "sfera-mesh-write-v2" {
		return hex.EncodeToString(digest(map[string]any{"domain": "sfera-mesh-write-id-v2", "network": b.Network, "cluster": b.Cluster, "origin": b.Origin, "block_token": b.BlockToken, "digest": b.Digest, "size": b.Size}))
	}
	return hex.EncodeToString(digest(map[string]string{"domain": "sfera-mesh-write-id-v1", "network": b.Network, "cluster": b.Cluster, "origin": b.Origin, "block_token": b.BlockToken}))
}

func decodeWrite(tx []byte, network string, placement PlacementHead) (WriteRecord, string, error) {
	var r WriteRecord
	if len(tx) > 4096 {
		return r, "", errors.New("write request too large")
	}
	d := json.NewDecoder(bytes.NewReader(tx))
	d.DisallowUnknownFields()
	if err := d.Decode(&r); err != nil {
		return r, "", err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return r, "", errors.New("trailing write request")
	}
	b := r.Body
	if !bytes.Equal(tx, canonical(r)) || (b.Domain != "sfera-mesh-write-v1" && b.Domain != "sfera-mesh-write-v2") || b.Network != network || b.Cluster != placement.Record.Body.Cluster || b.Epoch != placement.Record.Body.Epoch || b.PlacementHash != placement.Digest || b.RequestID != writeID(b) || b.Size < 1 || b.Size > 262144 || len(r.Consents) != 3 {
		return r, "", errors.New("invalid write context")
	}
	for _, value := range []string{b.Origin, b.BlockToken, b.RequestID, b.Digest, b.PlacementHash} {
		if !hex64.MatchString(value) {
			return r, "", errors.New("invalid write digest")
		}
	}
	members := map[string]bool{}
	for _, id := range placement.Record.Body.Members {
		members[id] = true
	}
	if !members[b.Origin] {
		return r, "", errors.New("write origin must be holder")
	}
	previous := ""
	for _, consent := range r.Consents {
		public, err := hex.DecodeString(consent.PublicKey)
		if err != nil || !hex64.MatchString(consent.PublicKey) || consent.PublicKey <= previous {
			return r, "", errors.New("distinct sorted write signers required")
		}
		sig, err := hex.DecodeString(consent.Signature)
		if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != consent.Signature || !members[hex.EncodeToString(hashNode(public))] || !ed25519.Verify(public, canonical(b), sig) {
			return r, "", errors.New("three write holder signatures required")
		}
		previous = consent.PublicKey
	}
	return r, hex.EncodeToString(digest(r)), nil
}

func applyWrite(s *State, tx []byte) error {
	var context WriteRecord
	if err := json.Unmarshal(tx, &context); err != nil {
		return err
	}
	if old, ok := s.WriteQueue[context.Body.RequestID]; ok {
		if bytes.Equal(tx, canonical(old.Record)) {
			return nil
		}
		return errors.New("immutable write request conflict")
	}
	// Completed content-bound requests are authenticated against their original
	// placement, but cannot create work or restore historical holder authority.
	if context.Body.Domain == "sfera-mesh-write-v2" && writeCommitted(*s, context.Body) {
		history := s.PlacementHistory[context.Body.Cluster]
		if context.Body.Epoch < 1 || context.Body.Epoch > int64(len(history)) {
			return errors.New("write placement history required")
		}
		_, _, err := decodeWrite(tx, s.Network, history[context.Body.Epoch-1])
		return err
	}
	placement, ok := s.Placements[context.Body.Cluster]
	if !ok {
		return errors.New("write placement required")
	}
	r, h, err := decodeWrite(tx, s.Network, placement)
	if err != nil {
		return err
	}
	if err := checkWriteCapacity(*s, r.Body.Cluster, map[string]int64{r.Body.Digest: r.Body.Size}); err != nil {
		return err
	}
	if len(s.WriteQueue) >= 128 {
		return errors.New("write queue laboratory limit")
	}
	for _, old := range s.WriteQueue {
		if old.Record.Body.Cluster == r.Body.Cluster && old.Record.Body.Digest == r.Body.Digest && old.Record.Body.Size != r.Body.Size {
			return errors.New("queued ciphertext size conflict")
		}
	}
	if manifest, ok := s.Manifests[r.Body.Cluster]; ok && manifest.Record.Body.Sizes != nil {
		for i, value := range manifest.Record.Body.Digests {
			if value == r.Body.Digest && (*manifest.Record.Body.Sizes)[i] != r.Body.Size {
				return errors.New("committed ciphertext size conflict")
			}
		}
	}
	if s.WriteQueue == nil {
		s.WriteQueue = map[string]WriteHead{}
	}
	s.WriteQueue[r.Body.RequestID] = WriteHead{r, h, s.BlockTime}
	return nil
}

func verifyWriteQueue(s State) error {
	if len(s.WriteQueue) > 128 {
		return errors.New("write queue laboratory limit")
	}
	clusters := map[string]bool{}
	for id, head := range s.WriteQueue {
		b := head.Record.Body
		clusters[b.Cluster] = true
		history := s.PlacementHistory[b.Cluster]
		if b.RequestID != id || b.Epoch < 1 || b.Epoch > int64(len(history)) || head.AcceptedAt < 1 || head.AcceptedAt > s.BlockTime {
			return errors.New("invalid write queue history")
		}
		_, h, err := decodeWrite(canonical(head.Record), s.Network, history[b.Epoch-1])
		if err != nil || h != head.Digest {
			return errors.New("invalid write queue snapshot")
		}
	}
	for cluster := range clusters {
		if err := checkWriteCapacity(s, cluster, nil); err != nil {
			return err
		}
	}
	return nil
}

func writeCommitted(s State, b WriteBody) bool {
	head, ok := s.Manifests[b.Cluster]
	if !ok || head.Record.Body.Sizes == nil {
		return false
	}
	for i, value := range head.Record.Body.Digests {
		if value == b.Digest {
			return (*head.Record.Body.Sizes)[i] == b.Size
		}
	}
	return false
}

func pruneCompletedWrites(s *State) {
	for id, head := range s.WriteQueue {
		if head.Record.Body.Domain == "sfera-mesh-write-v2" && writeCommitted(*s, head.Record.Body) {
			delete(s.WriteQueue, id)
		}
	}
}
