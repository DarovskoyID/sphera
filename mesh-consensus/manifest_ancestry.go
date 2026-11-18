package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
)

type ManifestLineage struct {
	First  int64    `json:"first"`
	Hashes []string `json:"hashes"`
	Root   string   `json:"root"`
}

func manifestLineageRoot(network, cluster string, first int64, hashes []string) string {
	row := make([][]byte, 0, len(hashes))
	for i, h := range hashes {
		payload := canonical(map[string]any{"domain": "sfera-mesh-manifest-ancestor-v1", "network": network, "cluster": cluster, "version": first + int64(i), "digest": h})
		sum := sha256.Sum256(append([]byte{0}, payload...))
		row = append(row, sum[:])
	}
	for len(row) > 1 {
		next := make([][]byte, 0, (len(row)+1)/2)
		for i := 0; i < len(row); i += 2 {
			right := row[i]
			if i+1 < len(row) {
				right = row[i+1]
			}
			payload := append(append([]byte{1}, row[i]...), right...)
			sum := sha256.Sum256(payload)
			next = append(next, sum[:])
		}
		row = next
	}
	count := make([]byte, 8)
	binary.BigEndian.PutUint64(count, uint64(len(hashes)))
	payload := append([]byte("sfera-mesh-manifest-lineage-v1\x00"), count...)
	if len(row) > 0 {
		payload = append(payload, row[0]...)
	} else {
		empty := sha256.Sum256(nil)
		payload = append(payload, empty[:]...)
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func nextManifestLineage(s State, cluster, hash string, version int64) (ManifestLineage, error) {
	old, ok := s.ManifestLineage[cluster]
	if !ok {
		old.First = version
		if head, exists := s.Manifests[cluster]; exists {
			old.First = head.Record.Body.Version
			old.Hashes = []string{head.Digest}
		}
	}
	next := ManifestLineage{First: old.First, Hashes: append(append([]string(nil), old.Hashes...), hash)}
	total := len(next.Hashes)
	for key, lineage := range s.ManifestLineage {
		if key != cluster {
			total += len(lineage.Hashes)
		}
	}
	if total > 4096 || next.First < 1 || next.First+int64(len(next.Hashes))-1 != version {
		return next, errors.New("manifest lineage limit or version gap")
	}
	next.Root = manifestLineageRoot(s.Network, cluster, next.First, next.Hashes)
	return next, nil
}

func verifyManifestLineages(s State) error {
	total := 0
	for cluster, lineage := range s.ManifestLineage {
		head, ok := s.Manifests[cluster]
		count := len(lineage.Hashes)
		total += count
		if !ok || lineage.First < 1 || count < 1 || count > 4096 || total > 4096 || lineage.First+int64(count)-1 != head.Record.Body.Version || lineage.Hashes[count-1] != head.Digest || (count > 1 && lineage.Hashes[count-2] != head.Record.Body.Previous) {
			return errors.New("invalid manifest lineage head")
		}
		for _, hash := range lineage.Hashes {
			if !hex64.MatchString(hash) {
				return errors.New("invalid manifest lineage hash")
			}
		}
		if lineage.Root != manifestLineageRoot(s.Network, cluster, lineage.First, lineage.Hashes) {
			return errors.New("invalid manifest lineage root")
		}
	}
	return nil
}
