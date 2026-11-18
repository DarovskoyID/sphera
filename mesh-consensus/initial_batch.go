package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sort"
)

type InitialBatchBody struct {
	Domain         string `json:"domain"`
	Network        string `json:"network"`
	PoolHash       string `json:"pool_hash"`
	PlacementsHash string `json:"placements_hash"`
}
type InitialBatch struct {
	Body       InitialBatchBody `json:"body"`
	Placements []Placement      `json:"placements"`
}
type InitialBatchReceipt struct {
	Body       InitialBatchBody `json:"body"`
	Clusters   []string         `json:"clusters"`
	AcceptedAt int64            `json:"accepted_at"`
}
type initialPoolEntry struct {
	NodeID        string `json:"node_id"`
	CandidateHash string `json:"candidate_hash"`
	ResourceHash  string `json:"resource_hash"`
}

func initialPool(s State) ([]initialPoolEntry, error) {
	pool := []initialPoolEntry{}
	for id, candidate := range s.Candidates {
		r, ok := assessedResource(s, id)
		if ok && r.CapacitySlots > 0 && membershipCount(s, id) == 0 {
			pool = append(pool, initialPoolEntry{id, candidate.Digest, s.Resources[id].Digest})
		}
	}
	sort.Slice(pool, func(i, j int) bool { return pool[i].NodeID < pool[j].NodeID })
	if len(pool) > 64 {
		return nil, errors.New("initial planning laboratory limit")
	}
	return pool, nil
}

