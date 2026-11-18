package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	cmtjson "github.com/cometbft/cometbft/libs/json"
	"github.com/cometbft/cometbft/types"
	"io"
	"os"
	"sort"
	"time"
)

const stateMerkleScheme = "sfera-mesh-state-merkle-v1"

type StateLeaf struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}
type StateProof struct {
	Network string    `json:"network"`
	Height  int64     `json:"height"`
	Leaf    StateLeaf `json:"leaf"`
	Index   int       `json:"index"`
	Count   int       `json:"count"`
	Path    []string  `json:"path"`
}
type ProofEvidence struct {
	Proof       StateProof          `json:"proof"`
	Header      json.RawMessage     `json:"signed_header"`
	Transitions []CommitteeEvidence `json:"committee_transitions,omitempty"`
}

func proofLeaf(key string, value any) StateLeaf { return StateLeaf{key, canonical(value)} }
func stateLeaves(s State) []StateLeaf {
	fields := map[string]json.RawMessage{}
	_ = json.Unmarshal(canonical(s), &fields)
	leaves := []StateLeaf{}
	for key, value := range fields {
		if key != "manifests" && key != "committees" && key != "recovery_roots" && key != "recovery_trees" {
			leaves = append(leaves, StateLeaf{"state/" + key, value})
		}
	}
	for key, head := range s.RecoveryTrees {
		leaves = append(leaves, proofLeaf("recovery-tree/"+key+"/head", head))
	}
	for key, head := range s.RecoveryRoots {
		meta := map[string]any{}
		decoder := json.NewDecoder(bytes.NewReader(canonical(head)))
		decoder.UseNumber()
		_ = decoder.Decode(&meta)
		body := meta["record"].(map[string]any)["body"].(map[string]any)
		delete(body, "messages")
		delete(body, "deleted")
		leaves = append(leaves, proofLeaf("recovery-root/"+key+"/meta", map[string]any{"head": meta, "count": len(head.Record.Body.Messages), "deleted_count": len(head.Record.Body.Deleted)}))
		for _, identity := range head.Record.Body.Messages {
			i := sort.SearchStrings(head.Record.Body.Deleted, identity)
			deleted := i < len(head.Record.Body.Deleted) && head.Record.Body.Deleted[i] == identity
			leaves = append(leaves, proofLeaf("recovery-root/"+key+"/message/"+identity, map[string]any{"root_hash": head.Digest, "version": head.Record.Body.Version, "deleted": deleted}))
		}
	}
	for _, head := range s.Committees {
		leaves = append(leaves, proofLeaf(committeeKey(head.Record.Body.Version), head))
	}
	for cluster, head := range s.Manifests {
		meta := map[string]any{}
		decoder := json.NewDecoder(bytes.NewReader(canonical(head)))
		decoder.UseNumber()
		_ = decoder.Decode(&meta)
		body := meta["record"].(map[string]any)["body"].(map[string]any)
		delete(body, "digests")
		delete(body, "sizes")
		leaves = append(leaves, proofLeaf("manifest/"+cluster+"/meta", map[string]any{"head": meta, "count": len(head.Record.Body.Digests), "sized": head.Record.Body.Sizes != nil}))
		for i, digest := range head.Record.Body.Digests {
			var size any
			if head.Record.Body.Sizes != nil {
				size = (*head.Record.Body.Sizes)[i]
			}
			leaves = append(leaves, proofLeaf("manifest/"+cluster+"/entry/"+digest, map[string]any{"size": size, "manifest_hash": head.Digest, "version": head.Record.Body.Version, "epoch": head.Record.Body.Epoch, "placement_hash": head.Record.Body.PlacementHash}))
		}
	}
	sort.Slice(leaves, func(i, j int) bool { return leaves[i].Key < leaves[j].Key })
	return leaves
}
func stateLeafHash(leaf StateLeaf) []byte {
	sum := sha256.Sum256(append([]byte{0}, canonical(leaf)...))
	return sum[:]
}
func stateParent(left, right []byte) []byte {
	sum := sha256.Sum256(append(append([]byte{1}, left...), right...))
	return sum[:]
}
func stateRows(leaves []StateLeaf) [][][]byte {
	row := [][]byte{}
	for _, leaf := range leaves {
		row = append(row, stateLeafHash(leaf))
	}
	rows := [][][]byte{row}
	for len(row) > 1 {
		next := [][]byte{}
		for i := 0; i < len(row); i += 2 {
			right := row[i]
			if i+1 < len(row) {
				right = row[i+1]
			}
			next = append(next, stateParent(row[i], right))
		}
		row = next
		rows = append(rows, row)
	}
	return rows
}
func rootAppHash(root []byte, count int) []byte {
	size := make([]byte, 8)
	binary.BigEndian.PutUint64(size, uint64(count))
	sum := sha256.Sum256(append(append([]byte(stateMerkleScheme+"\x00"), size...), root...))
	return sum[:]
}
func merkleStateHash(s State) []byte {
	rows := stateRows(stateLeaves(s))
	return rootAppHash(rows[len(rows)-1][0], len(rows[0]))
}
func makeStateProof(s State, key string) (StateProof, error) {
	if s.StateCommitment != stateMerkleScheme || s.Height < 1 || len(key) > 256 {
		return StateProof{}, errors.New("compact proof genesis required")
	}
	leaves := stateLeaves(s)
	index := sort.Search(len(leaves), func(i int) bool { return leaves[i].Key >= key })
	if index == len(leaves) || leaves[index].Key != key {
		return StateProof{}, errors.New("unknown state proof key")
	}
	rows := stateRows(leaves)
	return stateProofFromTree(s, leaves, rows, index), nil
}

