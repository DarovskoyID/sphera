package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
)

const recoveryTreeDomain = "sfera-mesh-recovery-tree-v2\x00"

type RecoveryTreeBody struct {
	Domain       string `json:"domain"`
	Network      string `json:"network"`
	Genesis      string `json:"genesis"`
	Publisher    string `json:"publisher"`
	PublicKey    string `json:"public_key"`
	Source       string `json:"source"`
	Scope        string `json:"scope"`
	Version      int64  `json:"version"`
	Previous     string `json:"previous"`
	Cluster      string `json:"cluster"`
	Digest       string `json:"digest"`
	Size         int64  `json:"size"`
	Root         string `json:"root"`
	Count        int64  `json:"count"`
	DeletedCount int64  `json:"deleted_count"`
	UpdatesHash  string `json:"updates_hash"`
}
type RecoveryTreeRecord struct {
	Body      RecoveryTreeBody `json:"body"`
	Signature string           `json:"signature"`
}
type RecoveryTreeHead struct {
	Record RecoveryTreeRecord `json:"record"`
	Digest string             `json:"digest"`
}
type RecoveryTreeUpdate struct {
	Message string   `json:"message"`
	Old     int      `json:"old"`
	New     int      `json:"new"`
	Path    []string `json:"path"`
}
type RecoveryTreeTransaction struct {
	Body      RecoveryTreeBody     `json:"body"`
	Signature string               `json:"signature"`
	Updates   []RecoveryTreeUpdate `json:"updates"`
}

