package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type EndpointBody struct {
	Domain    string `json:"domain"`
	Network   string `json:"network"`
	NodeID    string `json:"node_id"`
	PublicKey string `json:"public_key"`
	Version   int64  `json:"version"`
	Previous  string `json:"previous"`
	Endpoint  string `json:"endpoint"`
	IssuedAt  int64  `json:"issued_at"`
	ExpiresAt int64  `json:"expires_at"`
}
type EndpointRecord struct {
	Body      EndpointBody `json:"body"`
	Signature string       `json:"signature"`
}
type EndpointHead struct {
	Record     EndpointRecord `json:"record"`
	Digest     string         `json:"digest"`
	AcceptedAt int64          `json:"accepted_at"`
}

var endpointLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func decodeEndpoint(tx []byte, network string, now int64, policies ...string) (EndpointRecord, string, error) {
	policy := ""
	if len(policies) > 1 {
		return EndpointRecord{}, "", errors.New("one endpoint policy required")
	}
	if len(policies) == 1 {
		policy = policies[0]
	}
	domain := "sfera-mesh-endpoint-lab-v1"
	if policy == "https-v1" {
		domain = "sfera-mesh-endpoint-https-v1"
	} else if policy != "" {
		return EndpointRecord{}, "", errors.New("unsupported endpoint policy")
	}
	var r EndpointRecord
	if len(tx) > 2048 || json.Unmarshal(tx, &r) != nil || !bytes.Equal(tx, canonical(r)) {
		return r, "", errors.New("invalid endpoint record")
	}
	b := r.Body
	if b.Domain != domain || b.Network != network || b.Version < 1 || (b.Version == 1 && b.Previous != zero) || !hex64.MatchString(b.NodeID) || !hex64.MatchString(b.PublicKey) || !hex64.MatchString(b.Previous) || b.IssuedAt < 1 || b.IssuedAt > now+5 || b.IssuedAt < now-30 || b.ExpiresAt <= now || b.ExpiresAt <= b.IssuedAt || b.ExpiresAt-b.IssuedAt > 3600 {
		return r, "", errors.New("invalid endpoint context")
	}
	u, err := url.Parse(b.Endpoint)
	if err != nil || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return r, "", errors.New("endpoint loopback laboratory only")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return r, "", errors.New("invalid endpoint port")
	}
	if policy == "https-v1" {
		host := u.Hostname()
		if u.Scheme != "https" || len(host) > 253 || b.Endpoint != "https://"+host+":"+strconv.Itoa(port) {
			return r, "", errors.New("canonical HTTPS endpoint required")
		}
		for _, label := range strings.Split(host, ".") {
			if !endpointLabel.MatchString(label) {
				return r, "", errors.New("canonical endpoint hostname required")
			}
		}
	} else if u.Scheme != "http" || u.Hostname() != "127.0.0.1" || b.Endpoint != "http://127.0.0.1:"+strconv.Itoa(port) {
		return r, "", errors.New("endpoint loopback laboratory only")
	}
	pub, _ := hex.DecodeString(b.PublicKey)
	sig, err := hex.DecodeString(r.Signature)
	if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != r.Signature || hex.EncodeToString(hashNode(pub)) != b.NodeID || !ed25519.Verify(pub, canonical(b), sig) {
		return r, "", errors.New("endpoint owner signature")
	}
	return r, hex.EncodeToString(digest(r)), nil
}

func applyEndpoint(s *State, tx []byte) error {
	var context EndpointRecord
	if json.Unmarshal(tx, &context) != nil {
		return errors.New("invalid endpoint transaction")
	}
	if old, ok := s.Endpoints[context.Body.NodeID]; ok && bytes.Equal(tx, canonical(old.Record)) {
		return nil
	}
	r, h, err := decodeEndpoint(tx, s.Network, s.BlockTime, s.EndpointPolicy)
	if err != nil {
		return err
	}
	candidate, ok := s.Candidates[r.Body.NodeID]
	if !ok || candidate.Record.Body.PublicKey != r.Body.PublicKey {
		return errors.New("registered endpoint owner required")
	}
	old, exists := s.Endpoints[r.Body.NodeID]
	if (!exists && (r.Body.Version != 1 || len(s.Endpoints) >= 128)) || (exists && (old.Record.Body.Version == int64(^uint64(0)>>1) || r.Body.Version != old.Record.Body.Version+1 || r.Body.Previous != old.Digest)) {
		return errors.New("endpoint version conflict")
	}
	if s.Endpoints == nil {
		s.Endpoints = map[string]EndpointHead{}
	}
	s.Endpoints[r.Body.NodeID] = EndpointHead{r, h, s.BlockTime}
	return nil
}

func verifyEndpoints(s State) error {
	if len(s.Endpoints) > 128 {
		return errors.New("endpoint registry limit")
	}
	for node, head := range s.Endpoints {
		r, h, err := decodeEndpoint(canonical(head.Record), s.Network, head.AcceptedAt, s.EndpointPolicy)
		candidate, exists := s.Candidates[node]
		if err != nil || head.AcceptedAt < 1 || head.AcceptedAt > s.BlockTime || h != head.Digest || r.Body.NodeID != node || !exists || r.Body.PublicKey != candidate.Record.Body.PublicKey {
			return errors.New("invalid endpoint snapshot")
		}
	}
	return nil
}
