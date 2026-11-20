package main

// A bounded, replicated one-time-key journal. Consuming keys is a consensus
// operation, never a SELECT against an entry's private SQL cache. Only public
// Matrix SDK documents are admitted; private/session keys are not accepted.
import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
)

type ApplicationKeyBody struct {
	Domain         string `json:"domain"`
	Network        string `json:"network"`
	Genesis        string `json:"genesis"`
	Owner          string `json:"owner"`
	Device         string `json:"device"`
	DevicesVersion int64  `json:"devices_version"`
	Request        string `json:"request"`
	Kind           string `json:"kind"`
	Dialog         string `json:"dialog"`
	TargetOwner    string `json:"target_owner"`
	TargetDevice   string `json:"target_device"`
	KeysUTF8       string `json:"keys_utf8"`
}
type ApplicationKeyRecord struct {
	Body      ApplicationKeyBody `json:"body"`
	Signature string             `json:"signature"`
}
type ApplicationKeyReceipt struct {
	Record  ApplicationKeyRecord `json:"record"`
	Digest  string               `json:"digest"`
	KeyID   string               `json:"key_id"`
	KeyUTF8 string               `json:"key_utf8"`
}
type applicationPublicKey struct {
	Document string
	Public   string
	Consumed bool
}
type applicationKeyPool map[string]map[string]applicationPublicKey

var applicationKeyID = regexp.MustCompile(`^signed_curve25519:[A-Za-z0-9+/]{1,128}$`)
var applicationRequestID = regexp.MustCompile(`^[A-Za-z0-9._:+/-]{1,128}$`)

func sdkPublic(value string, size int) ([]byte, error) {
	raw, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil || len(raw) != size || base64.RawStdEncoding.EncodeToString(raw) != value {
		return nil, errors.New("application SDK key encoding")
	}
	return raw, nil
}

func decodeApplicationKey(s State, tx []byte, current bool) (ApplicationKeyRecord, error) {
	var r ApplicationKeyRecord
	if len(tx) > 65536 || json.Unmarshal(tx, &r) != nil || !bytes.Equal(tx, canonical(r)) {
		return r, errors.New("application key encoding")
	}
	b := r.Body
	history := s.Devices[b.Owner]
	if b.Domain != "sfera-mesh-application-key-v1" || b.Network != s.Network || b.Genesis != s.GenesisPin || !applicationRequestID.MatchString(b.Request) || b.DevicesVersion < 1 || b.DevicesVersion > int64(len(history)) || current && b.DevicesVersion != int64(len(history)) {
		return r, errors.New("application key context")
	}
	active := false
	for _, h := range history[:b.DevicesVersion] {
		if h.Event.Body.DeviceID == b.Device {
			active = h.Event.Body.Operation == "enroll"
		}
	}
	certificate, ok := s.CipherDevices[b.Owner+":"+b.Device]
	if !active || !ok {
		return r, errors.New("application key device not admitted")
	}
	pub, err := sdkPublic(certificate.Certificate.Body.Ed25519, 32)
	if err != nil {
		return r, err
	}
	sig, err := sdkPublic(r.Signature, 64)
	if err != nil || !ed25519.Verify(pub, canonical(b), sig) {
		return r, errors.New("application key signature")
	}
	if b.Kind == "upload" {
		if b.Dialog != "" || b.TargetOwner != "" || b.TargetDevice != "" || b.KeysUTF8 == "" {
			return r, errors.New("application key upload context")
		}
	} else if b.Kind == "claim" {
		dialog, ok := s.ApplicationDialogs[b.Dialog]
		if !ok || b.KeysUTF8 != "" || b.Owner == b.TargetOwner && b.Device == b.TargetDevice {
			return r, errors.New("application key claim context")
		}
		members := dialog.Record.Body.Members
		if len(members) != 2 || !((members[0] == b.Owner || members[1] == b.Owner) && (members[0] == b.TargetOwner || members[1] == b.TargetOwner)) {
			return r, errors.New("application key target not member")
		}
		target, ok := s.CipherDevices[b.TargetOwner+":"+b.TargetDevice]
		if !ok {
			return r, errors.New("application key target not pinned")
		}
		if current {
			enabled := false
			for _, h := range s.Devices[b.TargetOwner] {
				if h.Event.Body.DeviceID == b.TargetDevice {
					enabled = h.Event.Body.Operation == "enroll"
				}
			}
			if !enabled {
				return r, errors.New("application key target revoked")
			}
		}
		_ = target
	} else {
		return r, errors.New("application key kind")
	}
	return r, nil
}