func treeHash(raw []byte) []byte { value := sha256.Sum256(raw); return value[:] }
func treeParent(left, right []byte) []byte {
	raw := append([]byte{1}, []byte(recoveryTreeDomain)...)
	raw = append(raw, left...)
	raw = append(raw, right...)
	return treeHash(raw)
}
func treeEmpty() [129][]byte {
	var values [129][]byte
	values[0] = treeHash(append(append([]byte{0}, []byte(recoveryTreeDomain)...), 0))
	for i := 1; i <= 128; i++ {
		values[i] = treeParent(values[i-1], values[i-1])
	}
	return values
}
func treeUUID(id string) ([]byte, error) {
	if !recoveryScope.MatchString(id) {
		return nil, errors.New("invalid recovery tree UUID")
	}
	raw := make([]byte, 0, 32)
	for _, c := range []byte(id) {
		if c != '-' {
			raw = append(raw, c)
		}
	}
	return hex.DecodeString(string(raw))
}
func treeLeaf(id string, status int) ([]byte, error) {
	key, err := treeUUID(id)
	if err != nil || status < 0 || status > 2 {
		return nil, errors.New("invalid recovery tree leaf")
	}
	raw := append([]byte{0}, []byte(recoveryTreeDomain)...)
	if status == 0 {
		raw = append(raw, 0)
	} else {
		raw = append(raw, key...)
		raw = append(raw, byte(status))
	}
	return treeHash(raw), nil
}
func treePath(id string, status int, path []string) (string, error) {
	key, err := treeUUID(id)
	if err != nil || len(path) != 128 {
		return "", errors.New("invalid recovery tree path")
	}
	value, err := treeLeaf(id, status)
	if err != nil {
		return "", err
	}
	for level, sibling := range path {
		if !hex64.MatchString(sibling) {
			return "", errors.New("invalid recovery tree sibling")
		}
		other, _ := hex.DecodeString(sibling)
		if key[15-level/8]&(1<<uint(level%8)) != 0 {
			value = treeParent(other, value)
		} else {
			value = treeParent(value, other)
		}
	}
	return hex.EncodeToString(value), nil
}
func treeTransition(root string, count, deleted int64, updates []RecoveryTreeUpdate) (string, int64, int64, error) {
	if !hex64.MatchString(root) || count < 0 || deleted < 0 || deleted > count || updates == nil || len(updates) > 4 {
		return "", 0, 0, errors.New("invalid recovery tree transition")
	}
	empty := treeEmpty()
	if (count == 0) != (root == hex.EncodeToString(empty[128])) {
		return "", 0, 0, errors.New("invalid empty recovery tree")
	}
	seen := map[string]bool{}
	for _, u := range updates {
		if seen[u.Message] || u.Old < 0 || u.Old > 2 || u.New < 1 || u.New > 2 || (u.Old == 2 && u.New != 2) {
			return "", 0, 0, errors.New("recovery tree omission or resurrection")
		}
		seen[u.Message] = true
		old, err := treePath(u.Message, u.Old, u.Path)
		if err != nil || old != root {
			return "", 0, 0, errors.New("recovery tree old root mismatch")
		}
		root, err = treePath(u.Message, u.New, u.Path)
		if err != nil {
			return "", 0, 0, err
		}
		if u.Old == 0 {
			if count == math.MaxInt64 {
				return "", 0, 0, errors.New("recovery tree count overflow")
			}
			count++
		}
		if u.New == 2 && u.Old != 2 {
			if deleted == math.MaxInt64 {
				return "", 0, 0, errors.New("recovery tree deletion count overflow")
			}
			deleted++
		}
		if deleted > count {
			return "", 0, 0, errors.New("recovery tree deletion count overflow")
		}
	}
	return root, count, deleted, nil
}
func recoveryTreeKey(b RecoveryTreeBody) string {
	return recoveryRootKey(RecoveryRootBody{Publisher: b.Publisher, Source: b.Source, Scope: b.Scope})
}
func decodeRecoveryTree(record RecoveryTreeRecord, s State) (string, error) {
	b := record.Body
	if b.Domain != "sfera-mesh-recovery-tree-head-v2" || b.Network != s.Network || b.Genesis != s.GenesisPin ||
		(b.Source != "dm" && b.Source != "guild") || !recoveryScope.MatchString(b.Scope) || b.Version < 1 || b.Size < 1 || b.Size > 262144 || b.Count < 0 || b.DeletedCount < 0 || b.DeletedCount > b.Count {
		return "", errors.New("invalid recovery tree head")
	}
	if b.Version == 1 && b.Previous != zero {
		return "", errors.New("invalid initial recovery tree previous")
	}
	for _, value := range []string{b.Genesis, b.Publisher, b.PublicKey, b.Previous, b.Cluster, b.Digest, b.Root, b.UpdatesHash} {
		if !hex64.MatchString(value) {
			return "", errors.New("invalid recovery tree digest")
		}
	}
	empty := treeEmpty()
	if (b.Count == 0) != (b.Root == hex.EncodeToString(empty[128])) {
		return "", errors.New("invalid empty recovery tree")
	}
	public, _ := hex.DecodeString(b.PublicKey)
	signature, err := hex.DecodeString(record.Signature)
	if err != nil || len(signature) != 64 || hex.EncodeToString(signature) != record.Signature || hex.EncodeToString(hashNode(public)) != b.Publisher || !ed25519.Verify(public, canonical(b), signature) {
		return "", errors.New("invalid recovery tree signature")
	}
	candidate, ok := s.Candidates[b.Publisher]
	if !ok || candidate.Record.Body.PublicKey != b.PublicKey {
		return "", errors.New("registered recovery tree publisher required")
	}
	manifest, ok := s.Manifests[b.Cluster]
	if !ok || manifest.Record.Body.Sizes == nil {
		return "", errors.New("sized recovery tree manifest required")
	}
	found := false
	if len(manifest.Record.Body.Digests) != len(*manifest.Record.Body.Sizes) {
		return "", errors.New("invalid recovery tree manifest sizes")
	}
	for i, value := range manifest.Record.Body.Digests {
		if value == b.Digest && (*manifest.Record.Body.Sizes)[i] == b.Size {
			found = true
		}
	}
	if !found {
		return "", errors.New("uncommitted recovery tree index")
	}
	return hex.EncodeToString(digest(record)), nil
}
func applyRecoveryTree(s *State, raw []byte) error {
	var tx RecoveryTreeTransaction
	if json.Unmarshal(raw, &tx) != nil || !bytes.Equal(raw, canonical(tx)) || tx.Updates == nil || len(tx.Updates) > 4 || tx.Body.UpdatesHash != hex.EncodeToString(digest(tx.Updates)) {
		return errors.New("invalid recovery tree transaction")
	}
	record := RecoveryTreeRecord{tx.Body, tx.Signature}
	hash, err := decodeRecoveryTree(record, *s)
	if err != nil {
		return err
	}
	key := recoveryTreeKey(tx.Body)
	old, exists := s.RecoveryTrees[key]
	if exists && old.Digest == hash {
		return nil
	}
	if err := verifyLicense(s.Candidates[tx.Body.Publisher].Record.Body.License, s.Issuers, tx.Body.Publisher, s.Network, s.BlockTime); err != nil {
		return err
	}
	empty := treeEmpty()
	root := hex.EncodeToString(empty[128])
	var count, deleted int64
	previous := zero
	version := int64(0)
	if exists {
		root = old.Record.Body.Root
		count = old.Record.Body.Count
		deleted = old.Record.Body.DeletedCount
		previous = old.Digest
		version = old.Record.Body.Version
	} else if legacy, ok := s.RecoveryRoots[key]; ok {
		// Migration is deliberately separate from mutation: each old leaf is carried
		// over exactly, including every terminal deletion. The next tx may update it.
		if len(tx.Updates) != 0 {
			return errors.New("recovery tree migration must retain exact legacy registry")
		}
		root, err = treeLegacy(legacy.Record.Body.Messages, legacy.Record.Body.Deleted)
		if err != nil {
			return err
		}
		count = int64(len(legacy.Record.Body.Messages))
		deleted = int64(len(legacy.Record.Body.Deleted))
		previous = legacy.Digest
		version = legacy.Record.Body.Version
	}
	if !exists {
		namespaces := map[string]bool{}
		for k := range s.RecoveryRoots {
			namespaces[k] = true
		}
		for k := range s.RecoveryTrees {
			namespaces[k] = true
		}
		if !namespaces[key] && len(namespaces) >= 128 {
			return errors.New("recovery tree namespace capacity")
		}
	}
	if version == math.MaxInt64 || tx.Body.Version != version+1 || tx.Body.Previous != previous {
		return errors.New("recovery tree version conflict")
	}
	root, count, deleted, err = treeTransition(root, count, deleted, tx.Updates)
	if err != nil {
		return err
	}
	if root != tx.Body.Root || count != tx.Body.Count || deleted != tx.Body.DeletedCount {
		return errors.New("recovery tree transition commitment mismatch")
	}
	if s.RecoveryTrees == nil {
		s.RecoveryTrees = map[string]RecoveryTreeHead{}
	}
	s.RecoveryTrees[key] = RecoveryTreeHead{record, hash}
	return nil
}

