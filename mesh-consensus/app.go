// Package main implements the isolated, fixed-genesis mesh consensus laboratory.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sync"

	dbm "github.com/cometbft/cometbft-db"
	abci "github.com/cometbft/cometbft/abci/types"
)

type Body struct {
	Domain        string `json:"domain"`
	Network       string `json:"network"`
	UserID        string `json:"user_id"`
	PublicKey     string `json:"public_key"`
	Version       int64  `json:"version"`
	Previous      string `json:"previous"`
	VaultDigest   string `json:"vault_digest"`
	DialogsDigest string `json:"dialogs_digest"`
}
type Record struct {
	Body      Body   `json:"body"`
	Signature string `json:"signature"`
}
type Head struct {
	Record Record `json:"record"`
	Digest string `json:"digest"`
}
type State struct {
	CipherProfiles     map[string]CipherProfileHead     `json:"cipher_profiles,omitempty"`
	AccountControls    map[string][]AccountControlHead  `json:"account_controls,omitempty"`
	CipherDevices      map[string]CipherDeviceHead      `json:"cipher_devices,omitempty"`
	RecoveryTrees      map[string]RecoveryTreeHead      `json:"recovery_trees,omitempty"`
	RecoveryRoots      map[string]RecoveryRootHead      `json:"recovery_roots,omitempty"`
	Committees         []CommitteeHead                  `json:"committees,omitempty"`
	GrowthGrants       map[string]GrowthHead            `json:"growth_grants,omitempty"`
	Endpoints          map[string]EndpointHead          `json:"endpoints,omitempty"`
	ManifestLineage    map[string]ManifestLineage       `json:"manifest_lineage,omitempty"`
	Devices            map[string][]DeviceHead          `json:"devices,omitempty"`
	Network            string                           `json:"network"`
	Height             int64                            `json:"height"`
	Accounts           map[string]Head                  `json:"accounts"`
	Placements         map[string]PlacementHead         `json:"placements,omitempty"`
	PlacementHistory   map[string][]PlacementHead       `json:"placement_history,omitempty"`
	Issuers            map[string]string                `json:"license_issuers,omitempty"`
	BlockTime          int64                            `json:"block_time,omitempty"`
	Candidates         map[string]CandidateHead         `json:"candidates,omitempty"`
	PolicyKeys         map[string]string                `json:"placement_assessors,omitempty"`
	Resources          map[string]ResourceHead          `json:"resources,omitempty"`
	Manifests          map[string]ManifestHead          `json:"manifests,omitempty"`
	InitialBatches     map[string]InitialBatchReceipt   `json:"initial_batches,omitempty"`
	WriteQueue         map[string]WriteHead             `json:"write_queue,omitempty"`
	Transfers          map[string]TransferHead          `json:"transfers,omitempty"`
	GenesisPin         string                           `json:"genesis_pin,omitempty"`
	StateCommitment    string                           `json:"state_commitment,omitempty"`
	EndpointPolicy     string                           `json:"endpoint_policy,omitempty"`
	AdmissionPolicy    string                           `json:"admission_policy,omitempty"`
	Admissions         map[string][]AdmissionHead       `json:"admissions,omitempty"`
	AdmissionRotations map[string]AdmissionRotationHead `json:"admission_rotations,omitempty"`
}
type Application struct {
	abci.BaseApplication
	mu      sync.Mutex
	db      dbm.DB
	state   State
	pending *State
}

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)
var networkName = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`)

const zero = "0000000000000000000000000000000000000000000000000000000000000000"

// canonical matches Python's sorted ASCII JSON for this strictly ASCII schema.
func canonical(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var value any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&value); err != nil {
		panic(err)
	}
	raw, err = json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}
func digest(v any) []byte {
	if state, ok := v.(State); ok && state.StateCommitment == stateMerkleScheme {
		return merkleStateHash(state)
	}
	sum := sha256.Sum256(canonical(v))
	return sum[:]
}
func hashNode(public []byte) []byte {
	sum := sha256.Sum256(append([]byte("sfera-mesh-node-v1\x00"), public...))
	return sum[:]
}
func decodeRecord(tx []byte, network string) (Record, string, error) {
	return decodeRecordWithSigner(tx, network, "")
}
func decodeRecordWithSigner(tx []byte, network, signer string) (Record, string, error) {
	var r Record
	if len(tx) > 16384 {
		return r, "", errors.New("record too large")
	}
	dec := json.NewDecoder(bytes.NewReader(tx))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		return r, "", err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return r, "", errors.New("trailing JSON")
	}
	// Canonical bytes also reject duplicate keys, alternate number forms and omitted fields.
	if !bytes.Equal(tx, canonical(r)) {
		return r, "", errors.New("noncanonical record")
	}
	b := r.Body
	if b.Domain != "sfera-mesh-account-v1" || b.Network != network || b.Version < 1 {
		return r, "", errors.New("record context")
	}
	for _, s := range []string{b.UserID, b.PublicKey, b.Previous, b.VaultDigest, b.DialogsDigest} {
		if !hex64.MatchString(s) {
			return r, "", errors.New("invalid digest")
		}
	}
	pub, _ := hex.DecodeString(b.PublicKey)
	id := sha256.Sum256(append([]byte("sfera-mesh-user-v1\x00"), pub...))
	if signer != "" {
		if !hex64.MatchString(signer) {
			return r, "", errors.New("invalid account signer")
		}
		pub, _ = hex.DecodeString(signer)
	}
	sig, err := hex.DecodeString(r.Signature)
	if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != r.Signature || hex.EncodeToString(id[:]) != b.UserID || !ed25519.Verify(pub, canonical(b), sig) {
		return r, "", errors.New("owner signature")
	}
	return r, hex.EncodeToString(digest(r)), nil
}
func apply(s *State, tx []byte) error {
	if len(tx) > 262144 {
		return errors.New("transaction too large")
	}
	var kind struct {
		Body struct {
			Domain string `json:"domain"`
		} `json:"body"`
	}
	if err := json.Unmarshal(tx, &kind); err != nil {
		return err
	}
	if kind.Body.Domain == "sfera-mesh-write-batch-v2" {
		return applyWriteBatch(s, tx)
	}
	if len(tx) > 65536 {
		return errors.New("transaction too large")
	}
	if kind.Body.Domain == "sfera-mesh-recovery-root-v1" {
		return applyRecoveryRoot(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-recovery-tree-head-v2" {
		return applyRecoveryTree(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-transfer-v1" {
		return applyTransfer(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-committee-lab-v1" {
		return applyCommittee(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-growth-v1" {
		return applyGrowth(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-endpoint-lab-v1" || kind.Body.Domain == "sfera-mesh-endpoint-https-v1" {
		return applyEndpoint(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-device-event-lab-v1" {
		return applyDevice(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-cipher-device-v1" {
		return applyCipherDevice(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-cipher-profile-v1" {
		return applyCipherProfile(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-account-control-v1" {
		return errors.New("root transitions require atomic account update")
	}
	if kind.Body.Domain == "sfera-mesh-account-control-update-v1" {
		return applyAccountControlUpdate(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-device-update-lab-v1" {
		return applyDeviceBatch(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-admission-update-lab-v1" {
		return applyAdmission(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-initial-batch-v1" {
		return applyInitialBatch(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-write-v1" || kind.Body.Domain == "sfera-mesh-write-v2" {
		return applyWrite(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-manifest-v1" || kind.Body.Domain == "sfera-mesh-manifest-v2" {
		return applyManifest(s, tx)
	}
	if len(tx) > 16384 {
		return errors.New("transaction too large")
	}
	if kind.Body.Domain == "sfera-mesh-placement-v1" || kind.Body.Domain == "sfera-mesh-placement-v2" || kind.Body.Domain == "sfera-mesh-placement-v3" {
		return applyPlacement(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-candidate-v1" {
		return applyCandidate(s, tx)
	}
	if kind.Body.Domain == "sfera-mesh-resource-v1" {
		return applyResource(s, tx)
	}
	var identity struct {
		Body struct {
			UserID  string `json:"user_id"`
			Version int64  `json:"version"`
		} `json:"body"`
	}
	_ = json.Unmarshal(tx, &identity)
	r, h, err := decodeRecordWithSigner(tx, s.Network, historicalControlPublic(*s, identity.Body.UserID, identity.Body.Version, false))
	if err != nil {
		return err
	}
	old, exists := s.Accounts[r.Body.UserID]
	if exists && old.Digest == h {
		return nil
	}
	if (!exists && (r.Body.Version != 1 || r.Body.Previous != zero)) || (exists && (old.Record.Body.Version == int64(^uint64(0)>>1) || r.Body.Version != old.Record.Body.Version+1 || r.Body.Previous != old.Digest)) {
		return errors.New("account version conflict")
	}
	s.Accounts[r.Body.UserID] = Head{r, h}
	return nil
}
func NewApplication(db dbm.DB, network string) (*Application, error) {
	return NewApplicationWithIssuers(db, network, nil)
}
func NewApplicationWithIssuers(db dbm.DB, network string, issuers map[string]string) (*Application, error) {
	return NewApplicationWithPolicy(db, network, issuers, nil)
}
func NewApplicationWithPolicy(db dbm.DB, network string, issuers, policyKeys map[string]string, genesisPin ...string) (*Application, error) {
	pin := ""
	if len(genesisPin) > 3 {
		return nil, errors.New("one genesis pin required")
	}
	if len(genesisPin) >= 1 {
		pin = genesisPin[0]
		if !hex64.MatchString(pin) {
			return nil, errors.New("invalid genesis pin")
		}
	}
	scheme := ""
	if len(genesisPin) >= 2 {
		scheme = genesisPin[1]
		if scheme != "" && scheme != stateMerkleScheme {
			return nil, errors.New("unsupported state commitment")
		}
	}
	endpointPolicy := ""
	if len(genesisPin) == 3 {
		endpointPolicy = genesisPin[2]
	}
	if endpointPolicy != "" && endpointPolicy != "https-v1" {
		return nil, errors.New("unsupported endpoint policy")
	}
	if err := validatePolicyKeys(policyKeys); err != nil {
		return nil, err
	}
	if err := validateIssuers(issuers); err != nil {
		return nil, err
	}
	if len(policyKeys) > 0 && len(issuers) == 0 {
		return nil, errors.New("placement policy requires issuers")
	}
	if !networkName.MatchString(network) {
		return nil, errors.New("invalid network")
	}
	a := &Application{db: db, state: State{Network: network, Accounts: map[string]Head{}}}
	a.state.GenesisPin = pin
	a.state.StateCommitment = scheme
	a.state.EndpointPolicy = endpointPolicy
	if len(policyKeys) > 0 {
		a.state.PolicyKeys = make(map[string]string, len(policyKeys))
		for k, v := range policyKeys {
			a.state.PolicyKeys[k] = v
		}
	}
	if len(issuers) > 0 {
		a.state.Issuers = make(map[string]string, len(issuers))
		for k, v := range issuers {
			a.state.Issuers[k] = v
		}
	}
	raw, err := db.Get([]byte("state"))
	if err != nil {
		return nil, err
	}
	if raw != nil {
		var saved State
		if err = json.Unmarshal(raw, &saved); err != nil {
			return nil, err
		}
		a.state = saved
		if a.state.EndpointPolicy != endpointPolicy {
			return nil, errors.New("endpoint policy configuration changed")
		}
		if a.state.GenesisPin != pin {
			return nil, errors.New("pinned genesis changed")
		}
		if a.state.StateCommitment != scheme {
			return nil, errors.New("state commitment configuration changed")
		}
		if a.state.Network != network || a.state.Accounts == nil {
			return nil, errors.New("state context")
		}
		for id, head := range a.state.Accounts {
			_, h, err := decodeRecordWithSigner(canonical(head.Record), network, historicalControlPublic(a.state, id, head.Record.Body.Version, false))
			if err != nil || head.Record.Body.UserID != id || h != head.Digest {
				return nil, errors.New("invalid stored account authority")
			}
		}
		if len(a.state.Issuers) != len(issuers) {
			return nil, errors.New("issuer configuration changed")
		}
		for k, v := range issuers {
			if a.state.Issuers[k] != v {
				return nil, errors.New("issuer configuration changed")
			}
		}
		if err := verifyCandidateRegistry(a.state); err != nil {
			return nil, err
		}
		if !bytes.Equal(canonical(a.state.PolicyKeys), canonical(policyKeys)) {
			return nil, errors.New("placement policy changed")
		}
		if err := verifyResourceRegistry(a.state); err != nil {
			return nil, err
		}
		if err := verifyManifestRegistry(a.state); err != nil {
			return nil, err
		}
		if err := verifyWriteQueue(a.state); err != nil {
			return nil, err
		}
		if err := verifyTransfers(a.state); err != nil {
			return nil, err
		}
		if err := verifyAdmissions(a.state); err != nil {
			return nil, err
		}
		if err := verifyCommitteeHistory(a.state); err != nil {
			return nil, err
		}
		if err := verifyDevices(a.state); err != nil {
			return nil, err
		}
		if err := verifyAccountControls(a.state); err != nil {
			return nil, err
		}
		if err := verifyCipherDevices(a.state); err != nil {
			return nil, err
		}
		if err := verifyCipherProfiles(a.state); err != nil {
			return nil, err
		}
		if err := verifyManifestLineages(a.state); err != nil {
			return nil, err
		}
		if err := verifyEndpoints(a.state); err != nil {
			return nil, err
		}
		if err := verifyRecoveryRoots(a.state); err != nil {
			return nil, err
		}
		if err := verifyRecoveryTrees(a.state); err != nil {
			return nil, err
		}
		if err := verifyGrowthGrants(a.state); err != nil {
			return nil, err
		}
	}
	return a, nil
}
func (a *Application) Info(context.Context, *abci.RequestInfo) (*abci.ResponseInfo, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return &abci.ResponseInfo{AppVersion: 1, LastBlockHeight: a.state.Height, LastBlockAppHash: digest(a.state)}, nil
}
func (a *Application) InitChain(_ context.Context, r *abci.RequestInitChain) (*abci.ResponseInitChain, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	issuers, err := genesisIssuers(r.AppStateBytes)
	if err != nil || len(issuers) != len(a.state.Issuers) {
		return nil, errors.New("genesis issuer mismatch")
	}
	var config GenesisApplication
	if len(r.AppStateBytes) > 0 {
		if err := json.Unmarshal(r.AppStateBytes, &config); err != nil {
			return nil, err
		}
	}
	if config.PlacementPolicy != (len(a.state.PolicyKeys) > 0) {
		return nil, errors.New("genesis placement policy mismatch")
	}
	if config.StateCommitment != a.state.StateCommitment {
		return nil, errors.New("genesis state commitment mismatch")
	}
	if config.EndpointPolicy != a.state.EndpointPolicy {
		return nil, errors.New("genesis endpoint policy mismatch")
	}
	for k, v := range issuers {
		if a.state.Issuers[k] != v {
			return nil, errors.New("genesis issuer mismatch")
		}
	}
	if r.ChainId != a.state.Network || r.InitialHeight != 1 {
		return nil, errors.New("unsupported genesis context")
	}
	return &abci.ResponseInitChain{AppHash: digest(a.state)}, nil
}
func (a *Application) CheckTx(_ context.Context, r *abci.RequestCheckTx) (*abci.ResponseCheckTx, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := clone(a.state)
	if err := apply(&s, r.Tx); err != nil {
		return &abci.ResponseCheckTx{Code: 1, Log: err.Error()}, nil
	}
	return &abci.ResponseCheckTx{}, nil
}
func clone(s State) State {
	c := s
	c.RecoveryTrees = make(map[string]RecoveryTreeHead, len(s.RecoveryTrees))
	for k, v := range s.RecoveryTrees {
		c.RecoveryTrees[k] = v
	}
	c.RecoveryRoots = make(map[string]RecoveryRootHead, len(s.RecoveryRoots))
	for k, v := range s.RecoveryRoots {
		v.Record.Body.Messages = append([]string{}, v.Record.Body.Messages...)
		v.Record.Body.Deleted = append([]string{}, v.Record.Body.Deleted...)
		c.RecoveryRoots[k] = v
	}
	c.Committees = append([]CommitteeHead(nil), s.Committees...)
	c.GrowthGrants = make(map[string]GrowthHead, len(s.GrowthGrants))
	for k, v := range s.GrowthGrants {
		v.Record.Consents = append([]Consent(nil), v.Record.Consents...)
		c.GrowthGrants[k] = v
	}
	c.Endpoints = make(map[string]EndpointHead, len(s.Endpoints))
	for k, v := range s.Endpoints {
		c.Endpoints[k] = v
	}
	c.ManifestLineage = make(map[string]ManifestLineage, len(s.ManifestLineage))
	for k, v := range s.ManifestLineage {
		v.Hashes = append([]string(nil), v.Hashes...)
		c.ManifestLineage[k] = v
	}
	c.Devices = make(map[string][]DeviceHead, len(s.Devices))
	c.AccountControls = make(map[string][]AccountControlHead, len(s.AccountControls))
	for k, v := range s.AccountControls {
		c.AccountControls[k] = append([]AccountControlHead(nil), v...)
	}
	c.CipherDevices = make(map[string]CipherDeviceHead, len(s.CipherDevices))
	c.CipherProfiles = make(map[string]CipherProfileHead, len(s.CipherProfiles))
	for k, v := range s.CipherProfiles {
		c.CipherProfiles[k] = v
	}
	for k, v := range s.CipherDevices {
		c.CipherDevices[k] = v
	}
	for k, v := range s.Devices {
		c.Devices[k] = append([]DeviceHead(nil), v...)
	}
	c.AdmissionRotations = make(map[string]AdmissionRotationHead, len(s.AdmissionRotations))
	for k, v := range s.AdmissionRotations {
		c.AdmissionRotations[k] = v
	}
	c.Admissions = make(map[string][]AdmissionHead, len(s.Admissions))
	for k, v := range s.Admissions {
		c.Admissions[k] = append([]AdmissionHead(nil), v...)
	}
	c.Transfers = make(map[string]TransferHead, len(s.Transfers))
	for k, v := range s.Transfers {
		c.Transfers[k] = v
	}
	c.WriteQueue = make(map[string]WriteHead, len(s.WriteQueue))
	for k, v := range s.WriteQueue {
		c.WriteQueue[k] = v
	}
	c.InitialBatches = make(map[string]InitialBatchReceipt, len(s.InitialBatches))
	for k, v := range s.InitialBatches {
		c.InitialBatches[k] = v
	}
	c.Manifests = make(map[string]ManifestHead, len(s.Manifests))
	for k, v := range s.Manifests {
		c.Manifests[k] = v
	}
	c.Resources = make(map[string]ResourceHead, len(s.Resources))
	for k, v := range s.Resources {
		c.Resources[k] = v
	}
	c.Candidates = make(map[string]CandidateHead, len(s.Candidates))
	for k, v := range s.Candidates {
		c.Candidates[k] = v
	}
	c.Accounts = make(map[string]Head, len(s.Accounts))
	for k, v := range s.Accounts {
		c.Accounts[k] = v
	}
	c.Placements = make(map[string]PlacementHead, len(s.Placements))
	for k, v := range s.Placements {
		c.Placements[k] = v
	}
	c.PlacementHistory = make(map[string][]PlacementHead, len(s.PlacementHistory))
	for k, v := range s.PlacementHistory {
		c.PlacementHistory[k] = append([]PlacementHead(nil), v...)
	}
	return c
}
func (a *Application) FinalizeBlock(_ context.Context, r *abci.RequestFinalizeBlock) (*abci.ResponseFinalizeBlock, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.Height != a.state.Height+1 {
		return nil, fmt.Errorf("unexpected height %d", r.Height)
	}
	s := clone(a.state)
	results := make([]*abci.ExecTxResult, len(r.Txs))
	if !r.Time.IsZero() {
		if r.Time.Unix() < s.BlockTime {
			return nil, errors.New("block time rollback")
		}
		s.BlockTime = r.Time.Unix()
	}
	for i, tx := range r.Txs {
		results[i] = &abci.ExecTxResult{}
		if err := apply(&s, tx); err != nil {
			results[i].Code = 1
			results[i].Log = err.Error()
		}
	}
	s.Height = r.Height
	a.pending = &s
	return &abci.ResponseFinalizeBlock{TxResults: results, AppHash: digest(s), ValidatorUpdates: committeeUpdates(s, r.Height)}, nil
}
func (a *Application) Commit(context.Context, *abci.RequestCommit) (*abci.ResponseCommit, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pending == nil {
		return nil, errors.New("no finalized block")
	}
	for _, head := range a.pending.Committees {
		if head.Height == a.pending.Height {
			proof, err := makeStateProof(*a.pending, committeeKey(head.Record.Body.Version))
			if err != nil {
				return nil, err
			}
			if err := a.db.SetSync([]byte(committeeKey(head.Record.Body.Version)), canonical(proof)); err != nil {
				return nil, err
			}
		}
	}
	if err := a.db.SetSync([]byte("state"), canonical(*a.pending)); err != nil {
		return nil, err
	}
	a.state = *a.pending
	a.pending = nil
	return &abci.ResponseCommit{}, nil
}
func (a *Application) Query(_ context.Context, r *abci.RequestQuery) (*abci.ResponseQuery, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.Prove {
		return &abci.ResponseQuery{Code: 1, Log: "proof adapter not implemented"}, nil
	}
	if r.Path == "/committee-history" {
		proofs := []StateProof{}
		for _, head := range a.state.Committees {
			raw, err := a.db.Get([]byte(committeeKey(head.Record.Body.Version)))
			if err != nil {
				return nil, err
			}
			var proof StateProof
			if raw == nil || json.Unmarshal(raw, &proof) != nil {
				return &abci.ResponseQuery{Code: 1, Log: "committee proof unavailable"}, nil
			}
			proofs = append(proofs, proof)
		}
		return &abci.ResponseQuery{Value: canonical(proofs), Height: a.state.Height}, nil
	}
	if r.Path == "/state-proof" && (r.Height == 0 || r.Height == a.state.Height) {
		proof, err := makeStateProof(a.state, string(r.Data))
		if err != nil {
			return &abci.ResponseQuery{Code: 1, Log: err.Error()}, nil
		}
		return &abci.ResponseQuery{Value: canonical(proof), Height: a.state.Height}, nil
	}
	if r.Path == "/snapshot" && (r.Height == 0 || r.Height == a.state.Height) {
		// Full-state snapshots remain bounded independently of paged reads.
		value := canonical(a.state)
		if len(value) > 1048576 {
			return &abci.ResponseQuery{Code: 1, Log: "snapshot exceeds lab limit"}, nil
		}
		return &abci.ResponseQuery{Value: value, Height: a.state.Height}, nil
	}
	if r.Path == "/manifest-page" && (r.Height == 0 || r.Height == a.state.Height) {
		page, err := makeManifestPage(a.state, r.Data)
		if err != nil {
			return &abci.ResponseQuery{Code: 1, Log: err.Error()}, nil
		}
		return &abci.ResponseQuery{Value: canonical(page), Height: a.state.Height}, nil
	}
	if r.Path != "/account" || (r.Height != 0 && r.Height != a.state.Height) {
		return &abci.ResponseQuery{Code: 1, Log: "unsupported query"}, nil
	}
	h, ok := a.state.Accounts[string(r.Data)]
	if !ok {
		return &abci.ResponseQuery{Code: 1, Log: "unknown account", Height: a.state.Height}, nil
	}
	return &abci.ResponseQuery{Value: canonical(h), Height: a.state.Height}, nil
}
