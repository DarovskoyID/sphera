package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	cmtjson "github.com/cometbft/cometbft/libs/json"
	"github.com/cometbft/cometbft/types"
)

type CommitteeEvidence struct {
	Proof  StateProof      `json:"proof"`
	Header json.RawMessage `json:"signed_header"`
}

func genesisCommittee(genesis *types.GenesisDoc) ([]string, error) {
	members := []string{}
	for _, v := range genesis.Validators {
		if v.PubKey == nil || v.PubKey.Type() != "ed25519" || v.Power != 1 {
			return nil, errors.New("invalid pinned consensus validator")
		}
		members = append(members, hex.EncodeToString(v.PubKey.Bytes()))
	}
	// memberSet also rejects duplicates, after deterministic ordering.
	sortCommittee(members)
	_, err := memberSet(members)
	return members, err
}
func sortCommittee(members []string) { // shared schemas always use public-key order
	for i := 1; i < len(members); i++ {
		for j := i; j > 0 && members[j] < members[j-1]; j-- {
			members[j], members[j-1] = members[j-1], members[j]
		}
	}
}
func verifyCommitteeHeader(genesis *types.GenesisDoc, base []string, history []CommitteeHead, signed *types.SignedHeader) error {
	if err := signed.ValidateBasic(genesis.ChainID); err != nil {
		return err
	}
	current, err := memberSet(committeeMembers(base, history, signed.Height))
	if err != nil {
		return err
	}
	next, err := memberSet(committeeMembers(base, history, signed.Height+1))
	if err != nil {
		return err
	}
	if !bytes.Equal(signed.ValidatorsHash, current.Hash()) || !bytes.Equal(signed.NextValidatorsHash, next.Hash()) {
		return errors.New("header committee does not match committed activation history")
	}
	return current.VerifyCommit(genesis.ChainID, signed.Commit.BlockID, signed.Height, signed.Commit)
}
func verifyCommitteeEvidence(genesis *types.GenesisDoc, pin string, evidence []CommitteeEvidence, now time.Time) ([]string, []CommitteeHead, error) {
	base, err := genesisCommittee(genesis)
	if err != nil {
		return nil, nil, err
	}
	history := []CommitteeHead{}
	if len(evidence) > 16 {
		return nil, nil, errors.New("committee history limit")
	}
	var config GenesisApplication
	if len(evidence) > 0 && (json.Unmarshal(genesis.AppState, &config) != nil || !config.PlacementPolicy || config.StateCommitment != stateMerkleScheme || !hex64.MatchString(pin)) {
		return nil, nil, errors.New("committee transition requires pinned compact policy genesis")
	}
	lastTime := genesis.GenesisTime
	for _, item := range evidence {
		var head CommitteeHead
		decoder := json.NewDecoder(bytes.NewReader(item.Proof.Leaf.Value))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&head); err != nil {
			return nil, nil, err
		}
		if !bytes.Equal(item.Proof.Leaf.Value, canonical(head)) || item.Proof.Leaf.Key != committeeKey(int64(len(history)+1)) ||
			item.Proof.Network != genesis.ChainID || item.Proof.Height != head.Height {
			return nil, nil, errors.New("committee acceptance proof context")
		}
		if err := checkCommitteeRecord(genesis.ChainID, pin, base, history, head); err != nil {
			return nil, nil, err
		}
		var signed types.SignedHeader
		if err := cmtjson.Unmarshal(item.Header, &signed); err != nil {
			return nil, nil, err
		}
		if signed.Header == nil || signed.Height != head.Height+1 || signed.Time.Before(lastTime) ||
			signed.Time.After(now.Add(5*time.Second)) || signed.Time.Unix() < head.AcceptedAt {
			return nil, nil, errors.New("committee acceptance header time or height")
		}
		if err := verifyCommitteeHeader(genesis, base, history, &signed); err != nil {
			return nil, nil, err
		}
		root, err := proofAppHash(item.Proof)
		if err != nil || !bytes.Equal(root, signed.AppHash) {
			return nil, nil, errors.New("committee change was not committed by previous validators")
		}
		history = append(history, head)
		lastTime = signed.Time
	}
	return base, history, nil
}