func bestInitialPlan(s State, pool []initialPoolEntry, count int) ([][]string, error) {
	type option struct {
		members          []string
		mask             uint64
		spread, mismatch int
	}
	options := []option{}
	resources := map[string]ResourceBody{}
	for _, entry := range pool {
		r, ok := assessedResource(s, entry.NodeID)
		if !ok {
			return nil, errors.New("initial pool resource unavailable")
		}
		resources[entry.NodeID] = r
	}
	for a := 0; a < len(pool); a++ {
		for b := a + 1; b < len(pool); b++ {
			for c := b + 1; c < len(pool); c++ {
				ids := []string{pool[a].NodeID, pool[b].NodeID, pool[c].NodeID}
				if _, exists := s.Placements[clusterID(s.Network, ids)]; exists {
					continue
				}
				ra := resources[ids[0]]
				rb := resources[ids[1]]
				rc := resources[ids[2]]
				if ra.FailureDomain == rb.FailureDomain || ra.FailureDomain == rc.FailureDomain || rb.FailureDomain == rc.FailureDomain {
					continue
				}
				spread, mismatch, err := placementModuleScore([]LicenseDocument{s.Candidates[ids[0]].Record.Body.License, s.Candidates[ids[1]].Record.Body.License, s.Candidates[ids[2]].Record.Body.License})
				if err != nil {
					return nil, err
				}
				if count == 1 && spread == 0 && mismatch == 0 {
					return [][]string{ids}, nil
				}
				options = append(options, option{ids, 1<<a | 1<<b | 1<<c, spread, mismatch})
			}
		}
	}
	var best [][]string
	bestSpread, bestMismatch, states := 0, 0, 0
	var search func(int, uint64, [][]string, int, int) error
	search = func(start int, used uint64, chosen [][]string, spread, mismatch int) error {
		states++
		if states > 100000 {
			return errors.New("initial planning search budget exceeded")
		}
		if len(chosen) == count {
			if best == nil || spread < bestSpread || (spread == bestSpread && (mismatch < bestMismatch || (mismatch == bestMismatch && bytes.Compare(canonical(chosen), canonical(best)) < 0))) {
				best = append([][]string{}, chosen...)
				bestSpread, bestMismatch = spread, mismatch
			}
			return nil
		}
		available := len(pool)
		for bits := used; bits != 0; bits &= bits - 1 {
			available--
		}
		if available < (count-len(chosen))*3 {
			return nil
		}
		if best != nil && (spread > bestSpread || (spread == bestSpread && mismatch > bestMismatch)) {
			return nil
		}
		for i := start; i < len(options); i++ {
			if best != nil && bestSpread == 0 && bestMismatch == 0 {
				return nil
			}
			o := options[i]
			if used&o.mask == 0 {
				next := append(append([][]string{}, chosen...), o.members)
				if err := search(i+1, used|o.mask, next, spread+o.spread, mismatch+o.mismatch); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := search(0, 0, nil, 0, 0); err != nil {
		return nil, err
	}
	return best, nil
}

func applyInitialBatch(s *State, tx []byte) error {
	if len(tx) > 65536 || len(s.PolicyKeys) == 0 {
		return errors.New("bounded quorum initial batch required")
	}
	var batch InitialBatch
	decoder := json.NewDecoder(bytes.NewReader(tx))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&batch); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("trailing initial batch")
	}
	if !bytes.Equal(tx, canonical(batch)) || batch.Body.Domain != "sfera-mesh-initial-batch-v1" || batch.Body.Network != s.Network || !hex64.MatchString(batch.Body.PoolHash) || batch.Body.PlacementsHash != hex.EncodeToString(digest(batch.Placements)) || len(batch.Placements) < 1 || len(batch.Placements) > 4 {
		return errors.New("invalid initial batch context")
	}
	batchHash := hex.EncodeToString(digest(batch))
	if _, accepted := s.InitialBatches[batchHash]; accepted {
		return nil
	}
	groups := [][]string{}
	seen := map[string]bool{}
	hashes := []string{}
	for _, record := range batch.Placements {
		p, h, err := decodePlacement(canonical(record), s.Network)
		if err != nil {
			return err
		}
		if p.Body.Domain != "sfera-mesh-placement-v2" || p.Body.Epoch != 1 {
			return errors.New("initial licensed placements required")
		}
		groups = append(groups, p.Body.Members)
		hashes = append(hashes, h)
		for _, id := range p.Body.Members {
			if seen[id] {
				return errors.New("disjoint primary triples required")
			}
			seen[id] = true
		}
	}
	for _, p := range batch.Placements {
		if _, exists := s.Placements[p.Body.Cluster]; exists {
			return errors.New("initial batch placement conflict")
		}
	}
	pool, err := initialPool(*s)
	if err != nil {
		return err
	}
	if batch.Body.PoolHash != hex.EncodeToString(digest(pool)) {
		return errors.New("initial batch pool changed")
	}
	best, err := bestInitialPlan(*s, pool, len(batch.Placements))
	if err != nil {
		return err
	}
	if best == nil || !bytes.Equal(canonical(best), canonical(groups)) {
		return errors.New("best joint initial plan required")
	}
	staged := clone(*s)
	if len(staged.InitialBatches) >= 128 {
		return errors.New("initial batch receipt laboratory limit")
	}
	clusters := []string{}
	for i, p := range batch.Placements {
		if err := applyPlacement(&staged, canonical(p)); err != nil {
			return err
		}
		if staged.Placements[p.Body.Cluster].Digest != hashes[i] {
			return errors.New("initial batch digest mismatch")
		}
		clusters = append(clusters, p.Body.Cluster)
	}
	staged.InitialBatches[batchHash] = InitialBatchReceipt{batch.Body, clusters, s.BlockTime}
	*s = staged
	return nil
}

func verifyInitialBatches(s State) error {
	if len(s.InitialBatches) > 128 {
		return errors.New("initial batch receipt laboratory limit")
	}
	seen := map[string]bool{}
	for hash, receipt := range s.InitialBatches {
		if len(s.PolicyKeys) == 0 || receipt.AcceptedAt <= 0 || receipt.AcceptedAt > s.BlockTime || len(receipt.Clusters) < 1 || len(receipt.Clusters) > 4 || receipt.Body.Domain != "sfera-mesh-initial-batch-v1" || receipt.Body.Network != s.Network || !hex64.MatchString(receipt.Body.PoolHash) {
			return errors.New("invalid initial batch receipt")
		}
		records := []Placement{}
		members := map[string]bool{}
		previous := ""
		for _, cluster := range receipt.Clusters {
			history := s.PlacementHistory[cluster]
			if seen[cluster] || len(history) == 0 || history[0].AcceptedAt != receipt.AcceptedAt {
				return errors.New("invalid initial batch origin")
			}
			seen[cluster] = true
			p := history[0].Record
			if p.Body.Domain != "sfera-mesh-placement-v2" || p.Body.Epoch != 1 || len(p.Body.Members) != 3 || p.Body.Members[0] <= previous {
				return errors.New("invalid initial batch ordering")
			}
			previous = p.Body.Members[0]
			for _, id := range p.Body.Members {
				if members[id] {
					return errors.New("overlapping initial batch history")
				}
				members[id] = true
			}
			records = append(records, p)
		}
		if receipt.Body.PlacementsHash != hex.EncodeToString(digest(records)) || hash != hex.EncodeToString(digest(InitialBatch{receipt.Body, records})) {
			return errors.New("initial batch receipt hash mismatch")
		}
	}
	return nil
}
