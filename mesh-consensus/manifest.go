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

// Bounded, append-only ciphertext index certified by the storage majority.
// It records committed digests, not possession or completeness of unindexed data.
type ManifestBody struct {
	Domain        string   `json:"domain"`
	Network       string   `json:"network"`
	Cluster       string   `json:"cluster"`
	Epoch         int64    `json:"epoch"`
	PlacementHash string   `json:"placement_hash"`
	Version       int64    `json:"version"`
	Previous      string   `json:"previous"`
	Digests       []string `json:"digests"`
	Sizes         *[]int64 `json:"sizes,omitempty"`
}
type ManifestRecord struct {
	Body     ManifestBody `json:"body"`
	Consents []Consent    `json:"consents"`
}
type ManifestHead struct {
	Record ManifestRecord `json:"record"`
	Digest string         `json:"digest"`
}

func decodeManifest(tx []byte, network string, placement PlacementHead) (ManifestRecord, string, error) {
	var r ManifestRecord
	if len(tx) > 65536 {
		return r, "", errors.New("manifest too large")
	}
	d := json.NewDecoder(bytes.NewReader(tx))
	d.DisallowUnknownFields()
	if err := d.Decode(&r); err != nil {
		return r, "", err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return r, "", errors.New("trailing manifest")
	}
	b := r.Body
	if !bytes.Equal(tx, canonical(r)) || (b.Domain != "sfera-mesh-manifest-v1" && b.Domain != "sfera-mesh-manifest-v2") || b.Network != network || b.Cluster != placement.Record.Body.Cluster || b.Epoch != placement.Record.Body.Epoch || b.PlacementHash != placement.Digest || !hex64.MatchString(b.PlacementHash) || !hex64.MatchString(b.Previous) || b.Version < 1 || (b.Version == 1 && b.Previous != zero) || b.Digests == nil || len(b.Digests) > 512 || !sort.StringsAreSorted(b.Digests) || len(r.Consents) != 2 {
		return r, "", errors.New("invalid manifest context")
	}
	if b.Domain == "sfera-mesh-manifest-v1" && b.Sizes != nil || b.Domain == "sfera-mesh-manifest-v2" && (b.Sizes == nil || len(*b.Sizes) != len(b.Digests)) {
		return r, "", errors.New("invalid manifest sizes")
	}
	if b.Sizes != nil {
		for _, size := range *b.Sizes {
			if size < 1 || size > 262144 {
				return r, "", errors.New("invalid manifest size")
			}
		}
	}
	for i, value := range b.Digests {
		if !hex64.MatchString(value) || (i > 0 && b.Digests[i-1] == value) {
			return r, "", errors.New("invalid manifest digest")
		}
	}
	members := map[string]bool{}
	for _, id := range placement.Record.Body.Members {
		members[id] = true
	}
	prior := ""
	for _, consent := range r.Consents {
		public, err := hex.DecodeString(consent.PublicKey)
		if err != nil || !hex64.MatchString(consent.PublicKey) || consent.PublicKey <= prior {
			return r, "", errors.New("distinct sorted manifest signers required")
		}
		sig, err := hex.DecodeString(consent.Signature)
		if !members[hex.EncodeToString(hashNode(public))] || err != nil || len(sig) != 64 || hex.EncodeToString(sig) != consent.Signature || !ed25519.Verify(public, canonical(b), sig) {
			return r, "", errors.New("storage majority signatures required")
		}
		prior = consent.PublicKey
	}
	return r, hex.EncodeToString(digest(r)), nil
}

func applyManifest(s *State, tx []byte) error {
	var context struct {
		Body struct {
			Cluster string `json:"cluster"`
		} `json:"body"`
	}
	if err := json.Unmarshal(tx, &context); err != nil {
		return err
	}
	placement, exists := s.Placements[context.Body.Cluster]
	if !exists {
		return errors.New("confirmed manifest placement required")
	}
	// A retry remains idempotent after a membership change, without regranting.
	if old, ok := s.Manifests[context.Body.Cluster]; ok && bytes.Equal(canonical(old.Record), tx) {
		return nil
	}
	r, hash, err := decodeManifest(tx, s.Network, placement)
	if err != nil {
		return err
	}
	additions := map[string]int64{}
	for i, value := range r.Body.Digests {
		size := int64(0)
		if r.Body.Sizes != nil {
			size = (*r.Body.Sizes)[i]
		}
		additions[value] = size
	}
	if err := checkWriteCapacity(*s, r.Body.Cluster, additions); err != nil {
		return err
	}
	for _, work := range s.WriteQueue {
		b := work.Record.Body
		if b.Cluster == r.Body.Cluster {
			i := sort.SearchStrings(r.Body.Digests, b.Digest)
			if i < len(r.Body.Digests) && r.Body.Digests[i] == b.Digest && (r.Body.Sizes == nil || (*r.Body.Sizes)[i] != b.Size) {
				return errors.New("queued ciphertext size conflict")
			}
		}
	}
	old, exists := s.Manifests[r.Body.Cluster]
	if (!exists && r.Body.Version != 1) || (exists && (old.Record.Body.Version == int64(^uint64(0)>>1) || r.Body.Version != old.Record.Body.Version+1 || r.Body.Previous != old.Digest)) {
		return errors.New("manifest version conflict")
	}
	if exists {
		if old.Record.Body.Sizes != nil && r.Body.Sizes == nil {
			return errors.New("manifest sizes cannot be discarded")
		}
		for oldIndex, value := range old.Record.Body.Digests {
			index := sort.SearchStrings(r.Body.Digests, value)
			if index == len(r.Body.Digests) || r.Body.Digests[index] != value {
				return errors.New("manifest cannot discard committed ciphertext")
			}
			if old.Record.Body.Sizes != nil && (*old.Record.Body.Sizes)[oldIndex] != (*r.Body.Sizes)[index] {
				return errors.New("committed manifest size cannot change")
			}
		}
	}
	lineage, err := nextManifestLineage(*s, r.Body.Cluster, hash, r.Body.Version)
	if err != nil {
		return err
	}
	if s.ManifestLineage == nil {
		s.ManifestLineage = map[string]ManifestLineage{}
	}
	s.ManifestLineage[r.Body.Cluster] = lineage
	if s.Manifests == nil {
		s.Manifests = map[string]ManifestHead{}
	}
	s.Manifests[r.Body.Cluster] = ManifestHead{r, hash}
	pruneCompletedWrites(s)
	return nil
}

func verifyManifestRegistry(s State) error {
	for cluster, head := range s.Manifests {
		b := head.Record.Body
		history := s.PlacementHistory[cluster]
		if b.Cluster != cluster || b.Epoch < 1 || b.Epoch > int64(len(history)) {
			return errors.New("manifest placement history required")
		}
		_, hash, err := decodeManifest(canonical(head.Record), s.Network, history[b.Epoch-1])
		if err != nil || hash != head.Digest {
			return errors.New("invalid manifest snapshot")
		}
	}
	return nil
}
