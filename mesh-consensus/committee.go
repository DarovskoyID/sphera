package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	abci "github.com/cometbft/cometbft/abci/types"
	cmted "github.com/cometbft/cometbft/crypto/ed25519"
	"github.com/cometbft/cometbft/types"
)

// Governance votes authorize a proposal; clients additionally require an old
// committee's committed header and an inclusion proof of the accepted change.
type CommitteeBody struct {
	Domain     string            `json:"domain"`
	Network    string            `json:"network"`
	Genesis    string            `json:"genesis"`
	Version    int64             `json:"version"`
	Previous   string            `json:"previous"`
	ActivateAt int64             `json:"activate_at"`
	Members    []string          `json:"members"`
	Admissions map[string]string `json:"admissions"`
}
type CommitteeRecord struct {
	Body  CommitteeBody `json:"body"`
	Votes []Consent     `json:"votes"`
	Joins []Consent     `json:"joins"`
}
type CommitteeHead struct {
	Record     CommitteeRecord `json:"record"`
	Digest     string          `json:"digest"`
	Height     int64           `json:"height"`
	AcceptedAt int64           `json:"accepted_at"`
}

func committeeKey(version int64) string { return fmt.Sprintf("committee/%020d", version) }
func initialCommittee(keys map[string]string) []string {
	members := []string{}
	for _, public := range keys {
		members = append(members, public)
	}
	sort.Strings(members)
	return members
}
func committeeMembers(base []string, history []CommitteeHead, height int64) []string {
	members := base
	for _, head := range history {
		if head.Record.Body.ActivateAt <= height {
			members = head.Record.Body.Members
		}
	}
	return members
}
func memberSet(members []string) (*types.ValidatorSet, error) {
	if len(members) < 4 || len(members) > 16 {
		return nil, errors.New("committee must have 4..16 validators")
	}
	vals := []*types.Validator{}
	previous := ""
	for _, public := range members {
		if !hex64.MatchString(public) || public <= previous {
			return nil, errors.New("invalid committee keys or order")
		}
		raw, _ := hex.DecodeString(public)
		vals = append(vals, types.NewValidator(cmted.PubKey(raw), 1))
		previous = public
	}
	return types.NewValidatorSet(vals), nil
}
func checkCommitteeRecord(network, pin string, base []string, history []CommitteeHead, head CommitteeHead) error {
	b := head.Record.Body
	if b.Domain != "sfera-mesh-committee-lab-v1" || b.Network != network || b.Genesis != pin || !hex64.MatchString(pin) ||
		b.Version != int64(len(history)+1) || b.Version > 16 || head.Height < 1 || head.AcceptedAt < 0 ||
		b.ActivateAt < head.Height+4 || b.ActivateAt > head.Height+64 || head.Digest != hex.EncodeToString(digest(head.Record)) {
		return errors.New("invalid committee change context")
	}
	previous := zero
	if len(history) > 0 {
		old := history[len(history)-1]
		previous = old.Digest
		if head.Height < old.Record.Body.ActivateAt+2 {
			return errors.New("committee activation still pending")
		}
	}
	if b.Previous != previous {
		return errors.New("committee chain conflict")
	}
	oldMembers := committeeMembers(base, history, head.Height)
	if _, err := memberSet(oldMembers); err != nil {
		return err
	}
	if _, err := memberSet(b.Members); err != nil {
		return err
	}
	if bytes.Equal(canonical(oldMembers), canonical(b.Members)) {
		return errors.New("committee change is empty")
	}
	oldSet := map[string]bool{}
	newSet := map[string]bool{}
	for _, p := range oldMembers {
		oldSet[p] = true
	}
	for _, p := range b.Members {
		newSet[p] = true
	}
	votes := head.Record.Votes
	if len(votes) <= 2*len(oldMembers)/3 || len(votes) > len(oldMembers) {
		return errors.New("committee change quorum required")
	}
	previousKey := ""
	for _, v := range votes {
		if v.PublicKey <= previousKey || !oldSet[v.PublicKey] || !admissionSignature(v.PublicKey, v.Signature, b) {
			return errors.New("invalid committee vote")
		}
		previousKey = v.PublicKey
	}
	joins := map[string]bool{}
	previousKey = ""
	for _, v := range head.Record.Joins {
		if v.PublicKey <= previousKey || oldSet[v.PublicKey] || !newSet[v.PublicKey] || !admissionSignature(v.PublicKey, v.Signature, b) {
			return errors.New("invalid joining validator proof")
		}
		joins[v.PublicKey] = true
		previousKey = v.PublicKey
	}
	for p := range newSet {
		if !oldSet[p] && !joins[p] {
			return errors.New("joining validator possession required")
		}
	}
	if len(b.Admissions) != len(joins) {
		return errors.New("joining admission anchors required")
	}
	for public, anchor := range b.Admissions {
		if !joins[public] || !hex64.MatchString(anchor) {
			return errors.New("invalid joining admission anchor")
		}
	}
	return nil
}
func checkCommitteeAdmissions(s State, head CommitteeHead, base []string, prior []CommitteeHead, historical bool) error {
	old := map[string]bool{}
	for _, p := range committeeMembers(base, prior, head.Height) {
		old[p] = true
	}
	for _, public := range head.Record.Body.Members {
		if old[public] {
			continue
		}
		raw, _ := hex.DecodeString(public)
		node := hex.EncodeToString(hashNode(raw))
		var latest *AdmissionHead
		for _, decision := range s.Admissions[node] {
			if decision.AcceptedAt <= head.AcceptedAt && (!historical || decision.Digest == head.Record.Body.Admissions[public]) {
				v := decision
				latest = &v
			}
		}
		if latest == nil || latest.Application.Body.PublicKey != public || latest.Digest != head.Record.Body.Admissions[public] {
			return errors.New("joining validator admission required")
		}
		_, domain, _, expires := admissionVersion(*latest)
		if domain != "sfera-mesh-admission-approval-lab-v1" || expires <= head.AcceptedAt {
			return errors.New("joining validator admission inactive")
		}
	}
	return nil
}
func verifyCommitteeHistory(s State) error {
	if len(s.Committees) == 0 {
		return nil
	}
	if s.StateCommitment != stateMerkleScheme || len(s.PolicyKeys) != 4 || len(s.Committees) > 16 {
		return errors.New("committee changes require compact policy genesis")
	}
	base := initialCommittee(s.PolicyKeys)
	for i, head := range s.Committees {
		if head.Height > s.Height {
			return errors.New("future committee acceptance")
		}
		if err := checkCommitteeRecord(s.Network, s.GenesisPin, base, s.Committees[:i], head); err != nil {
			return err
		}
		if err := checkCommitteeAdmissions(s, head, base, s.Committees[:i], true); err != nil {
			return err
		}
	}
	return nil
}
func applyCommittee(s *State, tx []byte) error {
	var record CommitteeRecord
	decoder := json.NewDecoder(bytes.NewReader(tx))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil {
		return err
	}
	if !bytes.Equal(tx, canonical(record)) {
		return errors.New("noncanonical committee change")
	}
	hash := hex.EncodeToString(digest(record))
	for _, head := range s.Committees {
		if head.Digest == hash {
			return nil
		}
	}
	head := CommitteeHead{record, hash, s.Height + 1, s.BlockTime}
	if s.StateCommitment != stateMerkleScheme || len(s.PolicyKeys) != 4 {
		return errors.New("committee changes require compact policy genesis")
	}
	base := initialCommittee(s.PolicyKeys)
	if err := checkCommitteeRecord(s.Network, s.GenesisPin, base, s.Committees, head); err != nil {
		return err
	}
	if err := checkCommitteeAdmissions(*s, head, base, s.Committees, false); err != nil {
		return err
	}
	s.Committees = append(s.Committees, head)
	return nil
}
func committeeUpdates(s State, height int64) []abci.ValidatorUpdate {
	base := initialCommittee(s.PolicyKeys)
	before := committeeMembers(base, s.Committees, height+1)
	after := committeeMembers(base, s.Committees, height+2)
	if bytes.Equal(canonical(before), canonical(after)) {
		return nil
	}
	updates := []abci.ValidatorUpdate{}
	old, newKeys := map[string]bool{}, map[string]bool{}
	for _, p := range before {
		old[p] = true
	}
	for _, p := range after {
		newKeys[p] = true
	}
	for _, p := range before {
		if !newKeys[p] {
			raw, _ := hex.DecodeString(p)
			updates = append(updates, abci.Ed25519ValidatorUpdate(raw, 0))
		}
	}
	for _, p := range after {
		if !old[p] {
			raw, _ := hex.DecodeString(p)
			updates = append(updates, abci.Ed25519ValidatorUpdate(raw, 1))
		}
	}
	return updates
}