func stateProofFromTree(s State, leaves []StateLeaf, rows [][][]byte, index int) StateProof {
	proof := StateProof{s.Network, s.Height, leaves[index], index, len(leaves), []string{}}
	for _, row := range rows[:len(rows)-1] {
		sibling := index ^ 1
		if sibling >= len(row) {
			sibling = index
		}
		proof.Path = append(proof.Path, hex.EncodeToString(row[sibling]))
		index /= 2
	}
	return proof
}
func proofAppHash(p StateProof) ([]byte, error) {
	if p.Count < 1 || p.Count > 1<<20 || p.Index < 0 || p.Index >= p.Count || len(p.Path) > 20 || len(canonical(p.Leaf)) > 16384 {
		return nil, errors.New("invalid state proof bounds")
	}
	if !bytes.Equal(p.Leaf.Value, canonical(p.Leaf.Value)) {
		return nil, errors.New("noncanonical proof leaf value")
	}
	value := stateLeafHash(p.Leaf)
	index, count, position := p.Index, p.Count, 0
	for count > 1 {
		if position >= len(p.Path) || !hex64.MatchString(p.Path[position]) {
			return nil, errors.New("invalid state proof path")
		}
		sibling, _ := hex.DecodeString(p.Path[position])
		position++
		if index == count-1 && count%2 == 1 && !bytes.Equal(sibling, value) {
			return nil, errors.New("invalid duplicated proof sibling")
		}
		if index%2 == 1 {
			value = stateParent(sibling, value)
		} else {
			value = stateParent(value, sibling)
		}
		index /= 2
		count = (count + 1) / 2
	}
	if position != len(p.Path) {
		return nil, errors.New("trailing proof siblings")
	}
	return rootAppHash(value, p.Count), nil
}
func verifyProofEvidence(genesis *types.GenesisDoc, evidence ProofEvidence, now time.Time, genesisPin ...string) (map[string]any, error) {
	var config GenesisApplication
	if json.Unmarshal(genesis.AppState, &config) != nil || config.StateCommitment != stateMerkleScheme || len(genesis.Validators) != 4 {
		return nil, errors.New("pinned compact proof genesis required")
	}
	pin := ""
	if len(genesisPin) == 1 {
		pin = genesisPin[0]
	}
	base, history, err := verifyCommitteeEvidence(genesis, pin, evidence.Transitions, now)
	if err != nil {
		return nil, err
	}
	var signed types.SignedHeader
	if err := cmtjson.Unmarshal(evidence.Header, &signed); err != nil {
		return nil, err
	}
	if err := signed.ValidateBasic(genesis.ChainID); err != nil {
		return nil, err
	}
	if signed.Time.After(now.Add(5*time.Second)) || !signed.Time.After(now.Add(-30*time.Second)) {
		return nil, errors.New("stale proof header or committee change")
	}
	if err := verifyCommitteeHeader(genesis, base, history, &signed); err != nil {
		return nil, err
	}
	proof := evidence.Proof
	for _, head := range history {
		if head.Height > proof.Height {
			return nil, errors.New("future proof committee history")
		}
	}
	if proof.Network != genesis.ChainID || proof.Height < 1 || proof.Height != signed.Height-1 {
		return nil, errors.New("state proof context mismatch")
	}
	hash, err := proofAppHash(proof)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(hash, signed.AppHash) {
		return nil, errors.New("state proof app hash mismatch")
	}
	return map[string]any{"leaf": proof.Leaf, "network": proof.Network, "height": proof.Height, "header_hash": hex.EncodeToString(signed.Hash()), "expires_at": signed.Time.Unix() + 30, "committee_history": history}, nil
}
func verifyProofInput(path string) error {
	genesis, err := types.GenesisDocFromFile(path)
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 524289))
	if err != nil {
		return err
	}
	if len(raw) > 524288 {
		return errors.New("proof evidence too large")
	}
	var evidence ProofEvidence
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&evidence); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("trailing proof evidence")
	}
	genesisRaw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	pin := sha256.Sum256(genesisRaw)
	result, err := verifyProofEvidence(genesis, evidence, time.Now().UTC(), hex.EncodeToString(pin[:]))
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