// Used only for the bounded v1 migration, never for ordinary v2 updates.
func treeLegacy(messages, deleted []string) (string, error) {
	empty := treeEmpty()
	nodes := map[string][]byte{}
	removed := map[string]bool{}
	for _, id := range deleted {
		removed[id] = true
	}
	for _, id := range messages {
		key, err := treeUUID(id)
		if err != nil {
			return "", err
		}
		status := 1
		if removed[id] {
			status = 2
		}
		value, _ := treeLeaf(id, status)
		bits := ""
		for _, b := range key {
			for n := 7; n >= 0; n-- {
				if b&(1<<uint(n)) != 0 {
					bits += "1"
				} else {
					bits += "0"
				}
			}
		}
		nodes[bits] = value
		for level := 0; level < 128; level++ {
			prefix := bits[:len(bits)-1]
			last := bits[len(bits)-1]
			sibling := prefix + "0"
			if last == '0' {
				sibling = prefix + "1"
			}
			other, ok := nodes[sibling]
			if !ok {
				other = empty[level]
			}
			if last == '1' {
				value = treeParent(other, value)
			} else {
				value = treeParent(value, other)
			}
			bits = prefix
			nodes[bits] = value
		}
	}
	if value, ok := nodes[""]; ok {
		return hex.EncodeToString(value), nil
	}
	return hex.EncodeToString(empty[128]), nil
}
func verifyRecoveryTrees(s State) error {
	namespaces := map[string]bool{}
	for k := range s.RecoveryRoots {
		namespaces[k] = true
	}
	for key, head := range s.RecoveryTrees {
		hash, err := decodeRecoveryTree(head.Record, s)
		if err != nil || hash != head.Digest || key != recoveryTreeKey(head.Record.Body) {
			return errors.New("invalid recovery tree snapshot")
		}
		namespaces[key] = true
	}
	if len(namespaces) > 128 {
		return errors.New("recovery tree namespace capacity")
	}
	return nil
}
