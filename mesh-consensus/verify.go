package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"

	cmtjson "github.com/cometbft/cometbft/libs/json"
	"github.com/cometbft/cometbft/types"
)

// Pinned-genesis verifier with committed, equally weighted committee changes.
// The genesis file is a LOCAL trust anchor, never supplied by the RPC peer.
type Evidence struct {
	State       json.RawMessage     `json:"state"`
	Header      json.RawMessage     `json:"signed_header"`
	Transitions []CommitteeEvidence `json:"committee_transitions,omitempty"`
}
type Verified struct {
	State          State  `json:"state"`
	HeaderHash     string `json:"header_hash"`
	HeaderTime     int64  `json:"header_time"`
	ValidatorsHash string `json:"validators_hash"`
}

func verifyEvidence(genesis *types.GenesisDoc, evidence Evidence, now time.Time, genesisPin ...string) (*Verified, error) {
	if len(genesis.Validators) != 4 || !networkName.MatchString(genesis.ChainID) {
		return nil, errors.New("unsupported pinned genesis")
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
		return nil, errors.New("stale or future consensus header")
	}
	if err := verifyCommitteeHeader(genesis, base, history, &signed); err != nil {
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
	if !bytes.Equal(canonical(state.Committees), canonical(history)) && !(len(state.Committees) == 0 && len(history) == 0) {
		return nil, errors.New("snapshot committee history mismatch")
	}
	for _, head := range history {
		if head.Height > state.Height {
			return nil, errors.New("future committee history")
		}
	}
	if err := verifyCommitteeHistory(state); err != nil {
		return nil, err
	}
	if state.GenesisPin != "" && (len(genesisPin) != 1 || state.GenesisPin != genesisPin[0]) {
		return nil, errors.New("snapshot genesis pin mismatch")
	}
	issuers, err := genesisIssuers(genesis.AppState)
	if err != nil {
		return nil, err
	}
	var commitmentConfig GenesisApplication
	if json.Unmarshal(genesis.AppState, &commitmentConfig) != nil && len(genesis.AppState) > 0 {
		return nil, errors.New("invalid state commitment config")
	}
	if state.StateCommitment != commitmentConfig.StateCommitment || state.StateCommitment != "" && state.StateCommitment != stateMerkleScheme {
		return nil, errors.New("snapshot state commitment mismatch")
	}
	if state.EndpointPolicy != commitmentConfig.EndpointPolicy || state.EndpointPolicy != "" && state.EndpointPolicy != "https-v1" {
		return nil, errors.New("snapshot endpoint policy mismatch")
	}
	if len(issuers) != len(state.Issuers) {
		return nil, errors.New("snapshot issuer mismatch")
	}
	for k, v := range issuers {
		if state.Issuers[k] != v {
			return nil, errors.New("snapshot issuer mismatch")
		}
	}
	if state.BlockTime > signed.Time.Unix() {
		return nil, errors.New("snapshot future block time")
	}
	// Header at H+1 commits the application state produced at H.
	if !bytes.Equal(digest(state), signed.AppHash) {
		return nil, errors.New("snapshot app hash mismatch")
	}
	for id, head := range state.Accounts {
		r, h, err := decodeRecordWithSigner(canonical(head.Record), state.Network, historicalControlPublic(state, id, head.Record.Body.Version, false))
		if err != nil || r.Body.UserID != id || h != head.Digest {
			return nil, errors.New("invalid snapshot account")
		}
	}
	if err := verifyAccountControls(state); err != nil {
		return nil, err
	}
	if err := verifyApplicationProfiles(state); err != nil {
		return nil, err
	}
	if err := verifyApplicationDialogs(state); err != nil {
		return nil, err
	}
	if _, err := replayApplicationKeys(state); err != nil {
		return nil, err
	}
	counts := map[string]int{}
	policyKeys, err := genesisPolicyKeys(genesis)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(canonical(policyKeys), canonical(state.PolicyKeys)) {
		return nil, errors.New("snapshot placement policy mismatch")
	}
	if err := verifyResourceRegistry(state); err != nil {
		return nil, err
	}
	if err := verifyCandidateRegistry(state); err != nil {
		return nil, err
	}
	if err := verifyPlacementHistory(state); err != nil {
		return nil, err
	}
	if err := verifyManifestRegistry(state); err != nil {
		return nil, err
	}
	if err := verifyWriteQueue(state); err != nil {
		return nil, err
	}
	if err := verifyTransfers(state); err != nil {
		return nil, err
	}
	if err := verifyAdmissions(state); err != nil {
		return nil, err
	}
	if err := verifyDevices(state); err != nil {
		return nil, err
	}
	if err := verifyCipherDevices(state); err != nil {
		return nil, err
	}
	if err := verifyCipherProfiles(state); err != nil {
		return nil, err
	}
	if err := verifyManifestLineages(state); err != nil {
		return nil, err
	}
	if err := verifyEndpoints(state); err != nil {
		return nil, err
	}
	if err := verifyRecoveryRoots(state); err != nil {
		return nil, err
	}
	if err := verifyRecoveryTrees(state); err != nil {
		return nil, err
	}
	if err := verifyGrowthGrants(state); err != nil {
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
	return &Verified{state, hex.EncodeToString(signed.Hash()), signed.Time.Unix(), hex.EncodeToString(signed.ValidatorsHash)}, nil
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
	genesisRaw, err := os.ReadFile(genesisPath)
	if err != nil {
		return err
	}
	pin := sha256.Sum256(genesisRaw)
	verified, err := verifyEvidence(genesis, evidence, time.Now().UTC(), hex.EncodeToString(pin[:]))
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(verified)
}
