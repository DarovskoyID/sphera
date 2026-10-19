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
	Network  string          `json:"network"`
	Height   int64           `json:"height"`
	Accounts map[string]Head `json:"accounts"`
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
func digest(v any) []byte { sum := sha256.Sum256(canonical(v)); return sum[:] }
func decodeRecord(tx []byte, network string) (Record, string, error) {
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
	sig, err := hex.DecodeString(r.Signature)
	if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != r.Signature || hex.EncodeToString(id[:]) != b.UserID || !ed25519.Verify(pub, canonical(b), sig) {
		return r, "", errors.New("owner signature")
	}
	return r, hex.EncodeToString(digest(r)), nil
}
func apply(s *State, tx []byte) error {
	r, h, err := decodeRecord(tx, s.Network)
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
	if !networkName.MatchString(network) {
		return nil, errors.New("invalid network")
	}
	a := &Application{db: db, state: State{Network: network, Accounts: map[string]Head{}}}
	raw, err := db.Get([]byte("state"))
	if err != nil {
		return nil, err
	}
	if raw != nil {
		if err = json.Unmarshal(raw, &a.state); err != nil {
			return nil, err
		}
		if a.state.Network != network || a.state.Accounts == nil {
			return nil, errors.New("state context")
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
	if r.ChainId != a.state.Network || r.InitialHeight != 1 || len(r.AppStateBytes) != 0 {
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
	c.Accounts = make(map[string]Head, len(s.Accounts))
	for k, v := range s.Accounts {
		c.Accounts[k] = v
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
	for i, tx := range r.Txs {
		results[i] = &abci.ExecTxResult{}
		if err := apply(&s, tx); err != nil {
			results[i].Code = 1
			results[i].Log = err.Error()
		}
	}
	s.Height = r.Height
	a.pending = &s
	return &abci.ResponseFinalizeBlock{TxResults: results, AppHash: digest(s)}, nil
}
func (a *Application) Commit(context.Context, *abci.RequestCommit) (*abci.ResponseCommit, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pending == nil {
		return nil, errors.New("no finalized block")
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
	if r.Path == "/snapshot" && (r.Height == 0 || r.Height == a.state.Height) {
		value := canonical(a.state)
		if len(value) > 1048576 {
			return &abci.ResponseQuery{Code: 1, Log: "snapshot exceeds lab limit"}, nil
		}
		return &abci.ResponseQuery{Value: value, Height: a.state.Height}, nil
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