// Matrix signatures exclude unsigned/signatures. This schema deliberately only
// accepts signed_curve25519 one-time keys; fallback is an explicit future format.
func applicationKeyDocuments(s State, r ApplicationKeyRecord) (map[string]applicationPublicKey, error) {
	raw, err := hex.DecodeString(r.Body.KeysUTF8)
	if err != nil || hex.EncodeToString(raw) != r.Body.KeysUTF8 || len(raw) > 30000 {
		return nil, errors.New("application key documents encoding")
	}
	for _, v := range raw {
		if v < 32 || v > 126 || v == '<' || v == '>' || v == '&' {
			return nil, errors.New("application key documents ASCII")
		}
	}
	var docs map[string]json.RawMessage
	if json.Unmarshal(raw, &docs) != nil || !bytes.Equal(raw, canonical(docs)) || len(docs) < 1 || len(docs) > 128 {
		return nil, errors.New("application key documents schema")
	}
	cert := s.CipherDevices[r.Body.Owner+":"+r.Body.Device].Certificate.Body
	pub, _ := sdkPublic(cert.Ed25519, 32)
	user := "@" + r.Body.Owner + ":" + s.GenesisPin + ".sphere"
	result := map[string]applicationPublicKey{}
	for id, doc := range docs {
		if !applicationKeyID.MatchString(id) {
			return nil, errors.New("application one time key id")
		}
		var value struct {
			Key        string                       `json:"key"`
			Signatures map[string]map[string]string `json:"signatures"`
		}
		if json.Unmarshal(doc, &value) != nil || !bytes.Equal(doc, canonical(value)) {
			return nil, errors.New("application one time key schema")
		}
		if _, err := sdkPublic(value.Key, 32); err != nil {
			return nil, err
		}
		sig, err := sdkPublic(value.Signatures[user]["ed25519:"+r.Body.Device], 64)
		if err != nil || !ed25519.Verify(pub, canonical(map[string]string{"key": value.Key}), sig) {
			return nil, errors.New("application one time key signature")
		}
		result[id] = applicationPublicKey{Document: hex.EncodeToString(doc), Public: value.Key}
	}
	return result, nil
}

func performApplicationKey(s State, pool applicationKeyPool, r ApplicationKeyRecord) (string, string, error) {
	b := r.Body
	identity := b.Owner + ":" + b.Device
	if b.Kind == "upload" {
		docs, err := applicationKeyDocuments(s, r)
		if err != nil {
			return "", "", err
		}
		current := pool[identity]
		if current == nil {
			current = map[string]applicationPublicKey{}
		}
		for id, doc := range docs {
			if old, ok := current[id]; ok && old.Document != doc.Document {
				return "", "", errors.New("application key id immutable")
			}
			// An SDK signature signs the curve key, not its transport ID. Relabeling a
			// consumed key must never put it back in the available pool.
			for oldID, old := range current {
				if old.Public == doc.Public && oldID != id {
					return "", "", errors.New("application key alias")
				}
			}
			for otherID, other := range docs {
				if otherID != id && other.Public == doc.Public {
					return "", "", errors.New("application key alias")
				}
			}
		}
		newCount := len(current)
		for id := range docs {
			if _, exists := current[id]; !exists {
				newCount++
			}
		}
		if newCount > 512 {
			return "", "", errors.New("application device key capacity")
		}
		for id, doc := range docs {
			if _, exists := current[id]; !exists {
				current[id] = doc
			}
		}
		pool[identity] = current
		return "", "", nil
	}
	target := pool[b.TargetOwner+":"+b.TargetDevice]
	ids := []string{}
	for id, key := range target {
		if !key.Consumed {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	if len(ids) == 0 {
		return "", "", nil
	}
	id := ids[0]
	key := target[id]
	key.Consumed = true
	target[id] = key
	return id, key.Document, nil
}

func replayApplicationKeys(s State) (applicationKeyPool, error) {
	pool := applicationKeyPool{}
	if len(s.ApplicationKeys) > 512 || len(canonical(s.ApplicationKeys)) > 524288 {
		return nil, errors.New("application key journal capacity")
	}
	seen := map[string]bool{}
	for _, receipt := range s.ApplicationKeys {
		r, err := decodeApplicationKey(s, canonical(receipt.Record), false)
		if err != nil {
			return nil, err
		}
		identity := r.Body.Owner + ":" + r.Body.Device + ":" + r.Body.Request
		if seen[identity] || receipt.Digest != hex.EncodeToString(digest(r)) {
			return nil, errors.New("application key receipt identity")
		}
		seen[identity] = true
		id, doc, err := performApplicationKey(s, pool, r)
		if err != nil || id != receipt.KeyID || doc != receipt.KeyUTF8 {
			return nil, errors.New("application key receipt result")
		}
	}
	return pool, nil
}

func applyApplicationKey(s *State, tx []byte) error {
	r, err := decodeApplicationKey(*s, tx, true)
	if err != nil {
		return err
	}
	hash := hex.EncodeToString(digest(r))
	for _, old := range s.ApplicationKeys {
		if old.Record.Body.Owner == r.Body.Owner && old.Record.Body.Device == r.Body.Device && old.Record.Body.Request == r.Body.Request {
			if old.Digest == hash {
				return nil
			}
			return errors.New("application key request conflict")
		}
	}
	pool, err := replayApplicationKeys(*s)
	if err != nil {
		return err
	}
	id, doc, err := performApplicationKey(*s, pool, r)
	if err != nil {
		return err
	}
	next := append(append([]ApplicationKeyReceipt(nil), s.ApplicationKeys...), ApplicationKeyReceipt{r, hash, id, doc})
	if len(next) > 512 || len(canonical(next)) > 524288 {
		return errors.New("application key journal capacity")
	}
	// The existing readers impose a one MiB snapshot bound. Do not admit a new
	// journal record that would leave them unable to verify the network.
	candidate := *s
	candidate.ApplicationKeys = next
	if len(canonical(candidate)) > 950000 {
		return errors.New("application snapshot capacity")
	}
	s.ApplicationKeys = next
	return nil
}
