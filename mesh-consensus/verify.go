package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"

	cmtjson "github.com/cometbft/cometbft/libs/json"
	"github.com/cometbft/cometbft/types"
)

// This verifier supports only the immutable, equally weighted laboratory roster.
// The genesis file is a LOCAL trust anchor, never supplied by the RPC peer.
type Evidence struct {
	State  json.RawMessage `json:"state"`
	Header json.RawMessage `json:"signed_header"`
}
type Verified struct {
	State          State  `json:"state"`
	HeaderHash     string `json:"header_hash"`
	HeaderTime     int64  `json:"header_time"`
	ValidatorsHash string `json:"validators_hash"`
}

func verifyEvidence(genesis *types.GenesisDoc, evidence Evidence, now time.Time) (*Verified, error) {
	if len(genesis.Validators) != 4 || !networkName.MatchString(genesis.ChainID) {
		return nil, errors.New("unsupported pinned genesis")
	}
	validators := make([]*types.Validator, 0, 4)
	seen := map[string]bool{}
	for _, v := range genesis.Validators {
		if v.Power != 1 || v.PubKey == nil || seen[string(v.PubKey.Bytes())] {
			return nil, errors.New("invalid pinned validators")
		}
		seen[string(v.PubKey.Bytes())] = true
		validators = append(validators, types.NewValidator(v.PubKey, 1))
	}
	set := types.NewValidatorSet(validators)
	var signed types.SignedHeader
	if err := cmtjson.Unmarshal(evidence.Header, &signed); err != nil {
		return nil, err
	}
	if err := signed.ValidateBasic(genesis.ChainID); err != nil {
		return nil, err
	}
	if !bytes.Equal(signed.ValidatorsHash, set.Hash()) || !bytes.Equal(signed.NextValidatorsHash, set.Hash()) {
		return nil, errors.New("validator change unsupported")
	}
	if signed.Time.After(now.Add(5*time.Second)) || !signed.Time.After(now.Add(-30*time.Second)) {
		return nil, errors.New("stale or future consensus header")
	}
	if err := set.VerifyCommit(genesis.ChainID, signed.Commit.BlockID, signed.Height, signed.Commit); err != nil {
		return nil, err
	}
	var state State
	dec := json.NewDecoder(bytes.NewReader(evidence.State))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&state); err != nil {
		return nil, err
	}
	if state.Network != genesis.ChainID || state.Height < 1 || state.Height != signed.Height-1 || state.Accounts == nil || !bytes.Equal(evidence.State, canonical(state)) {
		return nil, errors.New("snapshot context")
	}
	// Header at H+1 commits the application state produced at H.
	if !bytes.Equal(digest(state), signed.AppHash) {
		return nil, errors.New("snapshot app hash mismatch")
	}
	for id, head := range state.Accounts {
		r, h, err := decodeRecord(canonical(head.Record), state.Network)
		if err != nil || r.Body.UserID != id || h != head.Digest {
			return nil, errors.New("invalid snapshot account")
		}
	}
	counts := map[string]int{}
	if err := verifyPlacementHistory(state); err != nil {
		return nil, err
	}
	for cluster, head := range state.Placements {
		p, h, err := decodePlacement(canonical(head.Record), state.Network)
		if err != nil || p.Body.Cluster != cluster || h != head.Digest {
			return nil, errors.New("invalid snapshot placement")
		}
		for _, member := range p.Body.Members {
			counts[member]++
			if counts[member] > 2 {
				return nil, errors.New("snapshot membership limit")
			}
		}
	}
	return &Verified{state, hex.EncodeToString(signed.Hash()), signed.Time.Unix(), hex.EncodeToString(set.Hash())}, nil
}
func verifyInput(genesisPath string) error {
	genesis, err := types.GenesisDocFromFile(genesisPath)
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 2*1048576+1))
	if err != nil {
		return err
	}
	if len(raw) > 2*1048576 {
		return errors.New("evidence exceeds lab limit")
	}
	var evidence Evidence
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&evidence); err != nil {
		return err
	}
	if err = dec.Decode(new(any)); err != io.EOF {
		return errors.New("trailing evidence")
	}
	verified, err := verifyEvidence(genesis, evidence, time.Now().UTC())
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(verified)
}
