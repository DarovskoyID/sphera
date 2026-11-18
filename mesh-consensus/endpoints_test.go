package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	dbm "github.com/cometbft/cometbft-db"
	"strings"
	"testing"
)

func TestEndpointOwnerVersionExpiryAndClone(t *testing.T) {
	key := placementKeys(t, 1)[0]
	s := State{Network: "lab", Issuers: testIssuers(), BlockTime: 1000}
	candidate := candidateFixture(t, key, 1, zero, true)
	record := EndpointRecord{Body: EndpointBody{"sfera-mesh-endpoint-lab-v1", "lab", candidate.Body.NodeID, candidate.Body.PublicKey, 1, zero, "http://127.0.0.1:12345", 1000, 2000}}
	sign := func() { record.Signature = hex.EncodeToString(ed25519.Sign(key, canonical(record.Body))) }
	sign()
	if apply(&s, canonical(record)) == nil {
		t.Fatal("unregistered owner accepted")
	}
	if err := apply(&s, canonical(candidate)); err != nil {
		t.Fatal(err)
	}
	if err := apply(&s, canonical(record)); err != nil {
		t.Fatal(err)
	}
	previous := s.Endpoints[record.Body.NodeID].Digest
	copied := clone(s)
	record.Body.Version = 2
	record.Body.Previous = previous
	record.Body.Endpoint = "http://127.0.0.1:23456"
	sign()
	if err := apply(&copied, canonical(record)); err != nil {
		t.Fatal(err)
	}
	if s.Endpoints[record.Body.NodeID].Record.Body.Version != 1 {
		t.Fatal("endpoint clone mutation")
	}
	s.BlockTime = 3000
	if err := verifyEndpoints(s); err != nil {
		t.Fatal("historical expired endpoint lost", err)
	}
	if apply(&s, canonical(record)) == nil {
		t.Fatal("expired renewal accepted")
	}
	for _, address := range []string{"http://127.0.0.1:023456", "http://127.0.0.1:1/", "http://evil:123", "http://127.0.0.1:1#fragment"} {
		record.Body.Endpoint = address
		sign()
		if _, _, err := decodeEndpoint(canonical(record), "lab", 1000); err == nil {
			t.Fatal("invalid address accepted", address)
		}
	}
}

func TestHTTPSEndpointRequiresExplicitNetworkPolicy(t *testing.T) {
	key := placementKeys(t, 1)[0]
	s := State{Network: "lab", Issuers: testIssuers(), BlockTime: 1000, Accounts: map[string]Head{}}
	candidate := candidateFixture(t, key, 1, zero, true)
	if err := apply(&s, canonical(candidate)); err != nil {
		t.Fatal(err)
	}
	record := EndpointRecord{Body: EndpointBody{"sfera-mesh-endpoint-https-v1", "lab", candidate.Body.NodeID, candidate.Body.PublicKey, 1, zero, "https://point.example:443", 1000, 2000}}
	record.Signature = hex.EncodeToString(ed25519.Sign(key, canonical(record.Body)))
	if apply(&s, canonical(record)) == nil {
		t.Fatal("HTTPS silently activated in legacy network")
	}
	if bytes.Contains(canonical(s), []byte("endpoint_policy")) {
		t.Fatal("legacy state commitment changed")
	}
	s.EndpointPolicy = "https-v1"
	if err := apply(&s, canonical(record)); err != nil {
		t.Fatal(err)
	}
	copied := clone(s)
	if copied.EndpointPolicy != s.EndpointPolicy {
		t.Fatal("endpoint policy lost in clone")
	}
	s.GenesisPin = strings.Repeat("a", 64)
	db := dbm.NewMemDB()
	defer db.Close()
	if err := db.SetSync([]byte("state"), canonical(s)); err != nil {
		t.Fatal(err)
	}
	if _, err := NewApplicationWithPolicy(db, "lab", s.Issuers, nil, s.GenesisPin, "", "https-v1"); err != nil {
		t.Fatal(err)
	}
	if _, err := NewApplicationWithPolicy(db, "lab", s.Issuers, nil, s.GenesisPin, ""); err == nil {
		t.Fatal("endpoint policy removed during restart")
	}
}

func TestHTTPSCanonicalAddressesAndNoPlaintextFallback(t *testing.T) {
	key := placementKeys(t, 1)[0]
	candidate := candidateFixture(t, key, 1, zero, true)
	record := EndpointRecord{Body: EndpointBody{"sfera-mesh-endpoint-https-v1", "lab", candidate.Body.NodeID, candidate.Body.PublicKey, 1, zero, "https://localhost:8443", 1000, 2000}}
	for _, address := range []string{"http://127.0.0.1:80", "https://point.example", "https://UPPER.example:443", "https://point.example:0443", "https://point.example:443/", "https://user@point.example:443", "https://point..example:443", "https://-point.example:443", "https://[::1]:443", "https://point.example:443?x=1", "https://point.example:443#x"} {
		record.Body.Endpoint = address
		record.Signature = hex.EncodeToString(ed25519.Sign(key, canonical(record.Body)))
		if _, _, err := decodeEndpoint(canonical(record), "lab", 1000, "https-v1"); err == nil {
			t.Fatal("unsafe HTTPS endpoint accepted", address)
		}
	}
	record.Body.Endpoint = "https://localhost:8443"
	record.Signature = hex.EncodeToString(ed25519.Sign(key, canonical(record.Body)))
	if _, _, err := decodeEndpoint(canonical(record), "lab", 1000, "https-v1"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := decodeEndpoint(canonical(record), "lab", 1000); err == nil {
		t.Fatal("legacy domain accepted HTTPS policy record")
	}
}
